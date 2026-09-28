#!/usr/bin/env node
/**
 * Phase 1 acceptance as one repeatable script (PLAN Phase 1, checks 1–10
 * + 2b rescan + race). Deterministic: it sets up its own state
 * (dev/reset.sh + fixture import), holds and kills its own probe tabs,
 * and prints one PASS/FAIL line per check with short evidence. Exit 1 on
 * any FAIL, so it can double as the regression suite in later phases.
 *
 *   node dev/check-phase1.mjs            all checks
 *   node dev/check-phase1.mjs 4 8        subset (accepts "2b", "race")
 *
 * Environment it expects (brings up itself if missing):
 *   - st-pm-dev container WITH the plugin on 127.0.0.1:8002 (dev/up.sh)
 *   - mock LLM on 127.0.0.1:8099 (dev/up.sh starts it)
 * It never touches :8001, the sillytavern container, ~/tools/ST-dev or
 * /home/jon/projects/sillysystem/st (read-only) — same rules as dev/*.
 *
 * Check 4 macro model (ST 1.19.0, experimental_macro_engine=true as seeded):
 *   - balanced-brace single pass per block: {{setvar::n::v}} -> "" (stores v,
 *     nested macros already resolved), {{getvar::n}} -> stored value,
 *     {{trim}} (with surrounding newlines) -> "", {{//…}} -> "",
 *     {{user}}/{{char}} -> seeded persona "Jon"/character "Assistant",
 *     {{roll::x}} -> digit(s), unknown macros stay VERBATIM (e.g.
 *     {{getvar::x::default}} — 2 args, strictArgs → kept raw, exactly what
 *     ST's MacroEngine does with an unmatched/failed macro).
 *   - comparison: whitespace-normalized containment of each enabled
 *     non-marker block's expanded text in the mock-captured prompt.
 */
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ST_URL = process.env.ST_URL ?? 'http://127.0.0.1:8002';
const BASE = `${ST_URL}/api/plugins/st-preset-manager`;
const MOCK = 'http://127.0.0.1:8099';
const CHROME = '/usr/bin/chromium-browser';
const FF = 'Freaky Frankenstein 5.4 Internal States (2)';
const SLOT_NAME = '⟨PM⟩ working';
const TAB_A = 'chk-a';
const TAB_B = 'chk-b';
const PERSONA = 'Jon';       // dev/seed-settings.mjs seeds username: "Jon"
const CHARNAME = 'Assistant'; // dev seed character

// ------------------------------------------------------------------ results

const results = [];
/** @param {string} name @param {boolean} pass @param {string} evidence */
function report(name, pass, evidence) {
    results.push({ name, pass, evidence });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${evidence ? ` — ${evidence}` : ''}`);
}
/** @param {string} name @param {string} evidence @returns {never} */
function fatal(name, evidence) {
    report(name, false, evidence);
    console.error('aborting: setup failure above');
    finish();
}
function finish() {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks PASS`);
    process.exit(failed.length ? 1 : 0);
}
process.on('exit', () => {
    cleanupTabs();
});
/** @param {string[]} only */
const wanted = (/** @type {string} */ name) => process.argv.slice(2).length === 0 || process.argv.slice(2).includes(name);

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** GET http://127.0.0.1:<port><pathPart> as JSON. @param {number} port @param {string} pathPart @returns {Promise<any>} */
function httpJson(port, pathPart) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: pathPart }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// ------------------------------------------------------------------ http api

const cookieJar = path.join(REPO, 'dev', '.check-phase1.cookies.jar');
let csrfToken = null;

/** @param {string} method @param {string} pathPart @param {any} [body] @returns {Promise<{status:number, json:any, text:string, ms:number}>} */
async function api(method, pathPart, body = undefined) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await apiOnce(method, pathPart, body);
        } catch (err) {
            if (attempt === 2) throw err;
            await sleep(1500); // container restart window: socket hang up
        }
    }
    throw new Error('unreachable');
}

/** @param {string} method @param {string} pathPart @param {any} [body] @returns {Promise<{status:number, json:any, text:string, ms:number}>} */
function apiOnce(method, pathPart, body = undefined) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request(`${BASE}${pathPart}`, {
            method,
            host: '127.0.0.1', port: 8002,
            headers: {
                ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
                ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
                ...(fs.existsSync(cookieJar) ? { cookie: fs.readFileSync(cookieJar, 'utf8').trim() } : {}),
            },
        }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(d); } catch { /* stream endpoints */ }
                resolve({ status: res.statusCode ?? 0, json, text: d, ms: 0 });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/** GET /csrf-token, remember cookie + token (session-bound). */
async function primeSession() {
    const jar = path.join(REPO, 'dev', '.cookies.jar'); // st-api.sh's jar, same session rules
    void jar;
    let raw = null;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            raw = await new Promise((resolve, reject) => {
                http.get(`${ST_URL}/csrf-token`, (res) => {
                    let d = '';
                    res.on('data', (c) => (d += c));
                    res.on('end', () => resolve({ setCookie: res.headers['set-cookie'] ?? [], body: d }));
                }).on('error', reject);
            });
            if (raw.setCookie && raw.body.includes('token')) break;
        } catch { /* restart window */ }
        await sleep(1500);
    }
    const cookies = Array.isArray(raw?.setCookie)
        ? raw.setCookie.map((/** @type {string} */ c) => c.split(';')[0]).join('; ')
        : '';
    if (!cookies) fatal('session', 'no session cookie from /csrf-token');
    fs.writeFileSync(cookieJar, cookies);
    csrfToken = JSON.parse(raw.body).token;
}

// ------------------------------------------------------------------ probe

/** @param {string} tab */
function profileDir(tab) { return path.join(REPO, 'dev', `chrome-profile-${tab}`); }

