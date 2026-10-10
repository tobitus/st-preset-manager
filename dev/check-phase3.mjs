#!/usr/bin/env node
/**
 * Phase 3 acceptance (roadmap acceptance 9 export half, 10, 11) as one
 * repeatable real-browser script. Drives the ACTUAL Import/Export section (bottom of the Library pane) in a
 * headless Chromium over raw CDP (file-input via CDP DOM.setFileInputFiles,
 * synthetic drag/drop, ST's own preset-import file input, real generation)
 * and cross-checks with the v1 parity script and the REST API — never only
 * one of those.
 *
 *   node dev/check-phase3.mjs              all checks
 *   node dev/check-phase3.mjs 10 9 ui native slot 11   subset
 *
 * Checks:
 *   setup   reset + fixtures, window opened via the UI
 *   10      parity script (v1 vs JS), library docs == v1 for the server
 *           import path, non-preset JSON rejected (API + file picker),
 *           FrankenSIM imported flat via the file picker and editable,
 *           container log stays clean
 *   9       ST export (format=st) carries no notes/groups/cardinality keys
 *   ui      drop import, drop outside the drop zone is swallowed,
 *           ST-list import (409 then identity-preserving replace),
 *           st/native export downloads == the API export, screenshots
 *   native  native export -> import: 409 without replace, delete, then a
 *           free-id reimport is byte-identical to the export (id included)
 *   slot    replacing the slot's own preset keeps it bound: panel edits in
 *           ST and switch edits in the v2 window both keep flowing
 *   11      ST round trip in a freshly reset ST: export a preset as ST
 *           JSON, import both the export and the original fixture into a
 *           clean ST, compare live oai state and mock-captured generation
 *
 * Environment: st-pm-dev on 127.0.0.1:8002 with the plugin (dev/up.sh), the
 * mock LLM on :8099. Never touches :8001, the sillytavern container,
 * ~/tools/ST-dev or /home/jon/projects/sillysystem/st.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    FF, Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, httpJson, sleep, until,
} from './harness.mjs';
import { FIXTURE_DIR, PARITY_FILES, jsStructure, structureDiff, v1Structure } from './parity.mjs';
import { CONNECTION_KEYS } from '../shared/st-keys.js';

const TAB = 'chk3';
const MOCK_PORT = 8099;
const LEAF_KINDS = ['marker', 'block', 'ghost'];

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-phase3.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const args = process.argv.slice(2);
const wanted = (/** @type {string} */ name) => args.length === 0 || args.includes(name);
const J = (/** @type {any} */ v) => JSON.stringify(v);

/** @type {{ ff: string, dem: string, sola: string, frank: string }} */
const presetIds = { ff: '', dem: '', sola: '', frank: '' };
/** @type {string} */
let t0 = '';

// ------------------------------------------------------------------ page helpers (check-phase2 pattern)

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
/** Set a form control's value and fire `evt` (input for text, change for select). */
const setValue = (/** @type {string} */ sel, /** @type {string} */ value, evt = 'input') => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return true; })()`);
/** Set a checkbox's checked state and fire `change`. */
const setChecked = (/** @type {string} */ sel, /** @type {boolean} */ value) => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.checked = ${value ? 'true' : 'false'}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

/** ST's live chat-completion state (order entries verbatim for byte compares). */
function oai() {
    return probe.eval(`(() => {
        const o = SillyTavern.getContext().chatCompletionSettings;
        return {
            preset: o.preset_settings_openai,
            order: o.prompt_order?.[0]?.order ?? [],
            prompts: (o.prompts ?? []).map((p) => ({ identifier: p.identifier, content: p.content ?? '' })),
        };
    })()`);
}
/** ST's OWN prompt-manager rows. @returns {Promise<{identifier: string, enabled: boolean}[]>} */
function stDom() {
    return probe.eval(`Array.from(document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')).map((r) => ({
        identifier: r.dataset.pmIdentifier,
        enabled: !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on'),
    }))`);
}
const getSlot = async () => (await api('GET', '/slot')).json;
/** The live order equals the compiled slot order (converged). */
async function converged() {
    const [o, s] = await Promise.all([oai(), getSlot()]);
    return o.preset === SLOT_NAME && J(o.order) === J(s.compiled?.prompt_order?.[0]?.order) ? o : null;
}
/** Click ST's own toggle; false while the bridge's apply overlay is up (retry). */
const clickStToggle = (/** @type {string} */ id) => probe.eval(`(() => { if (document.querySelector('.pm-apply-blocker')) return false; const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${id}"] .prompt-manager-toggle-action'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`);

/**
 * ST can pop a modal <dialog> in a fresh profile a few seconds after boot; a
 * modal dialog captures all real (CDP) keyboard/mouse input, while scripted
 * el.click() still works. Close any before driving real input; log what it was.
 */
async function dismissPopups() {
    const closed = await probe.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

/**
 * Poll for ~`ms` ms; for every open <dialog>, click its cancel button if
 * present else its ok button. Logs each popup's text and the button clicked.
 */
async function handlePopups(ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const closed = await probe.eval(`(() => {
            const open = [...document.querySelectorAll('dialog[open]')];
            return open.map((d) => {
                const cancel = d.querySelector('.popup-button-cancel');
                const btn = cancel ?? d.querySelector('.popup-button-ok');
                const text = d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80);
                const label = cancel ? 'cancel' : 'ok';
                btn?.click();
                return { text, label };
            });
        })()`);
        for (const c of closed) console.error(`[check] popup: "${c.text}" -> ${c.label}`);
        await sleep(250);
    }
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

// ------------------------------------------------------------------ structural helpers

/** Depth-first rows, descending into section `.rows` and group `.options`. */
function allRows(/** @type {any[]} */ rows) {
    /** @type {any[]} */
    const out = [];
    const walk = (/** @type {any[]} */ list) => {
        for (const r of list ?? []) {
            out.push(r);
            if (Array.isArray(r.rows)) walk(r.rows);
            if (Array.isArray(r.options)) walk(r.options);
        }
    };
    walk(rows);
    return out;
}

/** Total group/section rows across every sequence of a native doc. */
function countKinds(/** @type {any} */ doc) {
    let groups = 0;
    let sections = 0;
    for (const seq of doc?.sequences ?? []) {
        for (const r of allRows(seq.rows)) {
            if (r.kind === 'group') groups += 1;
            if (r.kind === 'section') sections += 1;
        }
    }
    return { groups, sections };
}

/** Structural compare (order-independent object keys); first differing JSON path, or null. */
function firstDiff(/** @type {any} */ a, /** @type {any} */ b, p = '$') {
    if (a === b) return null;
    if (a === null || b === null) return p;
    if (typeof a !== typeof b) return p;
    if (typeof a !== 'object') return p;
    if (Array.isArray(a) !== Array.isArray(b)) return p;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return `${p}.length(${a.length} vs ${b.length})`;
        for (let i = 0; i < a.length; i++) {
            const d = firstDiff(a[i], b[i], `${p}[${i}]`);
            if (d) return d;
        }
        return null;
    }
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (J(ak) !== J(bk)) return `${p}.keys(${J(ak)} vs ${J(bk)})`;
    for (const k of ak) {
        const d = firstDiff(a[k], b[k], `${p}.${k}`);
        if (d) return d;
    }
    return null;
}

const omit = (/** @type {any} */ obj, /** @type {string[]} */ keys) =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

/** Every key at any depth that appears in `banned`. */
function scanKeys(/** @type {any} */ value, /** @type {string[]} */ banned, /** @type {Set<string>} */ found = new Set()) {
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (banned.includes(k)) found.add(k);
            scanKeys(v, banned, found);
        }
    }
    return found;
}

