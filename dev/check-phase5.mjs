#!/usr/bin/env node
/**
 * Phase 5 acceptance (roadmap acceptance 12 + revisions) as one repeatable
 * real-browser script: PLAN §2 Phase 5 checks 1–3. Drives the ACTUAL v2
 * window's Diff tab (pickers, Compare, row clicks, mouse wheel) in a
 * headless Chromium over raw CDP, and observes the rendered DOM, the plugin
 * REST API and ST's live prompt state.
 *
 *   node dev/check-phase5.mjs            all checks (resets dev data first)
 *   CHK_SKIP=2a,3c node dev/check-phase5.mjs   skip checks by id (diagnosis only)
 *
 * Checks:
 *   1a FF Internal States (2) vs Hapuppy Forced Reasoning (1): the Kimi row is changed
 *   1b a preset vs itself: every row same
 *   2a acceptance 12: exactly one scrollable element holds both columns; a wheel scrolls both
 *   2f the Diff pane is display:none under every other tab (and alone under Diff)
 *   2b a block moved in a fork renders as moved with "moved from #n"
 *   2c clicking a changed row shows its line diff (.pm-diff-hunk) in the bottom row
 *   2d FF vs its own revision 3: the rows come from the snapshot
 *   2e DEM block vs Sola block, and two blocks of one preset: hunks render
 *   2g stale async results are discarded (held /diff + picker change; held row diff + new Compare)
 *   3a 10 rapid toggles -> 1 snapshot holding the pre-burst state
 *   3b a labelled save -> its own snapshot
 *   3c restore writes a snapshot first, and ST's live prompts show the restored state
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
import { blockOrder } from '../shared/compare.js';
import { flattenSeq } from '../shared/outline.js';

const TAB = 'chk5';
const HAP = 'Freaky Frankenstein 5.4 Hapuppy Forced Reasoning (1)';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';
const SOLA = 'Sola V2 Flame';
const FORK = 'FF chk5 fork';
const SHOTS = path.join(REPO, 'dev', 'shots');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-phase5.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { ff: '', hap: '', dem: '', sola: '', fork: '', kimi: '', ffMain: '' };

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);
const setValue = (/** @type {string} */ sel, /** @type {string} */ value, evt = 'input') => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return el.value === ${J(value)}; })()`);

const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;
const getRevs = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}/revisions`)).json;
const getSlot = async () => (await api('GET', '/slot')).json;
async function op(/** @type {string} */ id, /** @type {any} */ body) {
    const r = await api('POST', `/presets/${id}/ops`, body);
    if (r.status !== 200) throw new Error(`op ${body.op} -> ${r.status} ${r.text.slice(0, 200)}`);
    return r.json;
}

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

// ------------------------------------------------------------------ Diff tab helpers

const side = (/** @type {'a'|'b'} */ s, /** @type {string} */ sel) => `#pm-window .pm-diff-side[data-side="${s}"] ${sel}`;
const optionValues = (/** @type {string} */ sel) => probe.eval(`[...(document.querySelector(${J(sel)})?.options ?? [])].map((o) => o.value)`);

/** Open the Diff tab fresh (re-shown = pickers refreshed from /library). */
async function openDiff() {
    await showTab('library');
    await showTab('diff');
    await until(() => exists('#pm-window .pm-diff .pm-diff-top .pm-diff-table'), 5000, 'Diff tab table');
}

/**
 * Choose preset / revision / block on one side through the pickers, waiting
 * until each picker has loaded the lists the API says it must show.
 * @param {'a'|'b'} s @param {string} presetId @param {{ rev?: number, block?: string }} [o]
 */
async function pick(s, presetId, o = {}) {
    await until(async () => (await optionValues(side(s, '.pm-diff-preset'))).includes(presetId), 8000, `${s}: preset ${presetId} listed`);
    if (!(await setValue(side(s, '.pm-diff-preset'), presetId, 'change'))) throw new Error(`${s}: could not select preset ${presetId}`);
    const revs = (await getRevs(presetId)).map((/** @type {any} */ r) => String(r.rev)).reverse();
    await until(async () => J(await optionValues(side(s, '.pm-diff-rev'))) === J(['', ...revs]), 8000, `${s}: revision picker lists ${J(revs)}`);
    const rev = o.rev ? String(o.rev) : '';
    if (!(await setValue(side(s, '.pm-diff-rev'), rev, 'change'))) throw new Error(`${s}: could not select revision ${rev}`);
    const doc = o.rev ? (await api('GET', `/presets/${presetId}/revisions/${o.rev}`)).json.doc : await getDoc(presetId);
    const want = Object.keys(doc.blocks).sort();
    await until(async () => J((await optionValues(side(s, '.pm-diff-block'))).filter(Boolean).sort()) === J(want), 8000, `${s}: block picker lists the ${want.length} blocks`);
    if (!(await setValue(side(s, '.pm-diff-block'), o.block ?? '', 'change'))) throw new Error(`${s}: could not select block ${o.block}`);
    return doc;
}

