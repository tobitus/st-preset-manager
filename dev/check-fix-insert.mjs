#!/usr/bin/env node
/**
 * Fix round 4 acceptance (owner review 2026-10-15, PLAN-fix-insert-fork.md)
 * as one repeatable real-browser script over raw CDP: real clicks, real
 * mouse drags, real key presses, ST's own popups; observes the plugin REST
 * API and the rendered outline.
 *
 *   node dev/check-fix-insert.mjs            all checks (resets dev data first)
 *   node dev/check-fix-insert.mjs i0 k1      only those check ids (setup always runs)
 *
 * Checks:
 *   i0  report 3 reproduction (FF): with a row of each kind selected (block,
 *       group option, group heading, section heading), Insert → Section
 *       heading lands BELOW the selection by the rules (item: next row;
 *       option/group: after the whole group; section: after the whole section)
 *   k1  Library Fork: popup default, cancel, one POST /fork, the fork opens
 *       (fresh ids, same rows), a taken name shows the server error
 *   i1  (Sola) Insert → Section heading below row 4; ONE addSection {after}
 *   i2  Insert → Block with that heading selected = the section's first row
 *   i3  Insert → Block: group heading → options[0]; last option → new last
 *       option (FF); headerless group row → joins it last (DEM)
 *   i4  section heading selected → empty sibling after the whole section;
 *       nothing selected → the end
 *   m1  (Sola fork) ↓ moves a row into an empty trailing section, Alt+↑ back
 *   m2  real mouse drag of that row past the section li → into the section
 *   g1  Insert → Group heading (name, Pick one/many) → empty headed group;
 *       Insert → Block twice adds radio options; Ctrl+Z ×3 restores
 *   g2  Make group heading on a section heading = one demote; rows stay
 *       plain below; Demote makes the first one options[0]
 *   g3  the 1/N badge flips an empty group's cardinality without a popup
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    FF, Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';
import { flattenSeq } from '../shared/outline.js';

const TAB = 'chkfi';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';
const SOLA = 'Sola V2 Flame';
const SHOTS = path.join(REPO, 'dev', 'shots');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-fix-insert.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { ff: '', dem: '', sola: '', m: '' };
/** @type {{ sola0: string[], i1Key?: string, m?: { mover: string, sec: string, seq: string } }} */
const S = { sola0: [] };

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);
const setValue = (/** @type {string} */ sel, /** @type {string} */ value, evt = 'input') => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return el.value === ${J(value)}; })()`);

const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;
const getSlot = async () => (await api('GET', '/slot')).json;
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const op = (/** @type {string} */ id, /** @type {any} */ body) => api('POST', `/presets/${id}/ops`, body);
const nameOf = (/** @type {any} */ doc, /** @type {any} */ e) => doc.blocks[identOf(e.leaf)]?.name ?? identOf(e.leaf);

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

/** Reload the ST page and wait for boot + the extension's floating button. */
async function reloadPage() {
    await probe.cdp('Page.reload', { ignoreCache: false });
    await sleep(1500);
    await until(() => probe.eval('(document.getElementById("settings_preset_openai")?.options.length ?? 0) > 1').catch(() => false), 60000, 'ST booted after reload');
    await until(() => exists('#pm-float-btn').catch(() => false), 30000, 'floating button after reload');
    await until(async () => !(await exists('#preloader')), 30000, "ST's #preloader gone");
    await dismissPopups();
}

async function openWindow() {
    if (await exists('#pm-window')) return;
    if (!(await click('#pm-float-btn'))) throw new Error('no #pm-float-btn');
    await until(() => exists('#pm-window .pm-tab[data-tab="presets"]'), 10000, 'window opened');
}

/** Open a preset in the Presets tab through the Library's Open button. */
async function openPreset(/** @type {string} */ id) {
    await openWindow();
    if (!(await exists(view(id)))) {
        await showTab('library');
        await until(() => exists(`#pm-window .pm-library-row[data-preset-id="${id}"] .pm-open`), 8000, 'library row');
        await click(`#pm-window .pm-library-row[data-preset-id="${id}"] .pm-open`);
    }
    await showTab('presets');
    await click(`#pm-window .pm-preset-tab[data-preset-id="${id}"]`);
    await until(() => exists(`${view(id)} .pm-outline li.pm-node`), 10000, 'preset view');
}

/** Fill ST's input popup (POPUP_TYPE.INPUT) and confirm; returns the default it showed. */
async function fillPopup(/** @type {string} */ value) {
    await until(() => exists('dialog[open] .popup-input'), 5000, 'input popup');
    const shown = await probe.eval(`document.querySelector('dialog[open] .popup-input').value`);
    await setValue('dialog[open] .popup-input', value);
    await click('dialog[open] .popup-button-ok');
    await until(async () => !(await exists('dialog[open]')), 5000, 'popup closed');
    return shown;
}

/** Count page POSTs to /ops (with their op names and bodies) from now on. */
const countOps = () => probe.eval(`(() => {
    window.__chkOps = [];
    window.__chkBodies = [];
    window.__chkFetch0 = window.__chkFetch0 ?? window.fetch;
    const orig = window.__chkFetch0;
    window.fetch = (...args) => {
        const url = String(args[0]?.url ?? args[0]);
        if (url.includes('/api/plugins/st-preset-manager/presets/') && (args[1]?.method ?? 'GET') === 'POST') {
            let body = {};
            try { body = JSON.parse(String(args[1]?.body ?? '{}')); } catch { body = {}; }
            if (url.endsWith('/ops')) window.__chkOps.push(body.op ?? '?');
            window.__chkBodies.push({ url: url.replace(/^.*\\/presets\\//, '/presets/'), body });
        }
        return orig(...args);
    };
    return true; })()`);
