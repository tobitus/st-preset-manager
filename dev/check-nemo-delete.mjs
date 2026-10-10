#!/usr/bin/env node
/**
 * Nemo Engine recognizer + Library "Delete" control acceptance. Drives the
 * ACTUAL v2 window in a headless Chromium over raw CDP and observes the
 * plugin REST API plus the on-disk library.
 *
 *   node dev/check-nemo-delete.mjs               all checks (resets dev data first)
 *   CHK_SKIP=d1 node dev/check-nemo-delete.mjs   skip checks by id (diagnosis only)
 *
 * Checks:
 *   n1 REST: the imported "Nemo Engine 11.5.2 - Default RP" has, in
 *      sequences[0], 18 sections (only `=== … ===` headers) and 44 groups
 *      (29 pick-one, 15 pick-one-or-more under sub headers); every group is
 *      guessed:false; source.recognizer.kind is 'nemo'; a note names the
 *      split group 'World-Logic' and the moved sub header '<Vex Personas>'
 *   n2 UI: Library -> Open on the Nemo row; the first sequence's outline
 *      renders 18 section and 44 group rows; the `Format` group's member
 *      switches are all radios and its badge reads 1
 *   n4 UI: the `=== 🎭 Vex Personality ===` section row has no switch (its
 *      heading is comment-only); its first child is the group headed
 *      `<Vex Personas>` (no switch, badge 1, a click selects the row) with
 *      31 radios, the first `📋 Default: Vex`; then 4 plain rows with
 *      checkboxes. Indentation: the group heading's handle lines up with
 *      its sibling rows' handles, and an option's handle starts right of
 *      the heading's name
 *   n5 UI: the same indentation rule on a DEM outline (a section holding a
 *      plain row and a group)
 *   n3 UI: a folded-apart group (`Tense`, else `Tracker-Theme`) is headed by
 *      its first member; its heading row renders a radio switch. A real click
 *      on it makes the doc enable the heading and disable every option (and
 *      the radios/`.pm-none` follow); a click on `.pm-none` clears all
 *   d1 Delete, Cancel: the Library row's Delete opens an ST popup naming the
 *      preset; Cancel leaves the row, the REST doc and the file untouched
 *   d2 Delete, Confirm, on the slot-bound preset (also open in the Presets
 *      tab): popup also warns about the working slot; OK removes the row, the
 *      REST doc (404), the preset file and its revisions dir; the slot's
 *      desired preset and compiled output are null, the window header reads
 *      `Active in SillyTavern: none`, the Presets tab closes the deleted preset's tab, no
 *      popup remains, and ST's prompt manager still lists its prompts
 * Screenshots (dev/shots/): nemo-outline.png, nemo-vex-section.png,
 * dem-outline-indent.png, nemo-heading-radio.png, delete-confirm.png.
 *
 * Environment: the dev container st-pm-dev on 127.0.0.1:8002 with the plugin
 * (dev/up.sh); NEVER :8001. It RESETS the dev data (dev/reset.sh) first.
 * Never touches the sillytavern container, ~/tools/ST-dev or
 * /home/jon/projects/sillysystem/st.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    FF, Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';

const TAB = 'chknd';
const NEMO = 'Nemo Engine 11.5.2 - Default RP';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';
const SHOTS = path.join(REPO, 'dev', 'shots');
const PM_DIR = path.join(REPO, 'dev', 'data', 'default-user', 'preset-manager');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-nemo-delete.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { nemo: '', ff: '', dem: '' };

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);

const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;

async function dismissPopups() {
    const closed = await probe.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

/** Text of the first open ST popup, or null. */
const popupText = () => probe.eval(`(() => { const d = document.querySelector('dialog[open]'); return d ? d.textContent.trim() : null; })()`);

/** ST's live chat-completion prompt state. */
const st = () => probe.eval(`(() => {
    const o = SillyTavern.getContext().chatCompletionSettings;
    const b = window.__pmStarted?.bridge;
    return {
        preset: o.preset_settings_openai,
        order: o.prompt_order?.[0]?.order ?? [],
        blocker: !!document.querySelector('.pm-apply-blocker'),
        idle: !!b && !b.applying && !b._reconcileQueued && !b._panelQueued,
    };
})()`);

