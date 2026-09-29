#!/usr/bin/env node
/**
 * ST-panel reorder write-back keeps the outline's structure (owner decision
 * 2026-09-29, option (a); PLAN §1.4). Real mouse drags in SillyTavern's OWN
 * prompt-manager panel (jQuery UI sortable on
 * #completion_prompt_manager_list), on DEM, which has sections and pick-one
 * groups whose empty headings are suppressed from the slot.
 *
 *   node dev/check-reorder.mjs              all checks (resets dev data first)
 *   CHK_SKIP=r2 node dev/check-reorder.mjs  skip checks by id (diagnosis only)
 *
 * Checks (after each drag):
 *   - the library document still has the same sections and groups (names,
 *     cardinality, heading, members) except exactly the predicted change;
 *     the identifier multiset and every loadout bit are unchanged;
 *   - ST's live `oai` order converges to the library's compiled order;
 *   - no repeated applies: one panel POST, no 409, at most ONE slot save (the
 *     bridge re-applies once whenever the stored projection differs from the
 *     panel snapshot — here always, since the compile emits `prompts` in the
 *     new sequence order while ST's drag only reorders `prompt_order`; the
 *     whole-group rule needs that re-apply to converge), then nothing for 3 s.
 *   r1  an item dragged two rows down inside CONSTRAINTS (exact: the library
 *       takes ST's order)
 *   r2  the last option of the pick-one group PICK: AGENCY dragged to the top
 *       of its group (group + section headings are invisible in ST); it stays
 *       in the group (exact)
 *   r3  the WORLD-BUILDING group heading dragged two rows up, into PICK:
 *       (+18) NSFW's options: the whole group moves above NSFW (v2's heading
 *       drag); ST converges to the library order with one re-apply
 *
 * Environment: st-pm-dev on 127.0.0.1:8002 with the plugin (dev/up.sh).
 * dev/reset.sh runs first. Never touches :8001, the sillytavern container,
 * ~/tools/ST-dev or /home/jon/projects/sillysystem/st.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';

const TAB = 'chkro';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-reorder.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const must = (/** @type {any} */ cond, /** @type {string} */ msg) => { if (!cond) throw new Error(msg); };
let dem = '';

const getDoc = async () => (await api('GET', `/presets/${dem}`)).json;
const getSlot = async () => (await api('GET', '/slot')).json;
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;

/** ST's live prompt state + the bridge's idle flag. */
const st = () => probe.eval(`(() => {
    const o = SillyTavern.getContext().chatCompletionSettings;
    const b = window.__pmStarted?.bridge;
    return {
        preset: o.preset_settings_openai,
        order: (o.prompt_order?.[0]?.order ?? []).map((x) => x.identifier),
        blocker: !!document.querySelector('.pm-apply-blocker'),
        idle: !!b && !b.applying && !b._reconcileQueued && !b._panelQueued,
    };
})()`);

/** ST shows the slot, the bridge is idle, and ST's order equals the compiled slot. */
async function converged() {
    const s = await st();
    const slot = await getSlot();
    const lib = (slot.compiled?.prompt_order?.[0]?.order ?? []).map((/** @type {any} */ x) => x.identifier);
    return !s.blocker && s.idle && s.preset === SLOT_NAME && slot.desired?.presetId === dem
        && J(s.order) === J(lib) ? { s, lib } : null;
}

/**
 * Structure summary of the library document: every container with its rows
 * (leaf identifiers; a group row as `G:<heading id>`), every group with its
 * name, cardinality and members, plus the leaf multiset and loadout bits.
 * @param {any} doc
 */
