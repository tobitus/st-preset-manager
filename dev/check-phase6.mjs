#!/usr/bin/env node
/**
 * Phase 6 acceptance (roadmap acceptance 13: the block shelf and
 * cross-preset copy) as one repeatable real-browser script. It drives the
 * ACTUAL v2 window in a headless Chromium over raw CDP — clicks, and real
 * mouse drags through jQuery UI sortable's connectWith from the Presets
 * tab's right-hand shelf list into an open preset's outline — and observes
 * the plugin REST API and SillyTavern's live prompt state (`oai`).
 *
 *   node dev/check-phase6.mjs                 all checks (resets dev data first)
 *   CHK_SKIP=6h node dev/check-phase6.mjs     skip checks by id (diagnosis only)
 *
 * Checks:
 *   6a DEM's 「 Present 」 saved to the shelf from the Presets tab (Save to shelf)
 *   6b a marker cannot go on the shelf: 400 + error toast, shelf unchanged
 *   6c the shelf item dragged onto Sola's third row: GET /presets/<sola> has it
 *      at index 2 with a fresh identifier; ST's live oai shows it at 2, Sola in the slot
 *   6d the copy raised a macro warning toast (Present uses macros Sola lacks)
 *   6e a second drag of the same shelf item: another fresh identifier
 *   6f a whole FF group dragged into Sola: heading + options at the drop point,
 *      fresh ids, the group's name and cardinality; ST's oai shows them there
 *   6g a marker dragged from FF into Sola: 400 + error toast, Sola unchanged;
 *      the copyBlock REST op refuses a marker with 400 too
 *   6h Sola's identifier multiset grew by exactly the copied count; no id reused
 *   6i Shelf tab: the item listed; rename + notes through the UI reach GET /shelf
 *   6j Shelf tab: text typed into the notes while their save is held survives
 *      the save and the refresh (review round 1, finding 3)
 *   6k Shelf tab: Delete armed on item A, then B selected: the next click only
 *      arms B; B is deleted on B's own confirmation, A stays (finding 4)
 * Screenshots (dev/shots/): phase6-presets-shelf.png (Presets tab, shelf list
 * open) and phase6-shelf-tab.png (Shelf tab).
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

const TAB = 'chk6';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';
const SOLA = 'Sola V2 Flame';
const PRESENT = '「 Present 」';
const SHOTS = path.join(REPO, 'dev', 'shots');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-phase6.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { ff: '', dem: '', sola: '', present: '', shelf: '' };

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const setValue = (/** @type {string} */ sel, /** @type {string} */ value, evt = 'input') => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return el.value === ${J(value)}; })()`);

const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;
const getSlot = async () => (await api('GET', '/slot')).json;
const getShelf = async () => (await api('GET', '/shelf')).json;
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const flatIds = (/** @type {any} */ doc) => flat(doc).map((e) => identOf(e.leaf));

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
        prompts: (o.prompts ?? []).map((p) => ({ identifier: p.identifier, name: p.name, content: p.content ?? '' })),
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

async function showTab(/** @type {string} */ tab) {
    await click(`#pm-window .pm-tab[data-tab="${tab}"]`);
    await until(() => exists(`#pm-window .pm-pane[data-pane="${tab}"]:not([hidden])`), 5000, `${tab} tab shown`);
}

async function loadViaLibrary(/** @type {string} */ presetId) {
    await showTab('library');
    const row = `#pm-window .pm-library-row[data-preset-id="${presetId}"]`;
    await until(() => exists(row), 10000, 'library row');
    await click(`${row} .pm-load`);
    const res = await until(async () => {
        const c = await converged();
        return c && c.slot.desired.presetId === presetId ? c : null;
    }, 20000, `preset ${presetId} converged in the slot`);
    await dismissPopups();
    return res;
}

const view = (/** @type {string} */ id) => `#pm-window .pm-preset-view[data-preset-id="${id}"]`;

