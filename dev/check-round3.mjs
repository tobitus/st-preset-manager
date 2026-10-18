#!/usr/bin/env node
/**
 * Round 3 (a pick-one group's HEADING is never a member) acceptance, one
 * real-browser script. Drives the ACTUAL v2 window in a headless Chromium over
 * raw CDP and observes the plugin REST API and ST's live chat-completion state.
 *
 *   node dev/check-round3.mjs            all sections (resets dev data first)
 *   node dev/check-round3.mjs h1 h3      a subset of sections
 *
 * Sections:
 *   h1 A group heading row renders an ordinary checkbox (input.pm-switch of
 *      type checkbox); a real mouse click on it sends exactly one `toggle` op
 *      on the heading's own bit
 *   h2 Flipping a group to pick-one (badge click) with its heading ON succeeds:
 *      one `setCardinality` op, no ST popup; options become radios, the heading
 *      stays a checked checkbox, the enabled bits are unchanged and ST converges
 *   h3 The "none" radio clears every option and leaves the heading ON; control:
 *      a comment-only heading (Freaky Frankenstein's POV group) renders no switch
 *   g1 "Make group from selection" (3 rows multi-selected, Ctrl-click): the ST
 *      confirm popup defaults (heading = first row, pick-one); OK sends exactly one
 *      `createGroup` op, one undo step / one revision, a headed pick-one group; Ctrl+Z removes it
 *   g2 A non-adjacent selection (now a linked group: the popup title says "not
 *      adjacent") made pick-one with no heading while both rows are ON: the
 *      server refusal (409 "more than one option currently selected") shows in
 *      a second ST TEXT popup and the doc is unchanged
 *   n1 A pre-round-3 Nemo native document (dev/fixtures/native/nemo-adjacent-pre-r3.json)
 *      upgrades on import: each headed pick-one group gets a default comment-only
 *      heading, the former heading becomes option 0, loadout bits and overrides
 *      are unchanged (root loadouts also enable the new headings), the compiled
 *      ST text equals the pre-upgrade compile; the outline shows no switch on the
 *      heading and a radio on the first option
 *   s1 Sola V3 Flame imports through the Library UI: notes, 10 sections, 8
 *      pick-one groups (badge 1), the two Story Grounding rows plain checkboxes,
 *      and section 0's long MIND text reaches ST
 * Screenshots (dev/shots/): round3-h1-heading-checkbox.png,
 *   round3-h2-pick-one.png, round3-h3-none.png, round3-g1-popup.png,
 *   round3-g1-group.png, round3-g2-refusal.png, round3-n1-upgraded.png,
 *   round3-s1-import.png, round3-s1-outline.png.
 *
 * Environment: the dev container st-pm-dev on 127.0.0.1:8003 (PM_DEV_PORT=8003) with the plugin
 * (dev/up.sh); NEVER :8001. It RESETS the dev data (dev/reset.sh) first.
 * Never touches the sillytavern container or the live ST checkout.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    FF, Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';
import { isCommentOnly } from '../shared/groups.js';
import { compile } from '../shared/compile.js';
import { flattenSeq } from '../shared/outline.js';

const TAB = 'chkr3';
const SOLA = 'Sola V2 Flame';
const SHOTS = path.join(REPO, 'dev', 'shots');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-round3.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const args = process.argv.slice(2);
const wanted = (/** @type {string} */ name) => args.length === 0 || args.includes(name);
const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { ff: '', sola: '' };

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

/** The cardinality badge of the group `li` selector. */
const badge = (/** @type {string} */ sel) => `${sel} > .pm-row > .pm-card`;
const badgeText = async (/** @type {string} */ sel) => (await text(badge(sel)))?.trim() ?? null;

/**
 * Setup values, filled in main() once Sola is fetched: the heading H and the
 * two options O1/O2 of the group built in h1 (identifiers and leaf keys); G0..G2
 * (GK*) three plain rows for g1; SA/SB (SAK/SBK) two plain rows for g2.
 * @type {{ H: string, HK: string, O1: string, K1: string, O2: string, K2: string,
 *   G0: string, GK0: string, G1: string, GK1: string, G2: string, GK2: string,
 *   SA: string, SAK: string, SB: string, SBK: string, gj: number, sm: number }}
 */
const S = {
    H: '', HK: '', O1: '', K1: '', O2: '', K2: '',
    G0: '', GK0: '', G1: '', GK1: '', G2: '', GK2: '',
    SA: '', SAK: '', SB: '', SBK: '', gj: -1, sm: -1,
};

const gli = () => `${view(ids.sola)} li.pm-node[data-kind="group"][data-key="${S.HK}"]`;
const headSw = () => `${gli()} > .pm-row > input.pm-switch`;
const optSw = () => `${gli()} > ul.pm-list > li.pm-node .pm-switch`;
const noneSel = () => `${gli()} > .pm-row .pm-none`;