// ------------------------------------------------------------------ downloads (ui export checks)

/** Try Browser.setDownloadBehavior (browser-level), fall back to Page.setDownloadBehavior. */
async function enableDownloads(/** @type {string} */ downloadPath) {
    try {
        await probe.cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath, eventsEnabled: true });
        console.error('[check] downloads via Browser.setDownloadBehavior');
    } catch {
        await probe.cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath });
        console.error('[check] downloads via Page.setDownloadBehavior (fallback)');
    }
}

/** Wait for `fileName` to appear in `dir` with no .crdownload sibling and a stable size. */
async function waitForDownload(/** @type {string} */ dir, /** @type {string} */ fileName, ms = 10000) {
    const end = Date.now() + ms;
    let lastSize = -1;
    for (;;) {
        const files = fs.readdirSync(dir);
        const pending = files.some((f) => f.endsWith('.crdownload'));
        if (!pending && files.includes(fileName)) {
            const size = fs.statSync(path.join(dir, fileName)).size;
            if (size > 0 && size === lastSize) return path.join(dir, fileName);
            lastSize = size;
        }
        if (Date.now() > end) throw new Error(`timeout waiting for download ${fileName} in ${dir} (files: ${J(files)})`);
        await sleep(300);
    }
}

/** Select FF + format in the io tab, click export, compare the downloaded file to the API export. */
async function runExportCheck(/** @type {string} */ name, /** @type {'st'|'native'} */ fmt, /** @type {string} */ fileName, /** @type {string} */ dir) {
    try {
        for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
        await setValue('#pm-window .pm-io-format', fmt, 'change');
        await click('#pm-window .pm-io-export-go');
        const filePath = await waitForDownload(dir, fileName, 10000);
        const statusFile = await probe.eval(`document.querySelector('#pm-window .pm-io-export-status')?.dataset.file ?? null`);
        const fileJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const apiJson = (await api('GET', `/presets/${presetIds.ff}/export?format=${fmt}`)).json;
        const diff = firstDiff(fileJson, apiJson);
        report(name, statusFile === fileName && diff === null, `file=${fileName} statusFile=${statusFile} diff=${diff ?? 'none'}`);
    } catch (err) {
        report(name, false, /** @type {Error} */ (err).message);
    }
}

// ===========================================================================

