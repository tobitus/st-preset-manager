#!/usr/bin/env node
/**
 * Round 2 quick wins (owner note 001) acceptance, one real-browser script.
 * Drives the ACTUAL v2 window in a headless Chromium over raw CDP and
 * observes the plugin REST API and ST's live chat-completion state.
 *
 *   node dev/check-round2.mjs            all sections (resets dev data first)
 *   node dev/check-round2.mjs a1 a3      a subset of sections
 *
 * Sections:
 *   a1 Import/Export lives at the bottom of the Library pane (no Import/Export
 *      tab); importing the Nemo fixture (prompt_order 100000 + 100001) shows a
 *      result row whose .pm-io-notes names the dropped 100000 (F-066); the
 *      block editor's save button reads "Save block"
 * Screenshots (dev/shots/): round2-a1-library.png.
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
import { flattenSeq } from '../shared/outline.js';

const TAB = 'chkr2';
const SOLA = 'Sola V2 Flame';
const NEMO = 'Nemo Engine 11.5.2 - Default RP';
const SHOTS = path.join(REPO, 'dev', 'shots');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-round2.cookies.jar'), onFatal: fatal });
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
    await dismissPopups();
}

async function openWindow() {
    if (!(await click('#pm-float-btn'))) throw new Error('no #pm-float-btn');
    await until(() => exists('#pm-window .pm-tab[data-tab="presets"]'), 10000, 'window opened');
}

/**
 * Attach `absPath` to a file input via CDP (fires input+change like a real
 * pick): get an objectId (no returnByValue), then DOM.setFileInputFiles.
 */