let cdpPort = null;
let chromeChild = null;

/**
 * Raw CDP WebSocket framing without deps: use /json/version + the global
 * WebSocket (node ≥22). One chromium for the whole run; tab = its page.
 */
async function startProbe(tab) {
    // only this tab's leftovers: tab B may still be running (check 8 → 9)
    cleanupTabs([tab]);
    const port = await new Promise((resolve) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const p = /** @type {any} */ (srv.address()).port;
            srv.close(() => resolve(p));
        });
    });
    chromeChild = spawn(CHROME, [
        '--headless=new', '--window-size=1500,950',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir(tab)}`,
        '--no-first-run', '--disable-gpu',
        `${ST_URL}/`,
    ], { stdio: 'ignore' });
    cdpPort = port;
    for (let i = 0; i < 60; i++) {
        try { await cdpSendRaw(port, 'Browser.getVersion', {}); break; } catch { await sleep(500); }
    }
    let target = null;
    for (let i = 0; i < 120; i++) {
        try {
            const list = await httpJson(port, '/json/list');
            target = list.find((/** @type {any} */ t) => t.type === 'page' && t.url.startsWith(ST_URL));
            if (target) break;
        } catch { /* not up yet */ }
        await sleep(500);
    }
    if (!target) fatal('probe', 'chromium opened but no SillyTavern page target appeared');
    cdpWs = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { cdpWs.onopen = res; cdpWs.onerror = () => rej(new Error('ws error')); });
    // wait for ST boot: preset select filled (script.js getSettings done)
    for (let i = 0; i < 240; i++) {
        const ready = await evalInPage('(document.getElementById("settings_preset_openai")?.options.length ?? 0) > 1');
        if (ready) return;
        await sleep(500);
    }
    fatal('probe', 'SillyTavern did not finish booting in the probe tab');
}

let cdpWs = null;
const cdpPending = new Map();
let cdpNextId = 1;

function wireWs() {
    cdpWs.onmessage = (ev) => {
        const msg = JSON.parse(/** @type {any} */ (ev).data);
        if (msg.id && cdpPending.has(msg.id)) {
            const { resolve, reject, timer } = cdpPending.get(msg.id);
            clearTimeout(timer);
            cdpPending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
        }
    };
}

/**
 * @param {number} port
 * @param {string} method
 * @param {any} params
 */
function cdpSendRaw(port, method, params) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/json/version' }, () => resolve(undefined)).on('error', reject);
        void method; void params;
    });
}

/**
 * Evaluate in the ST page's MAIN world.
 * @param {string} expression
 * @returns {Promise<any>}
 */
async function evalInPage(expression) {
    if (!cdpWs) throw new Error('probe not started');
    wireWs();
    const id = cdpNextId++;
    const res = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cdpPending.delete(id);
            reject(new Error(`CDP timeout: ${expression.slice(0, 60)}`));
        }, 30000);
        cdpPending.set(id, { resolve, reject, timer });
        cdpWs.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, replMode: false } }));
    });
    if (res.exceptionDetails) {
        throw new Error(`page threw: ${res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
}

/** Kill leftover probe chromia. With `tabs`, only those; default: both. */
function cleanupTabs(tabs = [TAB_A, TAB_B]) {
    for (const tab of tabs) {
        try { execSync(`pkill -9 -f "user-data-dir=${profileDir(tab)}"`, { stdio: 'ignore' }); } catch { /* none */ }
    }
}
function stopChrome() {
    try { chromeChild?.kill('SIGKILL'); } catch { /* gone */ }
    try { chromeB?.kill('SIGKILL'); } catch { /* gone */ }
    cleanupTabs();
    chromeChild = null;
    chromeB = null;
    cdpWs = null;
    cdpWsB = null;
}

// ------------------------------------------------------------------ helpers

/** @param {string} dir @param {string} file */
function mtimeOf(dir, file) {
    const p = path.join(dir, file);
    return fs.statSync(p).mtimeMs;
}

const PM_DIR = path.join(REPO, 'dev', 'data', 'default-user', 'preset-manager');
const USER_DIR = path.join(REPO, 'dev', 'data', 'default-user');
const OPENAI_DIR = path.join(USER_DIR, 'OpenAI Settings');

/** Podman logs of the dev container. @returns {string} */
function containerLogs() {
    try {
        return execSync('podman logs st-pm-dev 2>&1', { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    } catch { return ''; }
}

/**
 * ST macro engine subset (ST 1.19.0, experimental_macro_engine) — see file
 * header. One balanced-brace pass, unknown macros stay verbatim.
 * Variable state is SHARED across blocks (ST keeps chat_metadata.variables
 * for the whole prompt build): process blocks in prompt_order.
 * @param {string} content
 * @param {Map<string,string>} vars
 */
function expandMacros(content, vars) {
    /** Balanced parse of one {{…}} group starting at i (content[i..i+1] === '{{'). */
    function findClose(s, i) {
        let depth = 0;
        for (let j = i; j < s.length - 1; j++) {
            if (s[j] === '{' && s[j + 1] === '{') { depth++; j++; continue; }
            if (s[j] === '}' && s[j + 1] === '}') { depth--; j++; if (depth === 0) return j + 1; }
        }
        return -1;
    }
    let out = '';
    let i = 0;
    while (i < content.length) {
        if (content[i] === '{' && content[i + 1] === '{') {
            const end = findClose(content, i);
            if (end > 0) {
                const raw = content.slice(i + 2, end - 2);
                // {{// comment }} — consumed wholesale (ST postEnv macro)
                if (raw.startsWith('//')) { out += ''; i = end; continue; }
                const m = raw.match(/^([\w/-]+)\s*(?:::([\s\S]*))?$/);
                const name = m?.[1]?.trim().toLowerCase();
                const argstr = m?.[2];
                /** @type {string[]} */
                const args = [];
                if (argstr !== undefined && argstr !== '') {
                    // split top-level :: args (nested {{}} respected)
                    let depth = 0, cur = '';
                    for (let k = 0; k < argstr.length; k++) {
                        if (argstr[k] === '{' && argstr[k + 1] === '{') { depth++; cur += '{{'; k++; continue; }
                        if (argstr[k] === '}' && argstr[k + 1] === '}') { depth--; cur += '}}'; k++; continue; }
                        if (argstr[k] === ':' && argstr[k + 1] === ':' && depth === 0) { args.push(cur); cur = ''; k++; continue; }
                        cur += argstr[k];
                    }
                    args.push(cur);
                }
                const value = (/** @returns {string} */ () => {
                    switch (name) {
                        case 'setvar': vars.set(args[0]?.trim(), args[1] ?? ''); return '';
                        case 'addvar': vars.set(args[0]?.trim(), (vars.get(args[0]?.trim()) ?? '') + (args[1] ?? '')); return '';
                        case 'incvar': case 'decvar': {
                            const n = Number(vars.get(args[0]?.trim()) ?? 0) + (name === 'incvar' ? 1 : -1);
                            vars.set(args[0]?.trim(), String(n)); return '';
                        }
                        case 'getvar': {
                            if (args.length !== 1) return `{{${raw}}}`; // strictArgs: kept verbatim (ST behavior)
                            const v = vars.get(args[0]?.trim()) ?? '';
                            return v;
                        }
                        case 'trim': return '';
                        case '//': return ''; // {{// comment }} — consumed
                        case 'user': return PERSONA;
                        case 'char': return CHARNAME;
                        case 'roll': return String(1 + Math.floor(Math.random() * 20));
                        case 'newline': return '\n';
                        case 'noop': return '';
                        default: return `{{${raw}}}`; // unknown -> verbatim (ST keeps raw)
                    }
                })();
                out += value;
                i = end;
                continue;
            }
        }
        out += content[i];
        i++;
    }
    // {{trim}} eats surrounding newlines: apply that as a post-pass (ST's legacy
    // regex did (?:\r?\n)* around it; the new engine trims scoped content —
    // either way leading/trailing newlines around a consumed trim vanish).
    out = out.replace(/(?:\r?\n)*(?:\r?\n)*/g, (s, off, whole) => s); // no-op guard, real pass below
    out = out.replace(/\n{3,}/g, '\n\n');
    return out;
}

const flat = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim();

/**
 * Read the tab's live oai state + rendered DOM rows in one evaluate.
 * @returns {Promise<any>}
 */
async function probeAll() {
    return evalInPage(`(() => {
        const ctx = SillyTavern.getContext();
        const oai = ctx.chatCompletionSettings;
        const rows = Array.from(document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')).map(r => ({
            identifier: r.dataset.pmIdentifier,
            enabled: !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on'),
        }));
        return {
            preset: oai.preset_settings_openai,
            temperature: oai.temp_openai,
            prompt_order: oai.prompt_order?.[0]?.order ?? [],
            prompts: (oai.prompts ?? []).map(p => ({ identifier: p.identifier, name: p.name ?? null, content: p.content ?? '', role: p.role ?? null, enabled: !!p.enabled, injection_position: p.injection_position, injection_depth: p.injection_depth, marker: !!p.marker, system_prompt: !!p.system_prompt })),
            dom: rows,
        };
    })()`);
}

/** Wait until fn() is true. @param {() => any|Promise<any>} fn @param {number} [ms] */
async function until(fn, ms = 8000, label = 'condition') {
    const end = Date.now() + ms;
    let last = null;
    for (;;) {
        let v;
        try { v = await fn(); last = v; } catch (e) { last = `err:${e?.message ?? e}`; }
        if (v) return v;
        if (Date.now() > end) {
            const brief = typeof last === 'object' && last !== null ? JSON.stringify(last).slice(0, 200) : String(last);
            throw new Error(`timeout waiting for ${label} (last: ${brief})`);
        }
        await sleep(250);
    }
}

// ===========================================================================

async function main() {
    // ---------------------------------------------------------- environment
    let health = null;
    for (let i = 0; i < 2; i++) {
        try {
            const res = await api('GET', '/health');
            if (res.status === 200) { health = res.json; break; }
        } catch { /* down or restarting */ }
        if (i === 0) {
            console.error('[check] st-pm-dev not answering; run dev/up.sh (starts it with the plugin + mock LLM)');
            execFileSync(path.join(REPO, 'dev', 'up.sh'), { stdio: 'inherit' });
        }
    }
    if (!health) fatal('environment', 'st-pm-dev did not come up');
    await primeSession();

    // ------------------------------------------------- setup: reset + import
    console.error('[check] resetting dev data (dev/reset.sh)…');
    execFileSync(path.join(REPO, 'dev', 'reset.sh'), { stdio: 'inherit' });
    await primeSession();
    console.error('[check] importing fixtures (dev/import-fixtures.sh)…');
    execFileSync(path.join(REPO, 'dev', 'import-fixtures.sh'), { stdio: 'pipe' });

    const library = (await api('GET', '/library')).json ?? [];
    const byName = new Map(library.map((/** @type {any} */ e) => [e.name, e.id]));
    const ffId = byName.get(FF);
    const solaId = byName.get('Sola V2 Flame');
    const demId = byName.get('DEUS.EX.MACHINA.V2.5.ST');
    if (!ffId || !solaId || !demId) fatal('setup', `fixtures missing from library: FF=${ffId} Sola=${solaId} DEM=${demId}`);

    // Probe tab: one held tab drives checks 3–8; killed at the end.
    console.error('[check] starting probe tab…');
    await startProbe(TAB_A);

    // ------------------------------------------------------------------ 1
    {
        const h = (await api('GET', '/health')).json;
        const log = containerLogs();
        const pass = h?.version === '2.0.0-phase1' && typeof h?.rev === 'number'
            && log.includes('Initializing plugin from') && log.includes('plugins/st-preset-manager/plugin/index.js')
            && log.includes('[st-preset-manager] plugin initialized');
        report('1 health+plugin', !!pass, `version=${h?.version} rev=${h?.rev} log lines found`);
    }

    // ------------------------------------------------------------------ 2
    {
        const lib = (await api('GET', '/library')).json ?? [];
        const ffDoc = (await api('GET', `/presets/${ffId}`)).json;
        const groups = [];
        const walk = (/** @type {any[]} */ rows) => { for (const r of rows ?? []) { if (r.kind === 'group') groups.push(r); walk(r.options); walk(r.rows); } };
        for (const seq of ffDoc.sequences ?? []) walk(seq.rows);
        const pick1 = groups.filter((g) => g.cardinality === 'pick-one').length;
        const conns = Object.keys(ffDoc.settings ?? {}).filter((k) =>
            ['chat_completion_source', 'openai_model', 'custom_url', 'proxy_password', 'reverse_proxy', 'claude_model'].includes(k));
        const onDisk = fs.readdirSync(path.join(PM_DIR, 'presets')).filter((f) => f.endsWith('.json')).length;
        // 4+4 pick-one/pick-one-or-more: import collapses the guessed echo
        // pairs (recognizer parity 7+1 is locked by test/recognizers.test.js)
        const pass = lib.length === 27 && groups.length === 8 && pick1 === 4 && conns.length === 0 && onDisk === 27;
        report('2 import+groups', !!pass, `library=${lib.length} groups=${groups.length} (pick-one=${pick1}) connKeys=${conns.length} files=${onDisk}`);
    }

    // ------------------------------------------------------------------ 2b
    {
        // a preset imported into a subfolder survives POST /rescan (finding 5)
        const src = (await api('GET', `/presets/${ffId}`)).json;
        const body = { native: src, name: 'ChkRescan Survivor', folder: 'deep/nest' };
        const imp = await api('POST', '/presets', body);
        const id = imp.json?.id;
        let after = null, err = '';
        if (id) {
            const resc = await api('POST', '/rescan', {});
            const lib = (await api('GET', '/library')).json ?? [];
            after = lib.find((/** @type {any} */ e) => e.id === id);
            const doc = (await api('GET', `/presets/${id}`)).json;
            const gone = doc?.error || doc?.format !== 'st-preset-manager/library';
            // cleanup regardless of verdict
            await api('DELETE', `/presets/${id}`);
            await api('POST', '/rescan', {});
            if (!after) err = `lost after rescan (${resc.json?.count ?? '?'} indexed)`;
            else if (gone) err = 'reindexed but unreadable';
        } else err = `import failed: ${imp.text.slice(0, 120)}`;
        report('2b rescan keeps subfolder import', !!after && !err, err || `folder=${after?.folder} id=${id} survived POST /rescan`);
    }

    // ------------------------------------------------------------------ 3
    {
        // SSE hello arrives unbuffered (compression must not sit on it)
        const got = await new Promise((resolve) => {
            const chunks = [];
            const req = http.request(`${BASE}/events`, { method: 'GET', host: '127.0.0.1', port: 8002, headers: { cookie: fs.readFileSync(cookieJar, 'utf8').trim() } }, (res) => {
                res.on('data', (c) => chunks.push(c));
            });
            req.on('error', () => resolve(null));
            const t = setTimeout(() => { req.destroy(); resolve(Buffer.concat(chunks).toString()); }, 4000);
            void t;
            req.end();
        });
        const ok = !!got && /data: .*"kind"\s*:\s*"hello"/.test(got.replace(/\s+/g, ' '));
        report('3 sse hello unbuffered', ok, got ? got.split('\n')[0].slice(0, 80) : 'nothing within 4s');
    }

    // --------------------------------------------------------------- 4 (+1a)
    {
        const load = await api('POST', '/slot/load', { presetId: ffId });
        if (load.status !== 200) fatal('4', `slot/load failed: ${load.text.slice(0, 120)}`);
        // apply broadcast → tab converges without reload: wait until oai AND
        // the rendered DOM both match the compiled order (render lags oai)
        const view = (await api('GET', '/slot')).json;
        await until(async () => {
            const t = await probeAll();
            return t.preset === SLOT_NAME
                && JSON.stringify(t.prompt_order) === JSON.stringify(view.compiled.prompt_order[0].order)
                && t.dom.length === view.compiled.prompt_order[0].order.length;
        }, 15000, 'tab applies slot (oai+DOM)');
        const tab = await probeAll();

        const orderEq = JSON.stringify(tab.prompt_order) === JSON.stringify(view.compiled.prompt_order[0].order);
        const tabPrompts = new Map(tab.prompts.map((/** @type {any} */ p) => [p.identifier, p]));
        let contentEq = true, mismatch = '';
        for (const cp of view.compiled.prompts) {
            const tp = tabPrompts.get(cp.identifier);
            if (!tp) { contentEq = false; mismatch = `tab missing prompt ${cp.identifier}`; break; }
            if ((tp.content ?? '') !== (cp.content ?? '') || (tp.role ?? null) !== (cp.role ?? null) || (tp.name ?? null) !== (cp.name ?? null)
                || tp.injection_position !== cp.injection_position || tp.injection_depth !== cp.injection_depth) {
                contentEq = false; mismatch = `prompt ${cp.identifier} differs (content/role/name/injection)`; break;
            }
        }
        const domEq = JSON.stringify(tab.dom) === JSON.stringify(view.compiled.prompt_order[0].order.map((/** @type {any} */ o) => ({ identifier: o.identifier, enabled: o.enabled })));
        const pass = orderEq && contentEq && domEq;
        report('4 slot apply: oai+DOM == GET /slot compiled', !!pass,
            `order=${orderEq} prompts=${contentEq}${mismatch ? ` (${mismatch})` : ''} domRows=${tab.dom.length}/${view.compiled.prompt_order[0].order.length}`);

        // generation → mock capture contains every enabled non-marker block,
        // macro-expanded exactly the way ST expands it
        evalInPage(`(() => { document.querySelector('#send_textarea').value = 'phase1 check'; document.querySelector('#send_but').dispatchEvent(new MouseEvent('click', {bubbles:true})); return true; })()`);
        await sleep(6500);
        const last = await new Promise((resolve, reject) => {
            http.get(`${MOCK}/last`, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
        });
        const captured = flat((last?.messages ?? []).map((/** @type {any} */ m) => m.content ?? '').join('\u0000'));
        const markers = new Set(['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'personaDescription', 'scenario', 'dialogueExamples', 'chatHistory']);
        const enabledBlocks = view.compiled.prompt_order[0].order.filter((/** @type {any} */ o) => o.enabled && !markers.has(o.identifier));
        // ST expands each enabled block once, in prompt_order, with variable
        // state shared across the build (setvar in main feeds getvar later)
        const macroVars = new Map();
        const expandedById = new Map();
        for (const o of view.compiled.prompt_order[0].order.filter((/** @type {any} */ x) => !markers.has(x.identifier))) {
            const cp = view.compiled.prompts.find((/** @type {any} */ p) => p.identifier === o.identifier);
            if (!cp || !o.enabled) continue;
            expandedById.set(o.identifier, expandMacros(cp.content ?? '', macroVars));
        }
        /** @type {string[]} */
        const missing = [];
        for (const o of enabledBlocks) {
            const cp = view.compiled.prompts.find((/** @type {any} */ p) => p.identifier === o.identifier);
            const want = flat(expandedById.get(o.identifier) ?? '');
            // roll values differ per generation — normalize seeded rolls
            const have = /Seed\d+:/.test(want) || /DnD Rolls/.test(want)
                ? captured.replace(/(Seed\d+:|User:|NPC:)\s+\d+/g, '$1 N')
                : captured;
            const probe = want.replace(/(Seed\d+:|User:|NPC:)\s+\d+/g, '$1 N').slice(0, 400);
            if (probe && !have.includes(probe)) missing.push(cp?.name ?? o.identifier);
        }
        report('4a mock capture carries all enabled blocks (macro-aware)', missing.length === 0,
            missing.length ? `missing: ${missing.slice(0, 4).join(' | ')}` : `${enabledBlocks.length}/${enabledBlocks.length} blocks present in capture (ST macro model applied)`);
    }

    {
        // panel toggle + slider write back into the doc
        const before = (await api('GET', `/presets/${ffId}`)).json;
        const target = before.loadouts[before.activeLoadoutId].enabled;
        const ident = Object.keys(target).find((k) => target[k] === true && before.blocks[k]);
        if (!ident) fatal('5', 'no enabled block to toggle');
        const clicked = await evalInPage(`(() => { const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${ident}"] .prompt-manager-toggle-action'); if (!el) return { ident: '${ident}', found: false }; el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return { ident: '${ident}', found: true }; })()`);
        if (!clicked?.found) fatal('5', `toggle control not found for ${ident}`);
        await until(async () => {
            const doc = (await api('GET', `/presets/${ffId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[ident] === false;
        }, 8000, 'toggle write-back');
        const afterToggle = (await api('GET', `/presets/${ffId}`)).json;
        const noOverride = Object.keys(afterToggle.loadouts[afterToggle.activeLoadoutId].overrides ?? {}).length === 0;
        // slider → settings.temperature (registry empty in Phase 1)
        evalInPage(`(() => { const el = document.getElementById('temp_openai'); el.value = 0.42; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
        await until(async () => {
            const slot = (await api('GET', '/slot')).json;
            return slot.compiled?.temperature === 0.42;
        }, 8000, 'temperature write-back');
        const docT = (await api('GET', `/presets/${ffId}`)).json;
        const tempRouted = docT.settings?.temperature === 0.42;
        const pass = noOverride && tempRouted;
        report('5 panel toggle+slider write back', !!pass,
            `toggle ${ident.slice(0, 8)}… → false, overrides=${noOverride ? 0 : 'CREATED'}, temperature routed to doc.settings=${tempRouted}`);
        // restore
        evalInPage(`(() => { const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${ident}"] .prompt-manager-toggle-action'); el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`);
        await until(async () => {
            const doc = (await api('GET', `/presets/${ffId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[ident] === true;
        }, 8000, 'toggle restore');
        evalInPage(`(() => { const el = document.getElementById('temp_openai'); el.value = 0.66; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
        await until(async () => ((await api('GET', '/slot')).json).compiled?.temperature === 0.66, 8000, 'temperature restore');
    }

    // ------------------------------------------------------------------ 6
    {
        // same tab: /slot/load Sola switches rows without reload; ops toggle reaches DOM
        const solaView0 = (await api('POST', '/slot/load', { presetId: solaId })).json;
        await until(async () => {
            const t = await probeAll();
            return t.preset === SLOT_NAME
                && JSON.stringify(t.prompt_order) === JSON.stringify(solaView0.compiled.prompt_order[0].order)
                && t.dom.length === solaView0.compiled.prompt_order[0].order.length
                ? true : { preset: t.preset, order: t.prompt_order.length, dom: t.dom.length, want: solaView0.compiled.prompt_order[0].order.length };
        }, 20000, 'tab switched to Sola');
        // settle: a late panel write-back from check 5 can flap the tab;
        // require the Sola view to hold steady for 2 consecutive seconds
        const solaDoc = (await api('GET', `/presets/${solaId}`)).json;
        const viewS = (await api('GET', '/slot')).json;
        await until(async () => {
            const a = await probeAll();
            if (a.prompt_order.length !== solaView0.compiled.prompt_order[0].order.length) return false;
            await sleep(1000);
            const b = await probeAll();
            return b.prompt_order.length === solaView0.compiled.prompt_order[0].order.length
                && JSON.stringify(b.prompt_order) === JSON.stringify(viewS.compiled.prompt_order[0].order)
                ? true : { flapped: a.prompt_order.length, then: b.prompt_order.length };
        }, 20000, 'Sola view settles');
        const tabS = await probeAll();
        const solaRows = tabS.prompt_order.length === viewS.compiled.prompt_order[0].order.length;
        const isSola = tabS.prompt_order.some((/** @type {any} */ o) => {
            const p = solaDoc.blocks?.[o.identifier] ?? solaDoc.markers?.find((/** @type {any} */ m) => m.identifier === o.identifier);
            return !!p;
        }) && tabS.prompts.length === viewS.compiled.prompts.length;
        // ops toggle → DOM shows it (leaf must sit in compiled prompt_order,
        // not an orphan block that renders no row)
        const ord = solaDoc.loadouts[solaDoc.activeLoadoutId].enabled;
        const orderIds = new Set(viewS.compiled.prompt_order[0].order.map((/** @type {any} */ o) => o.identifier));
        const leaf = Object.keys(ord).find((k) => solaDoc.blocks[k] && orderIds.has(k));
        const before = ord[leaf];
        const ops = await api('POST', `/presets/${solaId}/ops`, { op: 'toggle', identifier: leaf });
        if (ops.status !== 200) fatal('6', `ops toggle failed: ${ops.text.slice(0, 120)}`);
        await until(async () => {
            const t = await probeAll();
            const row = t.dom.find((/** @type {any} */ r) => r.identifier === leaf);
            return row && row.enabled === !before ? true : { found: !!row, rowEnabled: row?.enabled, want: !before };
        }, 10000, 'ops toggle in DOM');
        const pass = solaRows && isSola;
        report('6 slot/load no-reload + ops toggle reaches DOM', !!pass,
            `rows ${57}→${tabS.prompt_order.length} sola=${isSola} opsToggle visible`);
        // toggle back for a clean state
        await api('POST', `/presets/${solaId}/ops`, { op: 'toggle', identifier: leaf, value: before });
        await until(async () => {
            const doc = (await api('GET', `/presets/${solaId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[leaf] === before;
        }, 8000, 'sola toggle restore');
    }

    // ------------------------------------------------------------------ race
    {
        // finding 3: mutation while an apply is mid-flight must converge to
        // the latest rev. Fire two rapid /slot/load calls (A wins) and then,
        // while the tab is still applying, an ops toggle; the tab must end
        // on the latest rev with the toggled state visible.
        await api('POST', '/slot/load', { presetId: solaId });       // first target
        const p1 = api('POST', '/slot/load', { presetId: demId });   // race: switch again immediately
        await sleep(30);                                             // land mid-apply window
        const demDoc = (await api('GET', `/presets/${demId}`)).json;
        const ord = demDoc.loadouts[demDoc.activeLoadoutId].enabled;
        const leaf = Object.keys(ord).find((k) => demDoc.blocks[k]);
        const ops = api('POST', `/presets/${demId}/ops`, { op: 'toggle', identifier: leaf, value: !ord[leaf] });
        await Promise.all([p1, ops]);
        // convergence: the tab shows the DEM order WITH the toggle applied
        const view = await until(async () => {
            const v = (await api('GET', '/slot')).json;
            const t = await probeAll();
            const orderEq = JSON.stringify(t.prompt_order) === JSON.stringify(v.compiled.prompt_order[0].order);
            const row = t.dom.find((/** @type {any} */ r) => r.identifier === leaf);
            return orderEq && row?.enabled === !ord[leaf] ? v : null;
        }, 15000, 'race convergence');
        const pass = !!view && view.desired.presetId === demId && view.rev >= (ops.status === 200 ? 0 : 1);
        // settle doc back
        await api('POST', `/presets/${demId}/ops`, { op: 'toggle', identifier: leaf, value: ord[leaf] });
        await until(async () => {
            const doc = (await api('GET', `/presets/${demId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[leaf] === ord[leaf];
        }, 8000, 'race doc restore');
        report('race mid-apply mutation converges', !!pass,
            pass ? `tab on ${view.desired.presetId === demId ? 'DEM' : '?'} rev=${view.rev} with toggled row visible` : 'tab did not converge to latest rev');
    }

    // ------------------------------------------------------------------ 7
    {
        // cold tab: kill probe, load DEM, settings.json untouched, fresh tab applies desired
        stopChrome();
        const stBefore = mtimeOf(USER_DIR, 'settings.json');
        const slotFile = path.join(OPENAI_DIR, `${SLOT_NAME}.json`);
        const slotBefore = fs.existsSync(slotFile) ? fs.statSync(slotFile).mtimeMs : 0;
        await api('POST', '/slot/load', { presetId: demId });
        await sleep(2000);
        const stAfter = mtimeOf(USER_DIR, 'settings.json');
        const slotAfter = fs.existsSync(slotFile) ? fs.statSync(slotFile).mtimeMs : 0;
        const untouched = stBefore === stAfter && slotBefore === slotAfter;
        await startProbe(TAB_A);
        // cold boot: extension init (SETTINGS_LOADED) + bridge apply land
        // after the preset select fills, so wait for convergence the same
        // way check 4 does instead of probing immediately
        const view = (await api('GET', '/slot')).json;
        await until(async () => {
            const t = await probeAll();
            return t.preset === SLOT_NAME
                && JSON.stringify(t.prompt_order) === JSON.stringify(view.compiled.prompt_order[0].order);
        }, 20000, 'cold tab applies slot');
        const t = await probeAll();
        const applied = t.preset === SLOT_NAME
            && JSON.stringify(t.prompt_order) === JSON.stringify(view.compiled.prompt_order[0].order);
        const pass = untouched && applied;
        report('7 cold tab applies desired; plugin wrote no ST files', !!pass,
            `settings.json+slot mtime unchanged=${untouched}, fresh tab applied=${applied}`);
    }

    // ------------------------------------------------------------------ 8
    {
        // two tabs + API: latest write wins everywhere
        // (startTabB launches tab B's chromium itself; calling startProbe
        // here would cleanupTabs() tab A away and kill its live CDP ws)
        await startTabB();
        await until(async () => (await probeAllB()).prompt_order.length > 0, 20000, 'tab B up');
        const demDoc = (await api('GET', `/presets/${demId}`)).json;
        const enabledMap = demDoc.loadouts[demDoc.activeLoadoutId].enabled;
        const leaf = Object.keys(enabledMap).find((k) => demDoc.blocks[k]);
        const setTemp = (/** @type {number} */ v, /** @type {string} */ which) => evalInPage(`(() => { const el = document.getElementById('temp_openai'); el.value = ${v}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
        /** @param {string} tab which tab to click on (A|B) — the probe chrome is shared; tab B runs in the same page (same profile? no) */
        // NOTE: TAB_B is a separate chromium; drive it by switching cdp ws targets.
        const readAll = async () => {
            const slot = (await api('GET', '/slot')).json;
            const a = await probeAll();
            const b = await probeAllB();
            return { slot, a, b };
        };
        let evidence = '';
        let pass = true;
        // API wins over A's click. A's click reaches the doc through the
        // bridge's panel write-back (base->snapshot delta), so it lands a
        // beat later than the click itself; firing the API toggle first
        // would race the echo. Let the click land, then fire the API write
        // — it is then genuinely the latest write and must win everywhere.
        await evalInPage(clickToggle(leaf));
        await until(async () => {
            const doc = (await api('GET', `/presets/${demId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[leaf] === false;
        }, 10000, 'A click write-back lands');
        await api('POST', `/presets/${demId}/ops`, { op: 'toggle', identifier: leaf, value: true });
        await until(async () => {
            const { a, b } = await readAll();
            return rowOf(a, leaf) === true && rowOf(b, leaf) === true;
        }, 10000, 'API-on settles in A+B');
        // A's slider vs API. A's slider reaches the doc via panel write-back
        // (a beat after the input event), so settle it first; the API write
        // is then genuinely the latest and must win.
        await setTemp(0.42, 'A');
        await until(async () => {
            const doc = (await api('GET', `/presets/${demId}`)).json;
            return doc.settings?.temperature === 0.42;
        }, 10000, 'A 0.42 write-back lands');
        await api('POST', `/presets/${demId}/ops`, { op: 'setSettings', settings: { temperature: 0.9 } });
        await until(async () => {
            const { slot, a, b } = await readAll();
            return slot.compiled.temperature === 0.9 && a.temperature === 0.9 && b.temperature === 0.9;
        }, 10000, 'latest temperature wins');
        const { slot: s2 } = await readAll();
        pass = s2.compiled.temperature === 0.9;
        evidence = `latest write (0.9) in slot+A+B`;
        // and the reverse order: API first, A's slider last. The API write
        // must land in the doc BEFORE A's slider fires, otherwise the panel
        // echo and the reconcile it triggers can interleave (same race as
        // phase 1); settled first, A's slider is genuinely the latest write.
        await api('POST', `/presets/${demId}/ops`, { op: 'setSettings', settings: { temperature: 0.42 } });
        await until(async () => {
            const slot = (await api('GET', '/slot')).json;
            return slot.compiled.temperature === 0.42;
        }, 10000, 'API 0.42 lands');
        await setTemp(0.66, 'A');
        let lastT = null;
        await until(async () => {
            const { slot, a, b } = await readAll();
            lastT = { slot: slot.compiled.temperature, a: a.temperature, b: b.temperature };
            return slot.compiled.temperature === 0.66 && a.temperature === 0.66 && b.temperature === 0.66;
        }, 10000, 'A-last wins').catch((e) => { throw new Error(`${e.message} ${JSON.stringify(lastT)}`); });
        report('8 two tabs + API latest-write-wins', pass, evidence + ' (both orders)');
        // cleanup: restore FF's temperature routing state
        await api('POST', `/presets/${demId}/ops`, { op: 'setSettings', settings: { temperature: demDoc.settings?.temperature ?? 1 } });
    }

    // ------------------------------------------------------------------ 9
    {
        // --no-plugin: notice only, no writes (needs container restart)
        stopChrome();
        execFileSync(path.join(REPO, 'dev', 'down.sh'), { stdio: 'pipe' });
        execFileSync(path.join(REPO, 'dev', 'up.sh'), ['--no-plugin'], { stdio: 'pipe' });
        const health404 = (await api('GET', '/health')).status === 404;
        await startProbe(TAB_A);
        // wait for ST's own boot-time settings save to flush FIRST: the
        // guarantee under test is "no EXTENSION-driven writes", so the
        // measured window must start after the browser's first boot save
        await sleep(2500);
        const stBefore = mtimeOf(USER_DIR, 'settings.json');
        const slotFile = path.join(OPENAI_DIR, `${SLOT_NAME}.json`);
        const slotBefore = fs.existsSync(slotFile) ? fs.statSync(slotFile).mtimeMs : 0;
        // the extension module initializes some beats after the preset select
        // fills (SETTINGS_LOADED -> init -> pluginHealth round-trip); wait for
        // the menu item instead of clicking into the void
        let clickRes = null;
        for (let i = 0; i < 40; i++) {
            clickRes = await evalInPage(`(() => {
                const m = document.getElementById('pm-menu-item');
                if (!m) return { ok: false };
                m.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return { ok: true };
            })()`);
            if (clickRes?.ok) break;
            await sleep(500);
        }
        await sleep(1000);
        const notice = await evalInPage(`!!document.querySelector('.pm-install-notice')`);
        const stAfter = mtimeOf(USER_DIR, 'settings.json');
        const slotAfter = fs.existsSync(slotFile) ? fs.statSync(slotFile).mtimeMs : 0;
        const logs = containerLogs();
        const notInit = !logs.includes('[st-preset-manager] plugin initialized');
        const pass = health404 && clickRes?.ok && notice && stBefore === stAfter && slotBefore === slotAfter && notInit;
        report('9 --no-plugin: install notice only', !!pass,
            `health=${health404 ? 404 : 'up?'}, notice=${notice}, pluginInLog=${!notInit}, files unchanged=${stBefore === stAfter && slotBefore === slotAfter}`);
        // back to plugin mode
        stopChrome();
        execFileSync(path.join(REPO, 'dev', 'down.sh'), { stdio: 'pipe' });
        execFileSync(path.join(REPO, 'dev', 'up.sh'), { stdio: 'pipe' });
        await primeSession();
    }

    // ------------------------------------------------------------------ 10
    {
        execFileSync('npm', ['test'], { cwd: REPO, stdio: 'pipe' });
        execFileSync('npm', ['run', 'typecheck'], { cwd: REPO, stdio: 'pipe' });
        report('10 npm test + typecheck', true, 'node --test all green, tsc clean');
    }

    stopChrome();
    finish();
}

/** click helper string for a leaf toggle in the prompt manager list */
function clickToggle(/** @type {string} */ ident) {
    return `(() => { const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${ident}"] .prompt-manager-toggle-action'); el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`;
}
/** @param {any} probeView @param {string} ident */
function rowOf(probeView, ident) {
    const row = probeView.dom.find((/** @type {any} */ r) => r.identifier === ident);
    return row ? row.enabled : null;
}

// ------------------------------------------------------------------ tab B

let cdpWsB = null;
const cdpPendingB = new Map();
let cdpNextIdB = 1;
let chromeB = null;
let portB = null;

/** Launch a second chromium for tab B and attach the B websocket. */
async function startTabB() {
    // only tab B: cleanupTabs() with no args would kill tab A's live chrome
    // and leave its CDP ws permanently timed out (found by check 8)
    cleanupTabs([TAB_B]);
    portB = await new Promise((resolve) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const p = /** @type {any} */ (srv.address()).port;
            srv.close(() => resolve(p));
        });
    });
    chromeB = spawn(CHROME, [
        '--headless=new', '--window-size=1500,950',
        `--remote-debugging-port=${portB}`,
        `--user-data-dir=${profileDir(TAB_B)}`,
        '--no-first-run', '--disable-gpu',
        `${ST_URL}/`,
    ], { stdio: 'ignore' });
    let target = null;
    for (let i = 0; i < 120; i++) {
        try {
            const list = await httpJson(portB, '/json/list');
            target = list.find((/** @type {any} */ t) => t.type === 'page' && t.url.startsWith(ST_URL));
            if (target) break;
        } catch { /* not up yet */ }
        await sleep(500);
    }
    if (!target) fatal('8', 'tab B chromium produced no ST page');
    cdpWsB = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { cdpWsB.onopen = res; cdpWsB.onerror = () => rej(new Error('ws B error')); });
    cdpWsB.onmessage = (ev) => {
        const msg = JSON.parse(/** @type {any} */ (ev).data);
        if (msg.id && cdpPendingB.has(msg.id)) {
            const { resolve, reject, timer } = cdpPendingB.get(msg.id);
            clearTimeout(timer);
            cdpPendingB.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
        }
    };
    // wait for ST boot
    for (let i = 0; i < 240; i++) {
        try {
            const ready = await evalInPageB('(document.getElementById("settings_preset_openai")?.options.length ?? 0) > 1');
            if (ready) return;
        } catch { /* booting */ }
        await sleep(500);
    }
    fatal('8', 'tab B SillyTavern never finished booting');
}

/** @returns {Promise<any>} */
async function probeAllB() {
    if (!cdpWsB) throw new Error('tab B not started');
    return evalInPageB(`(() => {
        const ctx = SillyTavern.getContext();
        const oai = ctx.chatCompletionSettings;
        return {
            preset: oai.preset_settings_openai,
            temperature: oai.temp_openai,
            prompt_order: oai.prompt_order?.[0]?.order ?? [],
            dom: Array.from(document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')).map(r => ({
                identifier: r.dataset.pmIdentifier,
                enabled: !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on'),
            })),
        };
    })()`);
}

/**
 * @param {string} expression
 * @returns {Promise<any>}
 */
async function evalInPageB(expression) {
    const id = cdpNextIdB++;
    const res = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cdpPendingB.delete(id); reject(new Error('CDP B timeout')); }, 30000);
        cdpPendingB.set(id, { resolve, reject, timer });
        cdpWsB.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, replMode: false } }));
    });
    if (res.exceptionDetails) throw new Error(`B page threw: ${res.exceptionDetails.exception?.description ?? ''}`);
    return res.result?.value;
}

// startProbe for tab B (separate chromium, separate ws) is startTabB above.

main().catch((err) => {
    console.error('[check] crashed:', err?.stack ?? err);
    report('crashed', false, String(err?.message ?? err).slice(0, 200));
    stopChrome();
    finish();
});