/** The active loadout's enabled map of Sola. */
const en = async () => {
    const d = await getDoc(ids.sola);
    return d.loadouts[d.activeLoadoutId].enabled;
};

/** The group row of `doc` (any depth, incl. section rows) whose heading is S.H. */
const grp = (/** @type {any} */ doc) => {
    const find = (/** @type {any[]} */ rows) => {
        for (const r of rows ?? []) {
            if (r.kind === 'group' && r.header && (r.header.ref ?? r.header.identifier) === S.H) return r;
            if (r.kind === 'section') {
                const hit = find(r.rows);
                if (hit) return hit;
            }
        }
        return null;
    };
    return find(doc.sequences[0].rows);
};

async function setOn(/** @type {string} */ id, /** @type {boolean} */ value) {
    const res = await op(ids.sola, { op: 'toggle', identifier: id, value });
    must(res.status === 200, `toggle ${id}=${value} failed: HTTP ${res.status} ${J(res.json)}`);
}

/** `.checked` of every element matching `sel`. */
const checked = (/** @type {string} */ sel) => probe.eval(`[...document.querySelectorAll(${J(sel)})].map((el) => el.checked)`);
const typesOf = (/** @type {string} */ sel) => probe.eval(`[...document.querySelectorAll(${J(sel)})].map((el) => el.type)`);

/** Make the group's cardinality pick-one-or-more over REST when it is not already. */
async function ensureOrMore() {
    const g = grp(await getDoc(ids.sola));
    must(g, 'group missing');
    if (g.cardinality !== 'pick-one-or-more') {
        const res = await op(ids.sola, { op: 'setCardinality', key: g.key, cardinality: 'pick-one-or-more' });
        must(res.status === 200, `setCardinality pick-one-or-more failed: HTTP ${res.status} ${J(res.json)}`);
    }
}

/** A real key press via CDP (modifiers: 2 = Ctrl, 8 = Shift). */
async function pressKey(/** @type {string} */ key, /** @type {string} */ code, /** @type {number} */ vk, modifiers = 0) {
    await probe.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
    await probe.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
}

const history = async () => (await api('GET', `/presets/${ids.sola}/history`)).json;
const selectedCount = () => probe.eval(`document.querySelectorAll(${J(`${view(ids.sola)} li.pm-node > .pm-row.pm-selected`)}).length`);

/** Click the first row's name, Ctrl-click the rest, wait until exactly keys.length rows are selected. */
async function selectThree(/** @type {string[]} */ keys) {
    const name = (/** @type {string} */ k) => `${rowLi(ids.sola, k)} > .pm-row .pm-name`;
    await mouseClickSel(name(keys[0]));
    for (const k of keys.slice(1)) await mouseClickSel(name(k), 2);
    await until(async () => (await selectedCount()) === keys.length, 8000, `${keys.length} rows selected`);
}

/** The group row of `doc` (any depth, incl. section rows) headed by `ident`. */
const grpOf = (/** @type {any} */ doc, /** @type {string} */ ident) => {
    const find = (/** @type {any[]} */ rows) => {
        for (const r of rows ?? []) {
            if (r.kind === 'group' && r.header && (r.header.ref ?? r.header.identifier) === ident) return r;
            if (r.kind === 'section') {
                const hit = find(r.rows);
                if (hit) return hit;
            }
        }
        return null;
    };
    return find(doc.sequences[0].rows);
};

// ------------------------------------------------------------------ h1

async function sectionH1() {
    await check('h1 group heading renders an ordinary checkbox; clicking it sends one toggle op on its own bit', async () => {
        for (const body of [{ op: 'promote', key: S.HK }, { op: 'demote', key: S.K1 }, { op: 'demote', key: S.K2 }]) {
            const res = await op(ids.sola, body);
            must(res.status === 200, `${body.op} ${body.key} failed: HTTP ${res.status} ${J(res.json)}`);
        }
        await until(async () => grp(await getDoc(ids.sola))?.options?.length === 2, 8000, 'group has 2 options');
        await ensureOrMore();
        await until(() => exists(gli()), 10000, 'group li rendered');
        must(await exists(headSw()), `no heading switch ${headSw()}`);
        const type = await probe.eval(`document.querySelector(${J(headSw())}).type`);
        must(type === 'checkbox', `heading switch type is ${type}, want checkbox`);
        const badgeNow = await badgeText(gli());
        must(badgeNow === 'N', `badge is ${J(badgeNow)}, want "N"`);
        const was = (await en())[S.H] === true;
        await recordOps();
        await mouseClickSel(headSw());
        await until(async () => (await en())[S.H] === !was, 8000, 'heading bit flipped');
        const seen = await opsSeen();
        must(seen.length === 1, `expected one op, saw ${J(seen)}`);
        must(seen[0].op === 'toggle' && seen[0].identifier === S.H && seen[0].value === !was, `unexpected op ${J(seen[0])}`);
        await until(async () => (await checked(headSw()))[0] === !was, 8000, 'heading checkbox reflects the new bit');
        await shot('round3-h1-heading-checkbox.png');
        return `H=${S.H} ops=${J(seen)} bit ${was} -> ${!was}`;
    });
}