const opsSeen = () => probe.eval('window.__chkOps ?? []');
const bodiesSeen = () => probe.eval('window.__chkBodies ?? []');

async function shot(/** @type {string} */ file) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await sleep(300);
    const r = await probe.eval(`(() => { const b = document.querySelector('#pm-window').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    const out = path.join(SHOTS, file);
    fs.writeFileSync(out, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data, 'base64'));
    console.log(`[check] screenshot: ${out}`);
    return out;
}

const ONLY = process.argv.slice(2);
async function check(/** @type {string} */ name, /** @type {() => Promise<string>} */ body) {
    if (ONLY.length && !ONLY.includes(name.split(' ')[0])) return;
    try {
        report(name, true, await body());
    } catch (err) {
        report(name, false, /** @type {Error} */ (err).message);
    }
}
const must = (/** @type {any} */ cond, /** @type {string} */ msg) => { if (!cond) throw new Error(msg); };

/** Open the Insert menu and click one of its entries. */
async function insertVia(/** @type {string} */ id, /** @type {string} */ entry) {
    await click(`${view(id)} .pm-insert-toggle`);
    await until(() => exists(`${view(id)} .pm-insert-menu:not([hidden])`), 3000, 'Insert menu open');
    if (!(await click(`${view(id)} ${entry}`))) throw new Error(`no ${entry}`);
}

/** Wait for a doc whose blocks include one named `name`. */
const docWithBlock = (/** @type {string} */ id, /** @type {string} */ name) => until(async () => {
    const d = await getDoc(id);
    return Object.values(d.blocks).some((/** @type {any} */ b) => b.name === name) ? d : null;
}, 8000, `block ${name} in the doc`);

/** Flat index of the block named `name`. */
const idxOfName = (/** @type {any} */ doc, /** @type {string} */ name) => flat(doc).findIndex((e) => doc.blocks[identOf(e.leaf)]?.name === name);

/** Every group row (headed or not) of the first sequence, walking into sections. */
function groupsOf(/** @type {any} */ doc) {
    /** @type {any[]} */
    const out = [];
    const walk = (/** @type {any[]} */ rows) => {
        for (const r of rows ?? []) {
            if (r.kind === 'group') out.push(r);
            else if (r.kind === 'section') walk(r.rows);
        }
    };
    walk(doc.sequences[0].rows);
    return out;
}

/** The section row whose heading leaf key is `key` (top level of the first sequence). */
const sectionByKey = (/** @type {any} */ doc, /** @type {string} */ key) => doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section' && r.header?.key === key) ?? null;

/** Insert ▾ → Block with the current selection; waits for the doc and the new row's selection. */
async function insertBlockVia(/** @type {string} */ id) {
    const d0 = await getDoc(id);
    await insertVia(id, '.pm-insert-block');
    const d1 = await until(async () => {
        const d = await getDoc(id);
        return Object.keys(d.blocks).length === Object.keys(d0.blocks).length + 1 ? d : null;
    }, 8000, 'new block in the doc');
    const nb = /** @type {any} */ (Object.values(d1.blocks).find((/** @type {any} */ b) => !d0.blocks[b.identifier]));
    const e = flat(d1).find((x) => identOf(x.leaf) === nb.identifier);
    must(e, 'new block has no row');
    await until(() => exists(`${rowLi(id, e.leaf.key)} > .pm-row.pm-selected`), 8000, 'new block selected');
    return { d1, nb, key: e.leaf.key, entry: e };
}

/** Real mouse (CDP) press at `from`, move in steps to `to`, release. */
async function mouseDrag(/** @type {{x: number, y: number}} */ from, /** @type {{x: number, y: number}} */ to, steps = 16) {
    const m = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, extra = {}) => probe.cdp('Input.dispatchMouseEvent', { type, x, y, ...extra });
    const held = { button: 'left', buttons: 1 };
    await m('mouseMoved', from.x, from.y);
    await m('mousePressed', from.x, from.y, { ...held, clickCount: 1 });
    await sleep(120);
    for (let i = 1; i <= steps; i++) {
        await m('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, held);
        await sleep(25);
    }
    await sleep(120);
    await m('mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(150);
}

/** Real key press to the focused element. modifiers: Alt=1, Ctrl=2, Shift=8. */
async function pressKey(/** @type {string} */ key, /** @type {string} */ code, /** @type {number} */ vk, modifiers = 0) {
    await probe.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await probe.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}

/** Is the row of `key` inside the outline's visible box? */
const rowVisible = (/** @type {string} */ id, /** @type {string} */ key) => probe.eval(`(() => {
    const r = document.querySelector(${J(`${rowLi(id, key)} > .pm-row`)})?.getBoundingClientRect();
    const o = document.querySelector(${J(`${view(id)} .pm-outline`)})?.getBoundingClientRect();
    return !!r && !!o && r.top >= o.top - 1 && r.bottom <= o.bottom + 1; })()`);

const statusText = (/** @type {string} */ id) => text(`${view(id)} .pm-status`);

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
    if ((await api('POST', '/slot/load', { presetId: ids.ff })).status !== 200) fatal('setup', 'slot_load FF failed');

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
        await probe.eval(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pm.')) localStorage.removeItem(k); return true; })()`);
        await reloadPage();
        await convergedOn(ids.ff, 'FF converged in the slot');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    S.sola0 = flat(await getDoc(ids.sola)).map((e) => identOf(e.leaf));
    // m1/m2's copy of Sola, taken before i1-i4/g1-g3 insert rows into Sola
    // (i4 appends a trailing section, so a later copy has no top-level last row)
    {
        const r = await api('POST', `/presets/${ids.sola}/fork`, { name: 'Sola M' });
        if (r.status !== 201) fatal('setup', `fork Sola M ${r.status} ${r.text}`);
        ids.m = r.json.doc.id;
    }
    report('setup: reset, FF/DEM/Sola imported, FF in the slot, clean pm.* localStorage', true,
        `ff=${ids.ff} dem=${ids.dem} sola=${ids.sola}`);

    // ------------------------------------------------------------------ i0
    await check('i0 report 3: Insert → Section heading with a row of each kind selected lands BELOW the selection (item: next row; option/group heading: after the whole group; section heading: after the whole section)', async () => {
        await openPreset(ids.ff);
        const out = [];
        // a section heading to select: make one through the API
        {
            const d = await getDoc(ids.ff);
            const f = flat(d);
            const r = await op(ids.ff, { op: 'addSection', name: '== I0 Existing ==', before: f[1].leaf.key });
            must(r.status === 200, `setup addSection ${r.status} ${r.text}`);
            await until(async () => (await probe.eval(`document.querySelectorAll(${J(view(ids.ff) + ' li.pm-node[data-kind="section"]')}).length`)) > 0, 8000, 'section rendered');
        }
        const kinds = /** @type {const} */ (['item', 'option', 'group', 'section']);
        let n = 0;
        for (const kind of kinds) {
            const d0 = await getDoc(ids.ff);
            const f0 = flat(d0);
            // the first row of that kind that is not near the end
            const sel = f0.findIndex((e, i) => e.rank === kind && e.leaf.kind === 'block' && i > 0 && i < f0.length - 6);
            must(sel !== -1, `no ${kind} row`);
            const selKey = f0[sel].leaf.key;
            const label = `I0 ${kind}`;
            await countOps();
            await selectRow(ids.ff, selKey);
            await insertVia(ids.ff, '.pm-insert-section');
            await fillPopup(label);
            const d1 = await docWithBlock(ids.ff, `== ${label} ==`);
            const f1 = flat(d1);
            const at = idxOfName(d1, `== ${label} ==`);
            const selAt = f1.findIndex((e) => e.leaf.key === selKey);
            const bodies = await bodiesSeen();
            const newKey = f1[at]?.leaf.key;
            await until(() => exists(rowLi(ids.ff, newKey)), 8000, 'new heading rendered');
            await sleep(1500);
            const dom = await probe.eval(`(() => { const ks = [...document.querySelectorAll(${J(view(ids.ff) + ' li.pm-node')})].map((l) => l.dataset.key);
                return { at: ks.indexOf(${J(newKey)}), sel: ks.indexOf(${J(selKey)}), n: ks.length,
                  selected: document.querySelector(${J(view(ids.ff) + ' .pm-row.pm-selected')})?.closest('li')?.dataset.key ?? null }; })()`);
            const dLater = await getDoc(ids.ff);
            await shot(`fix-insert-i0-${kind}.png`);
            n++;
            out.push({ kind, selected: `${sel}:${nameOf(d0, f0[sel]).slice(0, 24)}`, sent: bodies.map((/** @type {any} */ b) => b.body), landed: at, selNow: selAt, last: f1.length - 1, rank: f1[at]?.rank,
                betweenRanks: at > selAt ? f1.slice(selAt + 1, at).map((e) => e.rank) : [], nextRank: f1[at + 1]?.rank ?? null,
                dom, laterAt: idxOfName(dLater, `== ${label} ==`), revs: [d0.rev, d1.rev, dLater.rev] });
        }
        console.log(`[i0] ${J(out)}`);
        // re-check each landing against the doc state right after its insert
        const bad = out.filter((o) => {
            if (o.rank !== 'section') return true;
            if (o.kind === 'item') return o.landed !== o.selNow + 1;
            if (o.landed <= o.selNow) return true;
            const between = o.betweenRanks;
            if (o.kind === 'option' || o.kind === 'group') return !between.every((/** @type {string} */ r) => r === 'option') || o.nextRank === 'option';
            return between.includes('section') || (o.nextRank !== null && o.nextRank !== 'section');
        });
        must(bad.length === 0, `not below the selection by the rules: ${J(bad)}`);
        return J(out);
    });

    // ------------------------------------------------------------------ k1
    await check('k1 Library Fork: popup defaults to "<name> fork"; cancel posts nothing; OK posts ONE fork and opens it (fresh ids, same rows); a taken name shows the server error', async () => {
        await openWindow();
        await showTab('library');
        const rowSel = `#pm-window .pm-library-row[data-preset-id="${ids.ff}"]`;
        await until(() => exists(`${rowSel} .pm-fork`), 8000, 'Fork button on the FF row');
        const lib0 = (await api('GET', '/library')).json ?? [];
        const want = `${lib0.find((/** @type {any} */ e) => e.id === ids.ff)?.name} fork`;
        await countOps();
        // cancel: nothing posted
        await click(`${rowSel} .pm-fork`);
        await until(() => exists('dialog[open] .popup-input'), 5000, 'fork popup');
        await click('dialog[open] .popup-button-cancel');
        await until(async () => !(await exists('dialog[open]')), 5000, 'popup closed');
        await sleep(800);
        must((await bodiesSeen()).length === 0, `cancel posted ${J(await bodiesSeen())}`);
        // OK on the default name
        await click(`${rowSel} .pm-fork`);
        const shown = await fillPopup(want);
        must(shown === want, `popup default ${J(shown)}, want ${J(want)}`);
        const lib1 = await until(async () => {
            const l = (await api('GET', '/library')).json ?? [];
            return l.length === lib0.length + 1 ? l : null;
        }, 8000, 'library gained the fork');
        const item = lib1.find((/** @type {any} */ e) => e.name === want);
        must(item, `no library item named ${J(want)}`);
        await until(() => exists('#pm-window .pm-pane[data-pane="presets"]:not([hidden])'), 8000, 'Presets tab active');
        await until(() => exists(`#pm-window .pm-preset-tabs .pm-preset-tab[data-preset-id="${item.id}"]`), 8000, 'the fork has a preset tab');
        await until(() => exists(`${view(item.id)} .pm-outline li.pm-node`), 10000, 'the fork is shown');
        const src = await getDoc(ids.ff);
        const fk = await getDoc(item.id);
        must(fk.source?.forkedFrom === ids.ff, `forkedFrom ${J(fk.source?.forkedFrom)}`);
        const fkIds = Object.keys(fk.blocks);
        must(fkIds.length === Object.keys(src.blocks).length, `blocks ${fkIds.length} vs ${Object.keys(src.blocks).length}`);
        // ST's fixed system prompts keep their identifiers (ST re-adds a missing one); every other block is re-minted
        const SYSTEM = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'];
        const kept = fkIds.filter((k) => src.blocks[k]);
        must(J(kept.sort()) === J(Object.keys(src.blocks).filter((k) => SYSTEM.includes(k)).sort()), `identifiers kept from the source: ${J(kept)}`);
        must(flat(fk).length === flat(src).length, `rows ${flat(fk).length} vs ${flat(src).length}`);
        const forks = (await bodiesSeen()).filter((/** @type {any} */ b) => b.url.endsWith('/fork'));
        must(forks.length === 1 && forks[0].url === `/presets/${ids.ff}/fork` && forks[0].body.name === want, `fork posts ${J(forks)}`);
        await shot('fix-insert-k1-forked.png');
        // the fork loads into ST and converges (no re-added default prompts, no endless apply)
        await showTab('library');
        await click(`#pm-window .pm-library-row[data-preset-id="${item.id}"] .pm-load`);
        const c = await convergedOn(item.id, 'the fork converged in ST');
        const extra = await probe.eval(`SillyTavern.getContext().chatCompletionSettings.prompts.map((p) => p.identifier).filter((i) => !${J(c.slot.compiled.prompts.map((/** @type {any} */ p) => p.identifier))}.includes(i))`);
        must(extra.length === 0, `ST shows prompts the fork's compile lacks: ${J(extra)}`);
        // the same name again: the server's 409 text atop the library
        await showTab('library');
        await click(`${rowSel} .pm-fork`);
        await fillPopup(want);
        const err = await until(async () => {
            const t = await text('#pm-window .pm-library-list > .pm-error');
            return t && /already taken/.test(t) ? t : null;
        }, 8000, '"already taken" error in the library');
        const lib2 = (await api('GET', '/library')).json ?? [];
        must(lib2.length === lib1.length, `library ${lib1.length} -> ${lib2.length}`);
        await shot('fix-insert-k1-taken.png');
        return `fork ${item.id} "${want}" opened; ${fkIds.length - kept.length} re-minted + kept ${J(kept)}, ${flat(fk).length} rows; loads and converges; error "${err.trim()}"`;
    });

    // ------------------------------------------------------------------ i1
    await check('i1 Insert → Section heading with row 4 selected: heading at index 5, rows 5..end its children; ONE addSection {after: row 4}; the heading selected and in view', async () => {
        await openPreset(ids.sola);
        const d0 = await getDoc(ids.sola);
        const f0 = flat(d0);
        must(J(f0.map((e) => identOf(e.leaf))) === J(S.sola0), 'precondition: Sola unchanged');
        const anchor = f0[4].leaf.key;
        await countOps();
        await selectRow(ids.sola, anchor);
        await insertVia(ids.sola, '.pm-insert-section');
        await fillPopup('I1 Below');
        const d1 = await docWithBlock(ids.sola, '== I1 Below ==');
        const f1 = flat(d1);
        const at = idxOfName(d1, '== I1 Below ==');
        must(at === 5 && f1[at].rank === 'section', `heading at ${at} rank ${f1[at]?.rank}, want 5 / section`);
        const key = f1[at].leaf.key;
        const kids = flattenSeq(sectionByKey(d1, key)?.rows ?? []).map((e) => identOf(e.leaf));
        must(J(kids) === J(S.sola0.slice(5)), `children ${kids.length}, want rows 5..end (${S.sola0.length - 5})`);
        const ops = await opsSeen();
        must(J(ops) === J(['addSection']), `ops ${J(ops)}`);
        const body = (await bodiesSeen())[0]?.body;
        must(body?.after === anchor && body?.before === undefined, `body ${J(body)}`);
        await until(() => exists(`${rowLi(ids.sola, key)} > .pm-row.pm-selected`), 8000, 'new heading selected');
        await until(() => rowVisible(ids.sola, key), 5000, 'new heading in view');
        S.i1Key = key;
        await shot('fix-insert-i1.png');
        return `heading ${key} at 5 with ${kids.length} children; body ${J(body)}`;
    });

    // ------------------------------------------------------------------ i2
    await check("i2 with the new section heading selected, Insert → Block: the block is the section's first row; ONE addBlock {after: heading}", async () => {
        must(S.i1Key, 'precondition: i1 made the heading');
        await openPreset(ids.sola);
        await selectRow(ids.sola, S.i1Key);
        await countOps();
        const r = await insertBlockVia(ids.sola);
        const first = flattenSeq(sectionByKey(r.d1, S.i1Key)?.rows ?? [])[0];
        must(first && identOf(first.leaf) === r.nb.identifier && r.entry.rank === 'item', `section's first row ${first && identOf(first.leaf)} rank ${r.entry.rank}`);
        const ops = await opsSeen();
        must(J(ops) === J(['addBlock']), `ops ${J(ops)}`);
        const body = (await bodiesSeen())[0]?.body;
        must(body?.after === S.i1Key, `body ${J(body)}`);
        must(await exists(`${rowLi(ids.sola, S.i1Key)} > ul.pm-list > li.pm-node:first-child[data-key="${r.key}"]`), 'the block li is not the first child of the section li');
        await shot('fix-insert-i2.png');
        return `block ${r.nb.identifier} is the first row of the section; body ${J(body)}`;
    });

    // ------------------------------------------------------------------ i3
    await check('i3 Insert → Block on a group heading → its first option; on the last option → a new last option; on a headerless group row → joins it last', async () => {
        await openPreset(ids.ff);
        const d0 = await getDoc(ids.ff);
        const g = groupsOf(d0).find((x) => x.header && x.options.length >= 2);
        must(g, 'no headed group in FF');
        await countOps();
        await selectRow(ids.ff, g.header.key);
        const a = await insertBlockVia(ids.ff);
        const g1 = groupsOf(a.d1).find((x) => x.key === g.key);
        must(g1 && identOf(g1.options[0]) === a.nb.identifier && a.entry.rank === 'option', `options[0] ${g1 && identOf(g1.options[0])} rank ${a.entry.rank}`);
        const lastKey = g1.options.at(-1).key;
        await selectRow(ids.ff, lastKey);
        const b = await insertBlockVia(ids.ff);
        const g2 = groupsOf(b.d1).find((x) => x.key === g.key);
        must(g2 && g2.options.length === g.options.length + 2 && identOf(g2.options.at(-1)) === b.nb.identifier, `last option ${g2 && identOf(g2.options.at(-1))}, ${g2?.options.length} options`);
        must(await exists(`${rowLi(ids.ff, g.header.key)} > ul.pm-list > li.pm-node:last-child[data-key="${b.key}"]`), 'the new option li is not last in the group');
        const ops = await opsSeen();
        const afters = (await bodiesSeen()).map((/** @type {any} */ x) => x.body.after);
        must(J(ops) === J(['addBlock', 'addBlock']) && J(afters) === J([g.header.key, lastKey]), `ops ${J(ops)} afters ${J(afters)}`);
        await shot('fix-insert-i3-headed.png');
        // a headerless group row (DEM): the UI resolves it to the last option
        await openPreset(ids.dem);
        const e0 = await getDoc(ids.dem);
        const h = groupsOf(e0).find((x) => !x.header && x.options.length >= 2);
        must(h, 'no headerless group in DEM');
        await countOps();
        await selectRow(ids.dem, h.key);
        const c = await insertBlockVia(ids.dem);
        const h1 = groupsOf(c.d1).find((x) => x.options.some((/** @type {any} */ o) => identOf(o) === c.nb.identifier));
        must(h1 && h1.options.length === h.options.length + 1 && identOf(h1.options[0]) === identOf(h.options[0]) && identOf(h1.options.at(-1)) === c.nb.identifier,
            `headerless: ${h1 ? h1.options.map(identOf).join(',') : 'not in a group'}`);
        const hb = (await bodiesSeen())[0]?.body;
        must(hb?.after === h.options.at(-1).key, `headerless body ${J(hb)}`);
        await shot('fix-insert-i3-headerless.png');
        return `headed: options[0] then last; headerless ${h.key}: joined last (after ${hb.after})`;
    });

    // ------------------------------------------------------------------ i4
    await check('i4 Insert → Section heading on a section heading → an empty sibling section right after that whole section; with nothing selected → the end', async () => {
        must(S.i1Key, 'precondition: i1 made the heading');
        await openPreset(ids.sola);
        const f0 = flat(await getDoc(ids.sola));
        const nextAnchor = f0.find((e) => identOf(e.leaf) === S.sola0[40]);
        must(nextAnchor, 'precondition: Sola row 40');
        const rs = await op(ids.sola, { op: 'addSection', name: '== I4 Next ==', before: nextAnchor.leaf.key });
        must(rs.status === 200, `setup addSection ${rs.status}`);
        const d1 = await getDoc(ids.sola);
        const nextKey = flat(d1)[idxOfName(d1, '== I4 Next ==')].leaf.key;
        await until(() => exists(rowLi(ids.sola, nextKey)), 8000, 'I4 Next rendered');
        const i1Rows = J(sectionByKey(d1, S.i1Key)?.rows);
        await countOps();
        await selectRow(ids.sola, S.i1Key);
        await insertVia(ids.sola, '.pm-insert-section');
        await fillPopup('I4 Sibling');
        const d2 = await docWithBlock(ids.sola, '== I4 Sibling ==');
        const f2 = flat(d2);
        const at = idxOfName(d2, '== I4 Sibling ==');
        must(f2[at].rank === 'section' && f2[at + 1]?.leaf.key === nextKey, `sibling at ${at}; next row ${nameOf(d2, f2[at + 1])}, want I4 Next`);
        must(J(sectionByKey(d2, S.i1Key)?.rows) === i1Rows, 'the selected section lost or gained rows');
        must(sectionByKey(d2, f2[at].leaf.key)?.rows.length === 0, 'the new section is not empty');
        const body = (await bodiesSeen())[0]?.body;
        must(body?.after === S.i1Key, `body ${J(body)}`);
        // nothing selected (a fresh page): the end
        await reloadPage();
        await openPreset(ids.sola);
        must(!(await exists(`${view(ids.sola)} .pm-row.pm-selected`)), 'precondition: no row selected after reload');
        await countOps();
        await insertVia(ids.sola, '.pm-insert-section');
        await fillPopup('I4 End');
        const d3 = await docWithBlock(ids.sola, '== I4 End ==');
        must(idxOfName(d3, '== I4 End ==') === flat(d3).length - 1, 'with nothing selected the heading is not last');
        const b2 = (await bodiesSeen())[0]?.body;
        must(b2 && b2.after === null, `no-selection body ${J(b2)}`);
        await shot('fix-insert-i4.png');
        return `sibling directly above I4 Next, empty; no selection -> end; bodies ${J(body)} ${J(b2)}`;
    });

    // ------------------------------------------------------------------ m1
    await check('m1 ↓ moves the row above an empty trailing section into it (ONE moveLeaf); Alt+↑ moves it back out byte-identically; ST converges each time', async () => {
        must((await api('POST', '/slot/load', { presetId: ids.m })).status === 200, 'slot_load Sola M');
        await convergedOn(ids.m, 'Sola M in the slot');
        await openPreset(ids.m);
        const mover = flat(await getDoc(ids.m)).at(-1);
        must(mover && mover.rank === 'item' && !mover.sname, 'precondition: the last row is a top-level item');
        await selectRow(ids.m, mover.leaf.key);
        await insertVia(ids.m, '.pm-insert-section');
        await fillPopup('M1 Empty');
        const d1 = await docWithBlock(ids.m, '== M1 Empty ==');
        const f1 = flat(d1);
        const sec = f1.at(-1);
        must(sec?.rank === 'section' && f1.at(-2)?.leaf.key === mover.leaf.key, 'precondition: an empty trailing section directly below the row');
        S.m = { mover: mover.leaf.key, sec: sec.leaf.key, seq: J(d1.sequences) };
        await convergedOn(ids.m, 'converged after the insert');
        await selectRow(ids.m, mover.leaf.key);
        await countOps();
        await click(`${view(ids.m)} .pm-move-down`);
        const inside = `${rowLi(ids.m, sec.leaf.key)} > ul.pm-list > li.pm-node[data-key="${mover.leaf.key}"]`;
        await until(() => exists(inside), 8000, 'the row is inside the section');
        const d2 = await getDoc(ids.m);
        const kids = flattenSeq(sectionByKey(d2, sec.leaf.key)?.rows ?? []).map((e) => e.leaf.key);
        must(J(kids) === J([mover.leaf.key]), `section rows ${J(kids)}`);
        const b1 = await bodiesSeen();
        must(J(await opsSeen()) === J(['moveLeaf']) && b1[0].body.delta === 1, `posted ${J(b1)}`);
        await until(converged, 20000, 'ST converged after ↓');
        await shot('fix-insert-m1-inside.png');
        await probe.eval(`document.querySelector(${J(`${view(ids.m)} .pm-outline`)}).focus()`);
        await pressKey('ArrowUp', 'ArrowUp', 38, 1);
        await until(async () => J((await getDoc(ids.m)).sequences) === S.m.seq, 8000, 'Alt+↑ restored the outline');
        await until(async () => !(await exists(inside)), 8000, 'the row left the section li');
        const b2 = await bodiesSeen();
        must(J(await opsSeen()) === J(['moveLeaf', 'moveLeaf']) && b2[1].body.delta === -1, `posted ${J(b2)}`);
        await until(converged, 20000, 'ST converged after Alt+↑');
        return `↓ -> section rows ${J(kids)}; Alt+↑ -> sequences identical; bodies ${J(b2.map((/** @type {any} */ x) => x.body))}`;
    });

    // ------------------------------------------------------------------ m2
    await check('m2 real mouse drag of that row past the empty section li (same list) → ONE moveLeaf {delta: 1}: the row is inside the section', async () => {
        must(ids.m && S.m, 'precondition: m1');
        await countOps();
        const geo = await probe.eval(`(() => {
            const li = document.querySelector(${J(rowLi(ids.m, S.m.mover))});
            const sec = document.querySelector(${J(rowLi(ids.m, S.m.sec))});
            if (!li || !sec) return null;
            li.scrollIntoView({ block: 'center' });
            const h = li.querySelector(':scope > .pm-row > .pm-drag-handle').getBoundingClientRect();
            const s = sec.getBoundingClientRect();
            return { from: { x: h.x + h.width / 2, y: h.y + h.height / 2 }, toY: h.y + h.height / 2 + s.height };
        })()`);
        must(geo, 'no mover / section li');
        await mouseDrag(geo.from, { x: geo.from.x, y: geo.toY });
        const inside = `${rowLi(ids.m, S.m.sec)} > ul.pm-list > li.pm-node[data-key="${S.m.mover}"]`;
        await until(() => exists(inside), 8000, 'the dragged row is inside the section');
        const b = await bodiesSeen();
        must(J(await opsSeen()) === J(['moveLeaf']) && b[0].body.delta === 1 && b[0].body.key === S.m.mover, `posted ${J(b)}`);
        await until(converged, 20000, 'ST converged after the drag');
        await shot('fix-insert-m2-dragged.png');
        return `drag posted ${J(b[0].body)}`;
    });

    // ------------------------------------------------------------------ g1
    await check('g1 Insert → Group heading: name + Pick one/Pick many popup; ONE addGroup {after: row}; an empty headed group, badge 1, selected; Insert → Block twice adds two radio options; Ctrl+Z ×3 removes it all', async () => {
        await openPreset(ids.sola);
        const d0 = await getDoc(ids.sola);
        const anchor = flat(d0)[2];
        must(anchor.rank === 'item', 'precondition: Sola row 2 is a plain row');
        await countOps();
        await selectRow(ids.sola, anchor.leaf.key);
        await insertVia(ids.sola, '.pm-insert-group');
        await until(() => exists('dialog[open] .pm-addgrp-form'), 5000, 'Group heading popup');
        const shown = await probe.eval(`document.querySelector('dialog[open] .pm-addgrp-name')?.value ?? null`);
        must(shown === 'New group', `name default ${J(shown)}`);
        const card0 = await probe.eval(`document.querySelector('dialog[open] input[name="pm-addgrp-card"]:checked')?.value ?? null`);
        must(card0 === 'pick-one', `cardinality default ${J(card0)}`);
        await setValue('dialog[open] .pm-addgrp-name', 'Fix4 Pick');
        await click('dialog[open] .popup-button-ok');
        await until(async () => !(await exists('dialog[open]')), 5000, 'popup closed');
        const d1 = await docWithBlock(ids.sola, 'Fix4 Pick');
        const g = groupsOf(d1).find((x) => x.header && d1.blocks[identOf(x.header)]?.name === 'Fix4 Pick');
        must(g && g.options.length === 0 && g.cardinality === 'pick-one', `group ${J(g && { options: g.options.length, cardinality: g.cardinality })}`);
        must(d1.rev === d0.rev + 1, `rev ${d0.rev} -> ${d1.rev}`);
        const f1 = flat(d1);
        const at = f1.findIndex((e) => e.leaf.key === g.header.key);
        must(f1[at - 1]?.leaf.key === anchor.leaf.key, 'the group heading is not directly below the selected row');
        const hid = identOf(g.header);
        must(d1.blocks[hid].content === '' && d1.loadouts[d1.activeLoadoutId].enabled[hid] === true, 'heading not empty / not ON');
        const body = (await bodiesSeen())[0]?.body;
        must(J(await opsSeen()) === J(['addGroup']) && body?.after === anchor.leaf.key && body?.name === 'Fix4 Pick' && body?.cardinality === 'pick-one', `posted ${J(body)}`);
        const gli = `${view(ids.sola)} li.pm-node[data-kind="group"][data-key="${g.header.key}"]`;
        await until(() => exists(`${gli} > .pm-row.pm-selected`), 8000, 'the group heading is rendered and selected');
        must((await text(`${gli} > .pm-row > .pm-card`))?.trim() === '1', 'badge is not 1');
        must((await probe.eval(`document.querySelectorAll(${J(`${gli} > ul.pm-list > li.pm-node`)}).length`)) === 0, 'the new group has rows');
        await shot('fix-insert-g1-empty.png');
        const a = await insertBlockVia(ids.sola);
        const b = await insertBlockVia(ids.sola);
        const g2 = groupsOf(b.d1).find((x) => x.key === g.key);
        must(g2 && J(g2.options.map(identOf)) === J([a.nb.identifier, b.nb.identifier]), `options ${g2 && J(g2.options.map(identOf))}`);
        const types = await probe.eval(`[...document.querySelectorAll(${J(`${gli} > ul.pm-list > li.pm-node .pm-switch`)})].map((el) => el.type)`);
        must(J(types) === J(['radio', 'radio']), `option switches ${J(types)}`);
        must(J(await opsSeen()) === J(['addGroup', 'addBlock', 'addBlock']), `ops ${J(await opsSeen())}`);
        await shot('fix-insert-g1-options.png');
        await probe.eval(`document.querySelector(${J(`${view(ids.sola)} .pm-outline`)}).focus()`);
        const n0 = Object.keys(d0.blocks).length;
        for (const n of [n0 + 2, n0 + 1, n0]) {
            await pressKey('z', 'KeyZ', 90, 2);
            await until(async () => Object.keys((await getDoc(ids.sola)).blocks).length === n, 8000, `Ctrl+Z to ${n} blocks`);
        }
        const d3 = await getDoc(ids.sola);
        must(J(d3.sequences) === J(d0.sequences), 'Ctrl+Z ×3 did not restore the outline');
        await until(async () => !(await exists(gli)), 8000, 'group li gone');
        return `group ${g.key} below row 2, 0 -> 2 radio options; Ctrl+Z ×3 restored`;
    });

    // ------------------------------------------------------------------ g2
    const MAKE_GROUP_ON_SECTION = 'Turn the section heading into a group heading; its rows stay below it as plain rows — select them and Demote to make them options';
    await check('g2 Make group heading on a section heading: enabled with its title; ONE demote; a group heading with its former rows as plain rows below; Demote on the first makes it options[0]', async () => {
        await openPreset(ids.sola);
        const f0 = flat(await getDoc(ids.sola));
        const keyOf = (/** @type {number} */ i) => f0.find((e) => identOf(e.leaf) === S.sola0[i])?.leaf.key;
        for (const [name, i] of /** @type {const} */ ([['== G2 Sec ==', 20], ['== G2 After ==', 24]])) {
            const r = await op(ids.sola, { op: 'addSection', name, before: keyOf(i) });
            must(r.status === 200, `setup addSection ${name} ${r.status}`);
        }
        const d1 = await getDoc(ids.sola);
        const hKey = flat(d1)[idxOfName(d1, '== G2 Sec ==')].leaf.key;
        must(J(flattenSeq(sectionByKey(d1, hKey)?.rows ?? []).map((e) => identOf(e.leaf))) === J(S.sola0.slice(20, 24)), 'precondition: G2 Sec holds rows 20..23');
        await until(() => exists(rowLi(ids.sola, hKey)), 8000, 'G2 Sec rendered');
        await selectRow(ids.sola, hKey);
        const btn = `${view(ids.sola)} .pm-rank-make-group`;
        const state = await probe.eval(`(() => { const b = document.querySelector(${J(btn)}); return { aria: b.getAttribute('aria-disabled'), title: b.title, label: b.textContent }; })()`);
        must(state.aria === 'false' && state.title === MAKE_GROUP_ON_SECTION, `button ${J(state)}`);
        await countOps();
        await click(btn);
        const d2 = await until(async () => {
            const d = await getDoc(ids.sola);
            return flat(d).find((e) => e.leaf.key === hKey)?.rank === 'group' ? d : null;
        }, 8000, 'the heading is a group heading');
        must(J(await opsSeen()) === J(['demote']), `ops ${J(await opsSeen())}`);
        const f2 = flat(d2);
        const at = f2.findIndex((e) => e.leaf.key === hKey);
        const after = f2.slice(at + 1, at + 5);
        must(J(after.map((e) => identOf(e.leaf))) === J(S.sola0.slice(20, 24)) && after.every((e) => e.rank === 'item'), `rows below ${J(after.map((e) => [identOf(e.leaf), e.rank]))}`);
        const g = groupsOf(d2).find((x) => x.header?.key === hKey);
        must(g && g.options.length === 0, 'the group has options');
        await until(() => exists(`${view(ids.sola)} li.pm-node[data-kind="group"][data-key="${hKey}"]`), 8000, 'group li rendered');
        const status = await statusText(ids.sola);
        must(/Demote to make them options/.test(status ?? ''), `status ${J(status)}`);
        await shot('fix-insert-g2-group.png');
        const firstKey = after[0].leaf.key;
        await selectRow(ids.sola, firstKey);
        await click(`${view(ids.sola)} .pm-rank-demote`);
        const d3 = await until(async () => {
            const d = await getDoc(ids.sola);
            const gg = groupsOf(d).find((x) => x.header?.key === hKey);
            return gg?.options[0]?.key === firstKey ? d : null;
        }, 8000, 'Demote made the first row options[0]');
        must(J(await opsSeen()) === J(['demote', 'demote']), `ops ${J(await opsSeen())}`);
        await shot('fix-insert-g2-option.png');
        return `section ${hKey} -> group; rows 20..23 plain below; status "${status}"; row 20 -> options[0] (rev ${d3.rev})`;
    });

    // ------------------------------------------------------------------ g3
    await check('g3 the 1/N badge on an empty group flips cardinality with no popup', async () => {
        await openPreset(ids.sola);
        const anchor = flat(await getDoc(ids.sola))[1];
        const r = await op(ids.sola, { op: 'addGroup', name: 'G3 Empty', cardinality: 'pick-one-or-more', after: anchor.leaf.key });
        must(r.status === 200, `setup addGroup ${r.status} ${r.text}`);
        const d1 = await getDoc(ids.sola);
        const g = groupsOf(d1).find((x) => x.header && d1.blocks[identOf(x.header)]?.name === 'G3 Empty');
        must(g && g.options.length === 0, 'precondition: an empty group');
        const gli = `${view(ids.sola)} li.pm-node[data-kind="group"][data-key="${g.header.key}"]`;
        const badge = `${gli} > .pm-row > .pm-card`;
        await until(async () => (await text(badge))?.trim() === 'N', 8000, 'badge N');
        await countOps();
        await click(badge);
        await until(async () => (await text(badge))?.trim() === '1', 8000, 'badge flipped to 1');
        must(!(await exists('dialog[open]')), 'a popup opened');
        must(groupsOf(await getDoc(ids.sola)).find((x) => x.key === g.key)?.cardinality === 'pick-one', 'doc not pick-one');
        await click(badge);
        await until(async () => (await text(badge))?.trim() === 'N', 8000, 'badge flipped back to N');
        must(!(await exists('dialog[open]')), 'a popup opened');
        must(J(await opsSeen()) === J(['setCardinality', 'setCardinality']), `ops ${J(await opsSeen())}`);
        return 'N -> 1 -> N, no popup';
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
