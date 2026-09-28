#!/usr/bin/env node
/**
 * Shared plumbing for dev/check-phase1.mjs (and later phase checks):
 * repo/env constants, tiny HTTP+JSON helpers, the PASS/FAIL reporter, the
 * cookie-jar API client, and a Probe class that drives one headless
 * chromium tab over the CDP WebSocket. Zero deps, node ≥22 (global
 * WebSocket), ESM. Import-time safe: only constants and factories, no
 * side effects.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root (the directory containing dev/). */
export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** SillyTavern base URL (override with ST_URL). */
export const ST_URL = process.env.ST_URL ?? 'http://127.0.0.1:8002';
/** Plugin REST base on the dev container. */
export const BASE = `${ST_URL}/api/plugins/st-preset-manager`;
export const CHROME = '/usr/bin/chromium-browser';
export const SLOT_NAME = '⟨PM⟩ working';
export const FF = 'Freaky Frankenstein 5.4 Internal States (2)';

/** @param {number} ms @returns {Promise<void>} */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET http://127.0.0.1:<port><pathPart> as JSON. @param {number} port @param {string} pathPart @returns {Promise<any>} */
export function httpJson(port, pathPart) {
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

/** Wait until fn() is truthy. @param {() => any|Promise<any>} fn @param {number} [ms] @param {string} [label] @returns {Promise<any>} */
export async function until(fn, ms = 8000, label = 'condition') {
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

// ------------------------------------------------------------------ reporter

/**
 * PASS/FAIL bookkeeping: one line per check, summary + exit at the end.
 * `onExit(fn)` registers cleanup that finish() runs BEFORE process.exit, so
 * probe chromia die on every path that ends through fatal()/finish().
 * @returns {{
 *   results: {name: string, pass: boolean, evidence: string}[],
 *   report: (name: string, pass: boolean, evidence: string) => void,
 *   fatal: (name: string, evidence: string) => never,
 *   finish: () => never,
 *   onExit: (fn: () => void) => void,
 * }}
 */
export function createReporter() {
    const results = [];
    /** @type {(() => void)[]} */
    const exitFns = [];
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
    /** Print the summary, run exit cleanups, exit. @returns {never} */
    function finish() {
        const failed = results.filter((r) => !r.pass);
        console.log(`\n${results.length - failed.length}/${results.length} checks PASS`);
        for (const fn of exitFns) {
            try { fn(); } catch { /* cleanup is best effort */ }
        }
        process.exit(failed.length ? 1 : 0);
    }
    /** @param {() => void} fn */
    function onExit(fn) { exitFns.push(fn); }
    return { results, report, fatal, finish, onExit };
}

// ------------------------------------------------------------------ http api

/**
 * Plugin API client with a session-bound CSRF token + cookie jar file.
 * @param {{ jar: string, onFatal: (name: string, evidence: string) => never }} opts
 * @returns {{
 *   api: (method: string, pathPart: string, body?: any) => Promise<{status: number, json: any, text: string, ms: number}>,
 *   apiOnce: (method: string, pathPart: string, body?: any) => Promise<{status: number, json: any, text: string, ms: number}>,
 *   primeSession: () => Promise<void>,
 * }}
 */
export function createApi({ jar, onFatal }) {
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
                    ...(fs.existsSync(jar) ? { cookie: fs.readFileSync(jar, 'utf8').trim() } : {}),
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
        if (!cookies) onFatal('session', 'no session cookie from /csrf-token');
        fs.writeFileSync(jar, cookies);
        csrfToken = JSON.parse(raw.body).token;
    }

    return { api, apiOnce, primeSession };
}

// ------------------------------------------------------------------ probe

/** @param {string} tab */
function profileDir(tab) { return path.join(REPO, 'dev', `chrome-profile-${tab}`); }

/** @returns {Promise<number>} */
function freePort() {
    return new Promise((resolve) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const p = /** @type {any} */ (srv.address()).port;
            srv.close(() => resolve(p));
        });
    });
}

/**
 * One headless chromium driving one ST page over the CDP WebSocket.
 * ONE message handler per socket, wired once on open; commands multiplex
 * through a pending-id map (no per-call re-wiring).
 */