// ------------------------------------------------------------------ h2

async function sectionH2() {
    await check('h2 flipping to pick-one with the heading ON succeeds (no popup); heading stays a checkbox', async () => {
        await setOn(S.H, true);
        await setOn(S.O1, true);
        await setOn(S.O2, false);
        await ensureOrMore();
        await until(async () => (await badgeText(gli())) === 'N' && (await checked(headSw()))[0] === true, 10000, 'badge N and heading checked');
        await recordOps();
        await mouseClickSel(badge(gli()));
        await until(async () => (await badgeText(gli())) === '1', 8000, 'badge reads 1');
        const kinds = (await opsSeen()).map((/** @type {any} */ o) => o.op);
        must(J(kinds) === J(['setCardinality']), `expected ["setCardinality"], saw ${J(kinds)}`);
        const popup = await popupText();
        must(popup === null, `an ST popup appeared: ${popup}`);
        const types = await typesOf(optSw());
        must(types.length === 2 && types.every((/** @type {string} */ t) => t === 'radio'), `option switches ${J(types)}, want 2 radios`);
        must((await typesOf(headSw()))[0] === 'checkbox', 'heading switch is no longer a checkbox');
        must((await checked(headSw()))[0] === true, 'heading checkbox is not checked');
        const d = await getDoc(ids.sola);
        must(grp(d).cardinality === 'pick-one', `cardinality is ${grp(d).cardinality}`);
        const e = d.loadouts[d.activeLoadoutId].enabled;
        must(e[S.H] === true && e[S.O1] === true && e[S.O2] === false, `enabled H/O1/O2 = ${e[S.H]}/${e[S.O1]}/${e[S.O2]}`);
        const c = await convergedOn(ids.sola, 'converged after the flip');
        const bit = (/** @type {string} */ id) => c.s.order.find((/** @type {any} */ o) => o.identifier === id)?.enabled;
        must(bit(S.H) === true && bit(S.O1) === true && bit(S.O2) === false, `ST order H/O1/O2 = ${bit(S.H)}/${bit(S.O1)}/${bit(S.O2)}`);
        await shot('round3-h2-pick-one.png');
        return `H=${S.H} ops=${J(kinds)} radios=${types.length} ST order H/O1/O2 = ${bit(S.H)}/${bit(S.O1)}/${bit(S.O2)}`;
    });
}

// ------------------------------------------------------------------ h3

async function sectionH3() {
    await check('h3 "none" clears every option and leaves the heading ON; a comment-only heading has no switch', async () => {
        await mouseClickSel(noneSel());
        await until(async () => {
            const e = await en();
            return e[S.O1] === false && e[S.O2] === false && e[S.H] === true;
        }, 8000, 'O1/O2 off, H on');
        await until(async () => (await checked(noneSel()))[0] === true
            && (await checked(headSw()))[0] === true
            && (await checked(optSw())).every((/** @type {boolean} */ b) => b === false), 8000, 'none radio checked, heading checked, options unchecked');
        const c = await convergedOn(ids.sola, 'converged after none');
        const bit = (/** @type {string} */ id) => c.s.order.find((/** @type {any} */ o) => o.identifier === id)?.enabled;
        must(bit(S.H) === true && bit(S.O1) === false && bit(S.O2) === false, `ST order H/O1/O2 = ${bit(S.H)}/${bit(S.O1)}/${bit(S.O2)}`);
        await shot('round3-h3-none.png');

        const ff = await getDoc(ids.ff);
        const findComment = (/** @type {any[]} */ rows) => {
            for (const r of rows ?? []) {
                if (r.kind === 'group' && r.header && isCommentOnly(ff.blocks[r.header.ref ?? r.header.identifier]?.content)) return r;
                if (r.kind === 'section') {
                    const hit = findComment(r.rows);
                    if (hit) return hit;
                }
            }
            return null;
        };
        const g = findComment(ff.sequences[0].rows);
        must(g, 'no comment-only-heading group in FF (the POV group)');
        await openFromLibrary(ids.ff);
        const li = `${view(ids.ff)} li.pm-node[data-kind="group"][data-node-key="${g.key}"]`;
        await until(() => exists(li), 10000, 'FF comment-only group li rendered');
        const n = await probe.eval(`document.querySelectorAll(${J(`${li} > .pm-row > input.pm-switch`)}).length`);
        must(n === 0, `comment-only heading renders ${n} switch(es), want 0`);
        return `Sola H=${S.H} stays on, O1/O2 off; FF comment-only group ${g.key} has no switch`;
    });
}

