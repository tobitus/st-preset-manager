#!/usr/bin/env node
/**
 * Group cardinality toggle acceptance: the `1`/`N` badge on every group row is
 * a click control that flips the group between pick-one and pick-one-or-more
 * (doc op setCardinality). Switching TO pick-one is refused (HTTP 409) while
 * 2+ members are on; the UI shows the server's text in an ST popup and
 * nothing is switched off. Drives the ACTUAL v2 window in a headless Chromium
 * over raw CDP (real mouse clicks) and observes the plugin REST API.
 *
 *   node dev/check-cardinality.mjs               all checks (resets dev data first)
 *   CHK_SKIP=c3 node dev/check-cardinality.mjs   skip checks by id (diagnosis only)
 *
 * Checks:
 *   c1 headed group round trip: N -> 1 -> N by real badge clicks; exactly one
 *      setCardinality op per click, options become radios (with a "none"
 *      label) and back to checkboxes, stored cardinality follows, no loadout
 *      enabled/overrides change, no popup
 *   c2 headerless group: the same round trip; the badge click never selects
 *      the row
 *   c3 refusal: with two options on, the click to pick-one posts exactly one
 *      setCardinality op, an ST popup shows "more than one option currently
 *      selected", the doc/loadouts are byte-identical and both options stay on
 *   c4 selection untouched: a badge click does not change the selected row(s)
 *      and does not select the group row
 * Screenshot (dev/shots/): cardinality-refusal.png.
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
import { flattenSeq } from '../shared/outline.js';

const TAB = 'chkcard';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';
const SOLA = 'Sola V2 Flame';
const SHOTS = path.join(REPO, 'dev', 'shots');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-cardinality.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { ff: '', dem: '', sola: '' };
/** state carried between checks */
const S = {
    /** @type {string[]} */ sola0: [], // Sola's flat identifiers before any edit
    /** @type {string[]} */ sola0Keys: [],
};

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);

const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const flatIds = (/** @type {any} */ doc) => flat(doc).map((e) => identOf(e.leaf));
const op = (/** @type {string} */ id, /** @type {any} */ body) => api('POST', `/presets/${id}/ops`, body);

/** Read Sola's current doc over REST. */
const docNow = () => getDoc(ids.sola);

/** Depth-first search of `doc.sequences[0].rows` for a group row whose `header` refs `id`. */
function findGroup(/** @type {any[]} */ rows, /** @type {string} */ id) {
    for (const r of rows) {
        if (r.kind === 'group' && r.header && identOf(r.header) === id) return r;
        if (r.kind === 'section') {
            const found = findGroup(r.rows, id);
            if (found) return found;
        }
    }
    return null;
}
const grpOf = (/** @type {any} */ doc, /** @type {string} */ id) => findGroup(doc.sequences[0].rows, id);

/** Depth-first search for the headerless group having `id` as an option. */
function findHeaderless(/** @type {any[]} */ rows, /** @type {string} */ id) {
    for (const r of rows) {
        if (r.kind === 'group' && !r.header && (r.options ?? []).some((/** @type {any} */ o) => identOf(o) === id)) return r;
        if (r.kind === 'section') {
            const found = findHeaderless(r.rows, id);
            if (found) return found;
        }
    }
    return null;
}
const hlessOf = (/** @type {any} */ doc, /** @type {string} */ id) => findHeaderless(doc.sequences[0].rows, id);

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
const rowLi = (/** @type {string} */ id, /** @type {string} */ key) => `${view(id)} li.pm-node[data-key="${key}"]`;

/** Click a row's name (scrolled into view) and wait until it is the selected row. */
async function selectRow(/** @type {string} */ id, /** @type {string} */ key) {
    const nameSel = `${rowLi(id, key)} > .pm-row .pm-name`;
    await probe.eval(`document.querySelector(${J(nameSel)})?.scrollIntoView({ block: 'center' })`);
    if (!(await click(nameSel))) throw new Error(`no row ${key}`);
    await until(() => exists(`${rowLi(id, key)} > .pm-row.pm-selected`), 5000, `row ${key} selected`);
}