/** Open a preset through the Library tab's Open button; it becomes the active view. */
async function openViaLibrary(/** @type {string} */ presetId) {
    await showTab('library');
    const row = `#pm-window .pm-library-row[data-preset-id="${presetId}"]`;
    await until(() => exists(row), 10000, 'library row');
    await click(`${row} .pm-open`);
    await until(() => exists(`${view(presetId)} .pm-outline li.pm-node`), 10000, `preset ${presetId} open`);
}

/** Top-level outline row `i` (0-based) of the open view's first sequence. */
const topRow = (/** @type {string} */ id, /** @type {number} */ i) => `${view(id)} .pm-outline > ul.pm-list[data-seq-index="0"] > li.pm-node:nth-child(${i + 1})`;

/** Toasts: clear, and read the visible ones. */
const clearToasts = () => probe.eval(`(() => { document.querySelectorAll('#toast-container .toast').forEach((t) => t.remove()); return true; })()`);
const toasts = (/** @type {string} */ kind) => probe.eval(`[...document.querySelectorAll('#toast-container .toast-${kind}')].map((t) => t.textContent)`);

// ------------------------------------------------------------------ real mouse drag

/**
 * Press on `handleSel` (a shelf-panel row's handle), travel vertically to
 * the target row's upper quarter, then horizontally into the outline, and
 * release: jQuery UI sortable's connectWith places the placeholder above the
 * target row. Returns where the placeholder sat right before the release.
 * @param {string} handleSel @param {string} targetSel li.pm-node of the outline
 * @param {number} wantIndex the target row's index in its list
 */
async function dragInto(handleSel, targetSel, wantIndex) {
    // the source row visible in the panel, the outline at its top
    await probe.eval(`(() => {
        document.querySelector(${J(handleSel)})?.scrollIntoView({ block: 'center' });
        for (const el of document.querySelectorAll('#pm-window .pm-outline')) el.scrollTop = 0;
        return true; })()`);
    await sleep(100);
    const g = await probe.eval(`(() => {
        const h = document.querySelector(${J(handleSel)});
        const t = document.querySelector(${J(targetSel)});
        if (!h || !t) return null;
        const row = t.querySelector(':scope > .pm-row') ?? t;
        const hb = h.getBoundingClientRect(); const tb = row.getBoundingClientRect();
        return { from: { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, to: { x: tb.x + Math.min(80, tb.width / 3), y: tb.y + tb.height * 0.25 } };
    })()`);
    if (!g) throw new Error(`drag: missing ${handleSel} or ${targetSel}`);
    const m = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, extra = {}) => probe.cdp('Input.dispatchMouseEvent', { type, x, y, ...extra });
    const held = { button: 'left', buttons: 1 };
    await m('mouseMoved', g.from.x, g.from.y);
    await m('mousePressed', g.from.x, g.from.y, { ...held, clickCount: 1 });
    await m('mouseMoved', g.from.x, g.from.y + 6, held);
    for (let i = 1; i <= 15; i++) {
        await m('mouseMoved', g.from.x, g.from.y + 6 + (g.to.y - g.from.y - 6) * i / 15, held);
        await sleep(15);
    }
    for (let i = 1; i <= 25; i++) {
        await m('mouseMoved', g.from.x + (g.to.x - g.from.x) * i / 25, g.to.y, held);
        await sleep(15);
    }
    await sleep(150);
    await m('mouseMoved', g.to.x, g.to.y, held);
    await sleep(150);
    const readPh = () => probe.eval(`(() => {
        const p = document.querySelector('#pm-window .pm-outline .pm-sort-placeholder');
        if (!p) return null;
        const sibs = [...p.parentElement.children].filter((el) => el.matches('li.pm-node, .pm-sort-placeholder'));
        return { index: sibs.indexOf(p), seqList: p.parentElement.dataset.list === 'seq', nextKey: p.nextElementSibling?.dataset?.key ?? null };
    })()`);
    // like a person watching the gap: nudge until the placeholder sits
    // right above the target row (sortable's entry heuristics can put it
    // one row off), then release
    let y = g.to.y;
    let placeholder = await readPh();
    for (let i = 0; i < 30 && placeholder && placeholder.seqList && placeholder.index !== wantIndex; i++) {
        y += placeholder.index > wantIndex ? -4 : 4;
        await m('mouseMoved', g.to.x, y, held);
        await sleep(60);
        placeholder = await readPh();
    }
    await m('mouseReleased', g.to.x, y, { button: 'left', buttons: 0, clickCount: 1 });
    return placeholder;
}