// ------------------------------------------------------------------ g1

async function sectionG1() {
    await check('g1 Make group from selection: one createGroup op, one revision, a headed pick-one group; Ctrl+Z removes it', async () => {
        await openFromLibrary(ids.sola); // h3 leaves the FF view in front
        await setOn(S.G2, false);
        await convergedOn(ids.sola, 'converged before g1');
        const h0 = await history();
        const rev0 = (await getDoc(ids.sola)).rev;
        await selectThree([S.GK0, S.GK1, S.GK2]);
        const btn = `${view(ids.sola)} .pm-rank-make-group-sel`;
        await until(() => probe.eval(`(() => { const b = document.querySelector(${J(btn)}); return !!b && !b.classList.contains('pm-disabled'); })()`), 8000, 'Make group button enabled');
        await recordOps();
        await mouseClickSel(btn);
        await until(() => exists('dialog[open] .pm-mkgrp-form'), 8000, 'make-group popup open');
        const head = await probe.eval(`document.querySelector('dialog[open] select.pm-mkgrp-heading').value`);
        must(head === S.GK0, `heading default ${J(head)}, want ${S.GK0}`);
        const card = await probe.eval(`document.querySelector('dialog[open] input[name="pm-mkgrp-card"]:checked')?.value ?? null`);
        must(card === 'pick-one', `cardinality default ${J(card)}, want pick-one`);
        const opts = await probe.eval(`[...document.querySelector('dialog[open] select.pm-mkgrp-heading').options].map((o) => o.value)`);
        must(J(opts) === J(['', S.GK0, S.GK1, S.GK2]), `heading options ${J(opts)}`);
        await shot('round3-g1-popup.png', 'page');
        must(await click('dialog[open] .popup-button-ok'), 'no popup OK button');
        const doc = await until(async () => {
            const d = await getDoc(ids.sola);
            return grpOf(d, S.G0) ? d : null;
        }, 8000, 'group headed by G0 exists');
        const seen = await opsSeen();
        const want = { op: 'createGroup', keys: [S.GK1, S.GK2], headerKey: S.GK0, cardinality: 'pick-one' };
        const got = seen.map((/** @type {any} */ o) => ({ op: o.op, keys: o.keys, headerKey: o.headerKey, cardinality: o.cardinality }));
        must(seen.length === 1 && J(got[0]) === J(want), `expected exactly ${J(want)}, saw ${J(seen)}`);
        const h1 = await history();
        must(h1.undo === h0.undo + 1, `undo depth ${h0.undo} -> ${h1.undo}, want +1`);
        must(doc.rev === rev0 + 1, `rev ${rev0} -> ${doc.rev}, want +1`);
        const g = grpOf(doc, S.G0);
        const optIds = g.options.map((/** @type {any} */ l) => l.ref ?? l.identifier);
        must(J(optIds) === J([S.G1, S.G2]), `group options ${J(optIds)}`);
        must(g.cardinality === 'pick-one', `cardinality ${g.cardinality}`);
        const gli = `${view(ids.sola)} li.pm-node[data-kind="group"][data-key="${S.GK0}"]`;
        await until(() => exists(gli), 10000, 'group li rendered');
        const headType = await probe.eval(`document.querySelector(${J(`${gli} > .pm-row > input.pm-switch`)})?.type ?? null`);
        must(headType === 'checkbox', `heading switch type ${headType}, want checkbox`);
        const types = await typesOf(`${gli} > ul.pm-list > li.pm-node .pm-switch`);
        must(types.length === 2 && types.every((/** @type {string} */ t) => t === 'radio'), `option switches ${J(types)}, want 2 radios`);
        const b = await badgeText(gli);
        must(b === '1', `badge ${J(b)}, want "1"`);
        const popup = await popupText();
        must(popup === null, `an ST popup is open: ${popup}`);
        await shot('round3-g1-group.png');

        await probe.eval(`document.querySelector(${J(`${view(ids.sola)} .pm-outline`)}).focus()`);
        await pressKey('z', 'KeyZ', 90, 2);
        await until(async () => {
            const d = await getDoc(ids.sola);
            if (grpOf(d, S.G0)) return false;
            const rk = new Map(flat(d).map((/** @type {any} */ r) => [identOf(r.leaf), r.rank]));
            return [S.G0, S.G1, S.G2].every((i) => rk.get(i) === 'item');
        }, 8000, 'Ctrl+Z removed the group');
        const h2 = await history();
        must(h2.undo === h0.undo, `undo depth after Ctrl+Z ${h2.undo}, want ${h0.undo}`);
        await until(async () => !(await exists(gli)), 8000, 'group li gone');
        await convergedOn(ids.sola, 'converged after undo');
        return `createGroup ${J(want)}; rev ${rev0} -> ${doc.rev}; history ${J(h0)} -> ${J(h1)} -> ${J(h2)}`;
    });
}

