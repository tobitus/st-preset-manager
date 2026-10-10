#!/usr/bin/env node
/**
 * Loadouts (root / playstyle) + per-loadout tuning acceptance, one
 * real-browser script. Drives the ACTUAL v2 window in a headless Chromium
 * over raw CDP and observes the plugin REST API and ST's live
 * chat-completion state.
 *
 *   node dev/check-loadouts.mjs            all sections (resets dev data first)
 *   node dev/check-loadouts.mjs l1 l2      a subset of sections
 *
 * Sections (run in this order):
 *   l1 A fresh preset has one root loadout; the UI creates a playstyle
 *      (parent = the root, empty sparse map); every row is inherited; the
 *      loadout box is a bordered box holding Delete loadout (the block
 *      delete lives outside it); parent select + disabled reset-all
 *   l2 Ticking a row on a playstyle writes only the playstyle's sparse map;
 *      ↺ clears it again; the root map never changes
 *   l3 A root edit shows through an inherited row of the picked playstyle
 *   l4 Activating the playstyle: ST's prompt_order equals root + playstyle;
 *      a tick in ST's own panel lands in the playstyle's map
 *   l5 New root (copy of the picked one's root), new playstyle under the
 *      picked one's root, re-parent through the parent select
 *   l7 Named tunings: copy, edit, bind per loadout x Model (ST follows);
 *      ST's own temperature slider writes the tuning in effect
 *   l8 Reset-all empties a playstyle's map
 *   l6 Delete guards (root with playstyles, last root) and deletion
 *   l9 An old-format document (no kind/parent/tuning, tuningOverrides) loads
 *      as a root loadout without being rewritten
 * Screenshots (dev/shots/): loadouts-l1-playstyle.png, loadouts-l4-live.png,
 * loadouts-l7-tuning.png.
 *
 * Environment: the dev container st-pm-dev on 127.0.0.1:8003 with the plugin
 * (dev/up.sh); NEVER :8001 or :8002. It RESETS the dev data (dev/reset.sh)
 * first. Never touches the sillytavern container or the live ST checkout.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
    FF, Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';
import { flattenSeq } from '../shared/outline.js';

const TAB = 'chklo';
const SOLA = 'Sola V2 Flame';
const SHOTS = path.join(REPO, 'dev', 'shots');
const OLD_FILE = path.join(REPO, 'dev', 'data', 'default-user', 'preset-manager', 'presets', 'Old Format Sola.json');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-loadouts.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const args = process.argv.slice(2);
const wanted = (/** @type {string} */ name) => args.length === 0 || args.includes(name);
const J = (/** @type {any} */ v) => JSON.stringify(v);
const eq = (/** @type {any} */ a, /** @type {any} */ b) => isDeepStrictEqual(a, b);
const ids = { ff: '', sola: '' };
/** loadout ids + the two rows the checks toggle */
const lo = { R: '', P: '', P2: '', R2: '' };
let X = '', Y = '', keyX = '', keyY = '', r0x = false, r0y = false;
let mockName = '';

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);
const setValue = (/** @type {string} */ sel, /** @type {string} */ value, evt = 'input') => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return true; })()`);

const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;
const getModels = async () => (await api('GET', '/models')).json.models;
const getSlot = async (/** @type {any} */ raw = null) => (await api('GET', raw
    ? `/slot?${new URLSearchParams({ source: raw.source ?? '', model: raw.model ?? '', profileId: raw.profileId ?? '' })}`
    : '/slot')).json;
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const op = (/** @type {string} */ id, /** @type {any} */ body) => api('POST', `/presets/${id}/ops`, body);

/** ST's live chat-completion state + connection panel. */
function st() {
    return probe.eval(`(() => {
        const c = SillyTavern.getContext();
        const o = c.chatCompletionSettings;
        const sel = document.getElementById('connection_profiles');
        return {
            preset: o.preset_settings_openai,
            temperature: o.temp_openai,
            order: o.prompt_order?.[0]?.order ?? [],
            source: document.getElementById('chat_completion_source')?.value ?? null,
            model: document.getElementById('custom_model_id')?.value ?? null,
            profile: sel?.selectedOptions?.[0]?.textContent ?? null,
            selectedProfile: c.extensionSettings.connectionManager.selectedProfile ?? null,
            blocker: !!document.querySelector('.pm-apply-blocker'),
            appliedSlotChangedRev: window.__pmStarted?.bridge?.appliedSlotChangedRev ?? -1,
            settled: (() => {
                const b = window.__pmStarted?.bridge;
                if (!b) return false;
                const r = { source: String(o.chat_completion_source ?? ''), model: String(c.getChatCompletionModel?.() ?? ''), profileId: c.extensionSettings.connectionManager.selectedProfile ?? null };
                const same = !b.baseRaw || (b.baseRaw.source === r.source && b.baseRaw.model === r.model && (b.baseRaw.profileId ?? null) === r.profileId);
                return same && !b.applying && !b._reconcileQueued && !b._modelQueued && !b._panelQueued;
            })(),
            raw: { source: String(o.chat_completion_source ?? ''), model: String(c.getChatCompletionModel?.() ?? ''), profileId: c.extensionSettings.connectionManager.selectedProfile ?? null },
        };
    })()`);
}
const clickStToggle = (/** @type {string} */ id) => probe.eval(`(() => { if (document.querySelector('.pm-apply-blocker')) return false; const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${id}"] .prompt-manager-toggle-action'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`);
/** ST's own sampler slider (dev/probe.mjs set-slider). */
const setSlider = (/** @type {string} */ id, /** @type {number} */ v) => probe.eval(`(() => {
    const el = document.getElementById(${J(id)}); if (!el) return false;
    el.value = ${J(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const liveProfiles = () => probe.eval('JSON.parse(JSON.stringify(SillyTavern.getContext().extensionSettings.connectionManager.profiles))');

async function dismissPopups() {
    const closed = await probe.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

/** ST shows the slot and its order equals the compiled slot (no apply in flight). */
async function converged() {
    const s = await st();
    const slot = await getSlot(s.raw);
    return !s.blocker && s.settled && s.preset === SLOT_NAME && s.appliedSlotChangedRev >= (slot.slotChangedRev ?? 0)
        && J(s.order) === J(slot.compiled?.prompt_order?.[0]?.order)
        && s.temperature === slot.compiled?.temperature ? { s, slot } : null;
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
const swSel = (/** @type {string} */ key) => `${rowLi(ids.sola, key)} > .pm-row input.pm-switch[type=checkbox]`;
const box = () => `${view(ids.sola)} .pm-loadout-box`;
const picker = () => `${box()} select.pm-loadout-picker`;

/** Open a library preset in the Presets tab and wait for its Model panel. */
async function openInPresets(/** @type {string} */ presetId) {
    await showTab('library');
    const row = `#pm-window .pm-library-row[data-preset-id="${presetId}"]`;
    await until(() => exists(row), 10000, 'library row');
    await click(`${row} .pm-open`);
    await until(() => exists(`#pm-window .pm-preset-view[data-preset-id="${presetId}"] .pm-model-panel .pm-mp-model`), 10000, 'model panel');
}

const panelSel = (/** @type {string} */ presetId) => `#pm-window .pm-preset-view[data-preset-id="${presetId}"] .pm-model-panel`;

/** Choose the Model the tuning panel edits (and wait until it is shown). */
async function panelModel(/** @type {string} */ presetId, /** @type {string} */ name) {
    const p = panelSel(presetId);
    await until(() => probe.eval(`[...(document.querySelector(${J(`${p} .pm-mp-model`)})?.options ?? [])].some((o) => o.value === ${J(name)})`), 8000, `panel lists ${name}`);
    await setValue(`${p} .pm-mp-model`, name, 'change');
    await until(() => probe.eval(`document.querySelector(${J(`${p} .pm-mp-model`)})?.value === ${J(name)}`), 5000, `panel on ${name}`);
}

/** Pick a Model in the v2 toolbar picker. */
async function toolbarPick(/** @type {string} */ name) {
    await until(() => probe.eval(`[...(document.querySelector('#pm-window .pm-model-picker')?.options ?? [])].some((o) => o.value === ${J(name)})`), 8000, `toolbar lists ${name}`);
    return setValue('#pm-window .pm-model-picker', name, 'change');
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

async function shot(/** @type {string} */ file) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await sleep(300);
    const r = await probe.eval(`(() => { const b = document.querySelector('#pm-window').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    const out = path.join(SHOTS, file);
    fs.writeFileSync(out, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data, 'base64'));
    console.log(`[check] screenshot: ${out}`);
    return out;
}

async function check(/** @type {string} */ name, /** @type {() => Promise<string>} */ body) {
    try {
        report(name, true, await body());
    } catch (err) {
        report(name, false, /** @type {Error} */ (err).message);
    }
}
const must = (/** @type {any} */ cond, /** @type {string} */ msg) => { if (!cond) throw new Error(msg); };

// ------------------------------------------------------------------ loadout-box helpers

/** Pick a loadout in the box's picker (change event) and wait until it is the picked one. */
async function pick(/** @type {string} */ lid) {
    await until(() => probe.eval(`[...(document.querySelector(${J(picker())})?.options ?? [])].some((o) => o.value === ${J(lid)})`), 8000, `picker lists ${lid}`);
    await setValue(picker(), lid, 'change');
    await until(() => probe.eval(`document.querySelector(${J(picker())})?.value === ${J(lid)}`), 5000, `picker on ${lid}`);
}
const pickerText = () => probe.eval(`document.querySelector(${J(picker())})?.selectedOptions[0]?.textContent ?? null`);
const pickerValue = () => probe.eval(`document.querySelector(${J(picker())})?.value ?? null`);
const parentValues = () => probe.eval(`[...document.querySelectorAll(${J(`${box()} select.pm-loadout-parent option`)})].map((o) => o.value)`);
const swChecked = (/** @type {string} */ key) => probe.eval(`document.querySelector(${J(swSel(key))})?.checked ?? null`);
const liHas = (/** @type {string} */ key, /** @type {string} */ cls) => exists(`${rowLi(ids.sola, key)}.${cls}`);
const hasReset = (/** @type {string} */ key) => exists(`${rowLi(ids.sola, key)} > .pm-row button.pm-reset-inherit`);
/** [total leaf rows, inherited leaf rows, reset buttons] in the outline */
const leafCounts = () => probe.eval(`(() => {
    const leaves = [...document.querySelectorAll(${J(`${view(ids.sola)} li.pm-node[data-kind="leaf"]`)})];
    return [leaves.length, leaves.filter((l) => l.classList.contains('pm-inherited')).length,
        document.querySelectorAll(${J(`${view(ids.sola)} .pm-reset-inherit`)}).length];
})()`);
const dialogText = () => probe.eval(`(() => { const d = document.querySelector('dialog[open]'); return d ? d.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);

/** Create a loadout through the box: name, kind, New. */
async function createViaUi(/** @type {string} */ name, /** @type {'root'|'playstyle'} */ kind) {
    await setValue(`${box()} input.pm-loadout-name`, name, 'input');
    await setValue(`${box()} select.pm-loadout-kind`, kind, 'change');
    await click(`${box()} .pm-loadout-new`);
}
const byName = (/** @type {any} */ doc, /** @type {string} */ name) => Object.values(doc.loadouts).find((/** @type {any} */ l) => l.name === name);

/** Pick a loadout, click Delete loadout twice (arm, confirm). */
async function deleteViaUi(/** @type {string} */ lid) {
    await pick(lid);
    must(await click(`${box()} .pm-loadout-delete`), 'no delete button');
    await until(async () => (await text(`${box()} .pm-loadout-delete`)) === 'Confirm delete', 3000, 'delete armed');
    await click(`${box()} .pm-loadout-delete`);
}

// ------------------------------------------------------------------ l1

async function sectionL1() {
    await check('l1a a fresh preset has exactly one root loadout, shown as "<name> (root)"', async () => {
        const doc = await getDoc(ids.sola);
        const list = Object.values(doc.loadouts);
        must(list.length === 1, `loadouts: ${J(list.map((/** @type {any} */ l) => [l.id, l.name, l.kind]))}`);
        const l = /** @type {any} */ (list[0]);
        must(l.kind === 'root' && l.parent === null, `kind=${l.kind} parent=${J(l.parent)}`);
        const t = await pickerText();
        must(typeof t === 'string' && t.startsWith(`${l.name} (root)`), `picker text ${J(t)}`);
        return `1 loadout ${l.id} "${l.name}" kind=${l.kind} parent=null; picker text ${J(t)}`;
    });

    await check('l1b creating a playstyle through the UI: parent = the root, empty sparse map, becomes the picked one', async () => {
        await createViaUi('P', 'playstyle');
        const doc = await until(async () => {
            const d = await getDoc(ids.sola);
            const l = /** @type {any} */ (byName(d, 'P'));
            return l && l.kind === 'playstyle' ? d : null;
        }, 8000, 'playstyle P in the doc');
        const l = /** @type {any} */ (byName(doc, 'P'));
        lo.P = l.id;
        must(l.parent === lo.R, `parent ${J(l.parent)} != ${lo.R}`);
        must(eq(l.enabled, {}), `enabled ${J(l.enabled)}`);
        await until(async () => (await pickerValue()) === lo.P, 5000, 'picker on P');
        const rName = doc.loadouts[lo.R].name;
        const t = await pickerText();
        must(typeof t === 'string' && t.startsWith(`P ↳ ${rName}`), `picker text ${J(t)}`);
        return `P=${lo.P} kind=${l.kind} parent=${l.parent} enabled=${J(l.enabled)}; picker value=${lo.P} text ${J(t)}`;
    });

    await check('l1c on the playstyle every leaf row is inherited and no row has a reset-inherit button', async () => {
        const [total, inherited, resets] = await until(async () => {
            const c = await leafCounts();
            return c[0] > 0 && c[0] === c[1] ? c : null;
        }, 8000, 'every leaf inherited');
        must(total > 0, 'no leaf rows');
        must(inherited === total, `inherited ${inherited} of ${total}`);
        must(resets === 0, `${resets} reset-inherit buttons`);
        return `${inherited}/${total} leaf rows .pm-inherited; ${resets} .pm-reset-inherit`;
    });

    await check('l1d the loadout box is bordered and holds "Delete loadout"; the block delete is outside it', async () => {
        const r = await probe.eval(`(() => {
            const b = document.querySelector(${J(box())});
            if (!b) return null;
            const cs = getComputedStyle(b);
            const d = b.querySelector('.pm-loadout-delete');
            const bd = document.querySelector(${J(`${view(ids.sola)} .pm-block-delete`)});
            return { w: cs.borderTopWidth, s: cs.borderTopStyle, del: d ? d.textContent : null, bd: !!bd, bdOutside: bd ? !bd.closest('.pm-loadout-box') : null };
        })()`);
        must(r, 'no .pm-loadout-box');
        must(parseFloat(r.w) > 0 && r.s !== 'none', `border ${r.w} ${r.s}`);
        must(r.del === 'Delete loadout', `delete text ${J(r.del)}`);
        must(r.bd && r.bdOutside, `block delete exists=${r.bd} outside=${r.bdOutside}`);
        return `border-top ${r.w} ${r.s}; delete text ${J(r.del)}; .pm-block-delete exists and is outside the box`;
    });

    await check('l1e the parent select (only the root) and a disabled reset-all are visible on a playstyle', async () => {
        const r = await probe.eval(`(() => {
            const vis = (el) => !!el && !el.hidden && el.offsetParent !== null;
            const p = document.querySelector(${J(`${box()} select.pm-loadout-parent`)});
            const ra = document.querySelector(${J(`${box()} .pm-loadout-reset-all`)});
            return { pv: vis(p), vals: p ? [...p.options].map((o) => o.value) : null, rv: vis(ra), rd: ra ? ra.disabled : null };
        })()`);
        must(r.pv, 'parent select not visible');
        must(eq(r.vals, [lo.R]), `parent options ${J(r.vals)}`);
        must(r.rv && r.rd === true, `reset-all visible=${r.rv} disabled=${r.rd}`);
        await shot('loadouts-l1-playstyle.png');
        return `parent options ${J(r.vals)}; reset-all visible=${r.rv} disabled=${r.rd}`;
    });
}

// ------------------------------------------------------------------ l2

async function sectionL2() {
    await check('l2 a tick on a playstyle writes only its sparse map; ↺ clears it; the root map never changes', async () => {
        await pick(lo.P);
        const snap = J((await getDoc(ids.sola)).loadouts[lo.R].enabled);
        must(await click(swSel(keyX)), 'no checkbox for X');
        const doc = await until(async () => {
            const d = await getDoc(ids.sola);
            return eq(d.loadouts[lo.P].enabled, { [X]: !r0x }) && J(d.loadouts[lo.R].enabled) === snap ? d : null;
        }, 8000, 'P.enabled = {X: !r0x}, R unchanged');
        await until(async () => !(await liHas(keyX, 'pm-inherited')) && (await hasReset(keyX)), 8000, 'X row explicit with ↺');
        const set = J(doc.loadouts[lo.P].enabled);
        must(await click(`${rowLi(ids.sola, keyX)} > .pm-row button.pm-reset-inherit`), 'no ↺ button');
        const doc2 = await until(async () => {
            const d = await getDoc(ids.sola);
            return eq(d.loadouts[lo.P].enabled, {}) ? d : null;
        }, 8000, 'P.enabled = {} after ↺');
        await until(async () => (await liHas(keyX, 'pm-inherited')) && !(await hasReset(keyX)), 8000, 'X row inherited again, no ↺');
        must(J(doc2.loadouts[lo.R].enabled) === snap, 'R map changed');
        return `after tick P.enabled=${set} (r0x=${r0x}); after ↺ ${J(doc2.loadouts[lo.P].enabled)}; X inherited, ↺ gone; R map unchanged`;
    });
}

// ------------------------------------------------------------------ l3

async function sectionL3() {
    await check('l3 a root edit shows through an inherited row of the picked playstyle', async () => {
        await pick(lo.P);
        const r1 = await op(ids.sola, { op: 'toggle', identifier: X, value: !r0x, loadoutId: lo.R });
        must(r1.status === 200, `toggle status ${r1.status}`);
        await until(async () => (await swChecked(keyX)) === !r0x && (await liHas(keyX, 'pm-inherited')) && (await pickerValue()) === lo.P, 8000, 'X shows the root edit, still inherited, picker still P');
        const mid = await swChecked(keyX);
        const r2 = await op(ids.sola, { op: 'toggle', identifier: X, value: r0x, loadoutId: lo.R });
        must(r2.status === 200, `toggle-back status ${r2.status}`);
        await until(async () => (await swChecked(keyX)) === r0x, 8000, 'X back to r0x');
        return `root toggle -> checkbox ${mid} (= !r0x ${!r0x}), row stayed .pm-inherited, picker ${lo.P}; toggled back -> ${await swChecked(keyX)}`;
    });
}

// ------------------------------------------------------------------ l4

async function sectionL4() {
    await check('l4 activating the playstyle: ST order = root + playstyle bits; ST\'s own tick lands in the playstyle', async () => {
        await pick(lo.P);
        must(await click(swSel(keyY)), 'no checkbox for Y');
        await until(async () => eq((await getDoc(ids.sola)).loadouts[lo.P].enabled, { [Y]: !r0y }), 8000, 'P.enabled = {Y: !r0y}');
        must(await click(`${box()} .pm-loadout-activate`), 'no activate button');
        await until(async () => (await getSlot()).desired?.loadoutId === lo.P && (await getDoc(ids.sola)).activeLoadoutId === lo.P, 10000, 'slot + doc active loadout = P');
        const c = await convergedOn(ids.sola, 'converged on Sola with P active');
        const doc = await getDoc(ids.sola);
        const expected = { ...doc.loadouts[lo.R].enabled, ...doc.loadouts[lo.P].enabled };
        const order = c.s.order;
        const bad = order.filter((/** @type {any} */ e) => e.enabled !== expected[e.identifier]);
        must(order.length > 0 && bad.length === 0, `${bad.length}/${order.length} entries differ: ${J(bad.slice(0, 3).map((/** @type {any} */ e) => [e.identifier, e.enabled, expected[e.identifier]]))}`);
        const oy = order.find((/** @type {any} */ e) => e.identifier === Y)?.enabled;
        const ox = order.find((/** @type {any} */ e) => e.identifier === X)?.enabled;
        await shot('loadouts-l4-live.png');

        const snapR = J(doc.loadouts[lo.R].enabled);
        await until(() => clickStToggle(X), 15000, 'ST toggle for X clickable');
        await until(async () => {
            const d = await getDoc(ids.sola);
            if (d.loadouts[lo.P].enabled[X] !== !r0x || J(d.loadouts[lo.R].enabled) !== snapR) return null;
            const c2 = await converged();
            return c2 && c2.s.order.find((/** @type {any} */ e) => e.identifier === X)?.enabled === !r0x ? c2 : null;
        }, 20000, 'ST tick in P.enabled, R unchanged, converged');
        const d2 = await getDoc(ids.sola);
        return `compared ${order.length} order entries to root+playstyle (all equal); ST Y=${oy} (r0y=${r0y}) X=${ox} (r0x=${r0x}); after ST tick on X: P.enabled[X]=${d2.loadouts[lo.P].enabled[X]} (!r0x=${!r0x}), R map unchanged`;
    });
}

// ------------------------------------------------------------------ l5

async function sectionL5() {
    await check('l5 new root copies the picked one\'s root; new playstyle goes under the picked one\'s root; re-parent via the select', async () => {
        await pick(lo.P);
        await createViaUi('R2', 'root');
        const doc = await until(async () => {
            const d = await getDoc(ids.sola);
            const l = /** @type {any} */ (byName(d, 'R2'));
            return l && l.kind === 'root' ? d : null;
        }, 8000, 'root R2 in the doc');
        const l = /** @type {any} */ (byName(doc, 'R2'));
        lo.R2 = l.id;
        const missing = Object.keys(doc.loadouts[lo.R].enabled).filter((k) => !(k in l.enabled));
        must(l.parent === null && missing.length === 0, `R2 parent=${J(l.parent)} missing keys=${missing.length}`);
        const nKeys = Object.keys(l.enabled).length;

        await pick(lo.P);
        const vals = await until(async () => {
            const v = await parentValues();
            return v.length ? v : null;
        }, 5000, 'parent options');
        const roots = Object.values((await getDoc(ids.sola)).loadouts).filter((/** @type {any} */ x) => x.kind === 'root').map((/** @type {any} */ x) => x.id);
        must(eq(vals, [lo.R, lo.R2]) && eq(roots, [lo.R, lo.R2]) && !vals.includes(lo.P), `parent options ${J(vals)} roots in doc ${J(roots)}`);

        await createViaUi('P2', 'playstyle');
        const doc2 = await until(async () => {
            const d = await getDoc(ids.sola);
            const x = /** @type {any} */ (byName(d, 'P2'));
            return x && x.kind === 'playstyle' ? d : null;
        }, 8000, 'playstyle P2 in the doc');
        const p2 = /** @type {any} */ (byName(doc2, 'P2'));
        lo.P2 = p2.id;
        must(p2.parent === lo.R, `P2 parent ${J(p2.parent)} (want ${lo.R}, not P ${lo.P})`);

        await pick(lo.P);
        const pEnabled = J((await getDoc(ids.sola)).loadouts[lo.P].enabled);
        await until(() => setValue(`${box()} select.pm-loadout-parent`, lo.R2, 'change'), 5000, 'set parent R2');
        const d3 = await until(async () => {
            const d = await getDoc(ids.sola);
            return d.loadouts[lo.P].parent === lo.R2 ? d : null;
        }, 8000, 'P.parent = R2');
        must(J(d3.loadouts[lo.P].enabled) === pEnabled, `P.enabled changed ${J(d3.loadouts[lo.P].enabled)}`);
        await setValue(`${box()} select.pm-loadout-parent`, lo.R, 'change');
        await until(async () => (await getDoc(ids.sola)).loadouts[lo.P].parent === lo.R, 8000, 'P.parent = R again');
        return `R2=${lo.R2} root with ${nKeys} enabled keys; parent options ${J(vals)}; P2=${lo.P2} parent=${p2.parent}; P.parent -> R2 -> R, P.enabled unchanged ${pEnabled}`;
    });
}

// ------------------------------------------------------------------ l7

async function sectionL7() {
    await check('l7 named tunings: copy, edit, bind per loadout x Model, rename; ST follows; ST\'s slider writes the tuning in effect', async () => {
        const r0 = await api('PATCH', `/models/${encodeURIComponent(mockName)}/tunings/default`, { set: { temperature: 0.8 } });
        must(r0.status === 200, `PATCH default tuning status ${r0.status} ${r0.text}`);
        await toolbarPick(mockName);
        await until(async () => {
            const c = await converged();
            return c && c.s.model === 'mock' && c.slot.desired?.modelId === mockName ? c : null;
        }, 20000, `ST on ${mockName}`);
        await pick(lo.P);
        await panelModel(ids.sola, mockName);
        const p = panelSel(ids.sola);

        await setValue(`${p} .pm-tuning-new-name`, 'hot', 'input');
        must(await click(`${p} .pm-tuning-new`), 'no .pm-tuning-new');
        await until(async () => (await getModels())[mockName]?.tunings?.hot && (await probe.eval(`document.querySelector(${J(`${p} .pm-tuning-name`)})?.value`)) === 'hot', 8000, 'tuning hot exists and is selected');

        await setValue(`${p} .pm-tuning-input[data-key="temperature"]`, '1.5', 'change');
        const m1 = await until(async () => {
            const t = (await getModels())[mockName].tunings;
            return t.hot?.temperature === 1.5 && t.default?.temperature === 0.8 ? t : null;
        }, 8000, 'hot.temperature 1.5, default 0.8');

        await setValue(`${p} .pm-ov-tuning`, 'hot', 'change');
        await until(async () => (await getDoc(ids.sola)).loadouts[lo.P].overrides?.[mockName]?.tuning === 'hot', 8000, 'P override tuning = hot');
        const c1 = await until(async () => {
            const c = await converged();
            return c && c.s.temperature === 1.5 ? c : null;
        }, 20000, 'ST temperature 1.5');

        await setValue(`${p} .pm-ov-tuning`, '', 'change');
        await until(async () => (await getDoc(ids.sola)).loadouts[lo.P].overrides?.[mockName]?.tuning === null, 8000, 'P override tuning = null');
        const c2 = await until(async () => {
            const c = await converged();
            return c && c.s.temperature === 0.8 ? c : null;
        }, 20000, 'ST temperature 0.8');

        await setValue(`${p} .pm-ov-tuning`, 'hot', 'change');
        const c3 = await until(async () => {
            const c = await converged();
            return c && c.s.temperature === 1.5 ? c : null;
        }, 20000, 'ST temperature 1.5 again');

        must(await setSlider('temp_openai', 1.25), 'no temp_openai slider');
        const t4 = await until(async () => {
            const t = (await getModels())[mockName].tunings;
            return t.hot?.temperature === 1.25 ? t : null;
        }, 10000, 'hot.temperature 1.25 from ST slider');
        must(t4.default?.temperature === 0.8, `default.temperature ${t4.default?.temperature}`);

        await setValue(`${p} .pm-tuning-new-name`, 'blazing', 'input');
        must(await click(`${p} .pm-tuning-rename`), 'no .pm-tuning-rename');
        await until(async () => {
            const t = (await getModels())[mockName].tunings;
            return t.blazing?.temperature === 1.25 && !t.hot ? t : null;
        }, 8000, 'tuning hot renamed to blazing (temperature 1.25)');
        await until(async () => (await getDoc(ids.sola)).loadouts[lo.P].overrides?.[mockName]?.tuning === 'blazing', 8000, 'P override tuning = blazing');
        await until(async () => (await probe.eval(`document.querySelector(${J(`${p} .pm-tuning-name`)})?.value`)) === 'blazing', 8000, 'panel select = blazing');
        const c5 = await until(async () => {
            const c = await converged();
            return c && c.s.temperature === 1.25 ? c : null;
        }, 20000, 'ST temperature 1.25 after rename');
        await shot('loadouts-l7-tuning.png');
        return `hot=${m1.hot.temperature}, default=${m1.default.temperature}; ST temp bound hot=${c1.s.temperature}, inherit=${c2.s.temperature}, hot again=${c3.s.temperature}; slider 1.25 -> hot=${t4.hot.temperature}, default=${t4.default.temperature}; rename hot -> blazing: override tuning=blazing, ST temp=${c5.s.temperature}`;
    });
}

// ------------------------------------------------------------------ l8

async function sectionL8() {
    await check('l8 reset-all empties the playstyle map and every row is inherited again', async () => {
        await pick(lo.P);
        const before = (await getDoc(ids.sola)).loadouts[lo.P].enabled;
        must(Object.keys(before).length >= 2, `P map before ${J(before)}`);
        await until(async () => probe.eval(`document.querySelector(${J(`${box()} .pm-loadout-reset-all`)})?.disabled === false`), 5000, 'reset-all enabled');
        must(await click(`${box()} .pm-loadout-reset-all`), 'no reset-all');
        await until(async () => eq((await getDoc(ids.sola)).loadouts[lo.P].enabled, {}), 8000, 'P.enabled = {}');
        const c = await until(async () => {
            const k = await leafCounts();
            return k[0] > 0 && k[0] === k[1] && k[2] === 0 ? k : null;
        }, 8000, 'every leaf inherited');
        const dis = await probe.eval(`document.querySelector(${J(`${box()} .pm-loadout-reset-all`)})?.disabled`);
        must(dis === true, `reset-all disabled=${dis}`);
        return `P map before ${J(before)}, after {}; ${c[1]}/${c[0]} leaves inherited, ${c[2]} ↺; reset-all disabled=${dis}`;
    });
}

// ------------------------------------------------------------------ l6

async function sectionL6() {
    await check('l6 delete guards: a root with playstyles and the last root refuse; the rest delete through the UI', async () => {
        await deleteViaUi(lo.R);
        const dlg = await until(async () => {
            const t = await dialogText();
            return t && t.includes('has 2 playstyle loadout(s)') ? t : null;
        }, 8000, 'dialog: has 2 playstyle loadout(s)');
        must(lo.R in (await getDoc(ids.sola)).loadouts, 'R vanished');
        await dismissPopups();

        for (const [name, lid] of [['P2', lo.P2], ['P', lo.P], ['R2', lo.R2]]) {
            await deleteViaUi(lid);
            await until(async () => !(lid in (await getDoc(ids.sola)).loadouts), 8000, `${name} deleted`);
        }

        await deleteViaUi(lo.R);
        const dlg2 = await until(async () => {
            const t = await dialogText();
            return t && t.includes('cannot delete the last root loadout') ? t : null;
        }, 8000, 'dialog: cannot delete the last root loadout');
        const left = Object.keys((await getDoc(ids.sola)).loadouts);
        must(eq(left, [lo.R]), `loadouts left ${J(left)}`);
        await dismissPopups();
        return `root-with-playstyles dialog ${J(dlg.slice(0, 120))}; P2, P, R2 gone; last-root dialog ${J(dlg2.slice(0, 120))}; loadouts left ${J(left)}`;
    });
}

// ------------------------------------------------------------------ l9

async function sectionL9() {
    await check('l9 an old-format document loads as a root loadout without being rewritten; the UI shows "Old (root)"', async () => {
        const doc = await getDoc(ids.sola);
        const old = structuredClone(doc);
        old.id = 'p_oldformat';
        old.name = 'Old Format Sola';
        old.loadouts = { L_old: { id: 'L_old', name: 'Old', notes: '', enabled: { ...doc.loadouts[lo.R].enabled }, overrides: { [mockName]: { enabled: {} } } } };
        old.activeLoadoutId = 'L_old';
        old.tuningOverrides = { [mockName]: { temperature: 0.42 } };
        fs.writeFileSync(OLD_FILE, JSON.stringify(old, null, 2));
        const rs = await api('POST', '/rescan');
        must(rs.status === 200, `rescan status ${rs.status} ${rs.text}`);
        const entry = await until(async () => ((await api('GET', '/library')).json ?? []).find((/** @type {any} */ e) => e.name === 'Old Format Sola'), 10000, 'library lists Old Format Sola');
        const od = await getDoc(entry.id);
        const l = od.loadouts?.L_old;
        must(l && l.kind === 'root' && l.parent === null, `L_old ${J(l && { kind: l.kind, parent: l.parent })}`);
        must(!('tuningOverrides' in od), 'tuningOverrides still in the loaded doc');
        const disk = JSON.parse(fs.readFileSync(OLD_FILE, 'utf8'));
        must('tuningOverrides' in disk, 'file on disk was rewritten (tuningOverrides gone)');

        // the Library pane lists the library as of window open: reload ST and reopen the window
        await reloadPage();
        await openWindow();
        await showTab('library');
        const row = `#pm-window .pm-library-row[data-preset-id="${entry.id}"]`;
        await until(() => exists(row), 10000, 'library row for Old Format Sola');
        const libText = await until(() => probe.eval(`document.querySelector(${J(`${row} .pm-loadout-select`)})?.selectedOptions[0]?.textContent ?? null`), 8000, 'library loadout select');
        must(libText === 'Old (root)', `library option text ${J(libText)}`);

        await openInPresets(entry.id);
        const pk = `${view(entry.id)} .pm-loadout-box select.pm-loadout-picker`;
        const pt = await until(() => probe.eval(`document.querySelector(${J(pk)})?.selectedOptions[0]?.textContent ?? null`), 8000, 'picker in the opened old preset');
        must(pt.startsWith('Old (root)'), `picker text ${J(pt)}`);
        return `id=${entry.id} L_old kind=${l.kind} parent=${J(l.parent)}; loaded doc has no tuningOverrides, disk file still does; library select ${J(libText)}; picker ${J(pt)}`;
    });
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
        ['^(Freaky Frankenstein 5\\.4 Internal States \\(2\\)|Sola V2 Flame)$'],
        { stdio: 'pipe' });
    const library = (await api('GET', '/library')).json ?? [];
    const idOf = (/** @type {string} */ n) => library.find((/** @type {any} */ e) => e.name === n)?.id ?? '';
    ids.ff = idOf(FF); ids.sola = idOf(SOLA);
    if (!ids.ff || !ids.sola) fatal('setup', `fixtures missing: ${J(library.map((/** @type {any} */ e) => e.name))}`);
    if ((await api('POST', '/slot/load', { presetId: ids.sola })).status !== 200) fatal('setup', 'slot_load Sola failed');

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
        await probe.eval(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pm.')) localStorage.removeItem(k); return true; })()`);
        await reloadPage();
        await convergedOn(ids.sola, 'Sola converged in the slot');
        await openWindow();
        await showTab('presets');
        await until(() => exists(`${view(ids.sola)} .pm-outline li.pm-node`), 10000, 'Sola view (the slot preset auto-opens)');

        const seed = await api('POST', '/models/seed', { profiles: await liveProfiles() });
        if (seed.status !== 200) throw new Error(`models/seed status ${seed.status} ${seed.text}`);
        const models = await getModels();
        mockName = Object.entries(models).find(([, m]) => (/** @type {any} */ (m).matches ?? []).some((/** @type {any} */ x) => x.source === 'custom' && x.model === 'mock'))?.[0] ?? '';
        if (!mockName) throw new Error(`no Model matching custom/mock in ${J(Object.keys(models))}`);

        const doc = await getDoc(ids.sola);
        const lids = Object.keys(doc.loadouts);
        if (lids.length !== 1) throw new Error(`Sola has ${lids.length} loadouts at setup`);
        lo.R = lids[0];
        const rEnabled = doc.loadouts[lo.R].enabled;
        const cands = flat(doc).filter((/** @type {any} */ e) => e.rank === 'item' && e.leaf.kind === 'block');
        const found = [];
        for (const e of cands) {
            if (await exists(`li.pm-node[data-key="${e.leaf.key}"] > .pm-row input.pm-switch[type=checkbox]`)) found.push(e.leaf);
            if (found.length === 2) break;
        }
        if (found.length < 2) throw new Error('fewer than two block rows with a checkbox switch');
        [X, Y] = [identOf(found[0]), identOf(found[1])];
        [keyX, keyY] = [found[0].key, found[1].key];
        r0x = !!rEnabled[X]; r0y = !!rEnabled[Y];
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, FF + Sola imported, Sola in the slot and open, Models seeded', true,
        `ff=${ids.ff} sola=${ids.sola} R=${lo.R} mock=${J(mockName)} X=${X}(r0x=${r0x}) Y=${Y}(r0y=${r0y})`);

    if (wanted('l1')) await sectionL1();
    if (wanted('l2')) await sectionL2();
    if (wanted('l3')) await sectionL3();
    if (wanted('l4')) await sectionL4();
    if (wanted('l5')) await sectionL5();
    if (wanted('l7')) await sectionL7();
    if (wanted('l8')) await sectionL8();
    if (wanted('l6')) await sectionL6();
    if (wanted('l9')) await sectionL9();

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