function summary(doc) {
    /** @type {Record<string, any>} */
    const groups = {};
    /** @type {{name: string|null, head: string|null, rows: string[]}[]} */
    const sections = [{ name: '(top)', head: null, rows: [] }];
    const rowsOf = (/** @type {any[]} */ rows, /** @type {string[]} */ into) => {
        for (const row of rows) {
            if (row.kind === 'group') {
                const head = row.header ? identOf(row.header) : `~${identOf(row.options[0])}`;
                groups[head] = { name: row.name, cardinality: row.cardinality, members: (row.options ?? []).map(identOf) };
                into.push(`G:${head}`);
            } else if (row.kind === 'section') {
                const s = { name: row.name ?? null, head: row.header ? identOf(row.header) : null, rows: [] };
                sections.push(s);
                rowsOf(row.rows ?? [], s.rows);
            } else {
                into.push(identOf(row));
            }
        }
    };
    rowsOf(doc.sequences[0].rows, sections[0].rows);
    const leaves = [];
    const walk = (/** @type {any[]} */ rows) => {
        for (const r of rows) {
            if (r.header) leaves.push(identOf(r.header));
            if (r.kind === 'section') walk(r.rows ?? []);
            else if (r.kind === 'group') walk(r.options ?? []);
            else if (!r.header) leaves.push(identOf(r));
        }
    };
    walk(doc.sequences[0].rows);
    return { groups, sections, leaves: leaves.sort(), bits: doc.loadouts };
}

const nameToId = (/** @type {any} */ doc, /** @type {string} */ name) => {
    const hit = Object.values(doc.blocks).find((/** @type {any} */ b) => b.name === name);
    if (!hit) throw new Error(`DEM has no block named ${name}`);
    return /** @type {any} */ (hit).identifier;
};

/** Move `id` directly above `before` in a list. */
function moved(/** @type {string[]} */ list, /** @type {string} */ id, /** @type {string} */ before) {
    const out = list.filter((x) => x !== id);
    out.splice(out.indexOf(before), 0, id);
    return out;
}

// ------------------------------------------------------------------ page helpers

/** Count slot saves (POST /api/presets/save for the slot) and panel POSTs (+409s) from now on. */
const resetCounters = () => probe.eval(`(() => {
    window.__rc = { saves: 0, panel: 0, p409: 0, log: [] };
    if (!window.__rcFetch0) {
        window.__rcFetch0 = window.fetch;
        const orig = window.__rcFetch0;
        window.fetch = async (...args) => {
            const url = String(args[0]?.url ?? args[0]);
            const method = (args[1]?.method ?? 'GET').toUpperCase();
            let kind = null;
            if (method === 'POST' && url.includes('/api/presets/save')) {
                try { if (JSON.parse(String(args[1]?.body ?? '{}')).name === ${J(SLOT_NAME)}) kind = 'save'; } catch { /* not ours */ }
            } else if (method === 'POST' && url.includes('/api/plugins/st-preset-manager/slot/panel')) kind = 'panel';
            if (kind === 'save') window.__rc.saves++;
            if (kind === 'panel') window.__rc.panel++;
            if (kind) window.__rc.log.push(kind + '@' + Math.round(performance.now()));
            const res = await orig(...args);
            if (kind === 'panel' && res.status === 409) window.__rc.p409++;
            return res;
        };
    }
    return true; })()`);
const counters = () => probe.eval('({ ...window.__rc, log: window.__rc.log.join(" ") })');