/** ST shows the slot and its order equals the compiled slot. */
async function converged() {
    const s = await st();
    const slot = (await api('GET', '/slot')).json;
    return !s.blocker && s.idle && s.preset === SLOT_NAME
        && J(s.order) === J(slot.compiled?.prompt_order?.[0]?.order) ? { s, slot } : null;
}
const convergedOn = (/** @type {string} */ presetId, /** @type {string} */ label) => until(async () => {
    const c = await converged();
    return c && c.slot.desired?.presetId === presetId ? c : null;
}, 20000, label);

async function showTab(/** @type {string} */ tab) {
    await click(`#pm-window .pm-tab[data-tab="${tab}"]`);
    await until(() => exists(`#pm-window .pm-pane[data-pane="${tab}"]:not([hidden])`), 5000, `${tab} tab shown`);
}

const view = (/** @type {string} */ id) => `#pm-window .pm-preset-view[data-preset-id="${id}"]`;
const libRow = (/** @type {string} */ id) => `#pm-window .pm-library-row[data-preset-id="${id}"]`;
const presetTab = (/** @type {string} */ id) => `#pm-window .pm-preset-tab[data-preset-id="${id}"]`;

/** Library tab -> the row's Open button -> the preset's outline is rendered. */
async function openFromLibrary(/** @type {string} */ id) {
    await showTab('library');
    await until(() => exists(libRow(id)), 10000, 'library row');
    if (!(await click(`${libRow(id)} .pm-open`))) throw new Error(`no .pm-open on row ${id}`);
    await until(() => exists(`${view(id)} .pm-outline li.pm-node`), 20000, `preset ${id} outline rendered`);
}

/** Reload the ST page and wait for boot + the extension's floating button. */
async function reloadPage() {
    await probe.cdp('Page.reload', { ignoreCache: false });
    await sleep(1500);
    await until(() => probe.eval('(document.getElementById("settings_preset_openai")?.options.length ?? 0) > 1').catch(() => false), 60000, 'ST booted after reload');
    await until(() => exists('#pm-float-btn').catch(() => false), 30000, 'floating button after reload');
    await dismissPopups();
}

async function openWindow() {
    if (!(await click('#pm-float-btn'))) throw new Error('no #pm-float-btn');
    await until(() => exists('#pm-window .pm-tab[data-tab="presets"]'), 10000, 'window opened');
}

