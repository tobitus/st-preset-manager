#!/usr/bin/env node
/**
 * Mini round acceptance (owner notes 2026-09-29, "mini round" on top of fix
 * round 1 / roadmap 015) as one repeatable real-browser script. It drives
 * the ACTUAL v2 window in a headless Chromium over raw CDP (clicks, real
 * key presses) and observes the plugin REST API and localStorage.
 *
 *   node dev/check-mini.mjs                  all checks (resets dev data first)
 *   CHK_SKIP=m4 node dev/check-mini.mjs      skip checks by id (diagnosis only)
 *
 * Checks (ids follow the owner's item numbers):
 *   m1 section rename: a REST addSection heading, renamed through the block
 *      editor, shows the new name on its outline row immediately and after
 *      a reload (the section's stored name and the block's name both track
 *      the rename)
 *   m2 Make group heading on a plain item (button), toggled back off byte-
 *      for-byte, made again, gains two options via REST demote, then
 *      renamed through the editor — the group's displayed/stored name
 *      tracks its heading block, live and after a reload
 *   m3 Make/Unmake section heading on a plain item: exactly one makeSection
 *      op, the new section's children are exactly the rows between it and
 *      the next heading, its own block/loadout bit are untouched, unmaking
 *      it restores the doc byte-for-byte; the same round trip again via
 *      Alt+S; ST's live order still carries the row if it has content
 *   m4 refusals: make-section/make-group on a group option, and
 *      make-section on a group heading, all warn "make it a plain row
 *      first", post no op and leave the doc untouched
 *   m5 group collapse: the same caret mechanism as sections — hides the
 *      options, is saved per preset, survives a reload, moves as one unit
 *      with move up/down, excludes shelf drop targets, is opened (without
 *      losing the saved state) by a search match inside it, and works the
 *      same for a headerless group
 *   m6 screenshot: the collapsed group with its rank bar showing "Unmake
 *      group heading"
 * Screenshot (dev/shots/): mini-collapsed.png.
 *
 * Environment: st-pm-dev on 127.0.0.1:8002 with the plugin (dev/up.sh).
 * dev/reset.sh runs first. Never touches :8001, the sillytavern container,
 * ~/tools/ST-dev or /home/jon/projects/sillysystem/st.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    FF, Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';
import { flattenSeq } from '../shared/outline.js';

const TAB = 'chkmini';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';
const SOLA = 'Sola V2 Flame';
const SHOTS = path.join(REPO, 'dev', 'shots');
const TOKEN = 'zqminitoken';

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-mini.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { ff: '', dem: '', sola: '' };
/** state carried between checks */
const S = {
    /** @type {string[]} */ sola0: [], // Sola's flat identifiers before any edit
    /** @type {string[]} */ sola0Keys: [],
    sec: { id: '', key: '' },
    grp: { id: '', key: '', nodeKey: '' },
};

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);
const setValue = (/** @type {string} */ sel, /** @type {string} */ value, evt = 'input') => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return el.value === ${J(value)}; })()`);
const ls = (/** @type {string} */ key) => probe.eval(`(() => { try { return JSON.parse(localStorage.getItem(${J(key)}) ?? 'null'); } catch { return '__malformed__'; } })()`);

const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;
const getSlot = async () => (await api('GET', '/slot')).json;
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const flatIds = (/** @type {any} */ doc) => flat(doc).map((e) => identOf(e.leaf));
const op = (/** @type {string} */ id, /** @type {any} */ body) => api('POST', `/presets/${id}/ops`, body);

/** Read Sola's current doc over REST. */
const docNow = () => getDoc(ids.sola);

/** Depth-first search of `doc.sequences[0].rows` for a row of `kind` whose `header` refs `id`. */
function findHeaderRow(/** @type {any[]} */ rows, /** @type {'section'|'group'} */ kind, /** @type {string} */ id) {
    for (const r of rows) {
        if (r.kind === kind && r.header && identOf(r.header) === id) return r;
        if (r.kind === 'section') {
            const found = findHeaderRow(r.rows, kind, id);
            if (found) return found;
        }
    }
    return null;
}
const secOf = (/** @type {any} */ doc, /** @type {string} */ id) => findHeaderRow(doc.sequences[0].rows, 'section', id);
const grpOf = (/** @type {any} */ doc, /** @type {string} */ id) => findHeaderRow(doc.sequences[0].rows, 'group', id);

async function dismissPopups() {
    const closed = await probe.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

/** ST's live chat-completion prompt state. */
const st = () => probe.eval(`(() => {
    const o = SillyTavern.getContext().chatCompletionSettings;
    const b = window.__pmStarted?.bridge;
    return {
        preset: o.preset_settings_openai,
        order: o.prompt_order?.[0]?.order ?? [],
        prompts: (o.prompts ?? []).map((p) => ({ identifier: p.identifier, content: p.content ?? '' })),
        blocker: !!document.querySelector('.pm-apply-blocker'),
        idle: !!b && !b.applying && !b._reconcileQueued && !b._panelQueued,
    };
})()`);

/** ST shows the slot and its order equals the compiled slot. */
async function converged() {
    const s = await st();
    const slot = await getSlot();
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
const rowLi = (/** @type {string} */ id, /** @type {string} */ key) => `${view(id)} li.pm-node[data-key="${key}"]`;

/** Click a row's name (scrolled into view) and wait until it is the selected row. */
async function selectRow(/** @type {string} */ id, /** @type {string} */ key) {
    const nameSel = `${rowLi(id, key)} > .pm-row .pm-name`;
    await probe.eval(`document.querySelector(${J(nameSel)})?.scrollIntoView({ block: 'center' })`);
    if (!(await click(nameSel))) throw new Error(`no row ${key}`);
    await until(() => exists(`${rowLi(id, key)} > .pm-row.pm-selected`), 5000, `row ${key} selected`);
}

/** Toasts: clear, and read the visible ones. */
const clearToasts = () => probe.eval(`(() => { document.querySelectorAll('#toast-container .toast').forEach((t) => t.remove()); return true; })()`);
const toasts = (/** @type {string} */ kind) => probe.eval(`[...document.querySelectorAll('#toast-container .toast-${kind}')].map((t) => t.textContent)`);

/** Real mouse click at a point. */
async function mouseClick(/** @type {{x: number, y: number}} */ p) {
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}

/** Real Alt+<key> key press (focus must already be on the target). Modifier bit 1 = Alt. */
async function altKey(/** @type {string} */ key, /** @type {string} */ code, /** @type {number} */ vk) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 1 };
    await probe.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await probe.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const rectOf = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return null; const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height), x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);

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

async function closeWindow() {
    await click('#pm-window .pm-close');
    await until(async () => !(await exists('#pm-window')), 5000, 'window closed');
}

/** Count page POSTs to /ops (with their op names) from now on. */
const countOps = () => probe.eval(`(() => {
    window.__chkOps = [];
    window.__chkFetch0 = window.__chkFetch0 ?? window.fetch;
    const orig = window.__chkFetch0;
    window.fetch = (...args) => {
        const url = String(args[0]?.url ?? args[0]);
        if (url.includes('/api/plugins/st-preset-manager/presets/') && url.endsWith('/ops') && (args[1]?.method ?? 'GET') === 'POST') {
            try { window.__chkOps.push(JSON.parse(String(args[1]?.body ?? '{}')).op); } catch { window.__chkOps.push('?'); }
        }
        return orig(...args);
    };
    return true; })()`);
const opsSeen = () => probe.eval('window.__chkOps ?? []');

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
        ['^(Freaky Frankenstein 5\\.4 Internal States \\(2\\)|DEUS\\.EX\\.MACHINA\\.V2\\.5\\.ST|Sola V2 Flame)$'],
        { stdio: 'pipe' });
    const library = (await api('GET', '/library')).json ?? [];
    const idOf = (/** @type {string} */ n) => library.find((/** @type {any} */ e) => e.name === n)?.id ?? '';
    ids.ff = idOf(FF); ids.dem = idOf(DEM); ids.sola = idOf(SOLA);
    if (!ids.ff || !ids.dem || !ids.sola) fatal('setup', `fixtures missing: ${J(library.map((/** @type {any} */ e) => e.name))}`);
    const sola0 = await getDoc(ids.sola);
    S.sola0 = flatIds(sola0);
    S.sola0Keys = flat(sola0).map((e) => e.leaf.key);
    if (flat(sola0).some((e) => e.rank === 'section')) fatal('setup', 'precondition: Sola has no section headings');
    if (S.sola0.length < 16) fatal('setup', `precondition: Sola has >= 16 rows (has ${S.sola0.length})`);
    if ((await api('POST', '/slot/load', { presetId: ids.sola })).status !== 200) fatal('setup', 'slot_load Sola failed');

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
        // a clean per-browser state: no saved rect/tabs/collapse/button position
        await probe.eval(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pm.')) localStorage.removeItem(k); return true; })()`);
        await reloadPage();
        await convergedOn(ids.sola, 'Sola converged in the slot');
        await openWindow();
        await showTab('presets');
        await until(() => exists(`${view(ids.sola)} .pm-outline li.pm-node`), 10000, 'Sola view (the slot preset auto-opens)');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, FF/DEM/Sola imported, Sola in the slot and open, clean pm.* localStorage', true,
        `ff=${ids.ff} dem=${ids.dem} sola=${ids.sola} solaRows=${S.sola0.length}`);

    // ------------------------------------------------------------------ m1
    await check('m1 section rename: the outline label follows the heading block\'s name, live and after a reload', async () => {
        must((await op(ids.sola, { op: 'addSection', name: '== New section ==', before: S.sola0Keys[12] })).status === 200, 'addSection failed');
        const d1 = await until(async () => {
            const d = await getDoc(ids.sola);
            return Object.values(d.blocks).some((/** @type {any} */ b) => b.name === '== New section ==') ? d : null;
        }, 8000, 'new section heading in the doc');
        const block = /** @type {any} */ (Object.values(d1.blocks).find((/** @type {any} */ b) => b.name === '== New section =='));
        const key = /** @type {string} */ (flat(d1).find((e) => identOf(e.leaf) === block.identifier).leaf.key);
        await until(() => exists(rowLi(ids.sola, key)), 8000, 'new section row in the outline');
        await selectRow(ids.sola, key);
        must(await setValue(`${view(ids.sola)} .pm-editor input.pm-block-name`, '━⏱️ Pacing & Rhythm'), 'could not set the name input');
        must(await click(`${view(ids.sola)} .pm-block-save`), 'no save button');
        await until(async () => (await text(`${rowLi(ids.sola, key)} > .pm-row .pm-name`)) === '━⏱️ Pacing & Rhythm', 8000, 'section row shows the new name');
        const d2 = await getDoc(ids.sola);
        const sec = secOf(d2, block.identifier);
        must(sec, 'no section found for the new heading');
        must(sec.name === '━⏱️ Pacing & Rhythm', `stored section name ${J(sec.name)}`);
        must(d2.blocks[block.identifier].name === '━⏱️ Pacing & Rhythm', 'block name not updated');
        await reloadPage();
        await openWindow();
        await showTab('presets');
        await until(() => exists(`${view(ids.sola)} .pm-outline li.pm-node`), 10000, 'Sola view restored after reload');
        must((await text(`${rowLi(ids.sola, key)} > .pm-row .pm-name`)) === '━⏱️ Pacing & Rhythm', 'label lost after reload');
        S.sec = { id: block.identifier, key };
        return `section heading ${block.identifier} renamed via the editor; row, stored section name and block name all "━⏱️ Pacing & Rhythm"; survives a reload`;
    });

    // ------------------------------------------------------------------ m2
    await check('m2 Make group heading on a plain item, toggle off byte-for-byte, remake, gain options, rename via the editor', async () => {
        const Y = S.sola0Keys[6];
        const before = await docNow();
        await selectRow(ids.sola, Y);
        must((await text(`${view(ids.sola)} .pm-rank-make-group`))?.startsWith('Make group heading'), 'button not "Make group heading"');
        await countOps();
        must(await click(`${view(ids.sola)} .pm-rank-make-group`), 'no make-group button');
        await until(async () => flat(await docNow()).find((e) => e.leaf.key === Y)?.rank === 'group', 8000, 'row is now a group heading');
        const d1 = await docNow();
        must(J(await opsSeen()) === J(['promote']), `ops ${J(await opsSeen())}`);
        const grp1 = grpOf(d1, S.sola0[6]);
        must(grp1, 'no group found for the new heading');
        must(grp1.name === d1.blocks[S.sola0[6]].name, 'group name != block name');
        await until(async () => (await text(`${view(ids.sola)} .pm-rank-make-group`))?.startsWith('Unmake group heading'), 5000, 'button now "Unmake group heading"');
        must(await click(`${view(ids.sola)} .pm-rank-make-group`), 'no unmake-group button');
        await until(async () => flat(await docNow()).find((e) => e.leaf.key === Y)?.rank === 'item', 8000, 'row back to a plain item');
        const d2 = await docNow();
        must(J(d2.sequences) === J(before.sequences), 'sequences differ from before make/unmake');
        must(J(d2.blocks) === J(before.blocks), 'blocks differ from before make/unmake');
        must(J(d2.loadouts) === J(before.loadouts), 'loadouts differ from before make/unmake');
        must(await click(`${view(ids.sola)} .pm-rank-make-group`), 'no make-group button (2nd time)');
        await until(async () => flat(await docNow()).find((e) => e.leaf.key === Y)?.rank === 'group', 8000, 'row is a group heading again');
        must((await op(ids.sola, { op: 'demote', key: S.sola0Keys[7] })).status === 200, 'demote row 7 failed');
        must((await op(ids.sola, { op: 'demote', key: S.sola0Keys[8] })).status === 200, 'demote row 8 failed');
        await until(async () => {
            const g = grpOf(await docNow(), S.sola0[6]);
            return g && g.options.length === 2;
        }, 8000, 'group has 2 options');
        await selectRow(ids.sola, Y);
        must(await setValue(`${view(ids.sola)} .pm-editor input.pm-block-name`, 'Anti-Slop'), 'could not set the name input');
        must(await click(`${view(ids.sola)} .pm-block-save`), 'no save button');
        await until(async () => (await text(`${rowLi(ids.sola, Y)} > .pm-row .pm-name`)) === 'Anti-Slop', 8000, 'group row shows the new name');
        const d4 = await docNow();
        must(grpOf(d4, S.sola0[6]).name === 'Anti-Slop', 'stored group name not updated');
        await reloadPage();
        await openWindow();
        await showTab('presets');
        await until(() => exists(`${view(ids.sola)} .pm-outline li.pm-node`), 10000, 'Sola view restored after reload');
        must((await text(`${rowLi(ids.sola, Y)} > .pm-row .pm-name`)) === 'Anti-Slop', 'label lost after reload');
        S.grp = { id: S.sola0[6], key: Y, nodeKey: `grp:${Y}` };
        return `row ${Y} toggled group heading via the button (ops ['promote'], byte-identical after unmake), remade, gained 2 options, renamed to "Anti-Slop" (row + stored name; survives a reload)`;
    });

    // ------------------------------------------------------------------ m3
    await check('m3 Make/Unmake section heading on a plain item, byte-for-byte, then again via Alt+S', async () => {
        const X = S.sola0Keys[3];
        const before = await docNow();
        await selectRow(ids.sola, X);
        must((await text(`${view(ids.sola)} .pm-rank-make-section`))?.startsWith('Make section heading'), 'button not "Make section heading"');
        await countOps();
        must(await click(`${view(ids.sola)} .pm-rank-make-section`), 'no make-section button');
        await until(async () => flat(await docNow()).find((e) => e.leaf.key === X)?.rank === 'section', 8000, 'row is now a section heading');
        const d1 = await docNow();
        must(J(await opsSeen()) === J(['makeSection']), `ops ${J(await opsSeen())}`);
        const sec = secOf(d1, S.sola0[3]);
        must(sec, 'no section found for the new heading');
        must(sec.name === d1.blocks[S.sola0[3]].name, 'section name != block name');
        const beforeFlat = flat(before);
        const xIdx = beforeFlat.findIndex((e) => identOf(e.leaf) === S.sola0[3]);
        const headIdx = beforeFlat.findIndex((e) => identOf(e.leaf) === S.sec.id);
        must(headIdx > xIdx, 'the m1 section heading does not follow X in the flat order');
        const wantChildren = beforeFlat.slice(xIdx + 1, headIdx).map((e) => identOf(e.leaf));
        const gotChildren = flattenSeq(sec.rows).map((e) => identOf(e.leaf));
        must(J(gotChildren) === J(wantChildren), `section children ${J(gotChildren)}, want ${J(wantChildren)}`);
        must(J(d1.blocks[S.sola0[3]]) === J(before.blocks[S.sola0[3]]), 'X\'s own block was mutated');
        must(before.loadouts[before.activeLoadoutId].enabled[S.sola0[3]] === d1.loadouts[d1.activeLoadoutId].enabled[S.sola0[3]], 'X\'s loadout bit changed');
        must(await exists(`${view(ids.sola)} li.pm-node[data-kind="section"][data-key="${X}"]`), 'no section li for X in the outline');
        await until(async () => (await text(`${view(ids.sola)} .pm-rank-make-section`))?.startsWith('Unmake section heading'), 5000, 'button now "Unmake section heading"');
        must(await click(`${view(ids.sola)} .pm-rank-make-section`), 'no unmake-section button');
        await until(async () => flat(await docNow()).find((e) => e.leaf.key === X)?.rank === 'item', 8000, 'row back to a plain item');
        const d2 = await docNow();
        must(J(d2.sequences) === J(before.sequences), 'sequences differ after unmake');
        must(J(d2.blocks) === J(before.blocks), 'blocks differ after unmake');
        must(J(d2.loadouts) === J(before.loadouts), 'loadouts differ after unmake');
        // keyboard toggle
        must(await probe.eval(`(() => { document.querySelector(${J(`${view(ids.sola)} .pm-outline`)})?.focus(); return true; })()`), 'could not focus the outline');
        await altKey('s', 'KeyS', 83);
        await until(async () => flat(await docNow()).find((e) => e.leaf.key === X)?.rank === 'section', 8000, 'Alt+S made a section heading');
        // the UI must have taken the new doc before the next press (else it would re-send makeSection)
        await until(async () => String(await text(`${view(ids.sola)} .pm-rank-make-section`)).startsWith('Unmake section heading'), 8000, 'the UI shows the section heading after Alt+S');
        if ((before.blocks[S.sola0[3]]?.content ?? '').trim() !== '') {
            const c = await until(async () => {
                const cc = await converged();
                return cc && flat(await docNow()).find((e) => e.leaf.key === X)?.rank === 'section'
                    && cc.s.order.some((/** @type {any} */ o) => o.identifier === S.sola0[3]) ? cc : null;
            }, 20000, 'ST still sends X while it is a (non-blank) section heading');
            must(c.s.prompts.find((/** @type {any} */ p) => p.identifier === S.sola0[3])?.content === before.blocks[S.sola0[3]].content, 'X\'s content changed in ST');
            must(await exists(`${rowLi(ids.sola, X)} > .pm-row .pm-sends-text`), 'no ⓘ on the non-blank section heading');
        }
        await altKey('s', 'KeyS', 83);
        await until(async () => flat(await docNow()).find((e) => e.leaf.key === X)?.rank === 'item', 8000, 'Alt+S unmade the section heading');
        const d3 = await docNow();
        must(J(d3.sequences) === J(before.sequences), 'sequences differ after the keyboard round trip');
        if ((d3.blocks[S.sola0[3]]?.content ?? '').trim() !== '') {
            const c = await until(converged, 20000, 'ST converged after the keyboard round trip');
            must(c.s.order.map((/** @type {any} */ o) => o.identifier).includes(S.sola0[3]), 'X missing from ST\'s live order');
        }
        return `X (${S.sola0[3]}) toggled a section heading via the button (ops ['makeSection'], children = the ${wantChildren.length} rows between X and the m1 heading, X's own block/loadout untouched, byte-identical after unmake) and again via Alt+S`;
    });

    // ------------------------------------------------------------------ m4
    await check('m4 refusals: an option and a group heading cannot become a section/group heading', async () => {
        const before = await docNow();
        /** @type {string[]} */ const toastTexts = [];
        const tryRefuse = async (/** @type {string} */ key, /** @type {string} */ sel, /** @type {string} */ label) => {
            await selectRow(ids.sola, key);
            await clearToasts();
            await countOps();
            must(await click(sel), `no ${label} button`);
            const warn = await until(async () => {
                const t = await toasts('warning');
                return t.some((/** @type {string} */ x) => x.includes('make it a plain row first')) ? t : null;
            }, 5000, `${label} warning toast`);
            must(J(await opsSeen()) === J([]), `${label} posted ops ${J(await opsSeen())}`);
            toastTexts.push(...warn);
        };
        await tryRefuse(S.sola0Keys[7], `${view(ids.sola)} .pm-rank-make-section`, 'make-section on a group option');
        await tryRefuse(S.sola0Keys[7], `${view(ids.sola)} .pm-rank-make-group`, 'make-group on a group option');
        await tryRefuse(S.grp.key, `${view(ids.sola)} .pm-rank-make-section`, 'make-section on a group heading');
        const after = await docNow();
        must(J(after.sequences) === J(before.sequences), 'a refused click still changed the doc');
        return `3 refusals, all "make it a plain row first" toasts, no ops posted, doc untouched: ${J(toastTexts)}`;
    });

    // ------------------------------------------------------------------ m5
    await check('m5 group collapse: same caret mechanism as sections — hides options, saved, survives reload, moves as a unit, no shelf drop inside, opened by search, headerless too', async () => {
        const li = `${view(ids.sola)} li.pm-node[data-kind="group"][data-key="${S.grp.key}"]`;
        const firstOption = `${li} > ul.pm-list > li.pm-node`;
        const optionsShown = () => probe.eval(`(() => { const c = document.querySelector(${J(firstOption)}); return !!c && c.offsetParent !== null; })()`);
        must(await optionsShown(), 'precondition: group options visible');
        must(!(await exists(`${li}.pm-collapsed`)), 'precondition: not collapsed');
        const selBefore = await probe.eval(`document.querySelector('${view(ids.sola)} .pm-row.pm-selected')?.closest('li')?.dataset.key ?? null`);
        must(await click(`${li} > .pm-row > .pm-caret`), 'no caret on the group heading');
        await until(() => exists(`${li}.pm-collapsed`), 3000, 'group collapsed');
        must(!(await optionsShown()), 'options still visible');
        must((await text(`${li} > .pm-row > .pm-caret`)) === '▸', 'caret not ▸');
        must((await ls(`pm.collapsed.${ids.sola}`))?.includes(S.grp.nodeKey), `saved ${J(await ls(`pm.collapsed.${ids.sola}`))}`);
        const selAfter = await probe.eval(`document.querySelector('${view(ids.sola)} .pm-row.pm-selected')?.closest('li')?.dataset.key ?? null`);
        must(selAfter === selBefore, 'the caret click changed the selection');

        // moves as a unit
        await selectRow(ids.sola, S.grp.key);
        const groupOptionIds = (/** @type {any} */ d) => grpOf(d, S.grp.id).options.map(identOf);
        const d0 = await docNow();
        const opts0 = groupOptionIds(d0);
        const idx0 = flat(d0).findIndex((e) => e.leaf.key === S.grp.key);
        must(await click(`${view(ids.sola)} .pm-move-up`), 'no move-up button');
        const dUp = await until(async () => {
            const d = await docNow();
            const idx = flat(d).findIndex((e) => e.leaf.key === S.grp.key);
            return idx < idx0 ? d : null;
        }, 8000, 'group moved up');
        must(J(groupOptionIds(dUp)) === J(opts0), 'the collapsed group did not move with its options');
        const fUp = flat(dUp);
        const idxUp = fUp.findIndex((e) => e.leaf.key === S.grp.key);
        must(identOf(fUp[idxUp + 1].leaf) === opts0[0] && identOf(fUp[idxUp + 2].leaf) === opts0[1], 'the options no longer directly follow the group heading');
        must(await exists(`${li}.pm-collapsed`), 'not collapsed after the move');
        must(await click(`${view(ids.sola)} .pm-move-down`), 'no move-down button');
        await until(async () => J(flatIds(await docNow())) === J(flatIds(d0)), 8000, 'moved back down to the pre-move order');

        // shelf: no drop target inside a collapsed list
        must(await click(`${view(ids.sola)} .pm-shelf-toggle`), 'no shelf toggle');
        const targets = await until(() => probe.eval(`(() => {
            const src = document.querySelector('${view(ids.sola)} .pm-shelf-panel ul.pm-shelf-list');
            const JQ = window.jQuery; if (!src || !JQ(src).sortable('instance')) return null;
            const sel = JQ(src).sortable('option', 'connectWith');
            const lists = JQ(sel).toArray();
            return { n: lists.length, inside: lists.filter((ul) => ul.closest('li.pm-collapsed')).length,
                collapsedLists: document.querySelectorAll('${view(ids.sola)} li.pm-collapsed ul.pm-list').length };
        })()`), 8000, 'shelf panel sortable');
        await click(`${view(ids.sola)} .pm-shelf-toggle`);
        must(targets.n > 0 && targets.inside === 0 && targets.collapsedLists > 0, `drop targets ${J(targets)}`);

        // reload: still collapsed
        await reloadPage();
        await openWindow();
        await showTab('presets');
        await until(() => exists(`${view(ids.sola)} .pm-outline li.pm-node`), 10000, 'Sola view restored after reload');
        await until(() => exists(`${li}.pm-collapsed`), 5000, 'still collapsed after reload');
        must(!(await optionsShown()), 'options visible after reload');

        // search opens the collapsed group for its match, without losing the saved state
        must((await op(ids.sola, { op: 'setContent', identifier: S.sola0[8], content: 'zqminitoken option text' })).status === 200, 'setContent failed');
        const input = `${view(ids.sola)} .pm-search-input`;
        must(await setValue(input, 'ZQMINITOKEN'), 'no search input');
        await until(() => probe.eval(`(() => {
            const l = document.querySelector(${J(li)}); if (!l || l.classList.contains('pm-collapsed')) return false;
            const opt = document.querySelector(${J(rowLi(ids.sola, S.sola0Keys[8]))});
            return !!opt && opt.offsetParent !== null;
        })()`), 8000, 'search opened the collapsed group');
        must((await ls(`pm.collapsed.${ids.sola}`))?.includes(S.grp.nodeKey), 'search overwrote the saved collapse state');
        must(await setValue(input, ''), 'could not clear the search input');
        await until(() => exists(`${li}.pm-collapsed`), 5000, 'collapsed again after clearing the search');

        // headerless group: a bare demote creates one
        must((await op(ids.sola, { op: 'demote', key: S.sola0Keys[1] })).status === 200, 'demote failed');
        const hless = `${view(ids.sola)} li.pm-node[data-kind="group"][data-key^="grp:"]`;
        await until(() => exists(`${hless} > .pm-row > .pm-caret`), 8000, 'headerless group row with a caret');
        const nodeKey = await probe.eval(`document.querySelector(${J(hless)})?.dataset.nodeKey ?? null`);
        must(await click(`${hless} > .pm-row > .pm-caret`), 'no caret on the headerless group');
        await until(() => exists(`${hless}.pm-collapsed`), 5000, 'headerless group collapsed');
        must((await ls(`pm.collapsed.${ids.sola}`))?.includes(nodeKey), 'headerless group key not saved');
        must(await click(`${hless} > .pm-row > .pm-caret`), 'no caret to re-expand');
        await until(async () => !(await exists(`${hless}.pm-collapsed`)), 5000, 'headerless group expanded again');

        return `Y's group collapsed (caret ▸, options hidden, saved ${S.grp.nodeKey}, selection kept); moved up/down as a unit with its ${opts0.length} options; shelf drop targets ${targets.n}, 0 inside (${targets.collapsedLists} hidden lists); survives reload; a search match inside opened it without losing the saved state; headerless group ${J(nodeKey)} collapses/expands and saves too`;
    });

    // ------------------------------------------------------------------ m6
    await check('m6 screenshot: the collapsed group with the rank bar showing "Unmake group heading"', async () => {
        await selectRow(ids.sola, S.grp.key);
        must(await exists(`${view(ids.sola)} li.pm-node[data-kind="group"][data-key="${S.grp.key}"].pm-collapsed`), 'group not collapsed for the screenshot');
        await probe.eval(`document.querySelector(${J(`${view(ids.sola)} li.pm-node[data-kind="group"][data-key="${S.grp.key}"]`)})?.scrollIntoView({ block: 'start' })`);
        must((await text(`${view(ids.sola)} .pm-rank-make-group`))?.startsWith('Unmake group heading'), 'rank bar does not show "Unmake group heading"');
        const out = await shot('mini-collapsed.png');
        return `screenshot ${out}: Y's group collapsed, rank bar shows "Unmake group heading"`;
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