async function main() {
    // ---------------------------------------------------------- environment
    let up = false;
    for (let i = 0; i < 2 && !up; i++) {
        try { up = (await api('GET', '/health')).status === 200; } catch { /* down */ }
        if (!up && i === 0) {
            console.error('[check] st-pm-dev not answering; running dev/up.sh');
            execFileSync(path.join(REPO, 'dev', 'up.sh'), { stdio: 'inherit' });
        }
    }
    if (!up) fatal('environment', 'st-pm-dev did not come up');
    await primeSession();
    console.error('[check] resetting dev data (dev/reset.sh)…');
    execFileSync(path.join(REPO, 'dev', 'reset.sh'), { stdio: 'inherit' });
    await primeSession();
    console.error('[check] importing fixtures (dev/import-fixtures.sh)…');
    execFileSync(path.join(REPO, 'dev', 'import-fixtures.sh'), { stdio: 'pipe' });
    const library0 = (await api('GET', '/library')).json ?? [];
    const need = { ff: FF, dem: 'DEUS.EX.MACHINA.V2.5.ST', sola: 'Sola V2 Flame', frank: 'FrankenSIM.2.5.Release.1' };
    for (const [key, name] of Object.entries(need)) {
        const id = library0.find((/** @type {any} */ e) => e.name === name)?.id;
        if (!id) fatal('setup', `fixture ${name} missing from the library`);
        presetIds[/** @type {keyof typeof presetIds} */ (key)] = id;
    }

    console.error('[check] starting probe tab…');
    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await dismissPopups();
    try {
        await until(() => exists('#pm-menu-item'), 20000, 'wand menu entry');
        await click('#pm-menu-item');
        await until(() => exists('#pm-window .pm-tabs'), 10000, 'window');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: fixtures imported + window opened', true,
        `ffId=${presetIds.ff} demId=${presetIds.dem} solaId=${presetIds.sola} frankId=${presetIds.frank}`);

    t0 = new Date().toISOString();

    // ------------------------------------------------------------------ 10
    if (wanted('10')) {
        {
            const name = '10 parity script (v1 vs JS, 3 presets)';
            try {
                const out = execFileSync('node', ['dev/parity.mjs'], { cwd: REPO, encoding: 'utf8' });
                const identical = out.split('\n').filter((l) => l.startsWith('IDENTICAL'));
                report(name, identical.length === 3, identical.join(' | '));
            } catch (err) {
                const out = /** @type {any} */ (err).stdout?.toString() ?? '';
                const diffLines = out.split('\n').filter((/** @type {string} */ l) => l.startsWith('DIFF') || l.startsWith('    ') || l.startsWith('parity:'));
                report(name, false, diffLines.join(' | ') || /** @type {Error} */ (err).message);
            }
        }
        {
            const name = '10 library docs == v1 (server import path)';
            try {
                const nameToId = { [FF]: presetIds.ff, 'DEUS.EX.MACHINA.V2.5.ST': presetIds.dem, 'Sola V2 Flame': presetIds.sola };
                /** @type {string[]} */
                const evid = [];
                let allEmpty = true;
                let ffGroups = 0;
                let demGroups = 0;
                for (const file of PARITY_FILES) {
                    const base = file.replace(/\.json$/, '');
                    const id = /** @type {any} */ (nameToId)[base];
                    if (!id) throw new Error(`no library id for parity file ${base}`);
                    const abs = path.join(FIXTURE_DIR, file);
                    const doc = (await api('GET', `/presets/${id}`)).json;
                    const diff = structureDiff(v1Structure(abs), jsStructure(doc));
                    const { groups, sections } = countKinds(doc);
                    if (base === FF) ffGroups = groups;
                    if (base === 'DEUS.EX.MACHINA.V2.5.ST') demGroups = groups;
                    if (diff.length) allEmpty = false;
                    evid.push(`${base}: groups=${groups} sections=${sections}${diff.length ? ` DIFF ${diff.slice(0, 3).join(' | ')}` : ''}`);
                }
                const nonVacuous = ffGroups >= 8 && demGroups >= 16;
                report(name, allEmpty && nonVacuous, evid.join('; '));
            } catch (err) {
                report(name, false, /** @type {Error} */ (err).message);
            }
        }
        {
            const name = '10 non-preset JSON → 400 (API)';
            try {
                const before = (await api('GET', '/library')).json ?? [];
                const regexJson = JSON.parse(fs.readFileSync(path.join(REPO, 'dev', 'fixtures', 'FF5 Regex 3.0 Suite.json'), 'utf8'));
                const res = await api('POST', '/presets', { st: regexJson, name: 'FF5 Regex 3.0 Suite' });
                const after = (await api('GET', '/library')).json ?? [];
                const msgOk = /not a Chat Completion preset/.test(res.json?.error ?? '');
                const noStack = !res.text.includes('    at ');
                const countOk = after.length === before.length;
                report(name, res.status === 400 && msgOk && noStack && countOk,
                    `status=${res.status} error=${res.json?.error} noStack=${noStack} library ${before.length}->${after.length}`);
            } catch (err) {
                report(name, false, /** @type {Error} */ (err).message);
            }
        }
        {
            const name = '10 FrankenSIM via file picker: flat, opens editable';
            try {
                await api('DELETE', `/presets/${presetIds.frank}`);
                const lib1 = (await api('GET', '/library')).json ?? [];
                if (lib1.some((/** @type {any} */ e) => e.id === presetIds.frank)) throw new Error('FrankenSIM still in library after delete');
                await click('#pm-window .pm-tab[data-tab="library"]');
                await until(() => exists('#pm-window .pm-pane[data-pane="library"]:not([hidden]) .pm-io-section .pm-io-file'), 5000, 'library pane with the import section shown');
                const absPath = path.join(REPO, 'dev', 'fixtures', 'presets', 'FrankenSIM.2.5.Release.1.json');
                await setFileInput('#pm-window .pm-io-file', absPath);
                const resultSel = '.pm-io-result[data-status="ok"][data-name="FrankenSIM.2.5.Release.1"]';
                const newId = await until(async () => {
                    if (!(await exists(resultSel))) return null;
                    return probe.eval(`document.querySelector(${J(resultSel)}).dataset.presetId`);
                }, 10000, 'FrankenSIM import result');
                const lib2 = (await api('GET', '/library')).json ?? [];
                if (!lib2.some((/** @type {any} */ e) => e.id === newId)) throw new Error(`imported id ${newId} not in library`);
                const doc = (await api('GET', `/presets/${newId}`)).json;
                const flatKind = doc.source?.recognizer?.kind === 'flat';
                const rows = doc.sequences[0].rows;
                const allLeaf = rows.every((/** @type {any} */ r) => LEAF_KINDS.includes(r.kind));
                const fixture = JSON.parse(fs.readFileSync(absPath, 'utf8'));
                const expectedLen = fixture.prompt_order?.find((/** @type {any} */ po) => po.character_id === 100001)?.order.length ?? -1;
                const leafCountOk = rows.length === expectedLen;

                await click(`${resultSel} .pm-io-open`);
                await until(() => probe.eval(`!document.querySelector('#pm-window .pm-pane[data-pane="presets"]').hidden`), 8000, 'presets pane visible');
                const nodeCount = await until(
                    async () => (await probe.eval(`document.querySelectorAll('#pm-window .pm-preset-view[data-preset-id="${newId}"] .pm-outline li.pm-node').length`)) || null,
                    8000, 'outline rendered',
                );
                const rowsRenderedOk = nodeCount === rows.length;

                const leafBlock = rows.find((/** @type {any} */ r) => r.kind === 'block');
                if (!leafBlock) throw new Error('no block leaf found');
                const leafBlockId = leafBlock.ref;
                const activeLoadout = doc.activeLoadoutId;
                const before = doc.loadouts[activeLoadout].enabled[leafBlockId];
                const switchSel = `#pm-window li.pm-node[data-identifier="${leafBlockId}"] > .pm-row input.pm-switch`;
                await click(switchSel);
                await until(async () => (await api('GET', `/presets/${newId}`)).json.loadouts[activeLoadout].enabled[leafBlockId] === !before, 5000, 'bit flip');
                await click(switchSel);
                await until(async () => (await api('GET', `/presets/${newId}`)).json.loadouts[activeLoadout].enabled[leafBlockId] === before, 5000, 'bit restore');

                report(name, flatKind && allLeaf && leafCountOk && rowsRenderedOk,
                    `kind=${doc.source?.recognizer?.kind} leaves=${rows.length}/${expectedLen} allLeaf=${allLeaf} rendered=${nodeCount} bit ${before}->!${before}->${before}`);
            } catch (err) {
                report(name, false, /** @type {Error} */ (err).message);
            }
        }
        {
            const name = '10 non-preset JSON via file picker → 400 shown in the tab';
            try {
                const before = (await api('GET', '/library')).json ?? [];
                await probe.eval(`(() => {
                    window.__p3Posts = [];
                    window.__p3OrigFetch = window.fetch;
                    window.fetch = async (...args) => {
                        const res = await window.__p3OrigFetch(...args);
                        try {
                            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
                            const method = (args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase();
                            if (method === 'POST' && url.includes('/api/plugins/st-preset-manager/presets')) window.__p3Posts.push({ url, status: res.status });
                        } catch {}
                        return res;
                    };
                    return true;
                })()`);
                const absPath = path.join(REPO, 'dev', 'fixtures', 'FF5 Regex 3.0 Suite.json');
                await setFileInput('#pm-window .pm-io-file', absPath);
                const resultSel = '.pm-io-result[data-status="error"][data-name="FF5 Regex 3.0 Suite"]';
                await until(() => exists(resultSel), 10000, 'error result');
                const text = await probe.eval(`document.querySelector(${J(resultSel)}).textContent`);
                const posts = await probe.eval('window.__p3Posts');
                await probe.eval(`(() => { window.fetch = window.__p3OrigFetch; delete window.__p3OrigFetch; return true; })()`);
                const after = (await api('GET', '/library')).json ?? [];
                const textOk = /not a Chat Completion preset/.test(text);
                const onePost400 = posts.length === 1 && posts[0].status === 400;
                report(name, textOk && onePost400 && after.length === before.length,
                    `text="${text?.slice(0, 60)}" posts=${J(posts)} library ${before.length}->${after.length}`);
            } catch (err) {
                report(name, false, /** @type {Error} */ (err).message);
            }
        }
        {
            const name = '10 container log: no new error/stack';
            try {
                const whole = spawnSync('podman', ['logs', 'st-pm-dev'], { encoding: 'utf8' });
                const since = spawnSync('podman', ['logs', '--since', t0, 'st-pm-dev'], { encoding: 'utf8' });
                const cmdOk = (/** @type {any} */ res) => res.error === undefined && res.status === 0;
                const wholeOk = cmdOk(whole);
                const sinceOk = cmdOk(since);
                if (!wholeOk || !sinceOk) {
                    const failing = !wholeOk ? "podman logs st-pm-dev" : "podman logs --since <t0> st-pm-dev";
                    const failedRes = !wholeOk ? whole : since;
                    throw new Error(`${failing} failed: status=${failedRes.status} error=${failedRes.error?.message ?? 'none'} stderr="${(failedRes.stderr ?? '').slice(0, 200)}"`);
                }
                const wholeText = `${whole.stdout ?? ''}\n${whole.stderr ?? ''}`;
                const positiveControl = wholeText.includes('[st-preset-manager] plugin initialized');
                const lines = `${since.stdout ?? ''}\n${since.stderr ?? ''}`.split('\n').filter((l) => l.length > 0);
                const bad = /\b(TypeError|ReferenceError|SyntaxError|RangeError|Unhandled|uncaught)\b|^\s+at .+:\d+:\d+\)?$|\[st-preset-manager\]/i;
                const offending = lines.filter((l) => bad.test(l));
                report(name, positiveControl && offending.length === 0,
                    `wholeStatus=${whole.status} sinceStatus=${since.status} positiveControl=${positiveControl} linesSinceT0=${lines.length} offending=${offending.slice(0, 3).join(' | ')}`);
            } catch (err) {
                report(name, false, /** @type {Error} */ (err).message);
            }
        }
    }

    // ------------------------------------------------------------------- 9
    if (wanted('9')) {
        const name = '9 ST export has no notes/groups/cardinality keys';
        try {
            const doc0 = (await api('GET', `/presets/${presetIds.ff}`)).json;
            const firstBlock = allRows(doc0.sequences[0].rows).find((r) => r.kind === 'block');
            if (!firstBlock) throw new Error('no block found in FF doc');
            await api('PATCH', `/presets/${presetIds.ff}/meta`, { notes: 'p3 preset note', blockNotes: { [firstBlock.ref]: 'p3 block note' } });
            const doc1 = (await api('GET', `/presets/${presetIds.ff}`)).json;
            const hasNotes = (doc1.notes ?? '').includes('p3 preset note');
            const hasBlockNote = doc1.blocks?.[firstBlock.ref]?.notes === 'p3 block note';
            const group = allRows(doc1.sequences[0].rows).find((r) => r.kind === 'group' && r.cardinality);
            if (!hasNotes || !hasBlockNote || !group) throw new Error(`precondition failed: notes=${hasNotes} blockNote=${hasBlockNote} group=${!!group}`);
            const exportRes = await api('GET', `/presets/${presetIds.ff}/export?format=st`);
            const found = scanKeys(exportRes.json, ['notes', 'groups', 'cardinality']);
            const hasBlockPrompt = Array.isArray(exportRes.json?.prompts) && exportRes.json.prompts.some((/** @type {any} */ p) => p.identifier === firstBlock.ref);
            const orderLen = exportRes.json?.prompt_order?.[0]?.order?.length ?? 0;
            report(name, found.size === 0 && hasBlockPrompt && orderLen > 0,
                `bannedKeysFound=${J([...found])} blockInPrompts=${hasBlockPrompt} orderLen=${orderLen}`);
        } catch (err) {
            report(name, false, /** @type {Error} */ (err).message);
        }
    }

    // ------------------------------------------------------------------ ui
    if (wanted('ui')) {
        {
            const name = 'ui drop import (synthetic drop)';
            try {
                const text = fs.readFileSync(path.join(REPO, 'dev', 'fixtures', 'presets', 'Sola V2 Flame.json'), 'utf8');
                await click('#pm-window .pm-tab[data-tab="library"]');
                await until(() => exists('#pm-window .pm-pane[data-pane="library"]:not([hidden]) .pm-io-section .pm-io-file'), 5000, 'library pane with the import section shown');
                // the drop must stay OURS: ST binds its own character/file import
                // on document.body `drop` (public/scripts/dragdrop.js:56), which
                // shows a "Could not import character" error toast for a preset
                const stChars0 = await probe.eval('SillyTavern.getContext().characters.length');
                await probe.eval(`(() => { document.querySelectorAll('#toast-container .toast').forEach((t) => t.remove()); return true; })()`);
                await probe.eval(`(() => {
                    const file = new File([${J(text)}], 'P3 Drop Sola.json', { type: 'application/json' });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    const zone = document.querySelector('#pm-window .pm-io-drop');
                    for (const type of ['dragenter', 'dragover', 'drop']) {
                        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
                    }
                    return true;
                })()`);
                const resultSel = '.pm-io-result[data-status="ok"][data-name="P3 Drop Sola"]';
                const newId = await until(async () => {
                    if (!(await exists(resultSel))) return null;
                    return probe.eval(`document.querySelector(${J(resultSel)}).dataset.presetId`);
                }, 10000, 'drop import result');
                await sleep(1500); // ST's handler is async (reads the file, POSTs, toasts)
                const toasts = await probe.eval(`Array.from(document.querySelectorAll('#toast-container .toast')).map((t) => t.textContent.trim())`);
                const stChars1 = await probe.eval('SillyTavern.getContext().characters.length');
                const stTouched = toasts.some((/** @type {string} */ t) => /import|invalid|corrupt/i.test(t)) || stChars1 !== stChars0;
                const newExport = (await api('GET', `/presets/${newId}/export?format=st`)).json;
                const solaExport = (await api('GET', `/presets/${presetIds.sola}/export?format=st`)).json;
                const doc = (await api('GET', `/presets/${newId}`)).json;
                const diff = firstDiff(newExport, solaExport);
                report(name, diff === null && doc.name === 'P3 Drop Sola' && !stTouched,
                    `id=${newId} name=${doc.name} diff=${diff ?? 'none'} stDropHandlerFired=${stTouched} toasts=${J(toasts)} characters ${stChars0}->${stChars1}`);
            } catch (err) {
                report(name, false, /** @type {Error} */ (err).message);
            }
        }
        {
            const name = 'ui file drop outside the zone is swallowed';
            try {
                const strayText = fs.readFileSync(path.join(REPO, 'dev', 'fixtures', 'presets', 'Sola V2 Flame.json'), 'utf8');
                /** Dispatch dragenter/dragover/drop with a stray file on `sel`; returns whether dragover was prevented, or null if `sel` is missing. */
                const dispatchStrayDrop = (/** @type {string} */ sel) => probe.eval(`(() => {
                    const el = document.querySelector(${J(sel)});
                    if (!el) return null;
                    const file = new File([${J(strayText)}], 'P3 Stray.json', { type: 'application/json' });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    let dragoverPrevented = null;
                    for (const type of ['dragenter', 'dragover', 'drop']) {
                        const evt = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
                        const notCancelled = el.dispatchEvent(evt);
                        if (type === 'dragover') dragoverPrevented = !notCancelled;
                    }
                    return { dragoverPrevented };
                })()`);
                const toasts = () => probe.eval(`Array.from(document.querySelectorAll('#toast-container .toast')).map((t) => t.textContent.trim())`);
                const clearToasts = () => probe.eval(`(() => { document.querySelectorAll('#toast-container .toast').forEach((t) => t.remove()); return true; })()`);

                // non-vacuity control: the same stray drop OUTSIDE our window
                // DOES hit ST's own body drop handler (proves the detector works)
                await clearToasts();
                await dispatchStrayDrop('body');
                const controlToasts = await until(async () => {
                    const t = await toasts();
                    return t.some((/** @type {string} */ x) => /import|invalid|corrupt/i.test(x)) ? t : null;
                }, 3000, 'ST toast for a stray body drop (non-vacuity control)');
                await clearToasts();

                const targets = ['#pm-window .pm-io-log', '#pm-window .pm-io-export-row', '#pm-window .pm-tabs'];
                /** @type {string[]} */
                const evid = [];
                let allPass = true;
                for (const sel of targets) {
                    if (!(await exists(sel))) { allPass = false; evid.push(`${sel}: MISSING`); continue; }
                    const charsBefore = await probe.eval('SillyTavern.getContext().characters.length');
                    const libBefore = ((await api('GET', '/library')).json ?? []).length;
                    const rowsBefore = await probe.eval(`document.querySelectorAll('#pm-window .pm-io-result').length`);
                    await clearToasts();
                    const dropRes = await dispatchStrayDrop(sel);
                    await sleep(1500);
                    const toastsAfter = await toasts();
                    const charsAfter = await probe.eval('SillyTavern.getContext().characters.length');
                    const libAfter = ((await api('GET', '/library')).json ?? []).length;
                    const rowsAfter = await probe.eval(`document.querySelectorAll('#pm-window .pm-io-result').length`);
                    const noToast = !toastsAfter.some((/** @type {string} */ t) => /import|invalid|corrupt/i.test(t));
                    const pass = noToast && charsAfter === charsBefore && libAfter === libBefore && rowsAfter === rowsBefore && dropRes?.dragoverPrevented === true;
                    if (!pass) allPass = false;
                    evid.push(`${sel}: chars ${charsBefore}->${charsAfter} lib ${libBefore}->${libAfter} rows ${rowsBefore}->${rowsAfter} dragoverPrevented=${dropRes?.dragoverPrevented} toasts=${J(toastsAfter)}`);
                }
                report(name, allPass, `control=${J(controlToasts)}; ${evid.join(' | ')}`);
            } catch (err) {
                report(name, false, /** @type {Error} */ (err).message);
            }
        }
        {
            const name = 'ui ST-list import (409 then replace)';
            try {
                const before = (await api('GET', '/library')).json ?? [];
                await setValue('#pm-window .pm-io-st-list', 'DEUS.EX.MACHINA.V2.5.ST', 'change');
                await setChecked('#pm-window .pm-io-replace', false);
                await click('#pm-window .pm-io-st-import');
                await until(() => exists('.pm-io-result[data-status="error"][data-name="DEUS.EX.MACHINA.V2.5.ST"][data-http-status="409"]'), 10000, '409 result');
                const afterErr = (await api('GET', '/library')).json ?? [];
                const unchangedAfterErr = afterErr.length === before.length;
                const revBefore = (await api('GET', `/presets/${presetIds.dem}`)).json.rev;
                await setChecked('#pm-window .pm-io-replace', true);
                await click('#pm-window .pm-io-st-import');
                const okSel = '.pm-io-result[data-status="ok"][data-name="DEUS.EX.MACHINA.V2.5.ST"]';
                const newId = await until(async () => {
                    if (!(await exists(okSel))) return null;
                    return probe.eval(`document.querySelector(${J(okSel)}).dataset.presetId`);
                }, 10000, 'replace result');
                const afterOk = (await api('GET', '/library')).json ?? [];
                const idKept = newId === presetIds.dem;
                const stillListed = afterOk.some((/** @type {any} */ e) => e.id === presetIds.dem);
                const countSame = afterOk.length === before.length;
                const newDoc = (await api('GET', `/presets/${newId}`)).json;
                const revIncreased = newDoc.rev > revBefore;
                const absDem = path.join(FIXTURE_DIR, 'DEUS.EX.MACHINA.V2.5.ST.json');
                const diff = structureDiff(v1Structure(absDem), jsStructure(newDoc));
                report(name, unchangedAfterErr && idKept && stillListed && countSame && revIncreased && diff.length === 0,
                    `409 unchanged=${unchangedAfterErr} idKept=${idKept} (${presetIds.dem}) stillListed=${stillListed} count ${before.length}->${afterOk.length} rev ${revBefore}->${newDoc.rev} diff=${diff.slice(0, 2).join(' | ')}`);
            } catch (err) {
                report(name, false, /** @type {Error} */ (err).message);
            }
        }
        {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-check3-dl-'));
            await enableDownloads(dir);
            await setValue('#pm-window .pm-io-export-preset', presetIds.ff, 'change');
            await runExportCheck('ui export st download == API export', 'st', `${FF}.json`, dir);
            await runExportCheck('ui export native download == API export', 'native', `${FF}.pm-library.json`, dir);
        }
        try {
            await click('#pm-window .pm-tab[data-tab="library"]');
            await until(() => exists('#pm-window .pm-pane[data-pane="library"]:not([hidden]) .pm-io-section .pm-io-file'), 5000, 'library pane with the import section shown');
            await until(() => probe.eval(`document.querySelectorAll('#pm-window .pm-io-result[data-status="ok"]').length > 0
                && document.querySelectorAll('#pm-window .pm-io-result[data-status="error"]').length > 0`), 5000, 'log populated');
            await dismissPopups();
            const dir = path.join(REPO, 'dev', 'shots');
            fs.mkdirSync(dir, { recursive: true });
            const tabShot = path.join(dir, 'phase3-io-tab.png');
            const fullShot = path.join(dir, 'phase3-io-full.png');
            const r = await probe.eval(`(() => { const b = document.querySelector('#pm-window').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
            fs.writeFileSync(tabShot, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data, 'base64'));
            fs.writeFileSync(fullShot, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
            console.log(`[check] screenshots: ${tabShot} ${fullShot}`);
        } catch (err) {
            console.log(`[check] screenshots failed: ${/** @type {Error} */ (err).message}`);
        }
    }

    // -------------------------------------------------------------- native
    if (wanted('native')) {
        const name = 'native round trip: export → import deepEqual (except id/createdAt)';
        try {
            const n1 = (await api('GET', `/presets/${presetIds.ff}/export?format=native`)).json;
            const conflictRes = await api('POST', '/presets', { native: n1 });
            const conflictOk = conflictRes.status === 409 && conflictRes.json?.conflict === presetIds.ff;
            const preserved = firstDiff((await api('GET', `/presets/${presetIds.ff}`)).json, n1) === null;
            const before = (await api('GET', '/library')).json ?? [];
            await api('DELETE', `/presets/${presetIds.ff}`);
            const libAfterDelete = (await api('GET', '/library')).json ?? [];
            const deleted = !libAfterDelete.some((/** @type {any} */ e) => e.id === presetIds.ff);
            const importRes = await api('POST', '/presets', { native: n1 });
            const n2 = importRes.json;
            const diffN = firstDiff(n1, n2);
            const getN2 = (await api('GET', `/presets/${n2.id}`)).json;
            const diffGet = firstDiff(getN2, n2);
            const after = (await api('GET', '/library')).json ?? [];
            const countSame = after.length === before.length;
            presetIds.ff = n2.id;
            report(name, importRes.status === 201 && conflictOk && preserved && deleted && diffN === null && diffGet === null && countSame,
                `conflict=${conflictOk} deleted=${deleted} firstDiff=${diffN ?? 'none'} import201=${importRes.status === 201} diffGet=${diffGet ?? 'none'} count ${before.length}->${after.length}`);
        } catch (err) {
            report(name, false, /** @type {Error} */ (err).message);
        }
    }

    // -------------------------------------------------------------- slot
    if (wanted('slot')) {
        const name = 'replace slot preset: slot stays bound, panel + window edits flow';
        try {
            // -- 1. load FF into the slot through the UI (check-phase2 pattern)
            await click('#pm-window .pm-tab[data-tab="library"]');
            await until(() => exists('#pm-window .pm-pane[data-pane="library"]:not([hidden])'), 5000, 'library tab shown');
            let row = `#pm-window .pm-library-row[data-preset-id="${presetIds.ff}"]`;
            if (!(await exists(row))) {
                // the library list can be stale after check D minted a new id; a
                // reopen (#pm-menu-item replaces the window in place) refetches it
                await click('#pm-menu-item');
                await until(() => exists('#pm-window .pm-tabs'), 10000, 'window reopened');
                await click('#pm-window .pm-tab[data-tab="library"]');
                await until(() => exists('#pm-window .pm-pane[data-pane="library"]:not([hidden])'), 5000, 'library tab shown');
            }
            await until(() => exists(row), 10000, 'library row for the current ff id');
            await click(`${row} .pm-load`);
            await until(async () => {
                const o = await converged();
                return o && (await stDom()).length === o.order.length;
            }, 15000, 'FF converged in the slot');
            await dismissPopups(); // FF triggers ST's embedded-regex popup

            // -- 2. open FF in the Presets tab
            await click(`${row} .pm-open`);
            await until(() => exists(`#pm-window .pm-preset-view[data-preset-id="${presetIds.ff}"] .pm-outline li.pm-node`), 10000, 'presets tab open');

            // -- 2b. pick a group OPTION block C (top-level blocks are reserved
            // for A/B below): the first group row (sections walked too) with a
            // block option, preferring an option enabled in the compiled order
            const slot0 = await getSlot();
            const compiledIds0 = new Set((slot0.compiled?.prompt_order?.[0]?.order ?? []).map((/** @type {any} */ e) => e.identifier));
            const doc0 = (await api('GET', `/presets/${presetIds.ff}`)).json;
            const notesBefore = doc0.notes;
            const groupRows0 = allRows(doc0.sequences[0].rows).filter((/** @type {any} */ r) => r.kind === 'group' && (r.options ?? []).some((/** @type {any} */ o) => o.kind === 'block'));
            if (!groupRows0.length) throw new Error('no group with a block option to select as C');
            const blockOptions0 = groupRows0[0].options.filter((/** @type {any} */ o) => o.kind === 'block');
            const C = blockOptions0.find((/** @type {any} */ o) => compiledIds0.has(o.ref))?.ref ?? blockOptions0[0].ref;
            if (!C) throw new Error('no block in the compiled order to select as C');
            const cContentBefore = doc0.blocks[C].content;
            await click(`#pm-window li.pm-node[data-identifier="${C}"] > .pm-row .pm-name`);
            await until(() => probe.eval(`document.querySelector('#pm-window textarea.pm-block-content')?.value === ${J(cContentBefore)}`), 5000, 'editor shows C');

            // -- 3. replace the SAME document (identity kept) with an edited native export
            const N = (await api('GET', `/presets/${presetIds.ff}/export?format=native`)).json;
            N.notes = 'p3 replace in slot';
            N.blocks[C].content = `${N.blocks[C].content}\n[p3 replaced ${Date.now()}]`;
            const newText = N.blocks[C].content;
            const replaceRes = await api('POST', '/presets', { native: N, replace: true });
            const idKept = replaceRes.status === 201 && replaceRes.json?.id === presetIds.ff;
            if (!idKept) throw new Error(`identity not kept: before=${presetIds.ff} after=${replaceRes.json?.id} status=${replaceRes.status}`);

            // -- 3b. C's new content reaches ST's live settings and the still-open
            // window editor within 2s of the POST response
            const postT0 = Date.now();
            const pollFor = async (/** @type {() => Promise<string|undefined>} */ read) => {
                let tail = '';
                while (Date.now() - postT0 <= 2000) {
                    tail = (await read()) ?? '';
                    if (tail === newText) return { ms: Date.now() - postT0, tail };
                    await sleep(50);
                }
                return { ms: null, tail };
            };
            const [stLive, tab] = await Promise.all([
                pollFor(async () => (await oai()).prompts.find((/** @type {any} */ p) => p.identifier === C)?.content),
                pollFor(() => probe.eval(`document.querySelector('#pm-window textarea.pm-block-content')?.value`)),
            ]);
            const stLiveMs = stLive.ms;
            const tabMs = tab.ms;

            // -- 4. the slot stays bound and the edit lands
            const slot = await until(async () => {
                const s = (await api('GET', '/slot')).json;
                return s.desired?.presetId === presetIds.ff && s.compiled !== null ? s : null;
            }, 5000, 'slot stays bound after replace');
            const notesOk = await until(async () => (await api('GET', `/presets/${presetIds.ff}`)).json.notes === 'p3 replace in slot', 5000, 'notes land');
            const rowsExpected = slot.compiled.prompt_order[0].order.length;
            const rowsGot = (await stDom()).length;
            const rowsOk = rowsGot === rowsExpected;

            // -- 5. ST panel -> ST -> API: a block toggled in ST's own panel reaches the doc
            const doc = (await api('GET', `/presets/${presetIds.ff}`)).json;
            const activeLoadout = doc.activeLoadoutId;
            const blockRows = doc.sequences[0].rows.filter((/** @type {any} */ r) => r.kind === 'block' && r.ref !== C);
            if (blockRows.length < 2) throw new Error(`need 2 top-level block leaves besides C, found ${blockRows.length}`);
            const A = blockRows[0].ref;
            const B = blockRows[1].ref;
            const aBefore = doc.loadouts[activeLoadout].enabled[A];

            await dismissPopups(); // again, before real input into ST's panel
            await probe.eval(`(() => {
                window.__p3PanelPosts = [];
                window.__p3OrigFetch = window.fetch;
                window.fetch = async (...args) => {
                    const res = await window.__p3OrigFetch(...args);
                    try {
                        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
                        const method = (args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase();
                        if (method === 'POST' && url.includes('/slot/panel')) window.__p3PanelPosts.push({ url, status: res.status });
                    } catch {}
                    return res;
                };
                return true;
            })()`);
            await until(() => clickStToggle(A), 10000, 'ST toggle clickable (A)');
            await until(async () => (await api('GET', `/presets/${presetIds.ff}`)).json.loadouts[activeLoadout].enabled[A] === !aBefore, 5000, 'A flip reaches the API');
            const aAfter = !aBefore;
            const panelPosts = await probe.eval('window.__p3PanelPosts');
            const panel409 = panelPosts.some((/** @type {any} */ p) => p.status === 409);
            const panel200 = panelPosts.some((/** @type {any} */ p) => p.status === 200);

            // -- 6. v2 window -> ST: a block switched in the window reaches ST's live settings
            const bBefore = doc.loadouts[activeLoadout].enabled[B];
            const bT0 = Date.now();
            await click(`#pm-window li.pm-node[data-identifier="${B}"] > .pm-row input.pm-switch`);
            const bMs = await until(async () => {
                const o = await oai();
                const entry = o.order.find((/** @type {any} */ e) => e.identifier === B);
                return entry && entry.enabled === !bBefore ? Date.now() - bT0 : null;
            }, 5000, 'B flip reaches ST live settings');
            const bAfter = !bBefore;

            // -- 7. restore A and B (best effort) + remove the spy
            try {
                await until(() => clickStToggle(A), 10000, 'ST toggle clickable (A restore)');
                await until(async () => (await api('GET', `/presets/${presetIds.ff}`)).json.loadouts[activeLoadout].enabled[A] === aBefore, 5000, 'A restored');
            } catch { /* best effort */ }
            try {
                await click(`#pm-window li.pm-node[data-identifier="${B}"] > .pm-row input.pm-switch`);
                await until(async () => {
                    const o = await oai();
                    return o.order.find((/** @type {any} */ e) => e.identifier === B)?.enabled === bBefore;
                }, 5000, 'B restored');
            } catch { /* best effort */ }

            // -- 7b. restore C's content and the preset notes — NOT best
            // effort: a leftover edit here would poison the later export/
            // diff checks (e.g. 11's round trip against FF's original body)
            const restoreContent = await api('POST', `/presets/${presetIds.ff}/ops`, { op: 'editBlock', identifier: C, content: cContentBefore });
            if (restoreContent.status !== 200) throw new Error(`restore C content failed: status=${restoreContent.status} body=${restoreContent.text.slice(0, 200)}`);
            await until(async () => (await api('GET', `/presets/${presetIds.ff}`)).json.blocks[C].content === cContentBefore, 5000, 'C content restored');
            const restoreNotes = await api('PATCH', `/presets/${presetIds.ff}/meta`, { notes: notesBefore });
            if (restoreNotes.status !== 200) throw new Error(`restore notes failed: status=${restoreNotes.status} body=${restoreNotes.text.slice(0, 200)}`);
            await until(async () => (await api('GET', `/presets/${presetIds.ff}`)).json.notes === notesBefore, 5000, 'notes restored');
            await probe.eval(`(() => { window.fetch = window.__p3OrigFetch; delete window.__p3OrigFetch; return true; })()`);

            report(name, idKept && !!slot && notesOk && aAfter === !aBefore && !panel409 && panel200 && bMs !== null
                && stLiveMs !== null && stLiveMs <= 2000 && tabMs !== null && tabMs <= 2000 && rowsOk,
                `C=${C.slice(0, 8)} stLive=${stLiveMs !== null ? `${stLiveMs}ms` : `timeout:"${stLive.tail.slice(0, 60)}"`} tab=${tabMs !== null ? `${tabMs}ms` : `timeout:"${tab.tail.slice(0, 60)}"`} rows=${rowsGot}/${rowsExpected} ffId=${presetIds.ff} replaceId=${replaceRes.json?.id} compiledNull=${slot ? slot.compiled === null : 'n/a'} notesOk=${notesOk} A ${aBefore}->${aAfter} panelPosts=${J(panelPosts)} B ${bBefore}->${bAfter} ms=${bMs}`);
        } catch (err) {
            report(name, false, /** @type {Error} */ (err).message);
        }
    }

    // ------------------------------------------------------------------ 11
    if (wanted('11')) {
        const NAME_OAI = '11 ST round trip: oai equal (enabled set, order, injection)';
        const NAME_GEN = '11 ST round trip: generation equal (:8099/last)';
        try {
            const E = (await api('GET', `/presets/${presetIds.ff}/export?format=st`)).json;
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-check3-rt-'));
            const exportPath = path.join(tmpDir, 'P3 RT export.json');
            const sourcePath = path.join(tmpDir, 'P3 RT source.json');
            fs.writeFileSync(exportPath, JSON.stringify(E, null, 4));
            fs.copyFileSync(path.join(REPO, 'dev', 'fixtures', 'presets', 'Freaky Frankenstein 5.4 Internal States (2).json'), sourcePath);
            const sourceJson = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

            console.error('[check] resetting for 11 (clean ST)…');
            execFileSync(path.join(REPO, 'dev', 'reset.sh'), { stdio: 'inherit' });
            await primeSession();
            probe.kill();
            await probe.start();
            await probe.cdp('Page.bringToFront');
            await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
            await dismissPopups();

            const libEmpty = ((await api('GET', '/library')).json ?? []).length === 0;
            const stNames = await probe.eval(`Array.from(document.querySelectorAll('#settings_preset_openai option')).map((o) => o.textContent)`);
            const noP3Names = !stNames.includes('P3 RT export') && !stNames.includes('P3 RT source');
            if (!libEmpty || !noP3Names) throw new Error(`precondition failed: libraryEmpty=${libEmpty} stNamesClean=${noP3Names}`);

            /** @type {{ [k: string]: { path: string, json: any } }} */
            const files = { export: { path: exportPath, json: E }, source: { path: sourcePath, json: sourceJson } };
            /** @type {{ [k: string]: any }} */
            const oai = {};
            /** @type {{ [k: string]: any }} */
            const lastBody = {};
            /** @type {{ [k: string]: string }} */
            const seenNames = {};

            // both generations must see the SAME chat: record its length once and
            // delete back to it before each send (the first run adds user+reply)
            const chatBase = await probe.eval('SillyTavern.getContext().chat.length');
            for (const label of ['export', 'source']) {
                const { path: absPath, json } = files[label];
                await setFileInput('#openai_preset_import_file', absPath);
                await handlePopups(5000);
                const wantLen = json.prompt_order?.find((/** @type {any} */ po) => po.character_id === 100001)?.order.length ?? -1;
                await until(async () => {
                    const presetName = await probe.eval('SillyTavern.getContext().chatCompletionSettings.preset_settings_openai');
                    const rows = await probe.eval(`document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]').length`);
                    return presetName === `P3 RT ${label}` && rows === wantLen;
                }, 15000, `${label} preset applied`);
                seenNames[label] = await probe.eval('SillyTavern.getContext().chatCompletionSettings.preset_settings_openai');

                const settingsKeys = Object.keys(json).filter((k) => k !== 'prompts' && k !== 'prompt_order' && !CONNECTION_KEYS.includes(k));
                oai[label] = await probe.eval(`(() => {
                    const ctx = SillyTavern.getContext();
                    const o = ctx.chatCompletionSettings;
                    const entry = (o.prompt_order || []).find((po) => po.character_id === 100001);
                    const order = (entry?.order || []).map((x) => ({ identifier: x.identifier, enabled: x.enabled }));
                    const prompts = {};
                    for (const e of order) {
                        const p = (o.prompts || []).find((pp) => pp.identifier === e.identifier);
                        prompts[e.identifier] = p ? {
                            name: p.name, role: p.role, content: p.content,
                            injection_position: p.injection_position, injection_depth: p.injection_depth,
                            injection_order: p.injection_order, injection_trigger: p.injection_trigger,
                            forbid_overrides: p.forbid_overrides,
                        } : null;
                    }
                    const settings = {};
                    for (const k of ${J(settingsKeys)}) settings[k] = o[k];
                    return { order, prompts, settings };
                })()`);

                await probe.eval(`(async () => {
                    const ctx = SillyTavern.getContext();
                    const extra = ctx.chat.length - ${chatBase};
                    if (extra > 0) await ctx.executeSlashCommandsWithOptions('/del ' + extra);
                    return true;
                })()`);
                const chatLen = await probe.eval('SillyTavern.getContext().chat.length');
                if (chatLen !== chatBase) throw new Error(`chat not reset to its base length ${chatBase} for ${label} (len=${chatLen})`);

                await probe.eval(`(() => {
                    document.querySelector('#send_textarea').value = ${J(`p3 rt ${label}`)};
                    document.querySelector('#send_but').dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return true;
                })()`);
                const last = await until(async () => {
                    const l = await httpJson(MOCK_PORT, '/last');
                    const hasLabel = (l?.messages ?? []).some((/** @type {any} */ m) => (m.content ?? '').includes(`p3 rt ${label}`));
                    const lastMes = await probe.eval('SillyTavern.getContext().chat.at(-1)?.mes');
                    return hasLabel && lastMes === 'Mock reply from st-pm mock-llm.' ? l : null;
                }, 20000, `${label} generation`);
                lastBody[label] = last;
            }

            // -- oai equal
            {
                const a = oai.export;
                const b = oai.source;
                const orderLen = a.order.length;
                const enabledA = a.order.filter((/** @type {any} */ o) => o.enabled).map((/** @type {any} */ o) => o.identifier).sort();
                const enabledB = b.order.filter((/** @type {any} */ o) => o.enabled).map((/** @type {any} */ o) => o.identifier).sort();
                const enabledSetOk = J(enabledA) === J(enabledB);
                const orderIdsOk = J(a.order.map((/** @type {any} */ o) => o.identifier)) === J(b.order.map((/** @type {any} */ o) => o.identifier));
                const orderEnabledOk = J(a.order) === J(b.order);
                const diffPrompts = firstDiff(a.prompts, b.prompts);
                const diffSettings = firstDiff(a.settings, b.settings);
                const nonVacuous = orderLen >= 30 && seenNames.export === 'P3 RT export' && seenNames.source === 'P3 RT source';
                const pass = enabledSetOk && orderIdsOk && orderEnabledOk && diffPrompts === null && diffSettings === null && nonVacuous;
                report(NAME_OAI, pass,
                    `orderLen=${orderLen} enabledCount=${enabledA.length} firstDiff=${diffPrompts ?? diffSettings ?? (orderIdsOk ? 'none' : 'order identifiers differ')}`);
            }

            // -- generation equal
            {
                const rawA = lastBody.export;
                const rawB = lastBody.source;
                const containedA = JSON.stringify(rawA).includes('p3 rt export');
                const containedB = JSON.stringify(rawB).includes('p3 rt source');
                const msgLenA = (rawA?.messages ?? []).length;
                const msgLenB = (rawB?.messages ?? []).length;
                // FF squashes system messages, so the request can be as short as
                // [system, user]; the preset text itself is what must be there
                const charsOf = (/** @type {any} */ body) => (body?.messages ?? []).reduce((/** @type {number} */ n, /** @type {any} */ m) => n + String(m.content ?? '').length, 0);
                const nonVacuous = msgLenA >= 2 && msgLenB >= 2 && charsOf(rawA) >= 2000 && charsOf(rawB) >= 2000 && containedA && containedB;
                const normalize = (/** @type {any} */ body) => {
                    let s = JSON.stringify(body).replace(/p3 rt export/gi, 'p3 rt X').replace(/p3 rt source/gi, 'p3 rt X');
                    s = s.replace(/(Seed\d+:|User:|NPC:)\s+\d+/g, '$1 N');
                    return JSON.parse(s);
                };
                const na = normalize(rawA);
                const nb = normalize(rawB);
                const diff = firstDiff(na, nb);
                let evid = `messages=${msgLenA}/${msgLenB} chars=${charsOf(rawA)}/${charsOf(rawB)} chatBase=${chatBase}`;
                if (diff) {
                    const m = diff.match(/\.messages\[(\d+)\]/);
                    if (m) {
                        const idx = Number(m[1]);
                        evid += ` firstDiffIdx=${idx} role=${na.messages?.[idx]?.role}/${nb.messages?.[idx]?.role} a="${J(na.messages?.[idx]).slice(0, 120)}" b="${J(nb.messages?.[idx]).slice(0, 120)}"`;
                    } else {
                        evid += ` firstDiff=${diff}`;
                    }
                }
                report(NAME_GEN, nonVacuous && diff === null, evid);
            }
        } catch (err) {
            const msg = /** @type {Error} */ (err).message;
            report(NAME_OAI, false, msg);
            report(NAME_GEN, false, msg);
        }
    }
}

main().catch((err) => {
    report('crashed', false, err?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(err));
    finish();
}).then(() => finish());