// ------------------------------------------------------------------ g2

async function sectionG2() {
    await check('g2 non-adjacent selection (linked, pick-one, both on): the server refusal shows in a TEXT popup, doc unchanged', async () => {
        const res = await op(ids.sola, { op: 'addSection', name: '== R3 split ==', before: S.SBK });
        must(res.status === 200, `addSection failed: HTTP ${res.status} ${J(res.json)}`);
        await until(async () => {
            const f = flat(await getDoc(ids.sola));
            const i = f.findIndex((/** @type {any} */ r) => identOf(r.leaf) === S.SB);
            return i > 0 && f[i - 1].rank === 'section';
        }, 8000, 'section row right before SB');
        await convergedOn(ids.sola, 'converged after addSection');
        await setOn(S.SA, true);
        await setOn(S.SB, true);
        await convergedOn(ids.sola, 'converged with SA and SB on');
        const rev0 = (await getDoc(ids.sola)).rev;
        await selectThree([S.SAK, S.SBK]);
        const btn = `${view(ids.sola)} .pm-rank-make-group-sel`;
        await until(() => probe.eval(`(() => { const b = document.querySelector(${J(btn)}); return !!b && !b.classList.contains('pm-disabled'); })()`), 8000, 'Make group button enabled');
        await mouseClickSel(btn);
        await until(() => exists('dialog[open] .pm-mkgrp-form'), 8000, 'make-group popup open');
        const title = await probe.eval(`document.querySelector('dialog[open] .pm-mkgrp-form div')?.textContent ?? ''`);
        must(title.includes('not adjacent'), `popup title ${J(title)} lacks "not adjacent"`);
        await probe.eval(`(() => {
            const s = document.querySelector('dialog[open] select.pm-mkgrp-heading');
            s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true }));
            const r = document.querySelector('dialog[open] input[name="pm-mkgrp-card"][value="pick-one"]');
            r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
            return true; })()`);
        must(await click('dialog[open] .popup-button-ok'), 'no popup OK button');
        const msg = await until(() => probe.eval(`(() => { for (const d of document.querySelectorAll('dialog[open]')) if (d.textContent.includes('more than one option currently selected')) return d.textContent.trim(); return null; })()`), 8000, 'refusal popup');
        const d = await getDoc(ids.sola);
        must(d.rev === rev0, `rev ${rev0} -> ${d.rev}, want unchanged`);
        must(!grpOf(d, S.SA) && !grpOf(d, S.SB), 'a group headed by SA/SB exists');
        const inGroup = (/** @type {any[]} */ rows) => rows.some((r) => (r.kind === 'group' && [r.header, ...(r.options ?? [])].some((l) => [S.SA, S.SB].includes(l?.ref ?? l?.identifier)))
            || (r.kind === 'group' && (r.remote ?? []).some((/** @type {string} */ k) => [S.SAK, S.SBK].includes(k)))
            || (r.kind === 'section' && inGroup(r.rows ?? [])));
        must(!inGroup(d.sequences[0].rows), 'SA or SB ended up inside (or linked to) a group');
        await shot('round3-g2-refusal.png', 'page');
        await dismissPopups();
        await until(async () => !(await exists('dialog[open]')), 8000, 'no dialog[open]');
        return `rev ${rev0} unchanged, no group; popup: ${J(msg)}`;
    });
}

// ------------------------------------------------------------------ n1

/** Every group of `doc` (any section depth, first sequence) as {name, key, header, options} (idents). */
function groupsOf(/** @type {any} */ doc) {
    /** @type {any[]} */ const out = [];
    const walk = (/** @type {any[]} */ rows) => {
        for (const r of rows ?? []) {
            if (r.kind === 'group') out.push({ name: r.name, key: r.key, header: r.header ? identOf(r.header) : null, headerKey: r.header?.key ?? null, options: (r.options ?? []).map(identOf) });
            else if (r.kind === 'section') walk(r.rows);
        }
    };
    walk(doc.sequences[0].rows);
    return out;
}