/** Close any modal ST dialog (a fresh profile can pop one; it captures real mouse input). */
async function dismissPopups() {
    const closed = await probe.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

/** Open ST's AI Response Configuration drawer (the prompt manager lives there). */
async function openAiConfig() {
    const probeRow = () => probe.eval(`(() => {
        const li = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier]');
        const panel = document.getElementById('left-nav-panel');
        if (!li) return { ok: false, why: 'no row', panel: panel?.className };
        li.scrollIntoView({ block: 'center' });
        const b = li.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { ok: !!hit && li.contains(hit), why: hit ? (hit.id || String(hit.className)).slice(0, 80) : 'no hit', panel: panel?.className, rect: [b.x, b.y, b.width, b.height].map(Math.round) };
    })()`);
    await dismissPopups();
    if ((await probeRow()).ok) return;
    if (/closedDrawer/.test((await probeRow()).panel ?? '')) {
        await probe.eval(`document.querySelector('#ai-config-button .drawer-toggle')?.click()`);
    }
    try {
        await until(async () => (await probeRow()).ok, 8000, 'ST prompt manager visible');
    } catch (err) {
        throw new Error(`${/** @type {Error} */ (err).message}: ${J(await probeRow())}`);
    }
}

const rowSel = (/** @type {string} */ id) => `#completion_prompt_manager_list li[data-pm-identifier="${id}"]`;
const rectOf = (/** @type {string} */ id) => probe.eval(`(() => { const b = document.querySelector(${J(rowSel(id))})?.getBoundingClientRect();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.top, h: b.height } : null; })()`);

/**
 * The order ST's list would commit if the mouse were released now: the
 * dragged row (helper 'original', still in the DOM) counts at the sortable
 * placeholder's position.
 * @param {string} id
 */
const pendingOrder = (id) => probe.eval(`(() => {
    const out = [];
    for (const el of document.querySelector('#completion_prompt_manager_list').children) {
        if (el.classList.contains('ui-sortable-placeholder')) out.push(${J(id)});
        else if (el.dataset?.pmIdentifier && el.dataset.pmIdentifier !== ${J(id)}) out.push(el.dataset.pmIdentifier);
        else if (el.dataset?.pmIdentifier === ${J(id)} && !document.querySelector('#completion_prompt_manager_list > .ui-sortable-placeholder')) out.push(${J(id)});
    }
    return out;
})()`);

/**
 * Real mouse drag in ST's panel (jQuery UI sortable; on desktop the whole
 * row is the handle — ST hides .drag-handle): press on the row's left edge,
 * hold past sortable's 50 ms delay, then move 3 px at a time, watching the
 * placeholder like a user would, and release once the row would land
 * directly above `before`.
 * @param {string} id @param {string} before @param {string[]} target ST's order the drop must produce
 */
async function stDrag(id, before, target) {
    /** @type {any} */
    let src = null;
    let x = 0;
    let hit = /** @type {any} */ (null);
    for (let attempt = 0; attempt < 4 && hit !== true; attempt++) {
        if (attempt) await sleep(1000);
        await openAiConfig(); // ST can close its drawer between drags (popups, applies)
        await probe.eval(`document.querySelector(${J(rowSel(id))}).scrollIntoView({ block: 'center' })`);
        await sleep(300);
        src = await rectOf(id);
        x = await probe.eval(`document.querySelector(${J(rowSel(id))}).getBoundingClientRect().left + 5`);
        hit = await probe.eval(`(() => { const li = document.querySelector(${J(rowSel(id))}); const el = document.elementFromPoint(${x}, ${src.y});
            return li.contains(el) ? true : (el ? (el.id || String(el.className)).slice(0, 80) : 'nothing') + ' @' + ${x} + ',' + ${src.y} + ' drawer=' + document.getElementById('left-nav-panel')?.className + ' dialogs=' + document.querySelectorAll('dialog[open]').length; })()`);
    }
    must(hit === true, `the row is covered at its left edge: ${hit}`);
    const dst = await rectOf(before);
    must(src && dst, `no rects for ${id} / ${before}`);
    const dir = dst.top < src.top ? -1 : 1;
    const m = (/** @type {string} */ type, /** @type {number} */ y, extra = {}) => probe.cdp('Input.dispatchMouseEvent', { type, x, y, ...extra });
    const held = { button: 'left', buttons: 1 };
    await m('mouseMoved', src.y);
    await m('mousePressed', src.y, { ...held, clickCount: 1 });
    await sleep(150); // sortable delay: 50 ms
    let y = src.y;
    const maxSteps = Math.ceil((Math.abs(dst.top - src.top) + 2 * src.h) / 3);
    let landed = false;
    /** @type {number[]} */
    const trace = [];
    for (let i = 0; i < maxSteps && !landed; i++) {
        y += 3 * dir;
        await m('mouseMoved', y, held);
        await sleep(15);
        const p = await pendingOrder(id);
        if (trace.at(-1) !== p.indexOf(id)) trace.push(p.indexOf(id));
        landed = J(p) === J(target);
        if (!landed && i === 0 && p.length !== target.length) {
            await m('mouseReleased', y, { button: 'left', buttons: 0, clickCount: 1 });
            throw new Error(`panel rows ${p.length} != order ${target.length}`);
        }
    }
    await sleep(120);
    await m('mouseReleased', y, { button: 'left', buttons: 0, clickCount: 1 });
    must(landed, `the placeholder never reached index ${target.indexOf(id)} (above ${before}); placeholder indices seen: ${trace.join(',')}`);
}

const SKIP = (process.env.CHK_SKIP ?? '').split(',').filter(Boolean);
async function check(/** @type {string} */ name, /** @type {() => Promise<string>} */ body) {
    if (SKIP.includes(name.split(' ')[0])) { console.log(`SKIP ${name}`); return; }
    try {
        report(name, true, await body());
    } catch (err) {
        report(name, false, /** @type {Error} */ (err).message);
    }
}

/**
 * One ST-panel drag and its checks.
 * @param {{ id: string, before: string, expect: (s: ReturnType<typeof summary>) => void, exact: boolean, shot: string }} c
 */
async function dragAndCheck(c) {
    const s0 = await converged();
    must(s0, 'precondition: ST converged on the slot before the drag');
    const docBefore = await getDoc();
    const sumBefore = summary(docBefore);
    const T = moved(s0.s.order, c.id, c.before);
    await resetCounters();
    await stDrag(c.id, c.before, T);
    const right = (await st()).order;
    must(J(right) === J(T), `the drag did not produce the intended ST order (moved ${c.id} to index ${right.indexOf(c.id)}, wanted ${T.indexOf(c.id)})`);
    // the write-back lands (panel POST) and ST converges on the library order
    const t0 = Date.now();
    await until(async () => (await counters()).panel >= 1, 10000, 'panel POST sent');
    const conv = await until(converged, 10000, 'ST order converged to the library compiled order');
    const tConv = Date.now() - t0;
    const docAfter = await getDoc();
    const sumAfter = summary(docAfter);
    // structure: before + exactly the predicted change
    const want = structuredClone(sumBefore);
    c.expect(want);
    must(J(sumAfter.leaves) === J(sumBefore.leaves), 'identifier multiset changed');
    must(J(sumAfter.bits) === J(sumBefore.bits), 'loadout bits changed');
    for (const [head, g] of Object.entries(want.groups)) {
        must(J(sumAfter.groups[head]) === J(g), `group ${g.name}: ${J(sumAfter.groups[head])} != predicted ${J(g)}`);
    }
    must(Object.keys(sumAfter.groups).length === Object.keys(want.groups).length, `group count ${Object.keys(sumAfter.groups).length} != ${Object.keys(want.groups).length}`);
    must(J(sumAfter.sections) === J(want.sections), `sections/rows differ from the prediction: ${J(sumAfter.sections.filter((s, i) => J(s) !== J(want.sections[i])))}`);
    // order: exact cases keep ST's order; the whole-group rule re-sends the library's
    if (c.exact) must(J(conv.lib) === J(T), 'library compiled order != the order the user dragged to');
    else must(J(conv.lib) !== J(T), 'expected the library order to differ from the dragged order (whole-group rule)');
    // no repeated applies: settle, then a quiet window
    const n1 = await counters();
    await sleep(3000);
    const n2 = await counters();
    must(n2.panel === 1 && n2.p409 === 0, `panel POSTs ${n2.panel} (409s ${n2.p409}), want exactly 1 and no 409 [${n2.log}]`);
    must(n2.saves <= 1 && (c.exact || n2.saves === 1), `slot saves ${n2.saves}, want ${c.exact ? 'at most 1' : 'exactly 1'} [${n2.log}]`);
    must(n2.saves === n1.saves && n2.panel === n1.panel, `activity after convergence: ${J(n1)} -> ${J(n2)}`);
    must(await converged(), 'ST drifted off the library order after settling');
    fs.mkdirSync(path.join(REPO, 'dev', 'shots'), { recursive: true });
    await probe.eval(`document.querySelector(${J(rowSel(c.id))})?.scrollIntoView({ block: 'center' })`);
    const shotFile = path.join(REPO, 'dev', 'shots', `reorder-${c.shot}.png`);
    fs.writeFileSync(shotFile, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    return `ST order after drop = dragged order; converged in ${tConv} ms; panel POSTs ${n2.panel}, 409s ${n2.p409}, slot saves ${n2.saves}; structure as predicted; ${path.relative(REPO, shotFile)}`;
}

// ------------------------------------------------------------------ main

async function main() {
    let up = false;
    for (let i = 0; i < 2 && !up; i++) {
        try { up = (await api('GET', '/health')).status === 200; } catch { /* down */ }
        if (!up && i === 0) {
            console.error('[check] st-pm-dev not answering; running dev/up.sh');
            execFileSync(path.join(REPO, 'dev', 'up.sh'), { stdio: 'inherit' });
        }
    }
    if (!up) fatal('environment', 'st-pm-dev did not come up');
    console.error('[check] resetting dev data (dev/reset.sh)…');
    execFileSync(path.join(REPO, 'dev', 'reset.sh'), { stdio: 'inherit' });
    await primeSession();
    execFileSync(path.join(REPO, 'dev', 'import-fixtures.sh'), ['^DEUS\\.EX\\.MACHINA\\.V2\\.5\\.ST$'], { stdio: 'pipe' });
    const library = (await api('GET', '/library')).json ?? [];
    dem = library.find((/** @type {any} */ e) => e.name === DEM)?.id ?? '';
    if (!dem) fatal('setup', `DEM missing: ${J(library.map((/** @type {any} */ e) => e.name))}`);
    if ((await api('POST', '/slot/load', { presetId: dem })).status !== 200) fatal('setup', 'slot_load DEM failed');
    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    let doc0;
    try {
        await until(converged, 30000, 'DEM converged in the slot');
        await openAiConfig();
        doc0 = await getDoc();
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    const s0 = summary(doc0);
    report('setup: reset, DEM imported and in the slot, ST prompt manager visible', true,
        `dem=${dem} groups=${Object.keys(s0.groups).length} sections=${s0.sections.length - 1} stRows=${(await st()).order.length}`);

    const N = (/** @type {string} */ name) => nameToId(doc0, name);
    const sectionRows = (/** @type {any} */ s, /** @type {string} */ head) => {
        const sec = s.sections.find((/** @type {any} */ x) => x.head === head);
        if (!sec) throw new Error(`no section headed ${head}`);
        return sec;
    };

    await check('r1 item dragged two rows down inside a section (CONSTRAINTS): stays an item of that section, the library takes ST\'s order', async () => {
        const x = N('| Character Realism |');
        const before = N('| Anti-Repetition |');
        const sec = N('🔹🔹CONSTRAINTS🔹🔹');
        return dragAndCheck({
            id: x, before, exact: true, shot: 'r1-item',
            expect: (s) => { const r = sectionRows(s, sec); r.rows = moved(r.rows, x, before); },
        });
    });

    await check('r2 option dragged to the top of its pick-one group (PICK: AGENCY, headings invisible in ST): stays in the group, the library takes ST\'s order', async () => {
        const x = N('「 Director 」');
        const before = N('「 You control {{user}} 」');
        const head = N('🔻PICK: AGENCY🔻');
        return dragAndCheck({
            id: x, before, exact: true, shot: 'r2-option',
            expect: (s) => { s.groups[head].members = moved(s.groups[head].members, x, before); },
        });
    });

    await check('r3 group heading dragged alone two rows up into another group\'s options (WORLD-BUILDING into NSFW): the whole group moves above NSFW, ST converges with one re-apply', async () => {
        const wb = N('🔻PICK: WORLD-BUILDING🔻');
        const nsfw = N('🔻PICK: (+18) NSFW🔻');
        const before = N('「 Max Lewdness 」');
        return dragAndCheck({
            id: wb, before, exact: false, shot: 'r3-group-heading',
            expect: (s) => {
                const sec = s.sections.find((x) => x.rows.includes(`G:${wb}`));
                if (!sec) throw new Error('no section holds WORLD-BUILDING');
                sec.rows = moved(sec.rows, `G:${wb}`, `G:${nsfw}`);
            },
        });
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err)?.stack ?? String(err)));