/** Click Compare and wait until THIS compare rendered (old rows/hunks are marked stale first). */
async function compare() {
    await probe.eval(`(() => {
        document.querySelectorAll('#pm-window .pm-diff-rows tr').forEach((el) => { el.dataset.chkOld = '1'; });
        return true; })()`);
    await markBottomStale();
    if (!(await click('#pm-window .pm-diff-go'))) throw new Error('no Compare button');
    return until(async () => {
        const r = await probe.eval(`(() => {
            const st = document.querySelector('#pm-window .pm-diff-status');
            const rows = [...document.querySelectorAll('#pm-window .pm-diff-rows tr.pm-diff-row')];
            if (st?.classList.contains('pm-error')) return { error: st.textContent };
            if (!rows.length || rows.some((tr) => tr.dataset.chkOld)) return null;
            return { status: st?.textContent ?? '' };
        })()`);
        if (r?.error) throw new Error(`Diff tab error: ${r.error}`);
        return r;
    }, 10000, 'compare rendered');
}

/**
 * Mark the bottom row stale: the tab rewrites the head's text and replaces the
 * hunk elements on every render, so a sentinel head text + a marker on the
 * current hunk elements prove that a later read is a NEW render.
 */
const STALE = '__chk_stale__';
const markBottomStale = () => probe.eval(`(() => {
    document.querySelectorAll('#pm-window .pm-diff-hunks > *').forEach((el) => { el.dataset.chkOld = '1'; });
    const h = document.querySelector('#pm-window .pm-diff-bottom-head'); if (h) h.textContent = ${J(STALE)};
    return true; })()`);

/** The rendered rows as data. */
const readRows = () => probe.eval(`[...document.querySelectorAll('#pm-window .pm-diff-rows tr.pm-diff-row')].map((tr) => ({
    status: tr.dataset.status, left: tr.dataset.left, right: tr.dataset.right,
    leftText: tr.querySelector('.pm-diff-left')?.textContent.trim() ?? '',
    rightText: tr.querySelector('.pm-diff-right')?.textContent.trim() ?? '',
    moved: tr.querySelector('.pm-diff-moved')?.textContent.trim() ?? null,
    selected: tr.classList.contains('pm-diff-selected'),
}))`);

/** Bottom row: the hunks as rendered (text per hunk + op/text lines). */
const readBottom = () => probe.eval(`(() => {
    const head = document.querySelector('#pm-window .pm-diff-bottom-head');
    return {
        head: head?.textContent ?? '', stale: head?.textContent === ${J(STALE)},
        hunks: [...document.querySelectorAll('#pm-window .pm-diff-hunks .pm-diff-hunk')].filter((h) => !h.dataset.chkOld).map((h) => ({
            text: h.textContent,
            lines: [...h.querySelectorAll('.pm-diff-line')].map((l) => (l.querySelector('.pm-diff-op')?.textContent ?? '') + '|' + (l.querySelector('.pm-diff-text')?.textContent ?? '')),
        })),
    };
})()`);

/** Click a rendered row and wait for its hunks in the bottom row. */
async function clickRow(/** @type {string} */ rowSel) {
    await markBottomStale();
    const ok = await probe.eval(`(() => { const tr = document.querySelector(${J(rowSel)}); if (!tr) return false; tr.querySelector('.pm-diff-mid').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`);
    if (!ok) throw new Error(`no row ${rowSel}`);
    return until(async () => {
        const b = await readBottom();
        const oldLeft = await probe.eval(`[...document.querySelectorAll('#pm-window .pm-diff-hunks > *')].some((el) => el.dataset.chkOld)`);
        return !b.stale && !oldLeft && b.head ? b : null;
    }, 10000, 'bottom row rendered');
}