export class Probe {
    /**
     * @param {string} tab profile suffix — profileDir is dev/chrome-profile-<tab>
     * @param {{ onFatal: (name: string, evidence: string) => never }} opts
     */
    constructor(tab, { onFatal }) {
        this.tab = tab;
        this.onFatal = onFatal;
        this.profileDir = profileDir(tab);
        this.port = /** @type {number|null} */ (null);
        this.ws = /** @type {WebSocket|null} */ (null);
        this.child = /** @type {any} */ (null);
        /** @type {Map<number, {resolve: (r: any) => void, reject: (e: Error) => void, timer: any}>} */
        this.pending = new Map();
        this.nextId = 1;
    }

    /**
     * Launch chromium (this tab's profile), attach the ST page socket and —
     * unless bootCheck is false — wait for ST boot (preset select filled).
     * @param {{ bootCheck?: boolean }} [opts]
     * @returns {Promise<Probe>}
     */
    async start({ bootCheck = true } = {}) {
        // only this tab's leftovers: another tab's chrome may still be live
        cleanupTabs([this.tab]);
        const port = await freePort();
        this.child = spawn(CHROME, [
            '--headless=new', '--window-size=1500,950',
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${this.profileDir}`,
            '--no-first-run', '--disable-gpu',
            `${ST_URL}/`,
        ], { stdio: 'ignore' });
        this.port = port;
        for (let i = 0; i < 60; i++) {
            try { await httpJson(port, '/json/version'); break; } catch { await sleep(500); }
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
        if (!target) this.onFatal('probe', 'chromium opened but no SillyTavern page target appeared');
        this.ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')); });
        // ONE handler per socket, set once on open
        this.ws.onmessage = (ev) => {
            const msg = JSON.parse(/** @type {any} */ (ev).data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject, timer } = this.pending.get(msg.id);
                clearTimeout(timer);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result);
            }
        };
        if (bootCheck) {
            // wait for ST boot: preset select filled (script.js getSettings done)
            for (let i = 0; i < 240; i++) {
                const ready = await this.eval('(document.getElementById("settings_preset_openai")?.options.length ?? 0) > 1');
                if (ready) return this;
                await sleep(500);
            }
            this.onFatal('probe', 'SillyTavern did not finish booting in the probe tab');
        }
        return this;
    }

    /**
     * One CDP command on this tab's socket with the shared 30 s timeout.
     * @param {string} method
     * @param {string} label timeout message suffix
     * @param {any} [params]
     * @returns {Promise<any>}
     */
    _send(method, label, params = {}) {
        if (!this.ws) throw new Error('probe not started');
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP timeout: ${label}`));
            }, 30000);
            this.pending.set(id, { resolve, reject, timer });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /**
     * Generic CDP command on this tab's socket; rejects on msg.error.
     * @param {string} method
     * @param {any} [params]
     * @returns {Promise<any>}
     */
    cdp(method, params = {}) { return this._send(method, method, params); }

    /**
     * Evaluate in the ST page's MAIN world.
     * @param {string} expression
     * @returns {Promise<any>}
     */
    async eval(expression) {
        const res = await this._send('Runtime.evaluate', expression.slice(0, 60), { expression, awaitPromise: true, returnByValue: true, replMode: false });
        if (res.exceptionDetails) {
            throw new Error(`page threw: ${res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result?.value;
    }

    /** SIGKILL the child and pkill anything still holding this profile. */
    kill() {
        try { this.child?.kill('SIGKILL'); } catch { /* gone */ }
        try { execSync(`pkill -9 -f "user-data-dir=${this.profileDir}"`, { stdio: 'ignore' }); } catch { /* none */ }
        this.child = null;
        this.ws = null;
    }
}

/** Kill leftover probe chromia by profile dir (dev/chrome-profile-<tab>). @param {string[]} tabs */
export function cleanupTabs(tabs) {
    for (const tab of tabs) {
        try { execSync(`pkill -9 -f "user-data-dir=${profileDir(tab)}"`, { stdio: 'ignore' }); } catch { /* none */ }
    }
}