async function sectionN1() {
    await check('n1 a pre-round-3 Nemo doc upgrades on import: default headings, former headings become options, bits unchanged, ST text unchanged', async () => {
        const fx = JSON.parse(fs.readFileSync(path.join(REPO, 'dev/fixtures/native/nemo-adjacent-pre-r3.json'), 'utf8'));
        // The synthetic fixture carries only its own blocks. ST's PromptManager
        // appends its default system prompts (main, chatHistory, …) to any preset
        // that lacks them, so the slot's prompts would never equal the compile and
        // the apply would never converge. Carry ST's own defaults as markers, as a
        // real ST import does; markers are outside every group and sequence, so the
        // upgrade under test is unaffected.
        const ST_DEFAULTS = ['main', 'nsfw', 'dialogueExamples', 'jailbreak', 'chatHistory', 'worldInfoAfter', 'worldInfoBefore', 'enhanceDefinitions', 'charDescription', 'charPersonality', 'scenario', 'personaDescription'];
        const stDefaults = await probe.eval(`SillyTavern.getContext().chatCompletionSettings.prompts.filter((p) => ${J(ST_DEFAULTS)}.includes(p.identifier))`);
        must(stDefaults.length === ST_DEFAULTS.length, `ST shows ${stDefaults.length} of the ${ST_DEFAULTS.length} default prompts`);
        fx.markers = stDefaults.map((/** @type {any} */ p) => ({ identifier: p.identifier, prompt: p }));
        const fxGroups = groupsOf(fx);
        const res = await api('POST', '/presets', { native: fx, name: 'Nemo upgrade r3' });
        must(res.status === 200 || res.status === 201, `native import HTTP ${res.status} ${J(res.json)}`);
        const id = res.json?.id;
        must(id, `import response has no id: ${J(res.json)?.slice(0, 200)}`);
        const d = await getDoc(id);
        const dGroups = groupsOf(d);
        const pmhIds = [];
        for (const fg of fxGroups) {
            const dg = dGroups.find((g) => g.name === fg.name);
            must(dg, `group ${fg.name} missing after import`);
            if (fg.header === null) {
                must(dg.header === null && J(dg.options) === J(fg.options), `headerless ${fg.name}: header ${J(dg.header)} options ${J(dg.options)}, want null / ${J(fg.options)}`);
                continue;
            }
            must(/^pmh-[0-9a-f]{8}$/.test(dg.header ?? ''), `${fg.name}: header ${J(dg.header)} is not a pmh id`);
            must(J(dg.options) === J([fg.header, ...fg.options]), `${fg.name}: options ${J(dg.options)}, want ${J([fg.header, ...fg.options])}`);
            const blk = d.blocks[dg.header];
            must(blk && blk.name === fg.name && blk.content === `{{// ${fg.name} }}{{trim}}`, `${fg.name}: heading block ${J(blk)}`);
            must(dg.key === `grp:${dg.headerKey}`, `${fg.name}: group key ${dg.key}, want grp:${dg.headerKey}`);
            pmhIds.push(dg.header);
        }
        must(pmhIds.length === 2, `${pmhIds.length} headings added, want 2 (Q and R)`);
        for (const [lid, fl] of Object.entries(fx.loadouts)) {
            const dl = d.loadouts[lid];
            must(dl, `loadout ${lid} missing`);
            for (const [k, v] of Object.entries(fl.enabled ?? {})) {
                must(dl.enabled[k] === v, `${fl.name}: enabled[${k}] ${dl.enabled[k]}, want ${v}`);
            }
            must(J(dl.overrides) === J(fl.overrides), `${fl.name}: overrides changed: ${J(dl.overrides)} vs ${J(fl.overrides)}`);
            for (const p of pmhIds) {
                if (fl.kind === 'root') must(dl.enabled[p] === true, `root ${fl.name}: enabled[${p}] ${dl.enabled[p]}, want true`);
                else must(!(p in dl.enabled), `${fl.name} (${fl.kind}) has a bit for ${p}`);
            }
        }
        const notes = d.source?.recognizer?.notes ?? [];
        must(notes.some((/** @type {string} */ n) => n.startsWith("upgrade: group 'Q' got a default heading")), `no upgrade note for Q in ${J(notes)}`);

        const enabledIds = (/** @type {any} */ c) => c.prompt_order[0].order.filter((/** @type {any} */ o) => o.enabled).map((/** @type {any} */ o) => o.identifier);
        const before = compile(fx, null, {}, fx.activeLoadoutId).compiled;
        const expectedTexts = enabledIds(before).map((/** @type {string} */ i) => [i, before.prompts.find((/** @type {any} */ p) => p.identifier === i)?.content ?? null]);
        must((await api('POST', '/slot/load', { presetId: id })).status === 200, 'slot_load upgraded Nemo failed');
        const c = await convergedOn(id, 'upgraded Nemo converged');
        const stPrompts = await probe.eval(`SillyTavern.getContext().chatCompletionSettings.prompts.map((p) => [p.identifier, p.content ?? null])`);
        const contentOf = new Map(stPrompts);
        const actualTexts = c.s.order
            .filter((/** @type {any} */ o) => o.enabled && !/^pmh-/.test(o.identifier))
            .map((/** @type {any} */ o) => [o.identifier, contentOf.get(o.identifier) ?? null]);
        must(J(actualTexts) === J(expectedTexts), `ST text differs: actual ${J(actualTexts)} vs expected ${J(expectedTexts)}`);
        for (const p of pmhIds) {
            must(c.s.order.some((/** @type {any} */ o) => o.identifier === p && o.enabled === true), `${p} not enabled in ST's order`);
        }

        await showTab('presets');
        await openFromLibrary(id);
        const qGroup = dGroups.find((g) => g.name === 'Q');
        const gli = `${view(id)} li.pm-node[data-kind="group"][data-node-key="${qGroup.key}"]`;
        await until(() => exists(gli), 10000, 'Q group li rendered');
        const n = await probe.eval(`document.querySelectorAll(${J(`${gli} > .pm-row > input.pm-switch`)}).length`);
        must(n === 0, `heading row renders ${n} switch(es), want 0`);
        const firstLi = `${gli} > ul.pm-list > li.pm-node`;
        const firstId = await probe.eval(`document.querySelector(${J(firstLi)})?.dataset.identifier ?? null`);
        const types = await typesOf(`${firstLi} .pm-switch`);
        must(firstId === 'q1' && types[0] === 'radio', `first option ${J({ firstId, types })}, want q1 radio`);
        await shot('round3-n1-upgraded.png');
        return `headings ${J(pmhIds)}; ${expectedTexts.length} ST text entries compared equal`;
    });
}