async function setFileInput(/** @type {string} */ sel, /** @type {string} */ absPath) {
    const ev = await probe.cdp('Runtime.evaluate', { expression: `document.querySelector(${J(sel)})` });
    const objectId = ev.result?.objectId;
    if (!objectId) throw new Error(`setFileInput: ${sel} not found`);
    await probe.cdp('DOM.setFileInputFiles', { files: [absPath], objectId });
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

// ------------------------------------------------------------------ a1

async function sectionA1() {
    await check('a1 Import/Export is a section at the bottom of the Library pane; no Import/Export tab', async () => {
        await showTab('library');
        must(!(await exists('#pm-window .pm-tab[data-tab="io"]')), 'a .pm-tab[data-tab=io] still exists');
        must(!(await exists('#pm-window .pm-pane[data-pane="io"]')), 'a .pm-pane[data-pane=io] still exists');
        const sel = '#pm-window .pm-pane[data-pane="library"] > .pm-io-section';
        await until(() => exists(`${sel} .pm-io-file`), 5000, 'io section with its file input');
        const geo = await probe.eval(`(() => {
            const sec = document.querySelector(${J(sel)});
            const list = document.querySelector('#pm-window .pm-pane[data-pane="library"] .pm-library-list');
            if (!sec || !list) return null;
            return {
                after: !!(list.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING),
                insideRoot: !!sec.closest('.pm-root'),
                listBottom: Math.round(list.getBoundingClientRect().bottom),
                secTop: Math.round(sec.getBoundingClientRect().top),
            };
        })()`);
        must(geo, 'section or library list missing');
        must(geo.after && !geo.insideRoot, `section not after the list outside .pm-root: ${J(geo)}`);
        must(geo.secTop >= geo.listBottom, `section top ${geo.secTop} above list bottom ${geo.listBottom}`);
        await shot('round2-a1-library.png');
        return `section after the list (list bottom ${geo.listBottom}px, section top ${geo.secTop}px), no io tab/pane`;
    });

    await check('a1 importing the Nemo fixture (100000 + 100001) shows a result row whose .pm-io-notes names 100000', async () => {
        const absPath = path.join(REPO, 'dev', 'fixtures', 'presets', `${NEMO}.json`);
        must(fs.existsSync(absPath), `fixture missing: ${absPath}`);
        await setFileInput('#pm-window .pm-io-section .pm-io-file', absPath);
        const resultSel = `#pm-window .pm-io-result[data-status="ok"][data-name="${NEMO}"]`;
        const presetId = await until(async () => {
            if (!(await exists(resultSel))) return null;
            return probe.eval(`document.querySelector(${J(resultSel)}).dataset.presetId`);
        }, 20000, 'Nemo import result row').catch(async (err) => {
            const rows = await probe.eval(`[...document.querySelectorAll('#pm-window .pm-io-result')].map((r) => [r.dataset.status, r.dataset.name, r.textContent.slice(0, 120)])`);
            throw new Error(`${err.message}; result rows: ${J(rows)}`);
        });
        const notes = await text(`${resultSel} .pm-io-notes`);
        must(notes && notes.includes('100000'), `.pm-io-notes ${J(notes?.slice(0, 120))} does not mention 100000`);
        const doc = await getDoc(presetId);
        must(doc.sequences.length === 1 && doc.sequences[0].character_id === 100001,
            `imported doc sequences ${J(doc.sequences.map((/** @type {any} */ s) => s.character_id))}, want [100001]`);
        const line = notes.split('\n').find((/** @type {string} */ l) => l.includes('100000'));
        return `preset ${presetId}: 1 sequence (100001); note ${J(line)}`;
    });

    await check('a1 the block editor save button reads "Save block"', async () => {
        await showTab('presets');
        await until(() => exists(`${view(ids.sola)} .pm-outline li.pm-node`), 10000, 'Sola view');
        const leaf = flat(await getDoc(ids.sola)).find((e) => e.rank === 'item' || e.rank === undefined) ?? flat(await getDoc(ids.sola))[0];
        await selectRow(ids.sola, leaf.leaf.key);
        const btn = `${view(ids.sola)} .pm-block-save`;
        await until(() => exists(btn), 5000, 'block editor');
        const t = (await text(btn))?.trim();
        must(t === 'Save block', `.pm-block-save text is ${J(t)}`);
        return `row ${identOf(leaf.leaf)}: .pm-block-save = ${J(t)}`;
    });
}

// ------------------------------------------------------------------ a2

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

/** The li selector of the headerless group that has the leaf `key` among its options. */
const hlessLi = (/** @type {string} */ key) => `${view(ids.sola)} li.pm-node[data-kind="group"][data-key^="grp:"]:has(> ul.pm-list > li.pm-node[data-key="${key}"])`;

async function sectionA2() {
    await showTab('presets');
    await until(() => exists(`${view(ids.sola)} .pm-outline li.pm-node`), 10000, 'Sola view');
    const doc0 = await getDoc(ids.sola);
    const f0 = flat(doc0);
    // two adjacent top-level plain blocks become a headerless group (REST)
    const i0 = f0.findIndex((e, i) => i > 2 && e.rank === 'item' && e.leaf.kind === 'block' && f0[i + 1]?.rank === 'item' && f0[i + 1]?.leaf.kind === 'block');
    must(i0 > 0, 'no two adjacent plain blocks in Sola');
    const [KA, KB] = [f0[i0].leaf.key, f0[i0 + 1].leaf.key];

    await check('a2 every outline row with a leaf shows .pm-row-num = its 1-based flat position', async () => {
        await until(async () => {
            const got = await probe.eval(`[...document.querySelectorAll(${J(`${view(ids.sola)} .pm-outline li.pm-node`)})]
                .filter((li) => li.dataset.kind === 'leaf' || (li.dataset.key && !li.dataset.key.startsWith('grp:')))
                .map((li) => [li.dataset.key, li.querySelector(':scope > .pm-row .pm-row-num')?.textContent?.trim() ?? null, li.dataset.pos ?? null])`);
            const want = flat(await getDoc(ids.sola)).map((e, i) => [e.leaf.key, String(i + 1), String(i + 1)]);
            return J(got) === J(want) ? got : null;
        }, 8000, 'row numbers 1..N in flat order');
        return `${f0.length} rows numbered 1..${f0.length} in flat order (data-pos matches)`;
    });

    await check('a2 clicking a headerless group row selects it; the editor shows rename / 1-N / Dissolve; Dissolve posts exactly one op', async () => {
        must((await op(ids.sola, { op: 'demote', keys: [KA, KB] })).status === 200, 'REST demote {keys} failed');
        const li = hlessLi(KA);
        await until(() => exists(li), 8000, 'headerless group renders');
        const groupKey = await probe.eval(`document.querySelector(${J(li)}).dataset.key`);
        const nameSel = `${li} > .pm-row .pm-name`;
        await mouseClickSel((await exists(nameSel)) ? nameSel : `${li} > .pm-row`);
        await until(() => exists(`${li} > .pm-row.pm-selected`), 5000, 'group row selected');
        for (const c of ['.pm-group-name', '.pm-group-rename', '.pm-group-card', '.pm-group-dissolve']) {
            await until(() => exists(`${view(ids.sola)} ${c}`), 5000, `editor ${c}`);
        }
        const cardText = (await text(`${view(ids.sola)} .pm-group-card`))?.trim();
        await shot('round2-a2-group-card.png');
        const loadouts0 = J((await getDoc(ids.sola)).loadouts);
        const ids0 = flat(await getDoc(ids.sola)).map((e) => e.leaf.key);
        await recordOps();
        await click(`${view(ids.sola)} .pm-group-dissolve`);
        const d1 = await until(async () => {
            const d = await getDoc(ids.sola);
            return flat(d).find((e) => e.leaf.key === KA)?.rank === 'item' ? d : null;
        }, 8000, 'options are plain items');
        await sleep(500);
        const seen = await opsSeen();
        must(J(seen) === J([{ op: 'dissolveGroup', key: groupKey }]), `ops ${J(seen)}`);
        must(flat(d1).find((e) => e.leaf.key === KB)?.rank === 'item', 'second option not a plain item');
        must(J(flat(d1).map((e) => e.leaf.key)) === J(ids0), 'flat order changed');
        must(J(d1.loadouts) === loadouts0, 'loadouts changed');
        const topLevel = (/** @type {string} */ k) => probe.eval(`(() => { const el = document.querySelector(${J(`${rowLi(ids.sola, k)}[data-kind="leaf"]`)}); return !!el && !el.parentElement.closest('li.pm-node'); })()`);
        await until(async () => !(await exists(li)) && await topLevel(KA) && await topLevel(KB), 8000, 'group row gone, options top-level');
        return `group ${groupKey} selected (card shows ${J(cardText)}); Dissolve -> ops ${J(seen)}; ${KA}/${KB} are top-level items, order + loadouts unchanged`;
    });

    await check('a2 Ctrl-click two rows, Promote: one promote op carrying both keys', async () => {
        await mouseClickSel(`${rowLi(ids.sola, KA)} > .pm-row .pm-name`);
        await until(() => exists(`${rowLi(ids.sola, KA)} > .pm-row.pm-selected`), 5000, 'A selected');
        await mouseClickSel(`${rowLi(ids.sola, KB)} > .pm-row .pm-name`, 2);
        await until(async () => await exists(`${rowLi(ids.sola, KA)} > .pm-row.pm-selected`) && await exists(`${rowLi(ids.sola, KB)} > .pm-row.pm-selected`), 5000, 'A and B selected');
        await recordOps();
        await click(`${view(ids.sola)} .pm-rank-promote`);
        const d = await until(async () => {
            const doc = await getDoc(ids.sola);
            const r = (/** @type {string} */ k) => flat(doc).find((e) => e.leaf.key === k)?.rank;
            return r(KA) === 'group' && r(KB) === 'group' ? doc : null;
        }, 8000, 'both rows are group headings');
        await sleep(500);
        const seen = await opsSeen();
        must(seen.length === 1 && seen[0].op === 'promote' && J([...seen[0].keys].sort()) === J([KA, KB].sort()), `ops ${J(seen)}`);
        await shot('round2-a2-multiselect.png');
        // restore plain rows (REST)
        must((await op(ids.sola, { op: 'demote', keys: [KA, KB] })).status === 200, 'restore demote failed');
        return `ops ${J(seen)}; ranks ${J([KA, KB].map((k) => flat(d).find((e) => e.leaf.key === k)?.rank))}`;
    });

    await check('a2 group card on a headerless group: Rename sets its name; 1/N flips it; its pick-one switch reaches ST\'s loaded preset', async () => {
        // A on, B off, then one headerless pick-one-or-more group of the two (REST)
        const [IA, IB] = [identOf(f0[i0].leaf), identOf(f0[i0 + 1].leaf)];
        must((await op(ids.sola, { op: 'toggle', identifier: IA, value: true })).status === 200, `toggle ${IA} on failed`);
        must((await op(ids.sola, { op: 'toggle', identifier: IB, value: false })).status === 200, `toggle ${IB} off failed`);
        must((await op(ids.sola, { op: 'demote', keys: [KA, KB] })).status === 200, 'REST demote {keys} failed');
        const li = hlessLi(KA);
        await until(() => exists(li), 8000, 'headerless group renders');
        const groupKey = await probe.eval(`document.querySelector(${J(li)}).dataset.key`);
        const groupRow = async () => (await getDoc(ids.sola)).sequences[0].rows.find((/** @type {any} */ r) => r.key === groupKey);
        must((await groupRow())?.cardinality === 'pick-one-or-more', `group ${groupKey} not pick-one-or-more`);
        const stOn = async () => {
            const order = (await st()).order;
            return [IA, IB].filter((i) => order.find((/** @type {any} */ o) => o.identifier === i)?.enabled);
        };
        await until(async () => J(await stOn()) === J([IA]), 10000, 'ST shows A on, B off');
        await mouseClickSel(`${li} > .pm-row`);
        await until(() => exists(`${li} > .pm-row.pm-selected`), 5000, 'group row selected');
        await until(() => exists(`${view(ids.sola)} .pm-group-name`), 5000, 'group card');
        const NAME = 'Round2 Options';
        await probe.eval(`(() => { const el = document.querySelector(${J(`${view(ids.sola)} .pm-group-name`)}); el.value = ${J(NAME)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await click(`${view(ids.sola)} .pm-group-rename`);
        await until(async () => (await groupRow())?.name === NAME, 8000, 'group renamed in the doc');
        await until(async () => (await text(`${li} > .pm-row`))?.includes(NAME), 8000, 'outline shows the new group name');
        await click(`${view(ids.sola)} .pm-group-card`);
        await until(async () => (await groupRow())?.cardinality === 'pick-one', 8000, 'cardinality pick-one');
        await until(() => exists(`${rowLi(ids.sola, KB)} > .pm-row input.pm-switch[type="radio"]`), 8000, 'options render as radios');
        await mouseClickSel(`${rowLi(ids.sola, KB)} > .pm-row input.pm-switch`);
        const on1 = await until(async () => { const on = await stOn(); return J(on) === J([IB]) ? on : null; }, 10000, 'ST loaded preset shows only B on');
        await mouseClickSel(`${li} > .pm-row`);
        await until(() => exists(`${view(ids.sola)} .pm-group-card`), 5000, 'group card again');
        await click(`${view(ids.sola)} .pm-group-card`);
        await until(async () => (await groupRow())?.cardinality === 'pick-one-or-more', 8000, 'cardinality back to pick-one-or-more');
        must((await op(ids.sola, { op: 'dissolveGroup', key: groupKey })).status === 200, `cleanup dissolveGroup ${groupKey} failed`);
        return `group ${groupKey} renamed ${J(NAME)}; N -> 1; clicking B's radio: ST enabled among ${J([IA, IB])} = ${J(on1)}; 1 -> N; dissolved`;
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
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, FF + Sola imported, Sola in the slot and open, clean pm.* localStorage', true, `ff=${ids.ff} sola=${ids.sola}`);

    if (wanted('a1')) await sectionA1();
    if (wanted('a2')) await sectionA2();

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