/**
 * Hold the next page fetch whose URL contains `urlPart` and whose body
 * contains `bodyPart` until window.__chkRelease(); __chkHeld turns true while
 * held, __chkDone once its response has come back. Restored by unhold().
 */
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
/** first non-empty trimmed line of `a` that does not occur in `b` */
const uniqueLine = (/** @type {string} */ a, /** @type {string} */ b) => {
    const bl = new Set(b.split(/\r?\n/).map((l) => l.trim()));
    return a.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 8 && !bl.has(l)) ?? null;
};

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
        ['^(Freaky Frankenstein 5\\.4 Internal States \\(2\\)|Freaky Frankenstein 5\\.4 Hapuppy Forced Reasoning \\(1\\)|DEUS\\.EX\\.MACHINA\\.V2\\.5\\.ST|Sola V2 Flame)$'],
        { stdio: 'pipe' });
    const library = (await api('GET', '/library')).json ?? [];
    const idOf = (/** @type {string} */ n) => library.find((/** @type {any} */ e) => e.name === n)?.id ?? '';
    ids.ff = idOf(FF); ids.hap = idOf(HAP); ids.dem = idOf(DEM); ids.sola = idOf(SOLA);
    if (!ids.ff || !ids.hap || !ids.dem || !ids.sola) fatal('setup', `fixtures missing: ${J(library.map((/** @type {any} */ e) => e.name))}`);
    const ff0 = await getDoc(ids.ff);
    ids.kimi = Object.values(ff0.blocks).find((/** @type {any} */ b) => /^kimi k3$/i.test(b.name ?? ''))?.identifier ?? '';
    ids.ffMain = blockOrder(ff0)[0]?.identifier ?? '';
    if (!ids.kimi || !ids.ffMain) fatal('setup', 'FF has no "Kimi K3" block or no first block');

    // FF revision history, built before anything else can write FF:
    //   #1 labelled (original), #2 = original again (the unlabelled edit's pre-state),
    //   #3 labelled (content ends MARK-R2), #4 = MARK-R2 state; current ends MARK-NOW
    try {
        must(J(await getRevs(ids.ff)) === '[]', `FF has revisions after reset: ${J(await getRevs(ids.ff))}`);
        const main0 = ff0.blocks[ids.ffMain].content;
        const r1 = await api('POST', `/presets/${ids.ff}/revisions`, { label: 'chk5 r1' });
        must(r1.status === 201 && r1.json.rev === 1, `label r1 -> ${r1.status} ${r1.text}`);
        await op(ids.ff, { op: 'setContent', identifier: ids.ffMain, content: `${main0}\nMARK-R2 chk5` });
        const r3 = await api('POST', `/presets/${ids.ff}/revisions`, { label: 'chk5 r3' });
        must(r3.status === 201 && r3.json.rev === 3, `label r3 -> ${r3.status} ${r3.text}`);
        await op(ids.ff, { op: 'setContent', identifier: ids.ffMain, content: `${main0}\nMARK-NOW chk5` });
        const revs = await getRevs(ids.ff);
        must(J(revs.map((/** @type {any} */ r) => [r.rev, r.label])) === J([[1, 'chk5 r1'], [2, null], [3, 'chk5 r3'], [4, null]]), `FF revisions ${J(revs)}`);
        const snap3 = (await api('GET', `/presets/${ids.ff}/revisions/3`)).json;
        must(snap3.doc.blocks[ids.ffMain].content.endsWith('MARK-R2 chk5'), 'revision 3 does not hold the MARK-R2 state');
    } catch (err) {
        fatal('setup: FF revisions', /** @type {Error} */ (err).message);
    }

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await dismissPopups();
    try {
        await until(() => exists('#pm-menu-item'), 20000, 'wand menu entry');
        await click('#pm-menu-item');
        await until(() => exists('#pm-window .pm-tab[data-tab="diff"]'), 10000, 'window with a Diff tab');
        await loadViaLibrary(ids.sola);
        await openDiff();
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, FF/Hapuppy/DEM/Sola imported, FF revisions 1-4, Sola in the slot, Diff tab open', true,
        `ff=${ids.ff} hap=${ids.hap} dem=${ids.dem} sola=${ids.sola} kimi=${ids.kimi}`);

    const hap0 = await getDoc(ids.hap);

    // ------------------------------------------------------------------ 1a
    await check('1a FF Internal States (2) vs Hapuppy Forced Reasoning (1): the Kimi row is changed', async () => {
        await pick('a', ids.ff);
        await pick('b', ids.hap);
        const { status } = await compare();
        const rows = await readRows();
        const apiRes = (await api('POST', '/diff', { a: { presetId: ids.ff }, b: { presetId: ids.hap } })).json;
        must(rows.length === apiRes.rows.length, `UI ${rows.length} rows, API ${apiRes.rows.length}`);
        must(J(rows.map((/** @type {any} */ r) => r.status)) === J(apiRes.rows.map((/** @type {any} */ r) => r.status)), 'UI statuses differ from POST /diff');
        const kimi = rows.filter((/** @type {any} */ r) => r.left === ids.kimi);
        must(kimi.length === 1, `precondition: one row for the Kimi block, got ${kimi.length}`);
        must(kimi[0].right === ids.kimi && /Kimi K3 JB \(secondary\)/.test(kimi[0].rightText), `Kimi row right side: ${J(kimi[0])}`);
        must(kimi[0].status === 'changed', `Kimi row is ${kimi[0].status}`);
        return `${rows.length} rows; Kimi row "${kimi[0].leftText}" | "${kimi[0].rightText}" = ${kimi[0].status}; status "${status}"`;
    });

    // ------------------------------------------------------------------ 1b
    await check('1b a preset vs itself: every row same', async () => {
        await pick('a', ids.ff);
        await pick('b', ids.ff);
        const { status } = await compare();
        const rows = await readRows();
        const placed = blockOrder(await getDoc(ids.ff)).length;
        must(rows.length === placed && placed > 0, `${rows.length} rows for ${placed} placed blocks`);
        const notSame = rows.filter((/** @type {any} */ r) => r.status !== 'same' || r.left !== r.right);
        must(notSame.length === 0, `not same: ${J(notSame.slice(0, 3))}`);
        must(/^identical/.test(status), `status line "${status}"`);
        return `${rows.length}/${placed} rows same; status "${status}"`;
    });

    // ------------------------------------------------------------------ 2a
    await check('2a acceptance 12: exactly one scrollable element holds both columns, and a mouse wheel scrolls both together', async () => {
        const rowsN = (await readRows()).length;
        must(rowsN > 20, `precondition: a long table (FF vs itself), got ${rowsN} rows`);
        const layout = await probe.eval(`(() => {
            const win = document.querySelector('#pm-window');
            const top = win.querySelector('.pm-diff-top');
            const over = (el) => { const cs = getComputedStyle(el); return /(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX); };
            const scrolls = (el) => over(el) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
            const all = [win, ...win.querySelectorAll('*')];
            const cells = [...win.querySelectorAll('.pm-diff-rows .pm-diff-left, .pm-diff-rows .pm-diff-right')];
            const covering = all.filter((el) => scrolls(el) && cells.some((c) => el.contains(c)));
            // any ancestor of the table up to the document that could scroll
            const anc = []; for (let el = top.parentElement; el; el = el.parentElement) if (scrolls(el)) anc.push(el.className || el.tagName);
            return {
                covering: covering.map((el) => el.className), topIsIt: covering.length === 1 && covering[0] === top,
                allCellsInTop: cells.every((c) => top.contains(c)), cells: cells.length,
                innerOverflow: [...top.querySelectorAll('*')].filter(over).map((el) => el.className || el.tagName),
                ancestors: anc,
                scrollable: top.scrollHeight > top.clientHeight, scrollTop: top.scrollTop,
                sh: top.scrollHeight, ch: top.clientHeight,
            };
        })()`);
        must(layout.cells === rowsN * 2, `cells ${layout.cells} for ${rowsN} rows`);
        must(layout.scrollable && layout.scrollTop === 0, `precondition: container overflows and is at the top: ${J(layout)}`);
        must(layout.topIsIt, `scrollables holding the columns: ${J(layout.covering)}`);
        must(layout.allCellsInTop, 'some cells are outside .pm-diff-top');
        must(layout.innerOverflow.length === 0, `scroll-capable elements inside the container: ${J(layout.innerOverflow)}`);
        must(layout.ancestors.length === 0, `scrollable ancestors: ${J(layout.ancestors)}`);
        // a row in the middle: both of its cells before/after a real wheel
        const k = Math.floor(rowsN / 2);
        const cellTops = () => probe.eval(`(() => {
            const tr = document.querySelectorAll('#pm-window .pm-diff-rows tr.pm-diff-row')[${k}];
            const top = document.querySelector('#pm-window .pm-diff-top');
            return { l: tr.querySelector('.pm-diff-left').getBoundingClientRect().top, r: tr.querySelector('.pm-diff-right').getBoundingClientRect().top, scrollTop: top.scrollTop };
        })()`);
        const before = await cellTops();
        const box = await probe.eval(`(() => { const b = document.querySelector('#pm-window .pm-diff-top').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
        await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
        await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 400 });
        const after = await until(async () => { const a = await cellTops(); return a.scrollTop > 0 ? a : null; }, 5000, 'container scrolled by the wheel');
        const d = after.scrollTop - before.scrollTop;
        must(Math.abs((before.l - after.l) - d) <= 1 && Math.abs((before.r - after.r) - d) <= 1, `cells moved ${before.l - after.l}/${before.r - after.r} for scrollTop +${d}`);
        must(Math.abs(after.l - after.r) <= 1 && Math.abs(before.l - before.r) <= 1, 'left and right cells of one row are not level');
        await probe.eval(`document.querySelector('#pm-window .pm-diff-top').scrollTop = 0`);
        return `1 scrollable (.pm-diff-top ${layout.ch}/${layout.sh}px) holds all ${layout.cells} cells; no inner/ancestor scrollers; wheel -> scrollTop ${after.scrollTop}, row ${k}'s left and right cells both moved ${before.l - after.l}px`;
    });

    // ------------------------------------------------------------------ 2f
    await check('2f the Diff pane takes no space under the other tabs, and only the Diff pane shows under Diff', async () => {
        const panes = () => probe.eval(`[...document.querySelectorAll('#pm-window .pm-pane')].map((p) => ({ pane: p.dataset.pane, hidden: p.hidden, display: getComputedStyle(p).display, h: Math.round(p.getBoundingClientRect().height) }))`);
        const out = [];
        for (const tab of ['library', 'presets', 'settings', 'diff']) {
            await showTab(tab);
            const ps = await panes();
            const shown = ps.filter((/** @type {any} */ p) => p.display !== 'none');
            must(shown.length === 1 && shown[0].pane === tab && shown[0].h > 0, `under ${tab}: displayed panes ${J(shown)}`);
            must(ps.every((/** @type {any} */ p) => p.pane === tab || (p.hidden && p.h === 0)), `under ${tab}: ${J(ps)}`);
            out.push(`${tab}:${shown[0].h}px`);
        }
        return `exactly one pane displayed per tab (${out.join(', ')}); the Diff pane is display:none elsewhere`;
    });

    // ------------------------------------------------------------------ 2b
    await check('2b a block moved in a fork renders as moved with "moved from #n"; a changed fork block shows its hunk', async () => {
        const f = await api('POST', `/presets/${ids.ff}/fork`, { name: FORK });
        must(f.status === 201, `fork -> ${f.status} ${f.text.slice(0, 200)}`);
        ids.fork = f.json.doc.id;
        const fork0 = f.json.doc;
        must(!fork0.blocks[ids.kimi], 'precondition: the fork re-minted identifiers (name matching is exercised)');
        await openDiff();
        await pick('a', ids.ff);
        await pick('b', ids.fork);
        await compare();
        const pre = await readRows();
        must(pre.length > 20 && pre.every((/** @type {any} */ r) => r.status === 'same'), `precondition: FF vs fresh fork all same, got ${J(pre.filter((/** @type {any} */ r) => r.status !== 'same').slice(0, 3))}`);
        // move "Time and Place" (top-level row 1) two sibling steps down in the fork
        const tp = fork0.sequences[0].rows[1];
        must(tp?.kind === 'block', 'precondition: fork row 1 is a block item');
        const posBefore = blockOrder(fork0).find((/** @type {any} */ b) => b.identifier === tp.ref)?.pos;
        const moved = (await op(ids.fork, { op: 'moveLeaf', key: tp.key, delta: 2 })).doc;
        const posAfter = blockOrder(moved).find((/** @type {any} */ b) => b.identifier === tp.ref)?.pos;
        must(posBefore === 2 && posAfter !== undefined && posAfter > posBefore, `the move landed: pos ${posBefore} -> ${posAfter}`);
        const ffTp = blockOrder(ff0)[1].identifier;
        await compare();
        const rows = await readRows();
        const mv = rows.filter((/** @type {any} */ r) => r.status === 'moved');
        must(mv.length === 1, `exactly one moved row expected, got ${J(mv)}`);
        must(mv[0].left === ffTp && mv[0].right === tp.ref, `moved row pairs ${mv[0].left} > ${mv[0].right}`);
        must(mv[0].moved === `moved from #${posBefore}`, `badge "${mv[0].moved}"`);
        must(mv[0].rightText.startsWith(`#${posAfter}`), `right cell "${mv[0].rightText}" should show #${posAfter}`);
        must(rows.filter((/** @type {any} */ r) => r.status !== 'same' && r.status !== 'moved').length === 0, 'other rows changed');
        const badges = await probe.eval(`document.querySelectorAll('#pm-window .pm-diff-rows .pm-diff-moved').length`);
        must(badges === 1, `${badges} badges rendered`);
        // edit another fork block -> changed row; click it -> hunk (the screenshot state)
        const editId = blockOrder(moved).map((b) => b.identifier).filter((id) => id !== tp.ref)[20];
        const edited = `${moved.blocks[editId].content}\nFORK-EDIT chk5 line`;
        await op(ids.fork, { op: 'setContent', identifier: editId, content: edited });
        await compare();
        const rows2 = await readRows();
        const ch = rows2.filter((/** @type {any} */ r) => r.status === 'changed');
        must(ch.length === 1 && ch[0].right === editId, `one changed row for the edited block: ${J(ch)}`);
        must(rows2.filter((/** @type {any} */ r) => r.status === 'moved').length === 1, 'the moved row is still there');
        const b = await clickRow(`#pm-window .pm-diff-rows tr.pm-diff-row[data-right="${editId}"]`);
        must(b.hunks.length >= 1 && b.hunks.some((/** @type {any} */ h) => h.lines.includes('+|FORK-EDIT chk5 line')), `bottom hunks ${J(b.hunks).slice(0, 300)}`);
        await probe.eval(`document.querySelector('#pm-window .pm-diff-top').scrollTop = 0`);
        await shot('phase5-diff.png');
        return `fork pos ${posBefore} -> ${posAfter}: row "${mv[0].leftText}" | "${mv[0].rightText}" = moved; 1 badge; edited block row changed -> hunk "+FORK-EDIT chk5 line"`;
    });

    // ------------------------------------------------------------------ 2c
    await check('2c clicking the changed Kimi row shows its line diff (.pm-diff-hunk) in the bottom row', async () => {
        await pick('a', ids.ff);
        await pick('b', ids.hap);
        await compare();
        const before = await readBottom();
        must(before.hunks.length === 0, `precondition: no hunk before the click (${before.hunks.length})`);
        const ffK = ff0.blocks[ids.kimi].content;
        const hapK = hap0.blocks[ids.kimi].content;
        const onlyHap = uniqueLine(hapK, ffK);
        const onlyFf = uniqueLine(ffK, hapK);
        must(onlyHap || onlyFf, 'precondition: the Kimi contents differ by a line');
        const b = await clickRow(`#pm-window .pm-diff-rows tr.pm-diff-row[data-left="${ids.kimi}"]`);
        const rows = await readRows();
        must(rows.find((/** @type {any} */ r) => r.left === ids.kimi)?.selected, 'the Kimi row is not marked selected');
        const all = b.hunks.flatMap((/** @type {any} */ h) => h.lines);
        must(b.hunks.length >= 1, `no .pm-diff-hunk (head "${b.head}")`);
        if (onlyHap) must(all.some((/** @type {string} */ l) => l.startsWith('+|') && l.includes(onlyHap)), `no "+${onlyHap}" line`);
        if (onlyFf) must(all.some((/** @type {string} */ l) => l.startsWith('-|') && l.includes(onlyFf)), `no "-${onlyFf}" line`);
        const apiH = (await api('POST', '/diff/blocks', { a: { presetId: ids.ff, identifier: ids.kimi }, b: { presetId: ids.hap, identifier: ids.kimi } })).json.hunks;
        must(apiH.length === b.hunks.length, `UI ${b.hunks.length} hunks, API ${apiH.length}`);
        return `${b.hunks.length} hunk(s) under "${b.head}"; +"${(onlyHap ?? '').slice(0, 50)}" / -"${(onlyFf ?? '').slice(0, 50)}"`;
    });

    // ------------------------------------------------------------------ 2d
    await check('2d FF vs its own revision 3: rows come from the snapshot', async () => {
        await pick('a', ids.ff);
        const snap = await pick('b', ids.ff, { rev: 3 });
        const revText = await probe.eval(`document.querySelector(${J(side('b', '.pm-diff-rev'))}).selectedOptions[0]?.textContent ?? ''`);
        must(/#3/.test(revText) && /chk5 r3/.test(revText), `revision option "${revText}"`);
        must(snap.blocks[ids.ffMain].content.endsWith('MARK-R2 chk5') && (await getDoc(ids.ff)).blocks[ids.ffMain].content.endsWith('MARK-NOW chk5'), 'precondition: current and #3 differ in the main block');
        await compare();
        const head = await text('#pm-window .pm-diff-head-right');
        const rows = await readRows();
        const ch = rows.filter((/** @type {any} */ r) => r.status !== 'same');
        must(ch.length === 1 && ch[0].left === ids.ffMain && ch[0].status === 'changed', `non-same rows: ${J(ch)}`);
        const b = await clickRow(`#pm-window .pm-diff-rows tr.pm-diff-row[data-left="${ids.ffMain}"]`);
        const lines = b.hunks.flatMap((/** @type {any} */ h) => h.lines);
        must(lines.includes('-|MARK-NOW chk5') && lines.includes('+|MARK-R2 chk5'), `hunk lines ${J(lines).slice(0, 300)}`);
        return `B = "${revText}", header "${head}": ${rows.length} rows, only the main block changed; hunk -MARK-NOW / +MARK-R2 (the snapshot's text)`;
    });

    // ------------------------------------------------------------------ 2e
    await check('2e DEM block vs Sola block, and two blocks of one preset: hunks render', async () => {
        const dem = await getDoc(ids.dem);
        const sola = await getDoc(ids.sola);
        const withText = (/** @type {any} */ doc) => blockOrder(doc).map((b) => doc.blocks[b.identifier]).filter((b) => (b.content ?? '').split('\n').filter((l) => l.trim().length > 8).length >= 2);
        const A = withText(dem)[2];
        const Bb = withText(sola)[3];
        must(A && Bb && A.content !== Bb.content, 'precondition: a DEM and a Sola block with different text');
        await pick('a', ids.dem, { block: A.identifier });
        await pick('b', ids.sola, { block: Bb.identifier });
        await markBottomStale();
        await compare();
        const b1 = await until(async () => { const b = await readBottom(); return !b.stale && b.hunks.length ? b : null; }, 10000, 'DEM/Sola hunks');
        const rows1 = await readRows();
        must(rows1.length === 1 && rows1[0].left === A.identifier && rows1[0].right === Bb.identifier, `pair row ${J(rows1)}`);
        const l1 = b1.hunks.flatMap((/** @type {any} */ h) => h.lines);
        const aLine = uniqueLine(A.content, Bb.content);
        const bLine = uniqueLine(Bb.content, A.content);
        must(aLine && l1.some((/** @type {string} */ l) => l.startsWith('-|') && l.includes(aLine)), `no "-" line from the DEM block (${aLine})`);
        must(bLine && l1.some((/** @type {string} */ l) => l.startsWith('+|') && l.includes(bLine)), `no "+" line from the Sola block (${bLine})`);
        // two blocks of the same preset
        const ffBlocks = withText(await getDoc(ids.ff));
        const P = ffBlocks[3];
        const Q = ffBlocks[5];
        must(P && Q && P.identifier !== Q.identifier, 'precondition: two FF blocks with text');
        await pick('a', ids.ff, { block: P.identifier });
        await pick('b', ids.ff, { block: Q.identifier });
        await markBottomStale();
        await compare();
        const b2 = await until(async () => { const b = await readBottom(); return !b.stale && b.hunks.length ? b : null; }, 10000, 'FF P/Q hunks');
        const l2 = b2.hunks.flatMap((/** @type {any} */ h) => h.lines);
        const pLine = uniqueLine(P.content, Q.content);
        const qLine = uniqueLine(Q.content, P.content);
        must(pLine && l2.some((/** @type {string} */ l) => l.startsWith('-|') && l.includes(pLine)), `no "-" line from ${P.name}`);
        must(qLine && l2.some((/** @type {string} */ l) => l.startsWith('+|') && l.includes(qLine)), `no "+" line from ${Q.name}`);
        return `DEM "${A.name}" vs Sola "${Bb.name}": ${b1.hunks.length} hunk(s); FF "${P.name}" vs FF "${Q.name}": ${b2.hunks.length} hunk(s)`;
    });

    // ------------------------------------------------------------------ 2g
    await check('2g a pending /diff whose pickers changed, and a pending row diff overtaken by a new Compare, are discarded', async () => {
        const names = { ff: (await getDoc(ids.ff)).name, hap: hap0.name, dem: (await getDoc(ids.dem)).name };
        // (i) baseline: FF vs FF rendered
        await pick('a', ids.ff);
        await pick('b', ids.ff);
        const { status: st0 } = await compare();
        must((await text('#pm-window .pm-diff-head-right')) === names.ff, 'precondition: FF | FF rendered');
        // hold the FF-vs-Hapuppy /diff, change B to DEM meanwhile, release
        await pick('b', ids.hap);
        await probe.eval(`(() => { document.querySelectorAll('#pm-window .pm-diff-rows tr').forEach((el) => { el.dataset.chkOld = '1'; }); return true; })()`);
        await holdFetch('/st-preset-manager/diff', ids.hap);
        try {
            must(await click('#pm-window .pm-diff-go'), 'no Compare button');
            await until(() => probe.eval('window.__chkHeld === true'), 5000, 'the FF vs Hapuppy /diff is held');
            await pick('b', ids.dem);
        } finally {
            await probe.eval('(() => { window.__chkRelease?.(); return true; })()');
        }
        await until(() => probe.eval('window.__chkDone === true'), 5000, 'the held /diff answered');
        await sleep(600);
        const after = await probe.eval(`({
            rowsNew: [...document.querySelectorAll('#pm-window .pm-diff-rows tr.pm-diff-row')].filter((tr) => !tr.dataset.chkOld).length,
            rowsOld: document.querySelectorAll('#pm-window .pm-diff-rows tr.pm-diff-row[data-chk-old]').length,
            left: document.querySelector('#pm-window .pm-diff-head-left')?.textContent,
            right: document.querySelector('#pm-window .pm-diff-head-right')?.textContent,
            status: document.querySelector('#pm-window .pm-diff-status')?.textContent,
        })`);
        must(after.rowsNew === 0 && after.rowsOld > 0, `the stale FF vs Hapuppy rows rendered: ${J(after)}`);
        must(after.left === names.ff && after.right === names.ff && after.status === st0, `headers/status no longer describe the rows: ${J(after)}`);
        // a fresh Compare still works and renders the NEW selection
        await compare();
        must((await text('#pm-window .pm-diff-head-right')) === names.dem, 'Compare after the discard did not render FF vs DEM');
        // (ii) a pending row diff overtaken by a new Compare
        await pick('a', ids.ff);
        await pick('b', ids.hap);
        await compare();
        await holdFetch('/st-preset-manager/diff/blocks', ids.kimi);
        try {
            must(await probe.eval(`(() => { const tr = document.querySelector('#pm-window .pm-diff-rows tr.pm-diff-row[data-left="${ids.kimi}"]'); if (!tr) return false; tr.querySelector('.pm-diff-mid').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`), 'no Kimi row');
            await until(() => probe.eval('window.__chkHeld === true'), 5000, 'the Kimi row diff is held');
            await compare();
        } finally {
            await probe.eval('(() => { window.__chkRelease?.(); return true; })()');
        }
        await until(() => probe.eval('window.__chkDone === true'), 5000, 'the held row diff answered');
        await sleep(600);
        const b = await probe.eval(`({ head: document.querySelector('#pm-window .pm-diff-bottom-head')?.textContent, hunks: document.querySelectorAll('#pm-window .pm-diff-hunks .pm-diff-hunk').length })`);
        must(b.hunks === 0 && /Click a row/.test(b.head ?? ''), `the stale Kimi hunk overwrote the new comparison's bottom row: ${J(b)}`);
        await unhold();
        return `held FF-vs-Hapuppy /diff discarded after B changed to DEM (rows/headers/status kept: "${after.right}"); a later Compare rendered FF vs DEM; a held Kimi row diff released after a new Compare left the bottom at "${b.head}"`;
    });
    await unhold();

    // ------------------------------------------------------------------ 3
    /** Sola bits before the burst, the ten toggled identifiers, the burst snapshot number */
    const burst = { pre: /** @type {Record<string, boolean>} */ ({}), toggled: /** @type {string[]} */ ([]), snapRev: 0, lid: '' };

    await check('3a 10 rapid toggles make exactly 1 snapshot, holding the state from before the burst', async () => {
        const c0 = await until(converged, 15000, 'Sola converged in the slot');
        must(c0.slot.desired.presetId === ids.sola, 'precondition: Sola is in the slot');
        // a labelled checkpoint first, so the burst cannot coalesce into an older snapshot
        const cp = await api('POST', `/presets/${ids.sola}/revisions`, { label: 'chk5 before burst' });
        must(cp.status === 201, `checkpoint -> ${cp.status}`);
        const revs0 = await getRevs(ids.sola);
        const d0 = await getDoc(ids.sola);
        burst.lid = d0.activeLoadoutId;
        burst.pre = { ...d0.loadouts[burst.lid].enabled };
        burst.toggled = flattenSeq(d0.sequences[0].rows)
            .filter((/** @type {any} */ e) => e.rank === 'item' && !e.gmeta && e.leaf.kind === 'block')
            .map((/** @type {any} */ e) => e.leaf.ref).slice(0, 10);
        must(burst.toggled.length === 10, `precondition: 10 ungrouped Sola blocks (${burst.toggled.length})`);
        // fire all ten without waiting in between
        const res = await Promise.all(burst.toggled.map((id) => api('POST', `/presets/${ids.sola}/ops`, { op: 'toggle', identifier: id })));
        must(res.every((r) => r.status === 200), `toggle statuses ${J(res.map((r) => r.status))}`);
        const d1 = await getDoc(ids.sola);
        must(d1.rev === d0.rev + 10, `all ten landed: doc rev ${d0.rev} -> ${d1.rev}`);
        const flipped = burst.toggled.filter((id) => d1.loadouts[burst.lid].enabled[id] === !burst.pre[id]);
        must(flipped.length === 10, `bits flipped: ${flipped.length}/10`);
        const revs1 = await getRevs(ids.sola);
        must(revs1.length === revs0.length + 1, `snapshots ${revs0.length} -> ${revs1.length}: ${J(revs1.slice(-3))}`);
        const newest = revs1.at(-1);
        must(newest.label === null, `the burst snapshot is unlabelled (${newest.label})`);
        burst.snapRev = newest.rev;
        const snap = (await api('GET', `/presets/${ids.sola}/revisions/${newest.rev}`)).json;
        must(J(snap.doc.loadouts[burst.lid].enabled) === J(burst.pre), 'the burst snapshot does not hold the pre-burst bits');
        return `doc rev ${d0.rev} -> ${d1.rev} (10 toggles landed), snapshots ${revs0.length} -> ${revs1.length}; #${newest.rev} holds the pre-burst loadout`;
    });

    await check('3b a labelled save makes its own snapshot', async () => {
        const revs0 = await getRevs(ids.sola);
        const cur = await getDoc(ids.sola);
        const r = await api('POST', `/presets/${ids.sola}/revisions`, { label: 'chk5 labelled save' });
        must(r.status === 201, `-> ${r.status} ${r.text}`);
        const revs1 = await getRevs(ids.sola);
        must(revs1.length === revs0.length + 1 && revs1.at(-1).rev === r.json.rev && revs1.at(-1).label === 'chk5 labelled save', `revisions ${J(revs1.slice(-3))}`);
        const snap = (await api('GET', `/presets/${ids.sola}/revisions/${r.json.rev}`)).json;
        must(J(snap.doc) === J(cur), 'the labelled snapshot is not the current document');
        must((await getDoc(ids.sola)).rev === cur.rev, 'a labelled snapshot changed the document');
        return `snapshots ${revs0.length} -> ${revs1.length}; #${r.json.rev} "chk5 labelled save" = the current document`;
    });

    await check('3c restore writes a snapshot first, and ST\'s live prompts show the restored state', async () => {
        must(burst.snapRev > 0, 'precondition: 3a recorded the burst snapshot');
        const c0 = await until(converged, 15000, 'Sola converged before the restore');
        const cur = await getDoc(ids.sola);
        const liveOn = (/** @type {any[]} */ order, /** @type {string} */ id) => order.find((e) => e.identifier === id)?.enabled;
        must(burst.toggled.every((id) => liveOn(c0.s.order, id) === cur.loadouts[burst.lid].enabled[id] && liveOn(c0.s.order, id) === !burst.pre[id]),
            'precondition: ST shows the toggled (post-burst) state');
        const domOf = () => probe.eval(`${J(burst.toggled)}.map((id) => { const r = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="' + id + '"]'); return r ? !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on') : null; })`);
        const matches = (/** @type {any[]} */ dom) => dom.filter((v, i) => v === burst.pre[burst.toggled[i]]).length;
        await until(async () => { const d = await domOf(); return d.every((v, i) => v === !burst.pre[burst.toggled[i]]); }, 10000, 'precondition: ST\'s prompt-manager rows show the post-burst toggles');
        const revs0 = await getRevs(ids.sola);
        const r = await api('POST', `/presets/${ids.sola}/restore`, { rev: burst.snapRev });
        must(r.status === 200, `restore -> ${r.status} ${r.text.slice(0, 200)}`);
        const revs1 = await getRevs(ids.sola);
        must(revs1.length === revs0.length + 1 && revs1.at(-1).rev === r.json.snapshotRev, `snapshots ${revs0.length} -> ${revs1.length}, snapshotRev ${r.json.snapshotRev}`);
        must(/restore/i.test(revs1.at(-1).label ?? ''), `pre-restore snapshot label "${revs1.at(-1).label}"`);
        const pre = (await api('GET', `/presets/${ids.sola}/revisions/${r.json.snapshotRev}`)).json;
        must(J(pre.doc) === J(cur), 'the pre-restore snapshot is not the document as it was before the restore');
        const after = await getDoc(ids.sola);
        must(J(after.loadouts[burst.lid].enabled) === J(burst.pre) && after.rev === cur.rev + 1, 'the document was not restored');
        const c1 = await until(async () => {
            const c = await converged();
            return c && burst.toggled.every((id) => liveOn(c.s.order, id) === burst.pre[id]) ? c : null;
        }, 20000, 'ST shows the restored bits');
        await until(async () => matches(await domOf()) === 10, 10000, `ST prompt-manager rows show the 10 restored toggles (last ${J(await domOf())}, pre ${J(burst.toggled.map((id) => burst.pre[id]))})`);
        return `restore #${burst.snapRev}: pre-restore snapshot #${r.json.snapshotRev} "${revs1.at(-1).label}" = old document; ST live order + prompt-manager DOM show all 10 restored bits (slot hash ${c0.slot.hash?.slice(0, 8)} -> ${c1.slot.hash?.slice(0, 8)})`;
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