// ------------------------------------------------------------------ s1

/** Attach `absPath` to a file input via CDP (fires input+change like a real pick). */
async function setFileInput(/** @type {string} */ sel, /** @type {string} */ absPath) {
    const ev = await probe.cdp('Runtime.evaluate', { expression: `document.querySelector(${J(sel)})` });
    const objectId = ev.result?.objectId;
    if (!objectId) throw new Error(`setFileInput: ${sel} not found`);
    await probe.cdp('DOM.setFileInputFiles', { files: [absPath], objectId });
}

async function sectionS1() {
    await check('s1 Sola V3 Flame imports via the Library: notes, 10 sections, 8 pick-one groups, GROUNDING plain, MIND text in the slot', async () => {
        await showTab('library');
        const absPath = path.join(REPO, 'dev/fixtures/presets/Sola V3 Flame.json');
        must(fs.existsSync(absPath), `fixture missing: ${absPath}`);
        await setFileInput('#pm-window .pm-io-section .pm-io-file', absPath);
        const resultSel = '#pm-window .pm-io-result[data-status="ok"][data-name="Sola V3 Flame"]';
        const sid = await until(async () => {
            if (!(await exists(resultSel))) return null;
            return probe.eval(`document.querySelector(${J(resultSel)}).dataset.presetId`);
        }, 20000, 'Sola V3 import result row').catch(async (err) => {
            const rows = await probe.eval(`[...document.querySelectorAll('#pm-window .pm-io-result')].map((r) => [r.dataset.status, r.dataset.name, r.textContent.slice(0, 120)])`);
            throw new Error(`${err.message}; result rows: ${J(rows)}`);
        });
        const notes = await text(`${resultSel} .pm-io-notes`);
        must(notes && notes.includes('"undefined"') && notes.includes('GROUNDING'), `.pm-io-notes ${J(notes?.slice(0, 300))} lacks "undefined" and GROUNDING`);
        await shot('round3-s1-import.png');

        await openFromLibrary(sid);
        const seq0 = `${view(sid)} .pm-outline ul.pm-list[data-list="seq"][data-seq-index="0"]`;
        const secNames = await probe.eval(`[...document.querySelectorAll(${J(`${seq0} > li.pm-node[data-kind="section"]`)})].map((li) => li.querySelector(':scope > .pm-row .pm-name')?.textContent ?? '')`);
        must(secNames.length === 10, `${secNames.length} top-level sections, want 10: ${J(secNames)}`);
        secNames.forEach((/** @type {string} */ n, /** @type {number} */ i) => must(n.includes(`0${i}.`), `section ${i} name ${J(n)} lacks "0${i}."`));
        const groups = await probe.eval(`[...document.querySelectorAll(${J(`${seq0} li.pm-node[data-kind="group"]`)})].map((li) => ({
            name: (li.querySelector(':scope > .pm-row .pm-name')?.textContent ?? '').trim(),
            badge: (li.querySelector(':scope > .pm-row > .pm-card')?.textContent ?? '').trim(),
        }))`);
        const wantNames = ['MIND', 'POV', 'PRONOUN', 'Agency-Lite / Embellished User', 'Anti-Slop Full / Anti-Slop Lite', 'STYLE', 'NPC Dialogue Colors 🎨 / Gradient ALL The Time 🎨', 'Anti-Softening / Anti-Cruelty'];
        must(groups.length === 8, `${groups.length} group rows, want 8: ${J(groups)}`);
        must(groups.every((/** @type {any} */ g) => g.badge === '1'), `badges ${J(groups.map((/** @type {any} */ g) => g.badge))}, want all "1"`);
        must(J(groups.map((/** @type {any} */ g) => g.name)) === J(wantNames), `group names ${J(groups.map((/** @type {any} */ g) => g.name))}, want ${J(wantNames)}`);
        const grounding = await probe.eval(`[...document.querySelectorAll(${J(`${seq0} li.pm-node[data-kind="leaf"]`)})]
            .filter((li) => (li.querySelector(':scope > .pm-row .pm-name')?.textContent ?? '').includes('Story Grounding'))
            .map((li) => [...li.querySelectorAll(':scope > .pm-row input.pm-switch')].map((i) => i.type))`);
        must(grounding.length === 2 && grounding.every((/** @type {string[]} */ t) => t.length === 1 && t[0] === 'checkbox'),
            `Story Grounding rows ${J(grounding)}, want 2 rows with one checkbox each`);
        await shot('round3-s1-outline.png');

        must((await api('POST', '/slot/load', { presetId: sid })).status === 200, 'slot_load Sola V3 failed');
        const c = await convergedOn(sid, 'Sola V3 converged');
        const d = await getDoc(sid);
        const sec0 = d.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section');
        must(sec0?.header, 'section 0 has no header');
        const ident = identOf(sec0.header);
        const prompt = await probe.eval(`(() => { const p = SillyTavern.getContext().chatCompletionSettings.prompts.find((p) => p.identifier === ${J(ident)}); return p ? { len: (p.content ?? '').length } : null; })()`);
        must(prompt && prompt.len > 4000, `ST prompt ${ident} ${J(prompt)}, want content length > 4000`);
        must(c.s.order.some((/** @type {any} */ o) => o.identifier === ident && o.enabled), `${ident} not enabled in ST's order`);
        return `${secNames.length} sections, ${groups.length} groups, 2 Story Grounding checkboxes; section 0 header ${ident} has ${prompt.len} chars in ST, enabled`;
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

    // Three consecutive plain block rows (rank 'item'), the first with real content (not comment-only).
    const sola0 = await getDoc(ids.sola);
    const rows = flat(sola0);
    const plain = (/** @type {any} */ r) => r.rank === 'item' && r.leaf.kind === 'block' && !!sola0.blocks[identOf(r.leaf)];
    let at = -1;
    for (let i = 1; i + 2 < rows.length; i++) {
        if (plain(rows[i]) && plain(rows[i + 1]) && plain(rows[i + 2])
            && !isCommentOnly(sola0.blocks[identOf(rows[i].leaf)]?.content)) { at = i; break; }
    }
    if (at < 0) fatal('setup', 'no three consecutive plain block rows with a non-comment-only first in Sola');
    S.H = identOf(rows[at].leaf); S.HK = rows[at].leaf.key;
    S.O1 = identOf(rows[at + 1].leaf); S.K1 = rows[at + 1].leaf.key;
    S.O2 = identOf(rows[at + 2].leaf); S.K2 = rows[at + 2].leaf.key;
    // g1: three plain rows after the h triple, a lone option-free spot (the next row is not an option).
    const isPlain = (/** @type {any} */ r) => !!r && r.rank === 'item' && r.leaf.kind === 'block' && !!sola0.blocks[identOf(r.leaf)];
    const notOption = (/** @type {any} */ r) => !r || r.rank !== 'option';
    for (let j = at + 4; j + 2 < rows.length; j++) {
        if (isPlain(rows[j]) && isPlain(rows[j + 1]) && isPlain(rows[j + 2]) && notOption(rows[j + 3])) { S.gj = j; break; }
    }
    if (S.gj < 0) fatal('setup', 'no three consecutive plain rows after the h triple for g1');
    S.G0 = identOf(rows[S.gj].leaf); S.GK0 = rows[S.gj].leaf.key;
    S.G1 = identOf(rows[S.gj + 1].leaf); S.GK1 = rows[S.gj + 1].leaf.key;
    S.G2 = identOf(rows[S.gj + 2].leaf); S.GK2 = rows[S.gj + 2].leaf.key;
    // g2: two consecutive plain rows after g1's three.
    for (let m = S.gj + 5; m < rows.length; m++) {
        if (isPlain(rows[m - 1]) && isPlain(rows[m]) && notOption(rows[m + 1])) { S.sm = m; break; }
    }
    if (S.sm < 0) fatal('setup', 'no two consecutive plain rows after the g1 rows for g2');
    S.SA = identOf(rows[S.sm - 1].leaf); S.SAK = rows[S.sm - 1].leaf.key;
    S.SB = identOf(rows[S.sm].leaf); S.SBK = rows[S.sm].leaf.key;

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
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, FF + Sola imported, Sola in the slot and open, clean pm.* localStorage', true, `ff=${ids.ff} sola=${ids.sola} H=${S.H} O1=${S.O1} O2=${S.O2}`);

    if (wanted('h1')) await sectionH1();
    if (wanted('h2')) await sectionH2();
    if (wanted('h3')) await sectionH3();
    if (wanted('g1')) await sectionG1();
    if (wanted('g2')) await sectionG2();
    if (wanted('n1')) await sectionN1();
    if (wanted('s1')) await sectionS1();

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
