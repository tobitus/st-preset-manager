#!/usr/bin/env node
/**
 * Linked groups (a group row's `remote` members: leaves elsewhere in the same
 * sequence that count as members of the group) acceptance, one real-browser
 * script. Drives the ACTUAL v2 window in a headless Chromium over raw CDP and
 * observes the plugin REST API and ST's live chat-completion state.
 *
 *   node dev/check-linked.mjs            all sections (resets dev data first)
 *   node dev/check-linked.mjs l1 l3      a subset of sections (each one that
 *                                        needs l1's setup rebuilds it over REST)
 *
 * Fixture: a synthetic ST preset "Linked Check" (POSTed over REST) with the
 * prompts la..lf (la, lb, lc, chatHistory, ld, le, lf; lc..lf disabled).
 *
 * Sections:
 *   l1 "Make group from selection" on two NON-adjacent rows (la, ld, Ctrl-click):
 *      the ST popup says "not adjacent"; OK (Pick one, No heading) sends exactly
 *      one `createGroup` op with linked: true, one undo step / one revision; a
 *      headerless pick-one group [la] whose `remote` is [ld]; the prompt order is
 *      unchanged; the outline shows one option row, one `li.pm-remote-ref` and a
 *      link badge on ld's own row; Ctrl+Z removes it all
 *   l2 A real click on the linked reference's radio sends exactly one `setGroup`
 *      op {group, identifier: ld}; ld on, la off, outline re-rendered, ST converges
 *   l3 Ticking la in ST's own prompt-manager panel wins: PM switches the linked
 *      ld off, the reference radio unchecks, ST converges with one of la/ld on
 *   l4 Moving ld's own row down sends one `moveLeaf` op; the group keeps
 *      remote = [ld] and the reference row's #pos follows
 *   l5 The reference's unlink button sends one `unlink` op: the group loses
 *      `remote`, the enabled bits are unchanged, ld's row loses the badge
 *   l6 Re-link over REST, then delete the ld block through the UI (Delete,
 *      Confirm delete): the doc stays valid (GET 200), the group has no `remote`,
 *      no reference row remains
 * Screenshots (dev/shots/): linked-l1-popup.png, linked-l1-group.png,
 *   linked-l1-undone.png, linked-l2-picked.png, linked-l3-st-tick.png,
 *   linked-l4-moved.png, linked-l5-unlinked.png, linked-l6-deleted.png.
 *
 * Environment: the dev container st-pm-dev on 127.0.0.1:8003 with the plugin
 * (PM_DEV_PORT=8003 PM_CHROME=$PWD/dev/chromium-podman.sh; dev/up.sh); NEVER
 * :8001. It RESETS the dev data (dev/reset.sh) first. Never touches the
 * sillytavern container or the live ST checkout.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';
import { flattenSeq } from '../shared/outline.js';

const TAB = 'chklink';
const SHOTS = path.join(REPO, 'dev', 'shots');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-linked.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const args = process.argv.slice(2);
const wanted = (/** @type {string} */ name) => args.length === 0 || args.includes(name);
const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { p: '' };

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);

const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
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

/** ST shows the slot and its order (with enabled bits) equals the compiled slot. */
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
const libRow = (/** @type {string} */ id) => `#pm-window .pm-library-row[data-preset-id="${id}"]`;

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

async function check(/** @type {string} */ name, /** @type {() => Promise<string>} */ body) {
    try {
        report(name, true, await body());
    } catch (err) {
        report(name, false, /** @type {Error} */ (err).message);
    }
}
const must = (/** @type {any} */ cond, /** @type {string} */ msg) => { if (!cond) throw new Error(msg); };

