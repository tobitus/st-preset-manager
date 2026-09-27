#!/usr/bin/env node
/**
 * Browser probe (PLAN §3 Browser recipe, orchestrator correction
 * 2026-09-27): drives system Chromium over raw CDP with Node 22's global
 * WebSocket — no omp browser, no deps. Runtime.evaluate runs in the page's
 * MAIN world, so SillyTavern.getContext() is directly reachable.
 *
 * Subcommands:
 *   probe.mjs start [tab]           spawn chromium for a tab (or default), wait for ST ready
 *   probe.mjs oai [tab]             preset name, prompt_order, prompts, temperature
 *   probe.mjs dom [tab]             prompt-manager rows + toggles as rendered
 *   probe.mjs click <sel> [tab]     click a selector
 *   probe.mjs set-slider <id> <v> [tab]  set an input range/number and fire input
 *   probe.mjs profile <name> [tab]  run /profile <name> via slash command
 *   probe.mjs generate <text> [tab] send a message and wait for the reply
 *   probe.mjs eval <expr> [tab]     arbitrary JS in the main world (last resort)
 *   probe.mjs hold [tab]            keep the tab open for other commands (writes dev/probe-<tab>.pid)
 *   probe.mjs stop [tab]            kill that chromium
 *
 * Tabs use separate --user-data-dir (dev/chrome-profile[-<tab>]) so cookies
 * stay isolated (F-050) and two tabs can differ (acceptance 5).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = '/usr/bin/chromium-browser';
const ST_URL = process.env.ST_URL ?? 'http://127.0.0.1:8002';

/** @param {string} tab */
function profileDir(tab) {
    return path.join(REPO, 'dev', tab === 'default' ? 'chrome-profile' : `chrome-profile-${tab}`);
}

/** @param {string} tab */
function pidFile(tab) {
    return path.join(REPO, 'dev', `probe-${tab}.pid`);
}

async function freePort() {
    return new Promise((resolve) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = /** @type {any} */ (srv.address()).port;
            srv.close(() => resolve(port));
        });
    });
}

/**
 * @param {number} port
 * @param {string} pathPart
 * @returns {Promise<any>}
 */
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

class Cdp {
    /** @param {string} wsUrl */
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.nextId = 1;
        /** @type {Map<number, (v: any) => void>} */
        this.pending = new Map();
        /** @type {Map<number, (v: any) => void>} */
        this.pendingErrors = new Map();
    }

    async connect() {
        this.ws = new WebSocket(this.wsUrl);
        await new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = (e) => reject(new Error('ws error'));
        });
        this.ws.onmessage = (ev) => {
            const msg = JSON.parse(/** @type {any} */ (ev).data);
            if (msg.id && this.pending.has(msg.id)) {
                if (msg.error) this.pendingErrors.get(msg.id)?.(msg.error);
                else this.pending.get(msg.id)?.(msg.result);
                this.pending.delete(msg.id);
                this.pendingErrors.delete(msg.id);
            }
        };
    }

    /**
     * @param {string} method
     * @param {any} [params]
     * @returns {Promise<any>}
     */
    send(method, params = undefined) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, resolve);
            this.pendingErrors.set(id, reject);
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    this.pendingErrors.delete(id);
                    reject(new Error(`CDP timeout: ${method}`));
                }
            }, 30000);
        });
    }

    /**
     * Evaluate in the page main world.
     * @param {string} expression
     * @returns {Promise<any>}
     */
    async evaluate(expression) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            replMode: false,
        });
        if (res.exceptionDetails) {
            throw new Error(`page threw: ${res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result?.value;
    }

    close() {
        try { this.ws?.close(); } catch { /* already gone */ }
    }
}

/** @param {string} tab */
async function startChromium(tab) {
    const port = await freePort();
    const dir = profileDir(tab);
    fs.mkdirSync(dir, { recursive: true });
    const child = spawn(CHROME, [
        '--headless=new',
        '--window-size=1500,950',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${dir}`,
        '--no-first-run',
        '--disable-gpu',
        `${ST_URL}/`,
    ], { stdio: 'ignore', detached: false });
    fs.writeFileSync(pidFile(tab), String(child.pid));
    // wait for the devtools endpoint
    for (let i = 0; i < 60; i++) {
        try {
            await httpJson(port, '/json/version');
            break;
        } catch { await sleep(500); }
    }
    // wait for the ST page target
    let target = null;
    for (let i = 0; i < 60; i++) {
        const list = await httpJson(port, '/json/list');
        target = list.find((/** @type {any} */ t) => t.type === 'page' && t.url.startsWith(ST_URL));
        if (target) break;
        await sleep(500);
    }
    if (!target) throw new Error('no page target found');
    return { child, port, target, pid: child.pid };
}