async function shot(/** @type {string} */ file, /** @type {'window'|'page'} */ area = 'window') {
    fs.mkdirSync(SHOTS, { recursive: true });
    await sleep(300);
    const params = { format: 'png' };
    if (area === 'window') {
        const r = await probe.eval(`(() => { const b = document.querySelector('#pm-window').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
        Object.assign(params, { clip: { ...r, scale: 1 } });
    }
    const out = path.join(SHOTS, file);
    fs.writeFileSync(out, Buffer.from((await probe.cdp('Page.captureScreenshot', params)).data, 'base64'));
    console.log(`[check] screenshot: ${out}`);
    return out;
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
const must = (/** @type {any} */ cond, /** @type {string} */ msg) => { if (!cond) throw new Error(msg); };

/** Scroll the first element matching `sel` to the top of its scroller. */
const scrollTo = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.scrollIntoView({ block: 'start' }); return true; })()`);

/** Left x of `part` ('.pm-drag-handle' | '.pm-name' | 'input.pm-switch') in the row of each li selector. */
const partX = (/** @type {string[]} */ lis, /** @type {string} */ part) => probe.eval(`${J(lis)}.map((s) => {
    const el = document.querySelector(s + ' > .pm-row > ' + ${J(part)});
    return el ? Math.round(el.getBoundingClientRect().left * 10) / 10 : null;
})`);

/**
 * Indentation rule for one container li: `groupLi` (a headed group) and
 * `leafLi` (a plain row) are siblings; their handles line up, and the
 * group's first option's handle starts right of the group heading's name.
 */
async function indentOk(/** @type {string} */ groupLi, /** @type {string} */ leafLi) {
    const optLi = `${groupLi} > ul.pm-list > li.pm-node`;
    const [gh, lh, oh] = await partX([groupLi, leafLi, optLi], '.pm-drag-handle');
    const [gn] = await partX([groupLi], '.pm-name');
    must(gh !== null && lh !== null && oh !== null && gn !== null, `indent probe missing a part: ${J({ gh, lh, oh, gn })}`);
    must(Math.abs(gh - lh) <= 1, `group heading handle x=${gh} vs sibling row handle x=${lh}: not aligned`);
    must(oh > gn, `option handle x=${oh} is not right of the group heading's name x=${gn}`);
    return `handles heading=${gh} sibling=${lh}; heading name=${gn} < option handle=${oh}`;
}

// ------------------------------------------------------------------ check helpers

/** Count section and group rows in a row tree (sections nest their rows). */
function walk(/** @type {any[]} */ rows, /** @type {{sections: number, groups: number, one: number, many: number, bad: string[]}} */ acc = { sections: 0, groups: 0, one: 0, many: 0, bad: [] }) {
    for (const r of rows) {
        if (r.kind === 'section') { acc.sections++; walk(r.rows ?? [], acc); }
        else if (r.kind === 'group') {
            acc.groups++;
            if (r.cardinality === 'pick-one') acc.one++; else acc.many++;
            if (r.guessed !== false) acc.bad.push(`${r.name}:${r.cardinality}/guessed=${r.guessed}`);
        }
    }
    return acc;
}

/** Depth-first search for the group row called `name`. */
function findGroupByName(/** @type {any[]} */ rows, /** @type {string} */ name) {
    for (const r of rows) {
        if (r.kind === 'group' && r.name === name) return r;
        if (r.kind === 'section') {
            const found = findGroupByName(r.rows ?? [], name);
            if (found) return found;
        }
    }
    return null;
}

/** The cardinality badge of the group `li` selector. */
const badgeText = async (/** @type {string} */ sel) => (await text(`${sel} > .pm-row > .pm-card`))?.trim() ?? null;

/** The option switches' input types of a group li. */
const switchTypes = (/** @type {string} */ liSel) => probe.eval(`[...document.querySelectorAll(${J(`${liSel} > ul.pm-list > li.pm-node .pm-switch`)})].map((el) => el.type)`);

/** Number of elements matching `sel`. */
const count = (/** @type {string} */ sel) => probe.eval(`document.querySelectorAll(${J(sel)}).length`);

/** Real mouse click at a point. */
async function mouseClick(/** @type {{x: number, y: number}} */ p) {
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}

/** Real mouse click on the centre of the first element matching `sel`. */
async function mouseClickSel(/** @type {string} */ sel) {
    await probe.eval(`document.querySelector(${J(sel)})?.scrollIntoView({ block: 'center' })`);
    const r = await probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error(`no element ${sel}`);
    await mouseClick(r);
}

/** The `checked` flag of every element matching `sel`. */
const checkedOf = (/** @type {string} */ sel) => probe.eval(`[...document.querySelectorAll(${J(sel)})].map((el) => el.checked)`);

/** The active loadout's enabled map of a REST preset doc. */
const enabledOf = (/** @type {any} */ doc) => doc.loadouts[doc.activeLoadoutId].enabled ?? {};

const ffFile = path.join(PM_DIR, 'presets', `${FF}.json`);

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
    execFileSync(path.join(REPO, 'dev', 'import-fixtures.sh'),
        ['^(Nemo Engine 11\\.5\\.2 - Default RP|Freaky Frankenstein 5\\.4 Internal States \\(2\\)|DEUS\\.EX\\.MACHINA\\.V2\\.5\\.ST)$'],
        { stdio: 'pipe' });
    const library = (await api('GET', '/library')).json ?? [];
    const idOf = (/** @type {string} */ n) => library.find((/** @type {any} */ e) => e.name === n)?.id ?? '';
    ids.nemo = idOf(NEMO); ids.ff = idOf(FF); ids.dem = idOf(DEM);
    if (!ids.nemo || !ids.ff || !ids.dem) fatal('setup', `fixtures missing: ${J(library.map((/** @type {any} */ e) => e.name))}`);
    if (!fs.existsSync(ffFile)) fatal('setup', `precondition: FF file missing at ${ffFile}`);

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
        // a clean per-browser state: no saved rect/tabs/collapse/button position
        await probe.eval(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pm.')) localStorage.removeItem(k); return true; })()`);
        await reloadPage();
        await openWindow();
        await showTab('library');
        await until(() => exists(libRow(ids.nemo)), 10000, 'Nemo library row');
        await until(() => exists(libRow(ids.ff)), 10000, 'FF library row');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, Nemo + FF + DEM imported, window open on the Library tab, clean pm.* localStorage', true,
        `nemo=${ids.nemo} ff=${ids.ff} dem=${ids.dem}`);

    const nemoDoc = await getDoc(ids.nemo);

    // ------------------------------------------------------------------ n1
    // F-066 (round 2 A1): the import drops prompt_order 100000 because
    // 100001 exists, so sequences[0] is now 100001's order: 44 groups
    // (29 pick-one). The dropped 100000 order had 45 (30 pick-one).
    await check('n1 REST: Nemo imports as 18 sections + 44 groups (29 pick-one, 15 pick-many), kind nemo, World-Logic + moved <Vex Personas> noted', async () => {
        const seq0 = walk(nemoDoc.sequences[0].rows);
        must(seq0.sections === 18, `sequences[0] has ${seq0.sections} sections, want 18`);
        must(seq0.groups === 44 && seq0.one === 29 && seq0.many === 15, `sequences[0] has ${seq0.groups} groups (${seq0.one} pick-one, ${seq0.many} pick-many), want 44 (29, 15)`);
        let groupsAll = 0;
        for (const [i, seq] of nemoDoc.sequences.entries()) {
            const w = walk(seq.rows);
            groupsAll += w.groups;
            must(!w.bad.length, `sequences[${i}] groups not guessed:false: ${J(w.bad.slice(0, 5))}`);
        }
        const kind = nemoDoc.source?.recognizer?.kind;
        must(kind === 'nemo', `source.recognizer.kind is ${J(kind)}, want "nemo"`);
        const notes = nemoDoc.source?.recognizer?.notes ?? [];
        const note = notes.find((/** @type {any} */ n) => String(n).includes(`group 'World-Logic'`));
        must(note, `no note includes "group 'World-Logic'" (notes: ${J(notes.slice(0, 5))})`);
        const moved = notes.find((/** @type {any} */ n) => String(n).includes(`moved sub header '<Vex Personas>'`));
        must(moved, `no note says "moved sub header '<Vex Personas>'"`);
        return `sequences[0]: ${seq0.sections} sections, ${seq0.groups} groups (${seq0.one} pick-one, ${seq0.many} pick-many); ${nemoDoc.sequences.length} sequences, ${groupsAll} groups in total, all guessed:false; kind=${kind}; notes ${J(String(note).slice(0, 60))}, ${J(String(moved).slice(0, 70))}`;
    });

    // ------------------------------------------------------------------ n2
    await check('n2 UI: Nemo outline renders 18 sections + 44 groups in its first sequence (F-066: 100001\'s order); Format is radios with badge 1', async () => {
        await openFromLibrary(ids.nemo);
        const seq0 = `${view(ids.nemo)} .pm-outline ul.pm-list[data-list="seq"][data-seq-index="0"]`;
        await until(async () => (await count(`${seq0} li.pm-node[data-kind="group"]`)) > 0, 10000, 'first sequence rendered');
        const sections = await count(`${seq0} li.pm-node[data-kind="section"]`);
        const groups = await count(`${seq0} li.pm-node[data-kind="group"]`);
        must(sections === 18, `UI shows ${sections} section rows in the first sequence, want 18`);
        must(groups === 44, `UI shows ${groups} group rows in the first sequence, want 44`);
        const fmt = findGroupByName(nemoDoc.sequences[0].rows, 'Format');
        must(fmt?.key, `no group named Format in sequences[0] (REST doc)`);
        const fli = `${seq0} li.pm-node[data-kind="group"][data-node-key="${fmt.key}"]`;
        must(await exists(fli), `no Format group row ${fmt.key} in the outline`);
        const types = await switchTypes(fli);
        must(types.length === (fmt.options ?? []).length && types.length > 0, `Format shows ${types.length} member switches, doc has ${(fmt.options ?? []).length}`);
        must(types.every((/** @type {string} */ t) => t === 'radio'), `Format switch types ${J(types)}, want all radio`);
        const b = await badgeText(fli);
        must(b === '1', `Format badge ${J(b)}, want "1"`);
        const out = await shot('nemo-outline.png');
        return `first sequence: ${sections} section rows, ${groups} group rows; Format (${types.length} members) all radio, badge ${b}; screenshot ${out}`;
    });

    // ------------------------------------------------------------------ n4
    await check('n4 UI: Vex section = [<Vex Personas> pick-one heading (selectable, no switch) + 31 radios, 4 plain checkboxes]; indentation', async () => {
        const seq0 = `${view(ids.nemo)} .pm-outline ul.pm-list[data-list="seq"][data-seq-index="0"]`;
        const vexRow = nemoDoc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section' && r.name === '=== 🎭 Vex Personality ===');
        must(vexRow, 'no Vex Personality section in sequences[0] (REST doc)');
        const sli = `${seq0} > li.pm-node[data-kind="section"][data-node-key="${vexRow.key}"]`;
        must(await exists(sli), `no Vex section row ${vexRow.key} in the outline`);
        must((await count(`${sli} > .pm-row input.pm-switch`)) === 0, 'the Vex section heading row renders a switch (its heading is comment-only)');
        const kids = await probe.eval(`[...document.querySelectorAll(${J(`${sli} > ul.pm-list > li.pm-node`)})].map((li) => ({
            kind: li.dataset.kind, nodeKey: li.dataset.nodeKey,
            name: li.querySelector(':scope > .pm-row .pm-name')?.textContent ?? '',
            own: [...li.querySelectorAll(':scope > .pm-row input.pm-switch')].map((i) => i.type),
            opts: [...li.querySelectorAll(':scope > ul.pm-list > li.pm-node > .pm-row input.pm-switch')].map((i) => i.type),
            firstOpt: li.querySelector(':scope > ul.pm-list > li.pm-node .pm-name')?.textContent ?? '',
        }))`);
        must(kids.length === 5, `Vex section has ${kids.length} child rows, want 5: ${J(kids.map((/** @type {any} */ k) => k.name))}`);
        const [g, ...plain] = kids;
        must(g.kind === 'group' && g.name === '<Vex Personas>', `first child is ${J([g.kind, g.name])}, want the group headed <Vex Personas>`);
        must(g.own.length === 0, `<Vex Personas> heading row renders switches ${J(g.own)}, want none`);
        must(g.opts.length === 31 && g.opts.every((/** @type {string} */ t) => t === 'radio'), `<Vex Personas> options: ${g.opts.length} switches ${J([...new Set(g.opts)])}, want 31 radios`);
        must(g.firstOpt === '📋 Default: Vex', `first option ${J(g.firstOpt)}, want "📋 Default: Vex"`);
        const gli = `${sli} > ul.pm-list > li.pm-node[data-node-key="${g.nodeKey}"]`;
        const badge = await badgeText(gli);
        must(badge === '1', `<Vex Personas> badge ${J(badge)}, want "1"`);
        must(J(plain.map((/** @type {any} */ k) => [k.kind, k.name, k.own])) === J([
            ['leaf', '♠️ Midnight Courier Vex', ['checkbox']], ['leaf', '💬 Vex Commentary', ['checkbox']],
            ['leaf', '💭 Vex Meta-Commentary', ['checkbox']], ['leaf', '📦 Core Assembler', ['checkbox']],
        ]), `rows after the group: ${J(plain.map((/** @type {any} */ k) => [k.kind, k.name, k.own]))}`);
        // the heading row is selectable: a real click on its name selects it
        await scrollTo(sli);
        await mouseClickSel(`${gli} > .pm-row .pm-name`);
        await until(() => exists(`${gli} > .pm-row.pm-selected`), 5000, '<Vex Personas> row selected after a click');
        const leafLi = `${sli} > ul.pm-list > li.pm-node[data-kind="leaf"]`;
        const indent = await indentOk(gli, leafLi);
        await scrollTo(sli);
        const out = await shot('nemo-vex-section.png');
        return `section row: no switch; <Vex Personas> group: no heading switch, badge 1, 31 radios from "📋 Default: Vex", selected by a click; 4 plain checkboxes; ${indent}; screenshot ${out}`;
    });

    // ------------------------------------------------------------------ n5
    await check('n5 UI: DEM outline indentation: a group heading lines up with its sibling rows, its options sit right of its name', async () => {
        const demDoc = await getDoc(ids.dem);
        // a section with a plain block row and a headed group row among its direct rows
        const sec = demDoc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section'
            && r.rows.some((/** @type {any} */ c) => c.kind === 'block') && r.rows.some((/** @type {any} */ c) => c.kind === 'group' && c.header));
        must(sec, 'no DEM section with both a plain row and a headed group');
        const grp = sec.rows.find((/** @type {any} */ c) => c.kind === 'group' && c.header);
        await openFromLibrary(ids.dem);
        const seq0 = `${view(ids.dem)} .pm-outline ul.pm-list[data-list="seq"][data-seq-index="0"]`;
        const sli = `${seq0} > li.pm-node[data-kind="section"][data-node-key="${sec.key}"]`;
        await until(() => exists(sli), 10000, 'DEM section rendered');
        const gli = `${sli} > ul.pm-list > li.pm-node[data-node-key="${grp.key}"]`;
        const leafLi = `${sli} > ul.pm-list > li.pm-node[data-kind="leaf"]`;
        const indent = await indentOk(gli, leafLi);
        await scrollTo(sli);
        const out = await shot('dem-outline-indent.png');
        await openFromLibrary(ids.nemo);
        return `DEM section ${J(sec.name)}, group ${J(grp.name)}: ${indent}; screenshot ${out}`;
    });

    // ------------------------------------------------------------------ n3
    await check("n3 UI: a folded-apart group's heading radio selects it", async () => {
        const grp = ['Tense', 'Tracker-Theme']
            .map((n) => findGroupByName(nemoDoc.sequences[0].rows, n))
            .find((g) => g?.header);
        must(grp, 'neither Tense nor Tracker-Theme is a headed group in sequences[0] (REST doc)');
        const headRef = grp.header.ref ?? grp.header.identifier;
        const optRefs = (grp.options ?? []).map((/** @type {any} */ o) => o.ref ?? o.identifier);
        must(headRef && optRefs.length > 0, `${grp.name}: header ref ${J(headRef)}, ${optRefs.length} options`);
        const seq0 = `${view(ids.nemo)} .pm-outline ul.pm-list[data-list="seq"][data-seq-index="0"]`;
        const gli = `${seq0} li.pm-node[data-kind="group"][data-node-key="${grp.key}"]`;
        must(await exists(gli), `no ${grp.name} group row ${grp.key} in the outline`);
        const headSel = `${gli} > .pm-row > input.pm-switch`;
        const noneSel = `${gli} > .pm-row .pm-none`;
        const optSel = `${gli} > ul.pm-list > li.pm-node .pm-switch`;
        must(await exists(headSel), `${grp.name}: heading row has no input.pm-switch`);
        const type = await probe.eval(`document.querySelector(${J(headSel)}).type`);
        must(type === 'radio', `${grp.name}: heading switch type ${J(type)}, want radio`);

        const docNow = async () => getDoc(ids.nemo);
        if (enabledOf(await docNow())[headRef] === true) {
            await mouseClickSel(optSel);
            await until(async () => enabledOf(await docNow())[optRefs[0]] === true, 8000, 'first option enabled in the doc');
        }

        await mouseClickSel(headSel);
        const bits = await until(async () => {
            const en = enabledOf(await docNow());
            return en[headRef] === true && optRefs.every((r) => en[r] === false) ? `head=${en[headRef]} options=${optRefs.map((r) => en[r]).join(',')}` : null;
        }, 8000, `${grp.name}: heading on and every option off in the doc`);
        const dom = await until(async () => {
            const [h] = await checkedOf(headSel);
            const opts = await checkedOf(optSel);
            const [none] = await checkedOf(noneSel);
            return h === true && opts.length === optRefs.length && opts.every((c) => c === false) && none === false ? { h, opts, none } : null;
        }, 8000, `${grp.name}: heading radio checked, options and .pm-none unchecked in the DOM`);
        const out = await shot('nemo-heading-radio.png');

        await mouseClickSel(noneSel);
        await until(async () => {
            const en = enabledOf(await docNow());
            return en[headRef] === false && optRefs.every((r) => en[r] === false);
        }, 8000, `${grp.name}: .pm-none clears the heading and every option in the doc`);
        await until(async () => (await checkedOf(noneSel))[0] === true && (await checkedOf(headSel))[0] === false,
            8000, `${grp.name}: .pm-none checked, heading radio unchecked in the DOM`);
        return `group ${J(grp.name)}, heading ${J(nemoDoc.blocks?.[headRef]?.name ?? '')} (${headRef}); after heading click: ${bits}, DOM heading checked=${dom.h}, options checked=[${dom.opts.join(',')}], none=${dom.none}; .pm-none click clears heading + ${optRefs.length} options; screenshot ${out}`;
    });

    // ------------------------------------------------------------------ d1
    await check('d1 Delete, Cancel: popup names the preset; Cancel keeps the row, the doc and the file', async () => {
        await showTab('library');
        await until(() => exists(`${libRow(ids.ff)} .pm-delete`), 10000, 'FF Delete button');
        must(await click(`${libRow(ids.ff)} .pm-delete`), 'Delete click failed');
        const msg = await until(async () => {
            const t = await popupText();
            return t && t.includes('Delete "Freaky') ? t : null;
        }, 8000, 'confirm popup naming the preset');
        const out = await shot('delete-confirm.png', 'page');
        must(await exists('dialog[open] .popup-button-cancel'), 'popup has no Cancel button');
        await click('dialog[open] .popup-button-cancel');
        await until(async () => !(await exists('dialog[open]')), 8000, 'popup closed after Cancel');
        await sleep(500);
        must(await exists(libRow(ids.ff)), 'FF library row vanished after Cancel');
        const r = await api('GET', `/presets/${ids.ff}`);
        must(r.status === 200, `GET /presets/<ff> is ${r.status} after Cancel, want 200`);
        must(fs.existsSync(ffFile), 'FF preset file gone after Cancel');
        return `popup ${J(msg.replace(/\s+/g, ' ').slice(0, 160))}; after Cancel: popup gone, row present, GET 200, file present; screenshot ${out}`;
    });

    // ------------------------------------------------------------------ d2
    await check('d2 Delete, Confirm on the slot-bound preset: row/doc/file/revisions gone, slot emptied, tab closed, ST keeps its prompts', async () => {
        // FF becomes the working slot, then is opened in the Presets tab
        must((await api('POST', '/slot/load', { presetId: ids.ff })).status === 200, 'slot/load FF failed');
        await convergedOn(ids.ff, 'FF converged in the slot');
        await openFromLibrary(ids.ff);
        must(await exists(presetTab(ids.ff)), 'precondition: no Presets-tab tab for FF before deleting');
        const promptsBefore = await count('#completion_prompt_manager_list li[data-pm-identifier]');
        must(promptsBefore > 0, 'precondition: ST prompt manager lists no prompts with FF in the slot');
        const revDir = path.join(PM_DIR, 'revisions', ids.ff);
        must((await api('POST', `/presets/${ids.ff}/revisions`, { label: 'before delete check' })).status === 201, 'revision snapshot failed');
        must(fs.existsSync(revDir), `precondition: revisions dir missing: ${revDir}`);

        await showTab('library');
        await until(() => exists(`${libRow(ids.ff)} .pm-active-marker`), 10000, 'FF row shows the "● Active" marker');
        must(await click(`${libRow(ids.ff)} .pm-delete`), 'Delete click failed');
        const msg = await until(async () => {
            const t = await popupText();
            return t && t.includes('Delete "Freaky') ? t : null;
        }, 8000, 'confirm popup naming the preset');
        must(msg.includes('working slot'), `popup lacks "working slot": ${J(msg.replace(/\s+/g, ' '))}`);
        must(await exists('dialog[open] .popup-button-ok'), 'popup has no OK button');
        await click('dialog[open] .popup-button-ok');

        await until(async () => !(await exists(libRow(ids.ff))), 8000, 'FF library row removed');
        const r = await api('GET', `/presets/${ids.ff}`);
        must(r.status === 404, `GET /presets/<ff> is ${r.status}, want 404`);
        must(!fs.existsSync(ffFile), `preset file still present: ${ffFile}`);
        must(!fs.existsSync(revDir), `revisions dir still present: ${revDir}`);

        const slot = (await api('GET', '/slot')).json;
        must(slot.desired?.presetId === null, `GET /slot desired.presetId is ${J(slot.desired?.presetId)}, want null`);
        must(slot.compiled === null, 'GET /slot compiled is not null');
        await until(async () => (await text('#pm-window .pm-active-status'))?.trim() === 'Active in SillyTavern: none', 8000, 'header reads "Active in SillyTavern: none"');
        must(!(await exists('dialog[open]')), 'a dialog[open] remains after confirming');
        await until(async () => !(await exists(presetTab(ids.ff))), 8000, 'Presets tab for FF closed');
        must(!(await exists(view(ids.ff))), 'FF preset view still in the DOM');
        const promptsAfter = await count('#completion_prompt_manager_list li[data-pm-identifier]');
        must(promptsAfter > 0, 'ST prompt manager lists no prompts after the delete (wiped)');
        return `row gone, GET 404, file + revisions dir gone, desired.presetId=null compiled=null, header "Active in SillyTavern: none", no dialog, Presets tab closed, ST prompts ${promptsBefore} -> ${promptsAfter}`;
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