/** Real mouse click at an element's centre (scrolled into view), with CDP modifiers (2 = Ctrl, 8 = Shift). */
async function mouseClickSel(/** @type {string} */ sel, modifiers = 0) {
    await probe.eval(`document.querySelector(${J(sel)})?.scrollIntoView({ block: 'center' })`);
    await sleep(100);
    const p = await probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 40), y: b.y + b.height / 2 }; })()`);
    if (!p) throw new Error(`no element ${sel}`);
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, modifiers });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1, modifiers });
}

/** Record page POSTs to /ops (full bodies) from now on. */
const recordOps = () => probe.eval(`(() => {
    window.__chkOps = [];
    window.__chkFetch0 = window.__chkFetch0 ?? window.fetch;
    const orig = window.__chkFetch0;
    window.fetch = (...args) => {
        const url = String(args[0]?.url ?? args[0]);
        if (url.includes('/api/plugins/st-preset-manager/presets/') && url.endsWith('/ops') && (args[1]?.method ?? 'GET') === 'POST') {
            try { window.__chkOps.push(JSON.parse(String(args[1]?.body ?? '{}'))); } catch { window.__chkOps.push('?'); }
        }
        return orig(...args);
    };
    return true; })()`);
const opsSeen = () => probe.eval('window.__chkOps ?? []');

// ------------------------------------------------------------------ check helpers

const ORDER = ['la', 'lb', 'lc', 'chatHistory', 'ld', 'le', 'lf'];
/** Leaf keys by identifier, filled in main(); GK is the key of the group built by l1/setupGroup. */
/** @type {Record<string, string>} */
const K = {};
const S = { gk: '' };

const history = async () => (await api('GET', `/presets/${ids.p}/history`)).json;
const en = (/** @type {any} */ d) => d.loadouts[d.activeLoadoutId].enabled;
/** Every loadout's enabled map and overrides, as one comparable string. */
const enabledState = (/** @type {any} */ doc) => J(Object.values(doc.loadouts).map((/** @type {any} */ l) => [l.id, l.enabled, l.overrides]));

/** Every group row of the doc's first sequence (any section depth). */
function groupsOf(/** @type {any} */ doc) {
    /** @type {any[]} */ const out = [];
    const walk = (/** @type {any[]} */ rows) => {
        for (const r of rows ?? []) {
            if (r.kind === 'group') out.push(r);
            else if (r.kind === 'section') walk(r.rows);
        }
    };
    walk(doc.sequences[0].rows);
    return out;
}
const optIds = (/** @type {any} */ g) => (g.options ?? []).map(identOf);
/** The one group holding la (as an option). */
const laGroup = (/** @type {any} */ doc) => groupsOf(doc).find((g) => optIds(g).includes('la')) ?? null;

const gli = () => `${view(ids.p)} li.pm-node[data-kind="group"][data-node-key="${S.gk}"]`;
const optRadio = () => `${gli()} > ul.pm-list > li.pm-node .pm-switch`;
const remoteLi = () => `${gli()} > ul.pm-remote-list > li.pm-remote-ref`;
const remoteSwitch = () => `${remoteLi()} input.pm-switch`;
const remotePos = () => `${remoteLi()} .pm-remote-pos`;
const badgeOf = (/** @type {string} */ ident) => `${rowLi(ids.p, K[ident])} > .pm-row button.pm-link-badge`;
const checked = (/** @type {string} */ sel) => probe.eval(`[...document.querySelectorAll(${J(sel)})].map((el) => el.checked)`);
const count = (/** @type {string} */ sel) => probe.eval(`document.querySelectorAll(${J(sel)}).length`);
const selectedCount = () => count(`${view(ids.p)} li.pm-node > .pm-row.pm-selected`);
/** 1-based flat row number of `ident` in the doc. */
const posOf = (/** @type {any} */ doc, /** @type {string} */ ident) => flat(doc).findIndex((e) => identOf(e.leaf) === ident) + 1;

/** ST's enabled bit of a prompt in its live prompt_order. */
const stBit = (/** @type {any} */ c, /** @type {string} */ id) => c.s.order.find((/** @type {any} */ o) => o.identifier === id)?.enabled;

/** ST's own prompt-manager tick (dev/check-loadouts.mjs clickStToggle). */
const clickStToggle = (/** @type {string} */ id) => probe.eval(`(() => { if (document.querySelector('.pm-apply-blocker')) return false; const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${id}"] .prompt-manager-toggle-action'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`);

/** A real key press via CDP (modifiers: 2 = Ctrl, 8 = Shift). */
async function pressKey(/** @type {string} */ key, /** @type {string} */ code, /** @type {number} */ vk, modifiers = 0) {
    await probe.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
    await probe.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
}

/** Click row names: the first plainly, the rest with Ctrl; wait until exactly `keys.length` rows are selected (one retry: a fresh page can swallow the first click). */
async function selectRows(/** @type {string[]} */ keys) {
    const name = (/** @type {string} */ k) => `${rowLi(ids.p, k)} > .pm-row .pm-name`;
    for (let attempt = 1; ; attempt++) {
        await dismissPopups();
        await mouseClickSel(name(keys[0]));
        for (const k of keys.slice(1)) await mouseClickSel(name(k), 2);
        try {
            await until(async () => (await selectedCount()) === keys.length, 5000, `${keys.length} rows selected`);
            return;
        } catch (err) {
            if (attempt >= 2) throw err;
        }
    }
}

async function selectRow(/** @type {string} */ key) {
    const nameSel = `${rowLi(ids.p, key)} > .pm-row .pm-name`;
    await probe.eval(`document.querySelector(${J(nameSel)})?.scrollIntoView({ block: 'center' })`);
    if (!(await click(nameSel))) throw new Error(`no row ${key}`);
    await until(() => exists(`${rowLi(ids.p, key)} > .pm-row.pm-selected`), 5000, `row ${key} selected`);
}

/** REST: toggle one block in the active loadout. */
async function setOn(/** @type {string} */ id, /** @type {boolean} */ value) {
    const res = await op(ids.p, { op: 'toggle', identifier: id, value });
    must(res.status === 200, `toggle ${id}=${value} failed: HTTP ${res.status} ${J(res.json)}`);
}

/** REST: the linked pick-one group LG [la] + remote [ld], la ON and ld OFF; ST converged; the group li rendered. */
async function setupGroup() {
    const doc = await getDoc(ids.p);
    must(!laGroup(doc), 'precondition: no group holds la');
    const res = await op(ids.p, { op: 'createGroup', keys: [K.la, K.ld], cardinality: 'pick-one', name: 'LG', linked: true });
    must(res.status === 200, `createGroup failed: HTTP ${res.status} ${J(res.json)}`);
    const d = await getDoc(ids.p);
    const g = laGroup(d);
    must(g && J(g.remote) === J([K.ld]), `setup group ${J(g)}`);
    S.gk = g.key;
    if (en(d).la !== true) await setOn('la', true);
    if (en(d).ld !== false) await setOn('ld', false);
    await convergedOn(ids.p, 'converged after the group setup');
    await until(() => exists(remoteLi()), 10000, 'reference row rendered');
}

// ------------------------------------------------------------------ l1

async function sectionL1() {
    await check('l1 Make group from selection on non-adjacent rows: one linked createGroup, headerless pick-one [la] + remote [ld]; Ctrl+Z undoes', async () => {
        const doc0 = await getDoc(ids.p);
        const h0 = await history();
        const order0 = flat(doc0).map((e) => identOf(e.leaf));
        must(J(order0) === J(ORDER), `precondition: order ${J(order0)}`);
        await selectRows([K.la, K.ld]);
        const btn = `${view(ids.p)} .pm-rank-make-group-sel`;
        await until(() => probe.eval(`(() => { const b = document.querySelector(${J(btn)}); return !!b && !b.classList.contains('pm-disabled'); })()`), 8000, 'Make group button enabled');
        await recordOps();
        await mouseClickSel(btn);
        await until(() => exists('dialog[open] .pm-mkgrp-form'), 8000, 'make-group popup open');
        const first = await probe.eval(`document.querySelector('dialog[open] .pm-mkgrp-form div')?.textContent ?? null`);
        must(first && first.includes('not adjacent'), `first div text ${J(first)} lacks "not adjacent"`);
        const hasNone = await probe.eval(`[...document.querySelector('dialog[open] select.pm-mkgrp-heading').options].some((o) => o.value === '')`);
        must(hasNone, 'heading select has no "No heading" option');
        await probe.eval(`(() => {
            const s = document.querySelector('dialog[open] select.pm-mkgrp-heading');
            s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true }));
            const r = document.querySelector('dialog[open] input[name="pm-mkgrp-card"][value="pick-one"]');
            if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
            return true; })()`);
        const card = await probe.eval(`document.querySelector('dialog[open] input[name="pm-mkgrp-card"]:checked')?.value ?? null`);
        must(card === 'pick-one', `cardinality ${J(card)}, want pick-one`);
        must((await probe.eval(`document.querySelector('dialog[open] select.pm-mkgrp-heading').value`)) === '', 'heading is not "No heading"');
        await shot('linked-l1-popup.png', 'page');
        must(await click('dialog[open] .popup-button-ok'), 'no popup OK button');
        const doc = await until(async () => {
            const d = await getDoc(ids.p);
            return laGroup(d) ? d : null;
        }, 8000, 'group holding la exists');
        const seen = await opsSeen();
        must(seen.length === 1, `expected exactly one op, saw ${J(seen)}`);
        const o = seen[0];
        must(o.op === 'createGroup' && o.linked === true, `op ${J(o)}, want createGroup linked:true`);
        must(J([...o.keys].sort()) === J([K.la, K.ld].sort()), `op keys ${J(o.keys)}`);
        must(!o.headerKey, `op headerKey ${J(o.headerKey)}, want none`);
        must(o.cardinality === 'pick-one', `op cardinality ${J(o.cardinality)}`);
        const h1 = await history();
        must(h1.undo === h0.undo + 1, `undo depth ${h0.undo} -> ${h1.undo}, want +1`);
        must(doc.rev === doc0.rev + 1, `rev ${doc0.rev} -> ${doc.rev}, want +1`);
        const g = laGroup(doc);
        must(!g.header, `group has a heading ${J(g.header)}, want headerless`);
        must(g.cardinality === 'pick-one', `cardinality ${g.cardinality}`);
        must(J(optIds(g)) === J(['la']), `options ${J(optIds(g))}, want ["la"]`);
        must(J(g.remote) === J([K.ld]), `remote ${J(g.remote)}, want [${K.ld}]`);
        must(J(flat(doc).map((e) => identOf(e.leaf))) === J(ORDER), 'prompt order changed');
        S.gk = g.key;
        await until(() => exists(gli()), 10000, 'group li rendered');
        await until(() => exists(remoteLi()), 10000, 'reference row rendered');
        must((await count(`${gli()} > ul.pm-list > li.pm-node`)) === 1, 'group li does not have exactly one option li');
        must((await count(remoteLi())) === 1, 'group li does not have exactly one li.pm-remote-ref');
        const pos = await text(remotePos());
        const wantPos = `#${posOf(doc, 'ld')}`;
        must(await exists(`${remotePos()} i.fa-link`), 'reference pos has no chain icon');
        must(pos?.trim() === wantPos, `reference pos ${J(pos)}, want ${J(wantPos)}`);
        must(await exists(badgeOf('ld')), 'ld row has no button.pm-link-badge');
        const badgeText = (await text(badgeOf('ld')))?.trim();
        must(badgeText === '(options)', `ld badge text ${J(badgeText)}, want the group row's name "(options)"`);
        must((await popupText()) === null, 'an ST popup is open');
        await shot('linked-l1-group.png');
        // the badge selects (and flashes) the group row; the jump button flashes ld's own row
        await mouseClickSel(badgeOf('ld'));
        await until(() => exists(`${gli()} > .pm-row.pm-selected`), 5000, 'badge click selected the group row');
        must((await selectedCount()) === 1, 'badge click left more than the group row selected');
        await mouseClickSel(`${remoteLi()} button.pm-remote-jump`);
        await until(() => exists(`${rowLi(ids.p, K.ld)}.pm-flash`), 3000, 'jump flashed ld\'s own row');
        must(await exists(`${gli()} > .pm-row.pm-selected`), 'the jump click changed the selection');

        await probe.eval(`document.querySelector(${J(`${view(ids.p)} .pm-outline`)}).focus()`);
        await pressKey('z', 'KeyZ', 90, 2);
        await until(async () => {
            const d = await getDoc(ids.p);
            return !laGroup(d) && !groupsOf(d).some((x) => x.remote);
        }, 8000, 'Ctrl+Z removed the group');
        must((await history()).undo === h0.undo, 'undo depth after Ctrl+Z is not back to the start');
        await until(async () => (await count(`${view(ids.p)} li.pm-remote-ref`)) === 0, 8000, 'no reference rows after undo');
        await convergedOn(ids.p, 'converged after undo');
        await shot('linked-l1-undone.png');
        await setupGroup();
        return `createGroup ${J({ keys: o.keys, linked: o.linked, cardinality: o.cardinality })}; rev ${doc0.rev} -> ${doc.rev}; history ${J(h0)} -> ${J(h1)}; ${wantPos}`;
    });
}

// ------------------------------------------------------------------ l2

async function sectionL2() {
    await check('l2 clicking the reference radio sends one setGroup op: ld on, la off, ST converges', async () => {
        must(await exists(remoteLi()), 'no reference row (needs the l1 setup)');
        must((await en(await getDoc(ids.p))).la === true && (await en(await getDoc(ids.p))).ld === false, 'precondition: la on, ld off');
        const type = await probe.eval(`document.querySelector(${J(remoteSwitch())})?.type ?? null`);
        must(type === 'radio', `reference switch type ${J(type)}, want radio`);
        const ownType = await probe.eval(`document.querySelector(${J(`${rowLi(ids.p, K.ld)} > .pm-row input.pm-switch`)})?.type ?? null`);
        must(ownType === 'radio', `ld's own-position switch type ${J(ownType)}, want radio`);
        await recordOps();
        await mouseClickSel(remoteSwitch());
        await until(async () => en(await getDoc(ids.p)).ld === true, 8000, 'ld on');
        const seen = await opsSeen();
        must(seen.length === 1, `expected one op, saw ${J(seen)}`);
        must(seen[0].op === 'setGroup' && seen[0].group === S.gk && seen[0].identifier === 'ld', `unexpected op ${J(seen[0])}`);
        const e = en(await getDoc(ids.p));
        must(e.ld === true && e.la === false, `bits la/ld = ${e.la}/${e.ld}`);
        await until(async () => J(await checked(remoteSwitch())) === J([true]) && J(await checked(optRadio())) === J([false]), 8000, 'reference radio checked, option radio unchecked');
        const c = await convergedOn(ids.p, 'converged after the reference click');
        must(J(c.s.order.map((/** @type {any} */ o) => o.identifier)) === J(ORDER), `ST order ${J(c.s.order.map((/** @type {any} */ o) => o.identifier))}`);
        must(stBit(c, 'ld') === true && stBit(c, 'la') === false, `ST la/ld = ${stBit(c, 'la')}/${stBit(c, 'ld')}`);
        await shot('linked-l2-picked.png');
        return `op ${J(seen[0])}; ST la/ld = false/true`;
    });
}

// ------------------------------------------------------------------ l3

async function sectionL3() {
    await check('l3 ticking la in ST\'s own panel wins: ld goes off, reference radio unchecks, ST converges', async () => {
        const d0 = await getDoc(ids.p);
        must(en(d0).la === false && en(d0).ld === true, `precondition: la/ld = ${en(d0).la}/${en(d0).ld}`);
        await until(() => clickStToggle('la'), 8000, 'ST panel tick on la');
        await until(async () => {
            const e = en(await getDoc(ids.p));
            return e.la === true && e.ld === false;
        }, 15000, 'doc shows la on, ld off');
        await until(async () => J(await checked(remoteSwitch())) === J([false]) && J(await checked(optRadio())) === J([true]), 8000, 'reference radio unchecked, option radio checked');
        const c = await convergedOn(ids.p, 'converged after the ST tick');
        must(stBit(c, 'la') === true && stBit(c, 'ld') === false, `ST la/ld = ${stBit(c, 'la')}/${stBit(c, 'ld')}`);
        await shot('linked-l3-st-tick.png');
        // Q6: the switch at the member's own position sends the same op
        await recordOps();
        await mouseClickSel(`${rowLi(ids.p, K.ld)} > .pm-row input.pm-switch`);
        await until(async () => en(await getDoc(ids.p)).ld === true, 8000, 'ld on via its own-position radio');
        const seen = await opsSeen();
        must(seen.length === 1 && seen[0].op === 'setGroup' && seen[0].group === S.gk && seen[0].identifier === 'ld', `own-position click ops ${J(seen)}`);
        const e = en(await getDoc(ids.p));
        must(e.la === false, `la still on after the own-position pick (${J(e)})`);
        await convergedOn(ids.p, 'converged after the own-position pick');
        return 'doc la/ld = true/false; ST la/ld = true/false; reference radio unchecked; own-position radio -> one setGroup, la off';
    });
}

// ------------------------------------------------------------------ l4

async function sectionL4() {
    await check('l4 moving ld\'s own row down sends one moveLeaf op; remote stays [ld], the reference #pos follows', async () => {
        const d0 = await getDoc(ids.p);
        const pos0 = posOf(d0, 'ld');
        await selectRow(K.ld);
        await recordOps();
        must(await click(`${view(ids.p)} .pm-move-down`), 'no .pm-move-down');
        await until(async () => posOf(await getDoc(ids.p), 'ld') === pos0 + 1, 8000, 'ld moved down one row');
        const seen = await opsSeen();
        must(seen.length === 1 && seen[0].op === 'moveLeaf' && seen[0].key === K.ld, `ops ${J(seen)}, want one moveLeaf on ${K.ld}`);
        const g = laGroup(await getDoc(ids.p));
        must(g && J(g.remote) === J([K.ld]), `remote ${J(g?.remote)}, want [${K.ld}]`);
        const want = `#${pos0 + 1}`;
        await until(async () => (await text(remotePos()))?.trim() === want, 8000, `reference pos reads ${want}`);
        await convergedOn(ids.p, 'converged after the move');
        await shot('linked-l4-moved.png');
        return `op ${J(seen[0])}; ld row ${pos0} -> ${pos0 + 1}; reference ${want}`;
    });
}

// ------------------------------------------------------------------ l5

async function sectionL5() {
    await check('l5 the reference\'s unlink button sends one unlink op: group has no remote, bits unchanged, no badge', async () => {
        const d0 = await getDoc(ids.p);
        must(await exists(`${remoteLi()} button.pm-remote-unlink`), 'no button.pm-remote-unlink');
        await recordOps();
        await mouseClickSel(`${remoteLi()} button.pm-remote-unlink`);
        await until(async () => !laGroup(await getDoc(ids.p))?.remote, 8000, 'group lost its remote');
        const seen = await opsSeen();
        must(seen.length === 1 && seen[0].op === 'unlink' && seen[0].key === S.gk && J(seen[0].keys) === J([K.ld]), `ops ${J(seen)}, want one unlink {key ${S.gk}, keys [${K.ld}]}`);
        const d1 = await getDoc(ids.p);
        must(enabledState(d1) === enabledState(d0), `enabled bits changed: ${enabledState(d0)} -> ${enabledState(d1)}`);
        await until(async () => (await count(`${view(ids.p)} li.pm-remote-ref`)) === 0, 8000, 'no reference rows');
        await until(async () => !(await exists(badgeOf('ld'))), 8000, 'ld badge gone');
        await shot('linked-l5-unlinked.png');
        return `op ${J(seen[0])}; bits unchanged; no remote, no reference, no badge`;
    });
}

// ------------------------------------------------------------------ l6

async function sectionL6() {
    await check('l6 re-link, then deleting the ld block through the UI leaves a valid doc: no remote, no reference row', async () => {
        const res = await op(ids.p, { op: 'linkToGroup', key: S.gk, keys: [K.ld] });
        must(res.status === 200, `linkToGroup failed: HTTP ${res.status} ${J(res.json)}`);
        await until(() => exists(remoteLi()), 10000, 'reference row rendered after re-link');
        await selectRow(K.ld);
        const delBtn = `${view(ids.p)} .pm-block-delete`;
        must(await click(delBtn), 'no Delete button');
        must((await text(delBtn)) === 'Confirm delete', 'first click did not arm');
        await click(delBtn);
        await until(async () => !(await getDoc(ids.p)).blocks.ld, 8000, 'ld block deleted');
        const r = await api('GET', `/presets/${ids.p}`);
        must(r.status === 200, `GET /presets/:id -> HTTP ${r.status}`);
        const g = laGroup(r.json);
        must(g, 'the group holding la is gone');
        must(!g.remote, `group still has remote ${J(g.remote)}`);
        must(!flat(r.json).some((e) => identOf(e.leaf) === 'ld'), 'ld row still in the sequence');
        await until(async () => (await count(`${view(ids.p)} li.pm-remote-ref`)) === 0, 8000, 'no reference rows in the outline');
        await shot('linked-l6-deleted.png');
        return `HTTP 200; group ${S.gk} has no remote; no li.pm-remote-ref`;
    });
}

// ------------------------------------------------------------------ main

/**
 * Synthetic ST preset: la, lb, lc, chatHistory, ld, le, lf; lc..lf disabled.
 * ST's PromptManager appends its default prompts (main, nsfw, …) to any preset
 * lacking them, so the slot would never equal the compile; carry ST's own
 * defaults (read from the page) in `prompts`, outside the order, as a real ST
 * export does (cf. check-round3 n1).
 * @param {any[]} stDefaults
 */
function fixture(stDefaults) {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const prompts = names.map((n) => ({ identifier: `l${n}`, name: `L ${n.toUpperCase()}`, content: `text ${n}`, role: 'system', system_prompt: false, marker: false }));
    prompts.push(...stDefaults);
    return {
        prompts,
        prompt_order: [{ character_id: 100001, order: ORDER.map((identifier) => ({ identifier, enabled: !['lc', 'ld', 'le', 'lf'].includes(identifier) })) }],
    };
}
const ST_DEFAULTS = ['main', 'nsfw', 'dialogueExamples', 'jailbreak', 'chatHistory', 'worldInfoAfter', 'worldInfoBefore', 'enhanceDefinitions', 'charDescription', 'charPersonality', 'scenario', 'personaDescription'];

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

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
        await probe.eval(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pm.')) localStorage.removeItem(k); return true; })()`);
        await reloadPage();
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    const stDefaults = await probe.eval(`SillyTavern.getContext().chatCompletionSettings.prompts.filter((p) => ${J(ST_DEFAULTS)}.includes(p.identifier))`);
    if (stDefaults.length !== ST_DEFAULTS.length) fatal('setup', `ST shows ${stDefaults.length} of the ${ST_DEFAULTS.length} default prompts`);
    const imp = await api('POST', '/presets', { st: fixture(stDefaults), name: 'Linked Check' });
    if (imp.status !== 200 && imp.status !== 201) fatal('setup', `fixture import HTTP ${imp.status} ${J(imp.json)}`);
    ids.p = imp.json?.id ?? '';
    if (!ids.p) fatal('setup', `fixture import has no id: ${J(imp.json)?.slice(0, 200)}`);
    const doc = await getDoc(ids.p);
    const rows = flat(doc);
    if (J(rows.map((e) => identOf(e.leaf))) !== J(ORDER)) fatal('setup', `fixture rows ${J(rows.map((e) => identOf(e.leaf)))}, want ${J(ORDER)}`);
    if (rows.some((e) => e.rank !== 'item' && e.leaf.kind !== 'marker')) fatal('setup', `fixture was auto-structured: ${J(rows.map((e) => e.rank))}`);
    for (const e of rows) K[identOf(e.leaf)] = e.leaf.key;
    const bits = en(doc);
    if (!doc.activeLoadoutId || ORDER.some((i) => i !== 'chatHistory' && bits[i] !== !['lc', 'ld', 'le', 'lf'].includes(i))) fatal('setup', `fixture bits ${J(bits)}`);
    if ((await api('POST', '/slot/load', { presetId: ids.p })).status !== 200) fatal('setup', 'slot_load failed');

    try {
        await convergedOn(ids.p, 'fixture converged in the slot');
        await openWindow();
        await showTab('presets');
        await openFromLibrary(ids.p);
        await showTab('presets');
        await until(() => exists(`${view(ids.p)} .pm-outline li.pm-node`), 10000, 'fixture view');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, Linked Check imported over REST (with ST\'s default prompts), in the slot and open, clean pm.* localStorage', true, `preset=${ids.p} keys=${J(K)}`);

    // sections after l1 need its end state; a subset run rebuilds it over REST
    if (wanted('l1')) await sectionL1();
    else if (args.some((a) => /^l[2-6]$/.test(a))) await setupGroup();
    if (wanted('l2')) await sectionL2();
    if (wanted('l3')) await sectionL3();
    if (wanted('l4')) await sectionL4();
    if (wanted('l5')) await sectionL5();
    if (wanted('l6')) await sectionL6();

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
