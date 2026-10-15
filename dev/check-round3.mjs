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
 * Screenshots (dev/shots/): round3-h1-heading-checkbox.png,
 *   round3-h2-pick-one.png, round3-h3-none.png.
 *
 * Environment: the dev container st-pm-dev on 127.0.0.1:8002 with the plugin
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
 * two options O1/O2 of the group built in h1 (identifiers and leaf keys).
 * @type {{ H: string, HK: string, O1: string, K1: string, O2: string, K2: string }}
 */
const S = { H: '', HK: '', O1: '', K1: '', O2: '', K2: '' };

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

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