/** @param {string} tab */
async function connectTab(tab) {
    // if a probe instance is already holding the tab, reuse it via the pid's port discovery is
    // unreliable; instead we always spawn fresh for command probes, and `hold` keeps one alive.
    const { child, port, target, pid } = await startChromium(tab);
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    // wait for SillyTavern to be ready
    for (let i = 0; i < 120; i++) {
        try {
            const ready = await cdp.evaluate('typeof SillyTavern !== "undefined" && !!SillyTavern.getContext()?.onlineStatus && document.querySelector("#chat_completion_source") !== null');
            if (ready) break;
        } catch { /* page still loading */ }
        await sleep(500);
    }
    return { cdp, child, pid, port };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** All OAI state the checks need, in one evaluate. */
const OAI_EXPR = `(() => {
    const ctx = SillyTavern.getContext();
    const oai = ctx.chatCompletionSettings;
    const pm = ctx.getPresetManager('openai');
    return {
        preset_settings_openai: oai.preset_settings_openai,
        temperature: oai.temp_openai,
        prompts: oai.prompts?.length ?? 0,
        prompt_order: oai.prompt_order?.[0]?.order ?? [],
        slotInList: pm.getPresets ? !!pm.getPresets().includes?.(${JSON.stringify('⟨PM⟩ working')}) : undefined,
    };
})()`;

const DOM_EXPR = `(() => {
    const rows = document.querySelectorAll('#openai_prompt_manager_list .prompt_manager_prompt');
    return Array.from(rows).map(r => ({
        identifier: r.dataset.pmIdentifier,
        name: (r.querySelector('.prompt_manager_prompt_name') ?? {}).textContent ?? '',
        enabled: !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on'),
    }));
})()`;

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const tabArg = rest.at(-1);
    const tab = ['default', .../^[a-z0-9-]{1,20}$/.test(tabArg ?? '') ? [tabArg] : []].includes(tabArg) ? tabArg : 'default';
    const argsPass = /^[a-z0-9-]{1,20}$/.test(tabArg ?? '') ? rest.slice(0, -1) : rest;

    if (cmd === 'hold') {
        const { cdp, child, pid } = await connectTab(tab);
        // verify ST readiness then keep alive until stopped
        const ready = await cdp.evaluate('!!SillyTavern');
        if (!ready) throw new Error('SillyTavern not reachable');
        console.log(JSON.stringify({ ok: true, pid, tab, note: 'holding; kill via probe.mjs stop' }));
        const heartbeat = setInterval(() => cdp.evaluate('1+1').catch(() => clearInterval(heartbeat)), 10000);
        process.on('SIGTERM', () => { child.kill(); process.exit(0); });
        process.on('SIGINT', () => { child.kill(); process.exit(0); });
        return; // the spawned chromium keeps running (detached from this exit? no—child is ours)
    }

    if (cmd === 'stop') {
        const pf = pidFile(tab);
        if (fs.existsSync(pf)) {
            const pid = Number(fs.readFileSync(pf, 'utf8').trim());
            try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
            fs.rmSync(pf, { force: true });
            console.log(JSON.stringify({ ok: true, killed: pid }));
        } else {
            console.log(JSON.stringify({ ok: true, killed: null }));
        }
        return;
    }

    const { cdp, child } = await connectTab(tab);
    try {
        switch (cmd) {
            case 'oai': {
                const res = await cdp.evaluate(OAI_EXPR);
                console.log(JSON.stringify(res, null, 2));
                break;
            }
            case 'dom': {
                const res = await cdp.evaluate(DOM_EXPR);
                console.log(JSON.stringify(res, null, 2));
                break;
            }
            case 'click': {
                const [selector] = argsPass;
                const res = await cdp.evaluate(`(() => {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (!el) return { ok: false, error: 'no element' };
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return { ok: true };
                })()`);
                console.log(JSON.stringify(res));
                if (!res.ok) process.exitCode = 1;
                await sleep(500);
                break;
            }
            case 'set-slider': {
                const [id, value] = argsPass;
                const res = await cdp.evaluate(`(() => {
                    const el = document.getElementById(${JSON.stringify(id)});
                    if (!el) return { ok: false, error: 'no element' };
                    el.value = ${JSON.stringify(Number(value))};
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return { ok: true, value: el.value };
                })()`);
                console.log(JSON.stringify(res));
                await sleep(1500); // saveSettingsDebounced
                break;
            }
            case 'profile': {
                const [name] = argsPass;
                const res = await cdp.evaluate(`(async () => {
                    const ctx = SillyTavern.getContext();
                    await ctx.executeSlashCommandsWithOptions('/profile ${name.replace(/'/g, "\\'")}');
                    return { ok: true };
                })()`);
                console.log(JSON.stringify(res));
                await sleep(1000);
                break;
            }
            case 'generate': {
                const [text] = argsPass;
                const res = await cdp.evaluate(`(async () => {
                    const ctx = SillyTavern.getContext();
                    document.querySelector('#send_textarea').value = ${JSON.stringify(text ?? 'hi')};
                    document.querySelector('#send_but').dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return { ok: true };
                })()`);
                console.log(JSON.stringify(res));
                // wait for generation to finish (mock answers fast, but ST adds delay)
                await sleep(6000);
                break;
            }
            case 'eval': {
                const res = await cdp.evaluate(argsPass[0]);
                console.log(JSON.stringify(res, null, 2));
                break;
            }
            default:
                console.error(`unknown command ${cmd}`);
                process.exitCode = 2;
        }
    } finally {
        cdp.close();
        child.kill('SIGKILL');
    }
}

main().catch((err) => {
    console.error(JSON.stringify({ error: String(err?.message ?? err) }));
    process.exit(1);
});