/** Real mouse click at a point. */
async function mouseClick(/** @type {{x: number, y: number}} */ p) {
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
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

// ------------------------------------------------------------------ check helpers

/** The cardinality badge of the group `li` selector. */
const badge = (/** @type {string} */ sel) => `${sel} > .pm-row > .pm-card`;
const badgeText = async (/** @type {string} */ sel) => (await text(badge(sel)))?.trim() ?? null;

/** Real mouse click on a group's badge (exercises the row's sortable mousedown). */
async function clickBadge(/** @type {string} */ liSel) {
    const sel = badge(liSel);
    await probe.eval(`document.querySelector(${J(sel)})?.scrollIntoView({ block: 'center' })`);
    const r = await rectOf(sel);
    if (!r) throw new Error(`no badge ${sel}`);
    await mouseClick({ x: r.x, y: r.y });
}

/** Every loadout's enabled map and overrides, as one comparable string. */
const enabledState = (/** @type {any} */ doc) => JSON.stringify(Object.values(doc.loadouts).map((/** @type {any} */ l) => [l.id, l.enabled, l.overrides]));

/** REST toggle of one block in the active loadout. */
async function setOn(/** @type {string} */ id, /** @type {boolean} */ value) {
    const res = await op(ids.sola, { op: 'toggle', identifier: id, value });
    must(res.status === 200, `toggle ${id}=${value} failed: HTTP ${res.status} ${J(res.json)}`);
}

/** Selected rows' data-keys in Sola's outline. */
const selectedKeys = () => probe.eval(`[...document.querySelectorAll(${J(`${view(ids.sola)} li.pm-node`)})]
    .filter((li) => li.querySelector(':scope > .pm-row.pm-selected')).map((li) => li.dataset.key)`);

/** The option switches' input types of a group li. */
const switchTypes = (/** @type {string} */ liSel) => probe.eval(`[...document.querySelectorAll(${J(`${liSel} > ul.pm-list > li.pm-node .pm-switch`)})].map((el) => el.type)`);

/**
 * Click the badge of `liSel` and check the flip to `want` ('1' or 'N'):
 * exactly one more setCardinality op, radios/checkboxes and the none label,
 * the stored cardinality, unchanged loadouts, no popup, row not selected.
 */
async function flipAndVerify(/** @type {string} */ liSel, /** @type {string} */ want, /** @type {(d: any) => any} */ groupOf, /** @type {string} */ enabled0) {
    const pickOne = want === '1';
    await countOps();
    await clickBadge(liSel);
    await until(async () => (await badgeText(liSel)) === want, 8000, `badge shows ${want}`);
    must(J(await opsSeen()) === J(['setCardinality']), `ops ${J(await opsSeen())}, want ["setCardinality"]`);
    const types = await switchTypes(liSel);
    must(types.length > 0 && types.every((/** @type {string} */ t) => t === (pickOne ? 'radio' : 'checkbox')), `option switch types ${J(types)}, want all ${pickOne ? 'radio' : 'checkbox'}`);
    must((await exists(`${liSel} > .pm-row .pm-none-label`)) === pickOne, `.pm-none-label ${pickOne ? 'missing' : 'still present'}`);
    const d = await docNow();
    must(groupOf(d)?.cardinality === (pickOne ? 'pick-one' : 'pick-one-or-more'), `stored cardinality ${J(groupOf(d)?.cardinality)}`);
    must(enabledState(d) === enabled0, 'loadout enabled/overrides changed');
    must((await popupText()) === null, `unexpected popup: ${await popupText()}`);
    must(!(await exists(`${liSel} > .pm-row.pm-selected`)), 'the badge click selected the group row');
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

    const H = S.sola0[6];
    const HK = S.sola0Keys[6];
    const O1 = S.sola0[7];
    const O2 = S.sola0[8];
    const hli = `${view(ids.sola)} li.pm-node[data-kind="group"][data-key="${HK}"]`;
    const optChecked = (/** @type {string} */ key) => probe.eval(`document.querySelector(${J(`${rowLi(ids.sola, key)} > .pm-row .pm-switch`)})?.checked ?? null`);

    // ------------------------------------------------------------------ c1
    await check('c1 headed group: N -> 1 -> N by real badge clicks, one setCardinality op each, radios/none label, loadouts untouched', async () => {
        // headed group with two options, REST only
        must((await op(ids.sola, { op: 'promote', key: HK })).status === 200, 'promote failed');
        await until(async () => flat(await docNow()).find((e) => e.leaf.key === HK)?.rank === 'group', 8000, 'row is a group heading');
        must((await op(ids.sola, { op: 'demote', key: S.sola0Keys[7] })).status === 200, 'demote row 7 failed');
        must((await op(ids.sola, { op: 'demote', key: S.sola0Keys[8] })).status === 200, 'demote row 8 failed');
        const d0 = await until(async () => {
            const d = await docNow();
            const g = grpOf(d, H);
            return g && g.options.length === 2 ? d : null;
        }, 8000, 'group has 2 options');
        const loadouts = Object.values(d0.loadouts);
        must(loadouts.length === 1, `expected 1 loadout after the fresh import, found ${loadouts.length}`);
        must(loadouts.every((/** @type {any} */ l) => !l.overrides || Object.keys(l.overrides).length === 0), `loadout overrides present: ${J(loadouts.map((/** @type {any} */ l) => l.overrides))}`);
        // heading off, option 1 on, option 2 off (the heading is never a member; round3 h2 covers it on)
        await setOn(H, false);
        await setOn(O1, true);
        await setOn(O2, false);
        if (grpOf(await docNow(), H).cardinality !== 'pick-one-or-more') {
            must((await op(ids.sola, { op: 'setCardinality', key: grpOf(await docNow(), H).key, cardinality: 'pick-one-or-more' })).status === 200, 'REST setCardinality pick-one-or-more failed');
        }
        await until(() => exists(hli), 10000, 'headed group renders');
        await until(async () => (await badgeText(hli)) === 'N', 8000, 'badge shows N');
        must((await probe.eval(`document.querySelector(${J(badge(hli))}).dataset.next`)) === 'pick-one', 'badge data-next is not pick-one');
        const enabled0 = enabledState(await docNow());
        await flipAndVerify(hli, '1', (d) => grpOf(d, H), enabled0);
        must((await probe.eval(`document.querySelector(${J(badge(hli))}).dataset.next`)) === 'pick-one-or-more', 'badge data-next is not pick-one-or-more after the flip');
        await flipAndVerify(hli, 'N', (d) => grpOf(d, H), enabled0);
        return `headed group ${HK}: N -> 1 (radios + none label) -> N (checkboxes); exactly ["setCardinality"] per click; stored cardinality follows; loadout state byte-identical; no popup`;
    });

    // ------------------------------------------------------------------ c2
    await check('c2 headerless group: N -> 1 -> N, one op per click, the row is never selected', async () => {
        const K = S.sola0Keys[1];
        must((await op(ids.sola, { op: 'demote', key: K })).status === 200, 'demote failed');
        const d0 = await until(async () => {
            const d = await docNow();
            return hlessOf(d, S.sola0[1]) ? d : null;
        }, 8000, 'headerless group in the doc');
        const g0 = hlessOf(d0, S.sola0[1]);
        if (Object.values(d0.loadouts).length !== 1) throw new Error(`expected 1 loadout, found ${Object.values(d0.loadouts).length}`);
        const groupOf = (/** @type {any} */ d) => hlessOf(d, S.sola0[1]);
        const members = g0.options.map(identOf);
        for (const m of members.slice(1)) await setOn(m, false);
        if (g0.cardinality !== 'pick-one-or-more') {
            must((await op(ids.sola, { op: 'setCardinality', key: g0.key, cardinality: 'pick-one-or-more' })).status === 200, 'REST setCardinality pick-one-or-more failed');
        }
        const li = `${view(ids.sola)} li.pm-node[data-kind="group"][data-key^="grp:"]:has(> ul.pm-list > li.pm-node[data-key="${K}"])`;
        await until(() => exists(li), 10000, 'headerless group renders');
        await until(async () => (await badgeText(li)) === 'N', 8000, 'headerless badge shows N');
        must((await probe.eval(`document.querySelector(${J(badge(li))}).dataset.next`)) === 'pick-one', 'badge data-next is not pick-one');
        const enabled0 = enabledState(await docNow());
        await flipAndVerify(li, '1', groupOf, enabled0);
        await flipAndVerify(li, 'N', groupOf, enabled0);
        return `headerless group (${members.length} members, nodeKey ${J(await probe.eval(`document.querySelector(${J(li)})?.dataset.nodeKey ?? null`))}): N -> 1 -> N; exactly ["setCardinality"] per click; stored cardinality follows; loadout state byte-identical; row never selected`;
    });

    // ------------------------------------------------------------------ c3
    await check('c3 refusal: pick-one with two options on shows the server text in an ST popup and changes nothing', async () => {
        await setOn(O1, true);
        await setOn(O2, true);
        await until(async () => (await optChecked(S.sola0Keys[7])) === true && (await optChecked(S.sola0Keys[8])) === true, 10000, 'both option checkboxes checked');
        must((await badgeText(hli)) === 'N', 'headed badge is not N');
        const enabled0 = enabledState(await docNow());
        await countOps();
        await clickBadge(hli);
        const msg = await until(async () => {
            const t = await popupText();
            return t && t.includes('more than one option currently selected') ? t : null;
        }, 8000, 'refusal popup with "more than one option currently selected"');
        const out = await shot('cardinality-refusal.png', 'page');
        must(J(await opsSeen()) === J(['setCardinality']), `ops ${J(await opsSeen())}, want ["setCardinality"]`);
        const d = await docNow();
        must(grpOf(d, H).cardinality === 'pick-one-or-more', `stored cardinality ${J(grpOf(d, H).cardinality)}`);
        must(enabledState(d) === enabled0, 'loadout enabled/overrides changed by the refused switch');
        must((await badgeText(hli)) === 'N', `badge now ${J(await badgeText(hli))}, want N`);
        must((await optChecked(S.sola0Keys[7])) === true && (await optChecked(S.sola0Keys[8])) === true, 'an option checkbox was switched off');
        await dismissPopups();
        must(!(await exists('dialog[open]')), 'a dialog[open] remains after dismissing');
        return `refused with popup ${J(msg.replace(/\s+/g, ' '))}; doc, loadouts and both options unchanged; badge still N; screenshot ${out}`;
    });

    // ------------------------------------------------------------------ c4
    await check('c4 selection untouched: a badge click keeps the selected rows and does not select the group', async () => {
        const X = S.sola0Keys[3];
        await selectRow(ids.sola, X);
        await setOn(O2, false);
        await until(async () => (await optChecked(S.sola0Keys[8])) === false, 10000, 'option 2 unchecked');
        const sel0 = await selectedKeys();
        must(sel0.includes(X), `row ${X} not among the selected rows ${J(sel0)}`);
        await clickBadge(hli);
        await until(async () => (await badgeText(hli)) === '1', 8000, 'badge shows 1');
        const sel1 = await selectedKeys();
        must(J(sel1) === J(sel0), `selection changed ${J(sel0)} -> ${J(sel1)}`);
        must(!(await exists(`${hli} > .pm-row.pm-selected`)), 'the group row is selected');
        await clickBadge(hli);
        await until(async () => (await badgeText(hli)) === 'N', 8000, 'badge back to N');
        must(J(await selectedKeys()) === J(sel0), 'selection changed on the way back');
        must(grpOf(await docNow(), H).cardinality === 'pick-one-or-more', 'group not restored to pick-one-or-more');
        return `selection ${J(sel0)} unchanged across two badge clicks; the group row was never selected; group restored to N`;
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