/** Hold the page's next fetch whose URL ends with urlPart and body contains bodyPart. */
const holdFetch = (/** @type {string} */ urlPart, /** @type {string} */ bodyPart) => probe.eval(`(() => {
    window.__chkHeld = false; window.__chkDone = false;
    window.__chkOrigFetch = window.__chkOrigFetch ?? window.fetch;
    const orig = window.__chkOrigFetch;
    let armed = true;
    window.fetch = async (...args) => {
        const url = String(args[0]?.url ?? args[0]);
        const body = String(args[1]?.body ?? '');
        const mine = armed && url.endsWith(${J(urlPart)}) && body.includes(${J(bodyPart)});
        if (!mine) return orig(...args);
        armed = false;
        window.__chkHeld = true;
        await new Promise((r) => { window.__chkRelease = r; });
        try { return await orig(...args); } finally { setTimeout(() => { window.__chkDone = true; }, 0); }
    };
    return true; })()`);
const unhold = () => probe.eval(`(() => { window.__chkRelease?.(); if (window.__chkOrigFetch) window.fetch = window.__chkOrigFetch; window.__chkOrigFetch = undefined; return true; })()`);

async function shot(/** @type {string} */ file) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await sleep(300);
    const r = await probe.eval(`(() => { const b = document.querySelector('#pm-window').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    const out = path.join(SHOTS, file);
    fs.writeFileSync(out, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data, 'base64'));
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
    const dem0 = await getDoc(ids.dem);
    const ff0 = await getDoc(ids.ff);
    const sola0 = await getDoc(ids.sola);
    ids.present = Object.values(dem0.blocks).find((/** @type {any} */ b) => b.name === PRESENT)?.identifier ?? '';
    if (!ids.present) fatal('setup', `DEM has no ${PRESENT} block`);
    const sola0Top = sola0.sequences[0].rows.slice(0, 8);
    if (!sola0Top.every((/** @type {any} */ r) => r.kind === 'block')) fatal('setup', 'precondition: Sola\'s first 8 rows are plain blocks');
    if (J((await getShelf())) !== '[]') fatal('setup', 'the shelf is not empty after reset');

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await dismissPopups();
    try {
        await until(() => exists('#pm-menu-item'), 20000, 'wand menu entry');
        await click('#pm-menu-item');
        await until(() => exists('#pm-window .pm-tab[data-tab="shelf"]'), 10000, 'window with a Shelf tab');
        await loadViaLibrary(ids.sola);
        await openViaLibrary(ids.dem);
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, FF/DEM/Sola imported, Sola in the slot, DEM open in the Presets tab', true,
        `ff=${ids.ff} dem=${ids.dem} sola=${ids.sola} present=${ids.present}`);

    /** every identifier minted by a copy in this run, in order */
    const copied = /** @type {string[]} */ ([]);

    // ------------------------------------------------------------------ 6a
    await check(`6a DEM's ${PRESENT} saved to the shelf from the Presets tab`, async () => {
        await dismissPopups();
        await clearToasts();
        const rowSel = `${view(ids.dem)} li.pm-node[data-identifier="${ids.present}"] > .pm-row .pm-name`;
        await until(async () => {
            await probe.eval(`document.querySelector(${J(rowSel)})?.scrollIntoView({ block: 'center' })`);
            return click(rowSel);
        }, 5000, 'Present row clickable');
        await until(() => exists(`${view(ids.dem)} li.pm-node[data-identifier="${ids.present}"] > .pm-row.pm-selected`), 5000, 'Present row selected');
        must(await click(`${view(ids.dem)} .pm-shelf-save:not([disabled])`), 'no enabled Save to shelf button');
        const shelf = await until(async () => { const s = await getShelf(); return s.length === 1 ? s : null; }, 8000, 'one shelf item');
        const e = shelf[0];
        must(e.name === PRESENT && e.content === dem0.blocks[ids.present].content, `shelf item ${J({ name: e.name })} differs from DEM's block`);
        must(e.savedFrom.presetId === ids.dem && e.savedFrom.identifier === ids.present, `savedFrom ${J(e.savedFrom)}`);
        ids.shelf = e.id;
        const ok = await until(async () => (await toasts('success')).join(' ') || null, 5000, 'success toast');
        must(!/&(quot|lt|gt|amp|#39);/.test(ok), `toast shows HTML entities: ${ok}`);
        return `shelf item ${e.id} "${e.name}" savedFrom ${J(e.savedFrom)}; toast "${ok.slice(0, 80)}"`;
    });

    // ------------------------------------------------------------------ 6b
    await check('6b a marker cannot go on the shelf: 400 + error toast, shelf unchanged', async () => {
        await clearToasts();
        const markerSel = `${view(ids.dem)} li.pm-node.pm-marker[data-identifier="chatHistory"] > .pm-row .pm-name`;
        await probe.eval(`document.querySelector(${J(markerSel)})?.scrollIntoView({ block: 'center' })`);
        must(await click(markerSel), 'no chatHistory marker row in DEM');
        await until(() => exists(`${view(ids.dem)} li.pm-node[data-identifier="chatHistory"] > .pm-row.pm-selected`), 5000, 'marker row selected');
        must(await click(`${view(ids.dem)} .pm-shelf-save:not([disabled])`), 'no enabled Save to shelf button');
        const err = await until(async () => (await toasts('error')).join(' ') || null, 5000, 'error toast');
        must(/marker/i.test(err), `toast "${err}"`);
        const rest = await api('POST', '/shelf', { fromPresetId: ids.dem, identifier: 'chatHistory' });
        must(rest.status === 400 && /marker/i.test(rest.json?.error ?? ''), `POST /shelf marker -> ${rest.status} ${rest.text}`);
        const shelf = await getShelf();
        must(shelf.length === 1 && shelf[0].id === ids.shelf, `shelf now ${J(shelf.map((/** @type {any} */ s) => s.name))}`);
        return `toast "${err.slice(0, 90)}"; POST /shelf marker -> 400 "${rest.json.error}"; shelf still 1 item`;
    });

    // open FF (a drag source later) and Sola (the drop target, active last)
    try {
        await openViaLibrary(ids.ff);
        await openViaLibrary(ids.sola);
        await dismissPopups();
        await click(`${view(ids.sola)} .pm-shelf-toggle`);
        await until(() => exists(`${view(ids.sola)} .pm-shelf-panel:not([hidden]) li.pm-src-item[data-shelf-id="${ids.shelf}"]`), 8000, 'shelf list open with the item');
    } catch (err) {
        fatal('setup: Sola open with the shelf list', /** @type {Error} */ (err).message);
    }
    const shelfHandle = `${view(ids.sola)} .pm-shelf-panel li.pm-src-item[data-shelf-id="${ids.shelf}"] > .pm-row > .pm-drag-handle`;

    // ------------------------------------------------------------------ 6c + 6d
    /** @type {string[]} */
    let warnToast = [];
    await check('6c shelf item dragged onto Sola\'s third row: at index 2 with a fresh id; ST shows it there, Sola in the slot', async () => {
        const before = await getDoc(ids.sola);
        const ids0 = flatIds(before);
        const c0 = await until(converged, 15000, 'Sola converged');
        must(c0.slot.desired.presetId === ids.sola, 'precondition: Sola in the slot');
        await clearToasts();
        const ph = await dragInto(shelfHandle, topRow(ids.sola, 2), 2);
        must(ph && ph.seqList && ph.index === 2, `placeholder before release ${J(ph)}`);
        const after = await until(async () => { const d = await getDoc(ids.sola); return d.rev > before.rev ? d : null; }, 8000, 'Sola changed');
        const ids1 = flatIds(after);
        const fresh = ids1.filter((i) => !ids0.includes(i));
        must(fresh.length === 1, `new identifiers ${J(fresh)}`);
        const n = fresh[0];
        must(ids1.indexOf(n) === 2, `new block at flat index ${ids1.indexOf(n)}`);
        must(after.sequences[0].rows[2].kind === 'block' && after.sequences[0].rows[2].ref === n, 'rows[2] is not the new block');
        must(n !== ids.present && !(n in dem0.blocks) && !(n in ff0.blocks), 'identifier reused from a source preset');
        must(after.blocks[n].name === PRESENT && after.blocks[n].content === dem0.blocks[ids.present].content, 'content/name differ from the shelf item');
        copied.push(n);
        const c1 = await until(async () => {
            const c = await converged();
            return c && c.s.order[2]?.identifier === n ? c : null;
        }, 15000, `ST order[2] is ${n}`);
        must(c1.slot.desired.presetId === ids.sola && c1.s.preset === SLOT_NAME, 'Sola is not in the slot');
        must(c1.s.prompts.find((/** @type {any} */ p) => p.identifier === n)?.content === dem0.blocks[ids.present].content, 'ST prompt content differs');
        warnToast = await until(async () => { const t = await toasts('warning'); return t.length ? t : null; }, 5000, 'macro warning toast').catch(() => []);
        return `placeholder at 2 in the sequence list; ${n} at flat index 2 (rows[2]); ST "${c1.s.preset}" order[2]=${n.slice(0, 12)}…, prompt content = DEM's`;
    });

    await check('6d the copy raised a macro warning toast for macros Sola lacks', async () => {
        const solaBlob = Object.values(sola0.blocks).map((/** @type {any} */ b) => `${b.content} ${b.name}`).join(' ');
        must(dem0.blocks[ids.present].content.includes('{{#if !.pick_tense}}') && !solaBlob.includes('{{#if !.pick_tense}}'), 'precondition: Present uses {{#if !.pick_tense}}, Sola never mentions it');
        const t = warnToast.join(' ');
        must(t.includes(PRESENT) && t.includes('{{#if !.pick_tense}}') && t.includes('absent in target preset'), `warning toast "${t.slice(0, 200)}"`);
        must(!t.includes('{{// Comment'), 'a comment macro was warned about');
        must(!/&(quot|lt|gt|amp|#39);/.test(t), 'toast shows HTML entities');
        return `toast "${t.slice(0, 160)}…"`;
    });

    // ------------------------------------------------------------------ screenshot: Presets tab with the shelf list
    try {
        await probe.eval(`document.querySelector(${J(`${view(ids.sola)} .pm-outline`)}).scrollTop = 0`);
        await clearToasts();
        await shot('phase6-presets-shelf.png');
    } catch (err) {
        console.log(`[check] presets screenshot failed: ${/** @type {Error} */ (err).message}`);
    }

    await check('6e a second drag of the same shelf item: another fresh identifier', async () => {
        const before = await getDoc(ids.sola);
        const ids0 = flatIds(before);
        const anchor = identOf(before.sequences[0].rows[5]);
        const ph = await dragInto(shelfHandle, topRow(ids.sola, 5), 5);
        must(ph && ph.seqList && ph.index === 5, `placeholder before release ${J(ph)}`);
        const after = await until(async () => { const d = await getDoc(ids.sola); return d.rev > before.rev ? d : null; }, 8000, 'Sola changed');
        const ids1 = flatIds(after);
        const fresh = ids1.filter((i) => !ids0.includes(i));
        must(fresh.length === 1, `new identifiers ${J(fresh)}`);
        const n = fresh[0];
        must(n !== copied[0], 'the second copy reused the first copy\'s identifier');
        must(ids1.indexOf(n) === ids0.indexOf(anchor) && ids1[ids1.indexOf(n) + 1] === anchor, 'second copy not right above the drop row');
        copied.push(n);
        await until(async () => { const c = await converged(); return c && c.s.order.some((/** @type {any} */ o) => o.identifier === n) ? c : null; }, 15000, 'ST shows the second copy');
        return `${n} at flat index ${ids1.indexOf(n)} (above ${anchor.slice(0, 12)}…), ≠ first copy ${copied[0].slice(0, 12)}…`;
    });

    // ------------------------------------------------------------------ 6f
    const pov = ff0.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'group' && /POV/.test(r.name));
    await check('6f a whole FF group dragged into Sola: heading + options at the drop point, fresh ids, name + cardinality', async () => {
        must(pov && pov.header && pov.options.length >= 2, 'precondition: FF has a POV group with heading + options');
        must(await setValue(`${view(ids.sola)} .pm-shelf-source`, ids.ff, 'change'), 'could not pick FF as the shelf-list source');
        const grpSel = `${view(ids.sola)} .pm-shelf-panel li.pm-src-group[data-group-key="${pov.key}"]`;
        await until(() => exists(grpSel), 8000, 'FF POV group row in the shelf list');
        const before = await getDoc(ids.sola);
        const ids0 = flatIds(before);
        const anchor = identOf(before.sequences[0].rows[7]);
        must(before.sequences[0].rows[7].kind === 'block', 'precondition: Sola row 7 is a plain block');
        await clearToasts();
        const ph = await dragInto(`${grpSel} > .pm-row > .pm-drag-handle`, topRow(ids.sola, 7), 7);
        must(ph && ph.seqList && ph.index === 7, `placeholder before release ${J(ph)}`);
        const after = await until(async () => { const d = await getDoc(ids.sola); return d.rev > before.rev ? d : null; }, 8000, 'Sola changed');
        const srcIds = [pov.header.ref, ...pov.options.map((/** @type {any} */ o) => o.ref)];
        const ids1 = flatIds(after);
        const fresh = ids1.filter((i) => !ids0.includes(i));
        must(fresh.length === srcIds.length, `${fresh.length} new identifiers, want ${srcIds.length}`);
        const at = ids0.indexOf(anchor);
        must(J(ids1.slice(at, at + fresh.length)) === J(fresh) && ids1[at + fresh.length] === anchor, 'the group did not land right above the drop row');
        const grp = after.sequences[0].rows[7];
        must(grp.kind === 'group' && grp.header?.ref === fresh[0] && J(grp.options.map((/** @type {any} */ o) => o.ref)) === J(fresh.slice(1)), `rows[7] ${J({ kind: grp.kind })} is not heading + options`);
        must(grp.name === pov.name && grp.cardinality === pov.cardinality, `name/cardinality ${J([grp.name, grp.cardinality])} vs ${J([pov.name, pov.cardinality])}`);
        must(srcIds.every((s, i) => after.blocks[fresh[i]].name === ff0.blocks[s].name && after.blocks[fresh[i]].content === ff0.blocks[s].content), 'copied names/contents differ from FF');
        must(fresh.every((i) => !srcIds.includes(i) && !copied.includes(i) && !(i in ff0.blocks)), 'an identifier was reused');
        copied.push(...fresh);
        const c = await until(async () => {
            const cc = await converged();
            if (!cc) return null;
            const o = cc.s.order.map((/** @type {any} */ e) => e.identifier);
            const k = o.indexOf(fresh[0]);
            return k !== -1 && J(o.slice(k, k + fresh.length + 1)) === J([...fresh, anchor]) ? cc : null;
        }, 15000, 'ST shows the group right above the drop row');
        return `"${grp.name}" (${grp.cardinality}) heading + ${grp.options.length} options at rows[7], flat ${at}..${at + fresh.length - 1}; fresh ids; ST order has them before ${anchor.slice(0, 12)}… (slot ${c.slot.desired.presetId === ids.sola ? 'Sola' : c.slot.desired.presetId})`;
    });

    // ------------------------------------------------------------------ 6g
    await check('6g a marker dragged from FF into Sola: 400 + error toast, Sola unchanged; the REST op refuses it too', async () => {
        const mSel = `${view(ids.sola)} .pm-shelf-panel li.pm-src-item.pm-marker[data-identifier="chatHistory"]`;
        await until(() => exists(mSel), 8000, 'FF chatHistory marker row in the shelf list');
        const before = await getDoc(ids.sola);
        await clearToasts();
        const ph = await dragInto(`${mSel} > .pm-row > .pm-drag-handle`, topRow(ids.sola, 3), 3);
        must(ph && ph.index === 3, `placeholder before release ${J(ph)}`);
        const err = await until(async () => (await toasts('error')).join(' ') || null, 8000, 'error toast');
        must(/marker/i.test(err), `toast "${err}"`);
        await sleep(500);
        const after = await getDoc(ids.sola);
        must(after.rev === before.rev && J(after) === J(before), 'Sola changed');
        const rest = await api('POST', `/presets/${ids.sola}/ops`, { op: 'copyBlock', fromPresetId: ids.ff, identifier: 'chatHistory', before: null });
        must(rest.status === 400 && /marker/i.test(rest.json?.error ?? ''), `copyBlock marker -> ${rest.status} ${rest.text}`);
        must(J(await getDoc(ids.sola)) === J(before), 'the REST refusal changed Sola');
        return `toast "${err.slice(0, 90)}"; Sola rev ${after.rev} unchanged; POST ops copyBlock marker -> 400 "${rest.json.error}"`;
    });

    // ------------------------------------------------------------------ 6h
    await check('6h Sola\'s identifier multiset grew by exactly the copied count; no identifier reused', async () => {
        must(copied.length === 2 + (pov ? 1 + pov.options.length : 0), `copied ${copied.length}`);
        const d = await getDoc(ids.sola);
        const before = flatIds(sola0).sort();
        const now = flatIds(d);
        must(new Set(now).size === now.length, 'an identifier appears twice in Sola\'s sequence');
        const expected = [...before, ...copied].sort();
        must(J([...now].sort()) === J(expected), `multiset: ${now.length} ids vs ${expected.length} expected`);
        must(Object.keys(d.blocks).length === Object.keys(sola0.blocks).length + copied.length, 'blocks map did not grow by the copied count');
        must(new Set(copied).size === copied.length, 'two copies share an identifier');
        const foreign = new Set([...Object.keys(dem0.blocks), ...Object.keys(ff0.blocks), ...before]);
        must(copied.every((i) => !foreign.has(i)), 'a copied identifier exists in DEM, FF or old Sola');
        const c = await until(converged, 15000, 'converged');
        const live = c.s.order.map((/** @type {any} */ e) => e.identifier);
        must(live.length === now.length && copied.every((i) => live.includes(i)), `ST order ${live.length} entries vs doc ${now.length}`);
        return `Sola ${before.length} -> ${now.length} leaves (+${copied.length}: 2 shelf copies + ${copied.length - 2} group blocks); all distinct, none from DEM/FF/Sola; ST order has ${live.length}`;
    });

    // ------------------------------------------------------------------ 6i
    await check('6i Shelf tab: item listed; rename + notes through the UI reach GET /shelf', async () => {
        await showTab('shelf');
        const item = `#pm-window .pm-shelf-items li.pm-shelf-item[data-shelf-id="${ids.shelf}"]`;
        await until(() => exists(item), 8000, 'shelf item listed');
        await click(item);
        await until(() => exists(`${item}.pm-selected`), 5000, 'item selected');
        must(await setValue('#pm-window .pm-shelf-name', `${PRESENT} (tense)`), 'name input');
        await click('#pm-window .pm-shelf-rename');
        await until(async () => (await getShelf())[0]?.name === `${PRESENT} (tense)`, 8000, 'renamed');
        must(await setValue('#pm-window .pm-shelf-notes', 'present-tense narration; pairs with DEM tense group'), 'notes input');
        await click('#pm-window .pm-shelf-notes-save');
        const s = await until(async () => { const x = await getShelf(); return x[0]?.notes === 'present-tense narration; pairs with DEM tense group' ? x : null; }, 8000, 'notes saved');
        await until(() => probe.eval(`document.querySelector(${J(`${item} .pm-shelf-item-name`)})?.textContent === ${J(`${PRESENT} (tense)`)}`), 5000, 'list shows the new name');
        const content = await probe.eval(`document.querySelector('#pm-window .pm-shelf-content')?.textContent ?? ''`);
        must(content === dem0.blocks[ids.present].content, 'detail content differs from the block');
        await clearToasts();
        await shot('phase6-shelf-tab.png');
        return `GET /shelf: name "${s[0].name}", notes "${s[0].notes}"; detail shows the content`;
    });

    // ------------------------------------------------------------------ 6j
    await check('6j Shelf tab: notes typed while their save is held survive the save and the refresh', async () => {
        const item = `#pm-window .pm-shelf-items li.pm-shelf-item[data-shelf-id="${ids.shelf}"]`;
        await click(item);
        await until(() => exists(`${item}.pm-selected`), 5000, 'item selected');
        const first = 'chk6j first';
        const more = 'chk6j first + typed during the save';
        must(await setValue('#pm-window .pm-shelf-notes', first), 'notes input');
        await holdFetch(`/shelf/${ids.shelf}`, first);
        await click('#pm-window .pm-shelf-notes-save');
        await until(() => probe.eval('window.__chkHeld === true'), 5000, 'notes PATCH held');
        must(await setValue('#pm-window .pm-shelf-notes', more), 'typing during the save');
        await unhold();
        await until(async () => (await getShelf()).find((/** @type {any} */ x) => x.id === ids.shelf)?.notes === first, 8000, 'the held save landed');
        await until(() => probe.eval('window.__chkDone === true'), 5000, 'held fetch finished');
        await sleep(800); // the save's refresh and the SSE-driven refresh
        const shown = await probe.eval(`document.querySelector('#pm-window .pm-shelf-notes').value`);
        must(shown === more, `textarea after the save: ${J(shown)}`);
        await click('#pm-window .pm-shelf-notes-save');
        await until(async () => (await getShelf()).find((/** @type {any} */ x) => x.id === ids.shelf)?.notes === more, 8000, 'second save landed');
        return `held save stored ${J(first)}; the textarea kept ${J(more)} through the refresh; saving again stored it`;
    });
    await unhold();

    // ------------------------------------------------------------------ 6k
    await check('6k Shelf tab: Delete armed on A does not delete B after B is selected', async () => {
        const other = Object.values(dem0.blocks).find((/** @type {any} */ b) => b.name === '「 Frenetic 」');
        must(other, 'precondition: DEM has 「 Frenetic 」');
        const add = await api('POST', '/shelf', { fromPresetId: ids.dem, identifier: other.identifier });
        must(add.status === 201, `POST /shelf -> ${add.status}`);
        const bId = add.json.id;
        const A = `#pm-window .pm-shelf-items li.pm-shelf-item[data-shelf-id="${ids.shelf}"]`;
        const B = `#pm-window .pm-shelf-items li.pm-shelf-item[data-shelf-id="${bId}"]`;
        await until(() => exists(B), 8000, 'B listed (SSE refresh)');
        await click(A);
        await until(() => exists(`${A}.pm-selected`), 5000, 'A selected');
        await click('#pm-window .pm-shelf-delete');
        const armedText = await probe.eval(`document.querySelector('#pm-window .pm-shelf-delete').textContent`);
        must(armedText === 'Confirm delete', `after one click on A: ${J(armedText)}`);
        await click(B);
        await until(() => exists(`${B}.pm-selected`), 5000, 'B selected');
        await click('#pm-window .pm-shelf-delete');
        await sleep(800);
        const mid = (await getShelf()).map((/** @type {any} */ x) => x.id);
        must(mid.includes(ids.shelf) && mid.includes(bId), `after A-armed, B-selected, click: shelf ${J(mid)}`);
        const text2 = await probe.eval(`document.querySelector('#pm-window .pm-shelf-delete').textContent`);
        must(text2 === 'Confirm delete', `that click should arm B: ${J(text2)}`);
        await click('#pm-window .pm-shelf-delete');
        const end = await until(async () => { const x = (await getShelf()).map((/** @type {any} */ e) => e.id); return x.includes(bId) ? null : x; }, 8000, 'B deleted');
        must(end.includes(ids.shelf), 'A was deleted');
        return `armed on A, selected B, clicked: nothing deleted, B armed; confirmed: B deleted, A kept (${J(end)})`;
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
