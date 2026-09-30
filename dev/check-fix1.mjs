#!/usr/bin/env node
/**
 * Fix round 1 acceptance (owner notes 2026-09-29, roadmap 014 fix round 1 +
 * roadmap 015) as one repeatable real-browser script. It drives the ACTUAL
 * v2 window in a headless Chromium over raw CDP (clicks, real mouse drags,
 * real key presses, ST's own input popup) and observes the plugin REST API,
 * localStorage and SillyTavern's live prompt state (`oai`).
 *
 *   node dev/check-fix1.mjs                  all checks (resets dev data first)
 *   CHK_SKIP=f4 node dev/check-fix1.mjs      skip checks by id (diagnosis only)
 *
 * Checks (ids follow the owner's item numbers):
 *   f10 floating button: a real click opens #pm-window; a drag moves it
 *       without opening; its position survives a reload
 *   f7  "● Active" marker: DEM (the slot) auto-opens active with the marker; a
 *       REST slot_load of Sola moves the marker live (Library + tab); on
 *       reopen Sola's tab auto-opens with the marker, DEM stays active
 *   f1  Insert ▾ → Section heading twice through ST's input popup: ONE
 *       addSection op each; empty content, rank section, ON in the active
 *       loadout; the rows below up to the next heading are its children
 *   f3  ST's live oai: the empty headings are absent; after giving one
 *       content it is present (ⓘ in the outline); the ST export has both
 *   f2  caret collapse hides the children, is saved per preset, survives a
 *       reload; a collapsed section moves as one unit (move down/up); the
 *       shelf drop targets exclude its list
 *   f9  search: match count, highlights, Enter / Shift+Enter (wrap), the
 *       editor follows; a match inside a collapsed section opens it without
 *       touching the saved state; Filter keeps matches + ancestors only;
 *       names match too
 *   f8  Insert ▾ → Block, Duplicate (fresh id, directly below), Delete
 *       (confirmation bound to its row); a marker is refused
 *   f4  Diff tab side-by-side view: paired lines for a changed block
 *   f5  window rect + f6 open tabs: move/resize, close/reopen, reload: same
 *       rect, same tabs; an off-screen rect is clamped; a missing preset id
 *       is dropped silently
 * Screenshots (dev/shots/): fix1-float-button.png, fix1-active-marker.png,
 * fix1-insert-menu.png, fix1-collapsed.png, fix1-search.png,
 * fix1-diff-side.png.
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
import { searchMatches } from '../ext/outline-model.js';

const TAB = 'chkf1';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';
const SOLA = 'Sola V2 Flame';
const SHOTS = path.join(REPO, 'dev', 'shots');
const TOKEN = 'zqfix1token';

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-fix1.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { ff: '', dem: '', sola: '' };
/** state carried between checks */
const S = {
    /** @type {string[]} */ sola0: [], // Sola's flat identifiers before any edit
    /** @type {string[]} */ sola0Keys: [],
    head: { id: '', key: '', nodeKey: '' },
    tail: { id: '', key: '' },
};

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);
const setValue = (/** @type {string} */ sel, /** @type {string} */ value, evt = 'input') => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return el.value === ${J(value)}; })()`);
const ls = (/** @type {string} */ key) => probe.eval(`(() => { try { return JSON.parse(localStorage.getItem(${J(key)}) ?? 'null'); } catch { return '__malformed__'; } })()`);
const lsRaw = (/** @type {string} */ key) => probe.eval(`localStorage.getItem(${J(key)})`);
const lsSet = (/** @type {string} */ key, /** @type {any} */ value) => probe.eval(`(() => { localStorage.setItem(${J(key)}, ${J(J(value))}); return true; })()`);

const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;
const getSlot = async () => (await api('GET', '/slot')).json;
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const flatIds = (/** @type {any} */ doc) => flat(doc).map((e) => identOf(e.leaf));
const op = (/** @type {string} */ id, /** @type {any} */ body) => api('POST', `/presets/${id}/ops`, body);

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

/** Real mouse (CDP) press at `from`, move in steps to `to`, release. */
async function mouseDrag(/** @type {{x: number, y: number}} */ from, /** @type {{x: number, y: number}} */ to, steps = 12) {
    const m = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, extra = {}) => probe.cdp('Input.dispatchMouseEvent', { type, x, y, ...extra });
    const held = { button: 'left', buttons: 1 };
    await m('mouseMoved', from.x, from.y);
    await m('mousePressed', from.x, from.y, { ...held, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
        await m('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, held);
        await sleep(20);
    }
    await sleep(80);
    await m('mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(150);
}

/** Real mouse click at a point. */
async function mouseClick(/** @type {{x: number, y: number}} */ p) {
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}

/** Real key press (focus must already be on the target). */
async function pressEnter(shift = false) {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: shift ? 8 : 0 };
    await probe.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await probe.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const rectOf = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return null; const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height), x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
const viewport = () => probe.eval('({ width: window.innerWidth, height: window.innerHeight })');
const near = (/** @type {any} */ a, /** @type {any} */ b) => !!a && !!b && ['left', 'top', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 1);
const rect4 = (/** @type {any} */ r) => r && { left: r.left, top: r.top, width: r.width, height: r.height };

/** Reload the ST page and wait for boot + the extension's floating button. */
async function reloadPage() {
    await probe.cdp('Page.reload', { ignoreCache: false });
    await sleep(1500);
    await until(() => probe.eval('(document.getElementById("settings_preset_openai")?.options.length ?? 0) > 1').catch(() => false), 60000, 'ST booted after reload');
    await until(() => exists('#pm-float-btn').catch(() => false), 30000, 'floating button after reload');
    // ST's #preloader overlay fades out after boot and swallows real mouse clicks meanwhile
    await until(async () => !(await exists('#preloader')), 30000, "ST's #preloader gone");
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

/** The Presets tab strip: [{id, active, slot, badge}]. */
const tabsState = () => probe.eval(`[...document.querySelectorAll('#pm-window .pm-preset-tab')].map((t) => ({
    id: t.dataset.presetId, active: t.classList.contains('pm-active'), slot: t.classList.contains('pm-slot'), badge: t.querySelector('.pm-active-marker')?.textContent === '● Active' }))`);
const libBadges = () => probe.eval(`[...document.querySelectorAll('#pm-window .pm-library-row')].filter((r) => r.querySelector('.pm-active-marker')?.textContent === '● Active').map((r) => r.dataset.presetId)`);

/** Fill ST's input popup (POPUP_TYPE.INPUT) and confirm; returns the default it showed. */
async function fillPopup(/** @type {string} */ value) {
    await until(() => exists('dialog[open] .popup-input'), 5000, 'input popup');
    const shown = await probe.eval(`document.querySelector('dialog[open] .popup-input').value`);
    await setValue('dialog[open] .popup-input', value);
    await click('dialog[open] .popup-button-ok');
    await until(async () => !(await exists('dialog[open]')), 5000, 'popup closed');
    return shown;
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
    if ((await api('POST', '/slot/load', { presetId: ids.dem })).status !== 200) fatal('setup', 'slot_load DEM failed');

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
        // a clean per-browser state: no saved rect/tabs/collapse/button position
        await probe.eval(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pm.')) localStorage.removeItem(k); return true; })()`);
        await reloadPage();
        await convergedOn(ids.dem, 'DEM converged in the slot');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, FF/DEM/Sola imported, DEM in the slot, clean pm.* localStorage', true,
        `ff=${ids.ff} dem=${ids.dem} sola=${ids.sola} solaRows=${S.sola0.length}`);

    // ------------------------------------------------------------------ f10
    await check('f10 floating button: a real click opens #pm-window; a drag moves it without opening; the position survives a reload', async () => {
        const vp = await viewport();
        const b0 = await rectOf('#pm-float-btn');
        must(b0, 'no #pm-float-btn');
        must(!(await exists('#pm-window')), 'precondition: the window is closed');
        must(b0.left >= 0 && b0.top >= 0 && b0.left + b0.width <= vp.width && b0.top + b0.height <= vp.height, `button off screen ${J(b0)}`);
        must((await ls('pm.floatBtn.pos')) === null, 'precondition: no saved button position');
        await shot('fix1-float-button.png', 'page');
        await mouseClick({ x: b0.x, y: b0.y });
        await until(() => exists('#pm-window .pm-tab[data-tab="presets"]'), 8000, 'window opened by the button');
        await closeWindow();
        const to = { x: b0.x - 300, y: b0.y - 200 };
        await mouseDrag({ x: b0.x, y: b0.y }, to);
        const b1 = await rectOf('#pm-float-btn');
        must(Math.abs(b1.left - (b0.left - 300)) <= 2 && Math.abs(b1.top - (b0.top - 200)) <= 2, `button did not follow the drag: ${J(rect4(b0))} -> ${J(rect4(b1))}`);
        await sleep(400);
        must(!(await exists('#pm-window')), 'the drag opened the window');
        const saved = await ls('pm.floatBtn.pos');
        must(saved && Math.abs(saved.left - b1.left) <= 1 && Math.abs(saved.top - b1.top) <= 1, `saved ${J(saved)} != shown ${J(rect4(b1))}`);
        await reloadPage();
        const b2 = await rectOf('#pm-float-btn');
        must(Math.abs(b2.left - b1.left) <= 1 && Math.abs(b2.top - b1.top) <= 1, `after reload ${J(rect4(b2))} != ${J(rect4(b1))}`);
        await mouseClick({ x: b2.x, y: b2.y });
        await until(() => exists('#pm-window'), 8000, 'window opened after reload');
        await closeWindow();
        return `button ${b0.left},${b0.top} -> dragged ${b1.left},${b1.top} (saved ${J(saved)}), after reload ${b2.left},${b2.top}; click opened, drag did not`;
    });

    // ------------------------------------------------------------------ f7
    await check('f7 "● Active" marker: the slot preset auto-opens active with the marker; a REST slot_load moves it live; on reopen the new slot preset auto-opens', async () => {
        must((await ls('pm.presets.open')) === null, 'precondition: no saved open tabs');
        must((await getSlot()).desired?.presetId === ids.dem, 'precondition: DEM is the slot preset');
        await openWindow();
        await showTab('presets');
        const t1 = await until(async () => {
            const t = await tabsState();
            return t.length === 1 && t[0].id === ids.dem && t[0].active && t[0].slot && t[0].badge ? t : null;
        }, 10000, 'DEM auto-opened, active, badged');
        await until(() => exists(`${view(ids.dem)} .pm-outline li.pm-node`), 10000, 'DEM outline');
        await showTab('library');
        await until(async () => J(await libBadges()) === J([ids.dem]), 8000, 'Library badge on DEM');
        // live: a slot_load from REST (another client)
        must((await api('POST', '/slot/load', { presetId: ids.sola })).status === 200, 'slot_load Sola failed');
        await until(async () => J(await libBadges()) === J([ids.sola]), 10000, 'Library badge moved to Sola');
        await showTab('presets');
        await until(async () => {
            const t = await tabsState();
            return t.length === 1 && t[0].id === ids.dem && !t[0].slot && !t[0].badge;
        }, 10000, 'DEM tab lost the badge');
        await convergedOn(ids.sola, 'Sola converged in the slot');
        await closeWindow();
        await openWindow();
        await showTab('presets');
        const t2 = await until(async () => {
            const t = await tabsState();
            const dem = t.find((/** @type {any} */ x) => x.id === ids.dem);
            const sola = t.find((/** @type {any} */ x) => x.id === ids.sola);
            return t.length === 2 && dem?.active && !dem.badge && sola && !sola.active && sola.slot && sola.badge ? t : null;
        }, 10000, 'reopen: DEM restored active, Sola auto-opened with the badge');
        await shot('fix1-active-marker.png');
        await click(`#pm-window .pm-preset-tab[data-preset-id="${ids.sola}"]`);
        await until(() => exists(`${view(ids.sola)} .pm-outline li.pm-node`), 10000, 'Sola view');
        return `open#1 ${J(t1)}; after REST slot_load Library badge -> Sola, DEM tab unbadged; reopen ${J(t2)}`;
    });

    // ------------------------------------------------------------------ f1
    await check('f1 Insert ▾ → Section heading: one addSection op each; empty, section rank, ON; rows below up to the next heading are its children', async () => {
        const tailAnchorKey = S.sola0Keys[12];
        const headAnchorKey = S.sola0Keys[4];
        const before = await getDoc(ids.sola);
        must(J(flatIds(before)) === J(S.sola0), 'precondition: Sola unchanged');
        await countOps();
        // tail heading first (above row 12), then head heading (above row 4)
        await selectRow(ids.sola, tailAnchorKey);
        await click(`${view(ids.sola)} .pm-insert-toggle`);
        await until(() => exists(`${view(ids.sola)} .pm-insert-menu:not([hidden])`), 3000, 'Insert menu open');
        await shot('fix1-insert-menu.png');
        await click(`${view(ids.sola)} .pm-insert-section`);
        const shownDefault = await fillPopup('Fix1 Tail');
        const d1 = await until(async () => {
            const d = await getDoc(ids.sola);
            return Object.values(d.blocks).some((/** @type {any} */ b) => b.name === '== Fix1 Tail ==') ? d : null;
        }, 8000, 'tail heading in the doc');
        await selectRow(ids.sola, headAnchorKey);
        await click(`${view(ids.sola)} .pm-insert-toggle`);
        await click(`${view(ids.sola)} .pm-insert-section`);
        await fillPopup('Fix1 Head');
        const d2 = await until(async () => {
            const d = await getDoc(ids.sola);
            return Object.values(d.blocks).some((/** @type {any} */ b) => b.name === '== Fix1 Head ==') ? d : null;
        }, 8000, 'head heading in the doc');
        must(shownDefault === 'New section', `popup default was ${J(shownDefault)}`);
        const ops = await opsSeen();
        must(J(ops) === J(['addSection', 'addSection']), `ops posted: ${J(ops)} (want exactly one addSection per insert)`);
        must(d1.rev === before.rev + 1 && d2.rev === before.rev + 2, `revs ${before.rev} -> ${d1.rev} -> ${d2.rev}: not one write per insert`);
        const tail = /** @type {any} */ (Object.values(d2.blocks).find((/** @type {any} */ b) => b.name === '== Fix1 Tail =='));
        const head = /** @type {any} */ (Object.values(d2.blocks).find((/** @type {any} */ b) => b.name === '== Fix1 Head =='));
        const f = flat(d2);
        const at = (/** @type {string} */ id) => f.findIndex((e) => identOf(e.leaf) === id);
        const L = d2.loadouts[d2.activeLoadoutId].enabled;
        for (const [label, b, anchorId] of /** @type {const} */ ([['tail', tail, S.sola0[12]], ['head', head, S.sola0[4]]])) {
            must(b.content === '', `${label} content ${J(b.content)}`);
            must(f[at(b.identifier)].rank === 'section', `${label} rank ${f[at(b.identifier)].rank}`);
            must(identOf(f[at(b.identifier) + 1].leaf) === anchorId, `${label} is not directly above its anchor row`);
            must(L[b.identifier] === true, `${label} not ON in the active loadout`);
        }
        const secRows = (/** @type {string} */ hid) => {
            const sec = d2.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section' && identOf(r.header) === hid);
            return sec ? flattenSeq(sec.rows).map((e) => identOf(e.leaf)) : null;
        };
        must(J(secRows(head.identifier)) === J(S.sola0.slice(4, 12)), `head children ${J(secRows(head.identifier))}`);
        must(J(secRows(tail.identifier)) === J(S.sola0.slice(12)), `tail children ${J(secRows(tail.identifier))}`);
        must(J(d2.sequences[0].rows.slice(0, 4).map(identOf)) === J(S.sola0.slice(0, 4)), 'rows above the head heading moved');
        const headKey = f[at(head.identifier)].leaf.key;
        await until(() => exists(`${rowLi(ids.sola, headKey)} > .pm-row.pm-selected`), 5000, 'the new heading is selected');
        S.head = { id: head.identifier, key: headKey, nodeKey: `sec:${headKey}` };
        S.tail = { id: tail.identifier, key: f[at(tail.identifier)].leaf.key };
        return `popup default "${shownDefault}"; ops ${J(ops)}; rev +1 each; head ${head.identifier} children=${secRows(head.identifier)?.length} (rows 4..11), tail ${tail.identifier} children=${secRows(tail.identifier)?.length} (rows 12..end); both content '' and ON`;
    });

    // ------------------------------------------------------------------ f3
    await check('f3 ST live oai: empty headings absent; a heading with content present (ⓘ); the ST export keeps both', async () => {
        must(S.head.id && S.tail.id, 'precondition: f1 made the headings');
        const c1 = await until(async () => {
            const c = await converged();
            return c && c.slot.desired?.presetId === ids.sola && c.slot.rev >= 1
                && flatIds(await getDoc(ids.sola)).includes(S.head.id) && c.s.order.length > 0 ? c : null;
        }, 20000, 'Sola with the headings converged');
        const order1 = c1.s.order.map((/** @type {any} */ o) => o.identifier);
        must(!order1.includes(S.head.id) && !order1.includes(S.tail.id), `empty heading in ST's order: ${J(order1.filter((x) => x === S.head.id || x === S.tail.id))}`);
        must(!c1.s.prompts.some((/** @type {any} */ p) => p.identifier === S.head.id), 'empty heading in ST prompts');
        must(order1.includes(S.sola0[4]) && order1.includes(S.sola0[12]), 'the heading children are missing from ST');
        must(!(await exists(`#completion_prompt_manager_list li[data-pm-identifier="${S.head.id}"]`)), 'empty heading shown in ST prompt manager');
        must(!(await exists(`${rowLi(ids.sola, S.tail.key)} > .pm-row .pm-sends-text`)), 'precondition: no ⓘ on the empty tail heading');
        // give the tail heading real content
        must((await op(ids.sola, { op: 'setContent', identifier: S.tail.id, content: 'Fix1 tail heading text.' })).status === 200, 'setContent failed');
        const c2 = await until(async () => {
            const c = await converged();
            return c && c.s.order.some((/** @type {any} */ o) => o.identifier === S.tail.id) ? c : null;
        }, 20000, 'tail heading (with content) in ST');
        const order2 = c2.s.order.map((/** @type {any} */ o) => o.identifier);
        must(!order2.includes(S.head.id), 'empty head heading reappeared');
        must(order2.indexOf(S.tail.id) + 1 === order2.indexOf(S.sola0[12]), 'tail heading not directly above its first child in ST');
        must(c2.s.prompts.find((/** @type {any} */ p) => p.identifier === S.tail.id)?.content === 'Fix1 tail heading text.', 'tail content not in ST');
        await until(() => exists(`${rowLi(ids.sola, S.tail.key)} > .pm-row .pm-sends-text`), 8000, 'ⓘ on the tail heading');
        must(!(await exists(`${rowLi(ids.sola, S.head.key)} > .pm-row .pm-sends-text`)), 'ⓘ on the empty head heading');
        const E = (await api('GET', `/presets/${ids.sola}/export?format=st`)).json;
        const eOrder = E.prompt_order.at(-1).order.map((/** @type {any} */ o) => o.identifier);
        must(eOrder.includes(S.head.id) && eOrder.includes(S.tail.id), 'export lost a heading');
        must(E.prompts.some((/** @type {any} */ p) => p.identifier === S.head.id && p.content === ''), 'export lost the empty heading prompt');
        return `ST order ${order1.length} entries without head/tail; after content: tail at ${order2.indexOf(S.tail.id)} (above its first child), head still absent; ⓘ on tail only; export order ${eOrder.length} with both`;
    });

    // ------------------------------------------------------------------ f2
    await check('f2 caret collapse: hides the children, saved per preset, survives a reload; moves as one unit; no shelf drop inside', async () => {
        must(S.head.key, 'precondition: f1 made the head heading');
        const li = `${view(ids.sola)} li.pm-node[data-kind="section"][data-key="${S.head.key}"]`;
        const child = `${li} > ul.pm-list > li.pm-node`;
        const childShown = () => probe.eval(`(() => { const c = document.querySelector(${J(child)}); return !!c && c.offsetParent !== null; })()`);
        must(await childShown(), 'precondition: head children visible');
        must(!(await exists(`${li}.pm-collapsed`)), 'precondition: not collapsed');
        const selBefore = await probe.eval(`document.querySelector('${view(ids.sola)} .pm-row.pm-selected')?.closest('li')?.dataset.key ?? null`);
        await click(`${li} > .pm-row > .pm-caret`);
        await until(() => exists(`${li}.pm-collapsed`), 3000, 'collapsed');
        must(!(await childShown()), 'children still visible');
        must((await text(`${li} > .pm-row > .pm-caret`)) === '▸', 'caret not ▸');
        must(J(await ls(`pm.collapsed.${ids.sola}`)) === J([S.head.nodeKey]), `saved ${J(await ls(`pm.collapsed.${ids.sola}`))}`);
        const selAfter = await probe.eval(`document.querySelector('${view(ids.sola)} .pm-row.pm-selected')?.closest('li')?.dataset.key ?? null`);
        must(selAfter === selBefore, 'the caret click changed the selection');
        await shot('fix1-collapsed.png');
        // keyboard/button move: the collapsed section swaps with the tail section as one unit
        await selectRow(ids.sola, S.head.key);
        const headKids = (/** @type {any} */ d) => {
            const sec = d.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section' && identOf(r.header) === S.head.id);
            return sec ? flattenSeq(sec.rows).map((e) => identOf(e.leaf)) : null;
        };
        const kids0 = headKids(await getDoc(ids.sola));
        await click(`${view(ids.sola)} .pm-move-down`);
        const dMoved = await until(async () => {
            const d = await getDoc(ids.sola);
            const secs = d.sequences[0].rows.filter((/** @type {any} */ r) => r.kind === 'section').map((/** @type {any} */ r) => identOf(r.header));
            return J(secs) === J([S.tail.id, S.head.id]) ? d : null;
        }, 8000, 'head section moved below the tail section');
        must(J(headKids(dMoved)) === J(kids0), 'the collapsed section did not move as one unit');
        await until(() => exists(`${li}.pm-collapsed`), 5000, 'still collapsed after the move');
        await click(`${view(ids.sola)} .pm-move-up`);
        await until(async () => {
            const d = await getDoc(ids.sola);
            return J(flatIds(d).filter((x) => x !== S.head.id && x !== S.tail.id)) === J(S.sola0)
                && d.sequences[0].rows.filter((/** @type {any} */ r) => r.kind === 'section').map((/** @type {any} */ r) => identOf(r.header))[0] === S.head.id;
        }, 8000, 'moved back up');
        // shelf drops: the real connectWith selector matches no list inside a collapsed section
        await click(`${view(ids.sola)} .pm-shelf-toggle`);
        const targets = await until(() => probe.eval(`(() => {
            const src = document.querySelector('${view(ids.sola)} .pm-shelf-panel ul.pm-shelf-list');
            const JQ = window.jQuery; if (!src || !JQ(src).sortable('instance')) return null;
            const sel = JQ(src).sortable('option', 'connectWith');
            const lists = JQ(sel).toArray();
            return { sel, n: lists.length, inside: lists.filter((ul) => ul.closest('li.pm-collapsed')).length,
                collapsedLists: document.querySelectorAll('${view(ids.sola)} li.pm-collapsed ul.pm-list').length };
        })()`), 8000, 'shelf panel sortable');
        await click(`${view(ids.sola)} .pm-shelf-toggle`);
        must(targets.n > 0 && targets.inside === 0 && targets.collapsedLists > 0, `drop targets ${J(targets)}`);
        // reload: still collapsed
        await reloadPage();
        await openWindow();
        await showTab('presets');
        await until(() => exists(`${view(ids.sola)} .pm-outline li.pm-node`), 10000, 'Sola view restored after reload');
        await until(() => exists(`${li}.pm-collapsed`), 5000, 'collapsed after reload');
        must(!(await childShown()), 'children visible after reload');
        return `head section collapsed (caret ▸, children hidden, saved ${S.head.nodeKey}, selection kept); moved below/above the tail section with its ${kids0?.length} children; shelf drop targets ${targets.n} lists, 0 inside the collapsed one (${targets.collapsedLists} hidden lists); collapsed after reload`;
    });

    // ------------------------------------------------------------------ f9
    await check('f9 search: count, highlights, Enter/Shift+Enter, editor follows; opens a collapsed section; Filter keeps ancestors; names match', async () => {
        const inside = S.sola0[6];
        const outside = S.sola0[1];
        const d0 = await getDoc(ids.sola);
        for (const id of [inside, outside]) {
            must((await op(ids.sola, { op: 'setContent', identifier: id, content: `${d0.blocks[id].content}\n${TOKEN} marker` })).status === 200, 'setContent failed');
        }
        const doc = await getDoc(ids.sola);
        const want = searchMatches(doc, TOKEN.toUpperCase());
        const keyOfId = (/** @type {string} */ id) => flat(doc).find((e) => identOf(e.leaf) === id).leaf.key;
        must(J(want) === J([keyOfId(outside), keyOfId(inside)]), `precondition: token matches ${J(want)}`);
        const li = `${view(ids.sola)} li.pm-node[data-kind="section"][data-key="${S.head.key}"]`;
        must(await exists(`${li}.pm-collapsed`), 'precondition: head section collapsed');
        const input = `${view(ids.sola)} .pm-search-input`;
        const count = () => text(`${view(ids.sola)} .pm-search-count`);
        await setValue(input, TOKEN.toUpperCase());
        await until(async () => (await count()) === '2 matches', 8000, 'count "2 matches"');
        const hl = await probe.eval(`[...document.querySelectorAll('${view(ids.sola)} .pm-row.pm-match')].map((r) => r.closest('li').dataset.key)`);
        must(J(hl) === J(want), `highlighted ${J(hl)}`);
        must(!(await exists(`${li}.pm-collapsed`)), 'the collapsed section with a match did not open');
        must(await probe.eval(`document.querySelector('${rowLi(ids.sola, keyOfId(inside))}').offsetParent !== null`), 'the match inside is hidden');
        must(J(await ls(`pm.collapsed.${ids.sola}`)) === J([S.head.nodeKey]), 'search overwrote the saved collapse state');
        await shot('fix1-search.png');
        await probe.eval(`document.querySelector(${J(input)}).focus()`);
        const step = async (/** @type {boolean} */ shift, /** @type {string} */ wantCount, /** @type {string} */ wantKey) => {
            await pressEnter(shift);
            await until(async () => (await count()) === wantCount
                && await exists(`${rowLi(ids.sola, wantKey)} > .pm-row.pm-selected.pm-match-current`), 5000, `${shift ? 'Shift+' : ''}Enter -> ${wantCount}`);
            const shownId = (await text(`${view(ids.sola)} .pm-editor .pm-block-identifier`))?.trim();
            const wantId = identOf(flat(doc).find((e) => e.leaf.key === wantKey).leaf);
            must(shownId === wantId, `editor shows ${shownId}, want ${wantId}`);
        };
        await step(false, '1/2', want[0]);
        await step(false, '2/2', want[1]);
        await step(true, '1/2', want[0]);
        await step(true, '2/2', want[1]); // wraps
        // Filter: matches + their ancestor headings only
        await probe.eval(`(() => { const c = document.querySelector('${view(ids.sola)} .pm-search-filter'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        const visible = await until(async () => {
            const v = await probe.eval(`[...document.querySelectorAll('${view(ids.sola)} .pm-outline li.pm-node')].filter((l) => l.offsetParent !== null).map((l) => l.dataset.key)`);
            return v.length < S.sola0.length ? v : null;
        }, 5000, 'filter applied');
        must(J([...visible].sort()) === J([...want, S.head.key].sort()), `visible ${J(visible)}; want matches + head heading`);
        must(await exists(`${view(ids.sola)} .pm-outline.pm-filtering`), 'outline not marked filtering');
        await probe.eval(`(() => { const c = document.querySelector('${view(ids.sola)} .pm-search-filter'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        // names match too
        await setValue(input, 'fix1 tail');
        const wantName = searchMatches(doc, 'fix1 tail');
        must(wantName.includes(S.tail.key), 'precondition: the tail heading matches by name');
        await until(async () => J(await probe.eval(`[...document.querySelectorAll('${view(ids.sola)} .pm-row.pm-match')].map((r) => r.closest('li').dataset.key)`)) === J(wantName), 5000, 'name match highlighted');
        // clearing restores the saved collapse
        await setValue(input, '');
        await until(async () => (await count()) === '' && await exists(`${li}.pm-collapsed`), 5000, 'search cleared, section collapsed again');
        return `"${TOKEN.toUpperCase()}" -> 2 matches ${J(want)} (content, case-insensitive); collapsed head opened for its match (saved state kept); Enter 1/2, 2/2, Shift+Enter 1/2, 2/2 (wrap), editor followed; Filter showed ${visible.length} rows = matches + head heading; name query "fix1 tail" -> ${wantName.length} match(es); cleared -> collapsed again`;
    });

    // ------------------------------------------------------------------ f8
    await check('f8 Insert ▾ → Block, Duplicate (fresh id, directly below), Delete bound to its row; a marker is refused', async () => {
        const doc0 = await getDoc(ids.sola);
        const f0 = flat(doc0);
        const anchor = f0[2];
        const src = f0[1];
        must(anchor.rank === 'item' && src.rank === 'item', 'precondition: rows 1 and 2 are plain items');
        await countOps();
        // Insert → Block above row 2
        await selectRow(ids.sola, anchor.leaf.key);
        await click(`${view(ids.sola)} .pm-insert-toggle`);
        await click(`${view(ids.sola)} .pm-insert-block`);
        const d1 = await until(async () => {
            const d = await getDoc(ids.sola);
            return Object.keys(d.blocks).length === Object.keys(doc0.blocks).length + 1 ? d : null;
        }, 8000, 'new block in the doc');
        const nb = /** @type {any} */ (Object.values(d1.blocks).find((/** @type {any} */ b) => !doc0.blocks[b.identifier]));
        const f1 = flat(d1);
        const nbIdx = f1.findIndex((e) => identOf(e.leaf) === nb.identifier);
        must(nb.name === 'New block' && nb.content === '', `new block ${J({ name: nb.name, content: nb.content })}`);
        must(identOf(f1[nbIdx + 1].leaf) === identOf(anchor.leaf), 'new block not directly above the selected row');
        const nbKey = f1[nbIdx].leaf.key;
        await until(() => exists(`${rowLi(ids.sola, nbKey)} > .pm-row.pm-selected`), 5000, 'new block selected');
        // Duplicate row 1
        await selectRow(ids.sola, src.leaf.key);
        must((await probe.eval(`document.querySelector('${view(ids.sola)} .pm-block-duplicate').getAttribute('aria-disabled')`)) === 'false', 'Duplicate not enabled for a block');
        await click(`${view(ids.sola)} .pm-block-duplicate`);
        const d2 = await until(async () => {
            const d = await getDoc(ids.sola);
            return Object.keys(d.blocks).length === Object.keys(d1.blocks).length + 1 ? d : null;
        }, 8000, 'duplicate in the doc');
        const dup = /** @type {any} */ (Object.values(d2.blocks).find((/** @type {any} */ b) => !d1.blocks[b.identifier]));
        const f2 = flat(d2);
        const srcIdx = f2.findIndex((e) => identOf(e.leaf) === identOf(src.leaf));
        const srcBlock = d2.blocks[identOf(src.leaf)];
        must(dup.identifier !== srcBlock.identifier && !d1.blocks[dup.identifier] && !(d1.markers ?? []).some((/** @type {any} */ m) => m.identifier === dup.identifier), 'duplicate identifier not fresh');
        must(dup.name === srcBlock.name && dup.content === srcBlock.content, 'duplicate differs from its source');
        must(identOf(f2[srcIdx + 1].leaf) === dup.identifier, 'duplicate is not directly below its source');
        const dupKey = f2[srcIdx + 1].leaf.key;
        await until(() => exists(`${rowLi(ids.sola, dupKey)} > .pm-row.pm-selected`), 5000, 'duplicate selected');
        // Delete: arm on the duplicate, select the new block -> disarmed; its own confirmation deletes IT
        const delBtn = `${view(ids.sola)} .pm-block-delete`;
        await click(delBtn);
        must((await text(delBtn)) === 'Confirm delete', 'first click did not arm');
        await selectRow(ids.sola, nbKey);
        must((await text(delBtn)) === 'Delete', 'selecting another row did not disarm');
        await click(delBtn);
        must((await text(delBtn)) === 'Confirm delete', 'did not arm on the new block');
        must(Object.keys((await getDoc(ids.sola)).blocks).length === Object.keys(d2.blocks).length, 'arming deleted something');
        await click(delBtn);
        const d3 = await until(async () => {
            const d = await getDoc(ids.sola);
            return !d.blocks[nb.identifier] ? d : null;
        }, 8000, 'new block deleted');
        must(!!d3.blocks[dup.identifier], 'the duplicate (armed earlier) was deleted instead');
        await selectRow(ids.sola, dupKey);
        await click(delBtn);
        await click(delBtn);
        await until(async () => !(await getDoc(ids.sola)).blocks[dup.identifier], 8000, 'duplicate deleted on its own confirmation');
        const ops = await opsSeen();
        must(J(ops) === J(['addBlock', 'copyBlock', 'deleteBlock', 'deleteBlock']), `ops posted ${J(ops)}`);
        // a marker is refused
        const marker = f0.find((e) => e.leaf.kind === 'marker');
        must(marker, 'precondition: Sola has a marker row');
        await selectRow(ids.sola, marker.leaf.key);
        const btnState = await probe.eval(`['.pm-block-duplicate', '.pm-block-delete'].map((s) => { const b = document.querySelector('${view(ids.sola)} ' + s); return { aria: b.getAttribute('aria-disabled'), cls: b.classList.contains('pm-disabled') }; })`);
        must(btnState.every((/** @type {any} */ b) => b.aria === 'true' && b.cls), `marker buttons ${J(btnState)}`);
        await clearToasts();
        const nBlocks = Object.keys((await getDoc(ids.sola)).blocks).length;
        await click(`${view(ids.sola)} .pm-block-duplicate`);
        await click(delBtn);
        await click(delBtn);
        const warn = await until(async () => { const t = await toasts('warning'); return t.length >= 2 ? t : null; }, 5000, 'marker toasts');
        must(warn.every((/** @type {string} */ t) => /Markers/.test(t)), `toasts ${J(warn)}`);
        must((await text(delBtn)) === 'Delete', 'Delete armed on a marker');
        const dM = await getDoc(ids.sola);
        must(Object.keys(dM.blocks).length === nBlocks && flatIds(dM).includes(identOf(marker.leaf)), 'the marker click changed the doc');
        const rest = await op(ids.sola, { op: 'deleteBlock', identifier: identOf(marker.leaf) });
        must(rest.status === 404, `REST deleteBlock on a marker -> ${rest.status}`);
        await clearToasts();
        return `new block ${nb.identifier} above row 2; duplicate ${dup.identifier} of ${srcBlock.identifier} directly below it; delete armed on dup, disarmed by selection, deleted the new block on its own confirmation, then the dup; ops ${J(ops)}; marker ${identOf(marker.leaf)}: aria-disabled, ${warn.length} warning toasts, REST 404`;
    });

    // ------------------------------------------------------------------ f4
    await check('f4 Diff tab side by side: a changed block renders paired lines; the toggle is remembered', async () => {
        const solaBlock = S.sola0[3];
        const demDoc = await getDoc(ids.dem);
        const demBlock = /** @type {string} */ (flatIds(demDoc).find((id) => demDoc.blocks[id]));
        must((await op(ids.sola, { op: 'setContent', identifier: solaBlock, content: 'P\nQ\nR' })).status === 200, 'setContent sola');
        must((await op(ids.dem, { op: 'setContent', identifier: demBlock, content: 'P\nQ2\nR\nS' })).status === 200, 'setContent dem');
        await showTab('library');
        await showTab('diff');
        for (const [s, pid, bid] of /** @type {const} */ ([['a', ids.sola, solaBlock], ['b', ids.dem, demBlock]])) {
            const side = `#pm-window .pm-diff-side[data-side="${s}"]`;
            await until(() => exists(`${side} .pm-diff-preset option[value="${pid}"]`), 8000, `${s}: preset listed`);
            await setValue(`${side} .pm-diff-preset`, pid, 'change');
            const want = J(Object.keys((await getDoc(pid)).blocks).sort());
            await until(async () => J((await probe.eval(`[...document.querySelectorAll('${side} .pm-diff-block option')].map((o) => o.value).filter(Boolean).sort()`))) === want, 8000, `${s}: block picker lists ${pid}'s blocks`);
            await setValue(`${side} .pm-diff-block`, bid, 'change');
        }
        await click('#pm-window .pm-diff-go');
        await until(() => exists('#pm-window .pm-diff-rows tr.pm-diff-row'), 10000, 'compare rendered');
        must((await lsRaw('pm.diff.view')) === null, 'precondition: no saved diff view');
        await probe.eval(`document.querySelector('#pm-window .pm-diff-rows tr.pm-diff-row .pm-diff-mid').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
        await until(() => exists('#pm-window .pm-diff-hunks .pm-diff-line'), 10000, 'interleaved hunks');
        const inter = await probe.eval(`[...document.querySelectorAll('#pm-window .pm-diff-hunks .pm-diff-line')].map((l) => l.textContent)`);
        await click('#pm-window .pm-diff-view-toggle [data-view="side"]');
        const pair = await probe.eval(`[...document.querySelectorAll('#pm-window .pm-diff-rows tr.pm-diff-row .pm-diff-name')].map((n) => n.textContent)`);
        must(J(pair) === J([(await getDoc(ids.sola)).blocks[solaBlock].name, demDoc.blocks[demBlock].name]), `pair row names ${J(pair)}`);
        const rows = await until(() => probe.eval(`(() => {
            const trs = [...document.querySelectorAll('#pm-window .pm-diff-hunks table.pm-diff-sbs tr.pm-sbs-row')];
            if (!trs.length) return null;
            return trs.map((tr) => [...tr.children].map((td) => td.textContent + (td.classList.contains('pm-sbs-text') ? ':' + [...td.classList].find((c) => /^pm-sbs-(ctx|del|add|empty)$/.test(c)).slice(7) : '')));
        })()`), 5000, 'side-by-side rows');
        const want = [
            ['1', 'P:ctx', '1', 'P:ctx'],
            ['2', 'Q:del', '2', 'Q2:add'],
            ['3', 'R:ctx', '3', 'R:ctx'],
            ['', ':empty', '4', 'S:add'],
        ];
        must(J(rows) === J(want), `rows ${J(rows)}`);
        must(await exists('#pm-window .pm-diff-view-toggle [data-view="side"].pm-active'), 'toggle not active');
        must((await lsRaw('pm.diff.view')) === 'side', 'toggle not remembered');
        const scrollers = await probe.eval(`[...document.querySelectorAll('#pm-window .pm-diff-bottom *')].filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)).length`);
        must(scrollers === 0, `${scrollers} inner scroll container(s) under .pm-diff-bottom`);
        await shot('fix1-diff-side.png');
        await click('#pm-window .pm-diff-view-toggle [data-view="interleaved"]');
        await until(() => exists('#pm-window .pm-diff-hunks .pm-diff-line'), 5000, 'interleaved again');
        must((await lsRaw('pm.diff.view')) === 'interleaved', 'switch back not remembered');
        await showTab('presets');
        return `interleaved ${inter.length} lines; side by side ${J(rows)}; one scroll (.pm-diff-bottom); remembered`;
    });

    // ------------------------------------------------------------------ f5 / f6
    await check('f5+f6 window rect and open tabs: move/resize, close/reopen and reload restore both; off-screen clamped; a missing id dropped', async () => {
        await showTab('presets');
        const r0 = await rectOf('#pm-window');
        const title = await rectOf('#pm-window .pm-titlebar');
        await mouseDrag({ x: title.left + 80, y: title.y }, { x: title.left + 80 - 150, y: title.y + 40 });
        const handle = await rectOf('#pm-window .ui-resizable-se');
        must(handle, 'no resize handle');
        await mouseDrag({ x: handle.x, y: handle.y }, { x: handle.x - 120, y: handle.y - 90 });
        const r1 = rect4(await rectOf('#pm-window'));
        must(Math.abs(r1.left - (r0.left - 150)) <= 2 && Math.abs(r1.top - (r0.top + 40)) <= 2, `move: ${J(rect4(r0))} -> ${J(r1)}`);
        must(Math.abs(r1.width - (r0.width - 120)) <= 3 && Math.abs(r1.height - (r0.height - 90)) <= 3, `resize: ${J(rect4(r0))} -> ${J(r1)}`);
        must(near(await ls('pm.window.rect'), r1), `saved ${J(await ls('pm.window.rect'))} != ${J(r1)}`);
        const tabs1 = await tabsState();
        must(tabs1.length === 2 && tabs1.find((/** @type {any} */ t) => t.id === ids.sola)?.active, `precondition tabs ${J(tabs1)}`);
        const tabIds = (/** @type {any[]} */ t) => J(t.map((x) => [x.id, x.active]));
        await closeWindow();
        await openWindow();
        await showTab('presets');
        const r2 = rect4(await rectOf('#pm-window'));
        const tabs2 = await until(async () => { const t = await tabsState(); return tabIds(t) === tabIds(tabs1) ? t : null; }, 8000, 'tabs after reopen');
        must(near(r2, r1), `reopen rect ${J(r2)} != ${J(r1)}`);
        await reloadPage();
        await openWindow();
        await showTab('presets');
        const r3 = rect4(await rectOf('#pm-window'));
        const tabs3 = await until(async () => { const t = await tabsState(); return tabIds(t) === tabIds(tabs1) ? t : null; }, 8000, 'tabs after reload');
        must(near(r3, r1), `reload rect ${J(r3)} != ${J(r1)}`);
        // clamp + dropped id
        await closeWindow();
        await lsSet('pm.window.rect', { left: 5000, top: 4000, width: 3000, height: 2000 });
        await lsSet('pm.presets.open', { ids: [ids.sola, 'p_gone_fix1', ids.dem], active: 'p_gone_fix1' });
        await openWindow();
        await showTab('presets');
        const vp = await viewport();
        const r4 = rect4(await rectOf('#pm-window'));
        must(r4.left >= 0 && r4.top >= 0 && r4.left + r4.width <= vp.width && r4.top + r4.height <= vp.height, `not clamped: ${J(r4)} in ${J(vp)}`);
        const tabs4 = await until(async () => {
            const t = await tabsState();
            return J(t.map((/** @type {any} */ x) => x.id)) === J([ids.sola, ids.dem]) && t[0].active ? t : null;
        }, 8000, 'tabs with the missing id dropped');
        const status = (await text(`${view(ids.sola)} .pm-status`)) ?? '';
        must(!/not found|error/i.test(status), `status shows an error: ${status}`);
        must(J((await ls('pm.presets.open')).ids) === J([ids.sola, ids.dem]), 'the dropped id is still saved');
        return `moved+resized ${J(rect4(r0))} -> ${J(r1)} (saved); reopen ${J(r2)}; reload ${J(r3)}; tabs ${tabIds(tabs3)} kept; off-screen 5000,4000 3000x2000 -> ${J(r4)}; tabs ${J(tabs4.map((/** @type {any} */ t) => t.id))} (gone id dropped, active -> the slot preset)`;
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
