#!/usr/bin/env node
/**
 * Phase 7 acceptance (roadmap acceptance 18: the MCP wrapper) as one
 * repeatable script. It spawns `node mcp/server.js` as a child and talks
 * newline-delimited JSON-RPC 2.0 to it over stdio, like an MCP client. The
 * server's ST_URL points at a recording pass-through proxy in this process
 * (forwarding to st-pm-dev), so the check knows every cookie and token the
 * server used and can prove none of them ever crossed the stdio boundary.
 * A headless Chromium on ST (raw CDP) shows what the UI shows.
 *
 *   node dev/check-phase7.mjs                 all checks (resets dev data first)
 *   CHK_SKIP=7g node dev/check-phase7.mjs     skip checks by id (diagnosis only)
 *
 * Checks:
 *   7a initialize echoes the protocol version; tools/list has every mapped
 *      tool, each with an object input schema
 *   7b library_list deep-equals GET /library
 *   7c slot_load {presetId, loadoutId} (a second loadout that differs from
 *      the active one in one block) -> ST's live oai shows that preset and
 *      that loadout; the tool result equals GET /slot
 *   7d diff_blocks on two unrelated blocks deep-equals POST /diff/blocks
 *   7e a preset_op toggle reaches ST's prompt-manager DOM (off, then on)
 *   7f errors: preset_get / slot_load on an unknown preset -> isError, 404,
 *      REST's own error message
 *   7g a 403 on a plugin call (injected once by the proxy) -> the server
 *      refreshes its session against real ST and the retry succeeds
 *   7h PLAN smoke: printf initialize | node mcp/server.js answers; with
 *      tools/list piped too it answers with the tool list
 *   7i no cookie or token (values or header names) in any JSON-RPC message
 *      either way, nor in the server's stderr; no auth-like argument key
 *
 * Environment: st-pm-dev on 127.0.0.1:8002 with the plugin (dev/up.sh).
 * dev/reset.sh runs first. Never touches :8001, the sillytavern container,
 * ~/tools/ST-dev or /home/jon/projects/sillysystem/st.
 */
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import {
    Probe, REPO, SLOT_NAME, ST_URL,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';

const TAB = 'chk7';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';
const SOLA = 'Sola V2 Flame';
const PRESENT = '「 Present 」';
const SERVER = path.join(REPO, 'mcp', 'server.js');
const PLUGIN = '/api/plugins/st-preset-manager';

/** The tool table (PLAN §1.7 + the REST rows Phases 4–6 added). */
const TOOL_NAMES = [
    'health', 'library_list', 'library_rescan',
    'preset_get', 'preset_export', 'preset_import', 'preset_save', 'preset_delete',
    'preset_fork', 'preset_move', 'preset_set_meta', 'preset_op',
    'loadout_create', 'loadout_update', 'loadout_delete', 'loadout_activate',
    'loadout_set_override', 'loadout_patch_override', 'loadout_delete_override',
    'tuning_override_set', 'tuning_override_patch', 'tuning_override_delete',
    'models_list', 'models_replace', 'models_set_tuning', 'models_patch_tuning',
    'models_rename', 'models_merge', 'models_seed', 'profiles_list', 'profiles_backup',
    'slot_get', 'slot_load', 'slot_set_model', 'diff_presets', 'diff_blocks',
    'revisions_list', 'revision_get', 'revision_create', 'revision_restore',
    'shelf_list', 'shelf_get', 'shelf_add', 'shelf_update', 'shelf_remove',
];

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-phase7.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const must = (/** @type {any} */ cond, /** @type {string} */ msg) => { if (!cond) throw new Error(msg); };
const ids = { dem: '', sola: '', present: '', l1: '', l2: '' };

// ------------------------------------------------------------------ recording proxy

/**
 * Pass-through proxy to st-pm-dev that records every auth secret the MCP
 * server sends or receives, and can fail the next plugin call with 403.
 */
const proxy = {
    /** cookie values and csrf tokens seen on the wire */
    secrets: new Set(),
    /** @type {{method: string, url: string, cookie: boolean, token: boolean, status: number}[]} */
    log: [],
    fail403Once: false,
    url: '',
    /** @type {http.Server|null} */
    srv: null,
};
const target = new URL(ST_URL);

function startProxy() {
    proxy.srv = http.createServer((rq, rs) => {
        const chunks = /** @type {Buffer[]} */ ([]);
        rq.on('data', (c) => chunks.push(c));
        rq.on('end', () => {
            const body = Buffer.concat(chunks);
            const cookie = String(rq.headers.cookie ?? '');
            for (const pair of cookie.split(/;\s*/).filter(Boolean)) proxy.secrets.add(pair.slice(pair.indexOf('=') + 1));
            const token = rq.headers['x-csrf-token'];
            if (typeof token === 'string' && token) proxy.secrets.add(token);
            const entry = { method: rq.method ?? '', url: rq.url ?? '', cookie: !!cookie, token: !!token, status: 0 };
            proxy.log.push(entry);
            if (proxy.fail403Once && rq.url?.startsWith(PLUGIN)) {
                proxy.fail403Once = false;
                entry.status = 403;
                rs.writeHead(403, { 'content-type': 'application/json' });
                rs.end(J({ error: 'Invalid CSRF token (injected by check-phase7)' }));
                return;
            }
            const up = http.request({
                host: target.hostname, port: target.port, method: rq.method, path: rq.url,
                headers: { ...rq.headers, host: target.host },
            }, (ur) => {
                const out = /** @type {Buffer[]} */ ([]);
                ur.on('data', (c) => out.push(c));
                ur.on('end', () => {
                    const buf = Buffer.concat(out);
                    for (const c of ur.headers['set-cookie'] ?? []) {
                        const pair = c.split(';')[0];
                        proxy.secrets.add(pair.slice(pair.indexOf('=') + 1));
                    }
                    if (rq.url === '/csrf-token') {
                        try { proxy.secrets.add(JSON.parse(buf.toString('utf8')).token); } catch { /* not json */ }
                    }
                    entry.status = ur.statusCode ?? 0;
                    rs.writeHead(ur.statusCode ?? 502, ur.headers);
                    rs.end(buf);
                });
            });
            up.on('error', (err) => { rs.writeHead(502); rs.end(String(err)); });
            up.end(body);
        });
    });
    return new Promise((resolve) => {
        proxy.srv?.listen(0, '127.0.0.1', () => {
            proxy.url = `http://127.0.0.1:${/** @type {any} */ (proxy.srv?.address()).port}`;
            resolve(null);
        });
    });
}

// ------------------------------------------------------------------ stdio JSON-RPC client

const mcp = {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */
    child: null,
    /** every raw line either way */
    sent: /** @type {string[]} */ ([]),
    received: /** @type {string[]} */ ([]),
    stderr: '',
    nextId: 1,
    /** @type {Map<number, (m: any) => void>} */
    pending: new Map(),
};

function startMcp() {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ST_URL: proxy.url, ST_USER: '', ST_PASSWORD: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    mcp.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
            const lineText = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!lineText.trim()) continue;
            mcp.received.push(lineText);
            let m;
            try { m = JSON.parse(lineText); } catch { console.error(`[check] non-JSON stdout line: ${lineText.slice(0, 200)}`); continue; }
            const resolve = mcp.pending.get(m.id);
            if (resolve) { mcp.pending.delete(m.id); resolve(m); }
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { mcp.stderr += c; });
    onExit(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
}

/** @param {any} msg */
function send(msg) {
    const lineText = J(msg);
    mcp.sent.push(lineText);
    mcp.child?.stdin.write(`${lineText}\n`);
}

/** One JSON-RPC request; resolves with the whole response message. @param {string} method @param {any} [params] @returns {Promise<any>} */
function rpc(method, params = undefined) {
    const id = mcp.nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { mcp.pending.delete(id); reject(new Error(`rpc ${method} timed out`)); }, 30000);
        mcp.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
}

/**
 * tools/call -> {isError, status?, data} where data is the parsed text.
 * @param {string} name @param {any} args
 */
async function tool(name, args) {
    const m = await rpc('tools/call', { name, arguments: args });
    if (m.error) throw new Error(`tools/call ${name}: JSON-RPC error ${J(m.error)}`);
    const c = m.result?.content;
    must(Array.isArray(c) && c.length === 1 && c[0].type === 'text', `${name}: content ${J(c)?.slice(0, 200)}`);
    let data;
    try { data = JSON.parse(c[0].text); } catch { data = c[0].text; }
    return { isError: m.result.isError === true, data };
}

/** tools/call that must succeed; returns the parsed result. @param {string} name @param {any} args */
async function ok(name, args) {
    const r = await tool(name, args);
    must(!r.isError, `${name} -> isError ${J(r.data)?.slice(0, 300)}`);
    return r.data;
}

// ------------------------------------------------------------------ page helpers

async function dismissPopups() {
    const closed = await probe.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

/** ST's live chat-completion prompt state + the prompt-manager DOM toggles. */
const st = () => probe.eval(`(() => {
    const o = SillyTavern.getContext().chatCompletionSettings;
    const b = window.__pmStarted?.bridge;
    return {
        preset: o.preset_settings_openai,
        order: o.prompt_order?.[0]?.order ?? [],
        blocker: !!document.querySelector('.pm-apply-blocker'),
        idle: !!b && !b.applying && !b._reconcileQueued && !b._panelQueued,
        dom: Object.fromEntries([...document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')]
            .map((r) => [r.dataset.pmIdentifier, !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on')])),
    };
})()`);

const getSlot = async () => (await api('GET', '/slot')).json;

/** ST shows the slot and its order equals the compiled slot. */
async function converged() {
    const s = await st();
    const slot = await getSlot();
    return !s.blocker && s.idle && s.preset === SLOT_NAME
        && J(s.order) === J(slot.compiled?.prompt_order?.[0]?.order) ? { s, slot } : null;
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

/** Run `printf '%s\n' <lines…> | node mcp/server.js` (ST unreachable: it must still answer). @param {any[]} msgs */
function pipeSmoke(msgs) {
    const args = msgs.map((m) => `'${J(m).replace(/'/g, `'\\''`)}'`).join(' ');
    return new Promise((resolve) => {
        const child = spawn('sh', ['-c', `printf '%s\\n' ${args} | node mcp/server.js`], { cwd: REPO, env: { ...process.env, ST_URL: 'http://127.0.0.1:1' } });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (err += c));
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
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
        ['^(DEUS\\.EX\\.MACHINA\\.V2\\.5\\.ST|Sola V2 Flame)$'],
        { stdio: 'pipe' });
    const library = (await api('GET', '/library')).json ?? [];
    const idOf = (/** @type {string} */ n) => library.find((/** @type {any} */ e) => e.name === n)?.id ?? '';
    ids.dem = idOf(DEM); ids.sola = idOf(SOLA);
    if (!ids.dem || !ids.sola) fatal('setup', `fixtures missing: ${J(library.map((/** @type {any} */ e) => e.name))}`);
    const dem0 = (await api('GET', `/presets/${ids.dem}`)).json;
    const sola0 = (await api('GET', `/presets/${ids.sola}`)).json;
    ids.present = Object.values(dem0.blocks).find((/** @type {any} */ b) => b.name === PRESENT)?.identifier ?? '';
    ids.l1 = sola0.activeLoadoutId;
    if (!ids.present || !ids.l1) fatal('setup', 'DEM has no Present block or Sola no active loadout');
    /** Sola's plain top-level (non-marker) blocks enabled in its active loadout */
    const plain = sola0.sequences[0].rows
        .filter((/** @type {any} */ r) => r.kind === 'block' && !sola0.blocks[r.ref]?.fields?.marker && sola0.loadouts[ids.l1].enabled[r.ref] === true)
        .map((/** @type {any} */ r) => r.ref);
    if (plain.length < 2) fatal('setup', `Sola has ${plain.length} enabled plain blocks; need 2`);
    const [X, Y] = plain;

    await startProxy();
    startMcp();
    await probe.start();
    await dismissPopups();
    try {
        await until(() => probe.eval('!!window.__pmStarted?.bridge'), 20000, 'the v2 bridge started in the tab');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, DEM + Sola imported, MCP server spawned behind the recording proxy, ST tab booted', true,
        `dem=${ids.dem} sola=${ids.sola} proxy=${proxy.url} X=${X} Y=${Y}`);

    // ------------------------------------------------------------------ 7a
    await check('7a initialize + tools/list: every mapped tool, each with an object input schema', async () => {
        const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-phase7', version: '0' } });
        must(init.result?.protocolVersion === '2025-06-18', `protocolVersion ${J(init.result?.protocolVersion)}`);
        must(init.result?.serverInfo?.name === 'st-preset-manager' && J(init.result?.capabilities) === J({ tools: {} }), `init ${J(init.result)}`);
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const list = await rpc('tools/list', {});
        const tools = list.result?.tools ?? [];
        const names = tools.map((/** @type {any} */ t) => t.name);
        const missing = TOOL_NAMES.filter((n) => !names.includes(n));
        const extra = names.filter((/** @type {string} */ n) => !TOOL_NAMES.includes(n));
        must(!missing.length && !extra.length, `missing ${J(missing)} extra ${J(extra)}`);
        must(tools.every((/** @type {any} */ t) => t.inputSchema?.type === 'object' && t.description), 'a tool lacks an object schema or a description');
        const future = await rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {} });
        must(future.result?.protocolVersion === '2025-06-18', `unsupported version negotiation ${J(future)}`);
        const malformed = await rpc('initialize', { protocolVersion: 7 });
        must(malformed.error?.code === -32602, `malformed initialize ${J(malformed)}`);
        return `server ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}; ${tools.length} tools, all mapped, all with object schemas`;
    });

    // ------------------------------------------------------------------ 7b
    await check('7b library_list deep-equals GET /library', async () => {
        const viaMcp = await ok('library_list', {});
        const viaRest = (await api('GET', '/library')).json;
        assert.deepStrictEqual(viaMcp, viaRest);
        const tagged = await ok('library_list', { tag: 'no-such-tag' });
        assert.deepStrictEqual(tagged, (await api('GET', '/library?tag=no-such-tag')).json);
        return `${viaMcp.length} entries, deep-equal (and the ?tag filter: ${tagged.length} = REST)`;
    });

    // ------------------------------------------------------------------ 7c
    await check('7c slot_load {presetId, loadoutId}: ST shows that preset and that loadout', async () => {
        // a second loadout L2 that differs from the active L1 in exactly X, built through MCP
        const created = await ok('loadout_create', { presetId: ids.sola, name: 'mcp L2' });
        ids.l2 = Object.values(created.doc.loadouts).find((/** @type {any} */ l) => l.name === 'mcp L2')?.id ?? '';
        must(ids.l2, 'loadout_create returned no "mcp L2"');
        await ok('loadout_activate', { presetId: ids.sola, loadoutId: ids.l2 });
        const t = await ok('preset_op', { presetId: ids.sola, op: 'toggle', identifier: X, value: false });
        must(t.doc.loadouts[ids.l2].enabled[X] === false, 'toggle did not turn X off in L2');
        await ok('loadout_activate', { presetId: ids.sola, loadoutId: ids.l1 });
        const doc = (await api('GET', `/presets/${ids.sola}`)).json;
        must(doc.activeLoadoutId === ids.l1 && doc.loadouts[ids.l1].enabled[X] === true && doc.loadouts[ids.l2].enabled[X] === false,
            'precondition: L1 active with X on, L2 with X off');

        const view = await ok('slot_load', { presetId: ids.sola, loadoutId: ids.l2 });
        assert.deepStrictEqual(view, await getSlot());
        must(view.desired.presetId === ids.sola && view.desired.loadoutId === ids.l2, `desired ${J(view.desired)}`);
        const c = await until(async () => {
            const cc = await converged();
            return cc && cc.slot.desired.presetId === ids.sola && cc.slot.desired.loadoutId === ids.l2 ? cc : null;
        }, 25000, 'ST converged on Sola / L2');
        await dismissPopups();
        const xEntry = c.s.order.find((/** @type {any} */ e) => e.identifier === X);
        must(xEntry && xEntry.enabled === false, `ST oai order entry for X: ${J(xEntry)}`);
        must(c.s.order.find((/** @type {any} */ e) => e.identifier === Y)?.enabled === true, 'Y should be on in L2');
        const want = view.compiled.prompt_order[0].order;
        must(J(c.s.order) === J(want), 'ST order differs from the slot_load result');
        return `slot_load result = GET /slot; ST preset "${c.s.preset}", ${c.s.order.length} order entries = the result's compiled order; X (${X.slice(0, 12)}…) off as in L2 (on in L1)`;
    });

    // ------------------------------------------------------------------ 7d
    await check('7d diff_blocks on two unrelated blocks deep-equals POST /diff/blocks', async () => {
        const body = { a: { presetId: ids.dem, identifier: ids.present }, b: { presetId: ids.sola, identifier: X } };
        const viaMcp = await ok('diff_blocks', body);
        const viaRest = (await api('POST', '/diff/blocks', body)).json;
        assert.deepStrictEqual(viaMcp, viaRest);
        must(viaMcp.hunks.length > 0, 'no hunks between unrelated blocks');
        const withCtx = await ok('diff_blocks', { ...body, context: 0 });
        assert.deepStrictEqual(withCtx, (await api('POST', '/diff/blocks', { ...body, context: 0 })).json);
        return `"${viaMcp.a.name}" vs "${viaMcp.b.name}": ${viaMcp.hunks.length} hunk(s), deep-equal (context 0 too: ${withCtx.hunks.length})`;
    });

    // ------------------------------------------------------------------ 7e
    await check('7e a preset_op toggle reaches ST\'s prompt-manager DOM (off, then on)', async () => {
        // the slot shows L2; make it the active loadout so toggle edits what ST shows
        await ok('loadout_activate', { presetId: ids.sola, loadoutId: ids.l2 });
        const before = await until(async () => { const s = await st(); return s.dom[Y] === true ? s : null; }, 15000, 'Y shown on in the DOM');
        must(before.dom[Y] === true, 'precondition: Y on');
        await ok('preset_op', { presetId: ids.sola, op: 'toggle', identifier: Y, value: false });
        await until(async () => { const s = await st(); return s.dom[Y] === false && !s.blocker ? s : null; }, 20000, 'Y off in ST\'s DOM');
        const off = await until(converged, 20000, 'converged after the toggle');
        must(off.s.order.find((/** @type {any} */ e) => e.identifier === Y)?.enabled === false, 'oai order has Y on');
        await ok('preset_op', { presetId: ids.sola, op: 'toggle', identifier: Y, value: true });
        await until(async () => { const s = await st(); return s.dom[Y] === true && !s.blocker ? s : null; }, 20000, 'Y back on in ST\'s DOM');
        await until(converged, 20000, 'converged after the second toggle');
        const doc = (await api('GET', `/presets/${ids.sola}`)).json;
        must(doc.loadouts[ids.l2].enabled[Y] === true, 'doc: Y not back on');
        return `#completion_prompt_manager_list li[data-pm-identifier="${Y.slice(0, 12)}…"]: fa-toggle-on -> off -> on, oai order followed`;
    });

    // ------------------------------------------------------------------ 7f
    await check('7f errors: unknown preset -> isError with 404 and REST\'s message', async () => {
        const bad = 'p_no_such_preset_mcp';
        const g = await tool('preset_get', { presetId: bad });
        const gRest = await api('GET', `/presets/${bad}`);
        must(g.isError && g.data.status === 404 && gRest.status === 404, `preset_get -> ${J(g)} / REST ${gRest.status}`);
        must(g.data.error === gRest.json.error, `message ${J(g.data.error)} vs REST ${J(gRest.json.error)}`);
        const l = await tool('slot_load', { presetId: bad });
        const lRest = await api('POST', '/slot/load', { presetId: bad });
        must(l.isError && l.data.status === 404 && l.data.error === lRest.json.error, `slot_load -> ${J(l)} / REST ${lRest.status} ${J(lRest.json)}`);
        const beforeInvalid = proxy.log.length;
        const m = await rpc('tools/call', { name: 'preset_get', arguments: {} });
        must(m.error?.code === -32602 && /presetId/.test(m.error.message), `missing arg -> ${J(m)}`);
        const dot = await rpc('tools/call', { name: 'loadout_delete', arguments: { presetId: ids.sola, loadoutId: '..' } });
        must(dot.error?.code === -32602 && /loadoutId/.test(dot.error.message), `dot segment -> ${J(dot)}`);
        must(proxy.log.length === beforeInvalid, 'an invalid path argument reached HTTP');
        const u = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
        must(u.error?.code === -32602, `unknown tool -> ${J(u)}`);
        const x = await rpc('resources/list', {});
        must(x.error?.code === -32601, `unknown method -> ${J(x)}`);
        return `preset_get: isError ${J(g.data)}; slot_load: isError ${J(l.data)}; missing/dot path args -32602 without HTTP; unknown tool -32602; unknown method -32601`;
    });

    // ------------------------------------------------------------------ 7g
    await check('7g an injected 403: one refresh against real ST, one retry, the call succeeds', async () => {
        const n0 = proxy.log.length;
        proxy.fail403Once = true;
        const viaMcp = await ok('shelf_list', {});
        assert.deepStrictEqual(viaMcp, (await api('GET', '/shelf')).json);
        const seen = proxy.log.slice(n0).map((e) => `${e.method} ${e.url.replace(PLUGIN, '')} ${e.status}`);
        must(J(seen) === J(['GET /shelf 403', 'GET /csrf-token 200', 'GET /shelf 200']), `wire: ${J(seen)}`);
        return `wire: ${seen.join(' → ')}`;
    });

    // ------------------------------------------------------------------ 7h
    await check('7h PLAN smoke: printf initialize | node mcp/server.js answers (and with the tool list)', async () => {
        const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } };
        const a = /** @type {any} */ (await pipeSmoke([init]));
        const la = a.out.split('\n').filter(Boolean);
        must(a.code === 0 && la.length === 1, `exit ${a.code}, ${la.length} stdout lines: ${a.out.slice(0, 200)}`);
        const r1 = JSON.parse(la[0]);
        must(r1.id === 1 && r1.result?.serverInfo?.name === 'st-preset-manager', `answer ${la[0].slice(0, 200)}`);
        const b = /** @type {any} */ (await pipeSmoke([init, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]));
        const lb = b.out.split('\n').filter(Boolean).map((/** @type {string} */ s) => JSON.parse(s));
        must(b.code === 0 && lb.length === 2 && lb[1].id === 2 && lb[1].result.tools.length === TOOL_NAMES.length, `second run: exit ${b.code}, ${lb.length} lines`);
        return `exit 0, one line ${la[0].slice(0, 90)}…; with tools/list piped: ${lb[1].result.tools.length} tools`;
    });

    // ------------------------------------------------------------------ 7i
    await check('7i no cookie or token in any JSON-RPC message, either way, nor in stderr', async () => {
        const plugin = proxy.log.filter((e) => e.url.startsWith(PLUGIN));
        must(plugin.length >= 10, `only ${plugin.length} plugin calls went through the proxy`);
        must(plugin.every((e) => e.cookie && e.token), 'a plugin call without the session');
        const secrets = [...proxy.secrets].filter((s) => s && s.length >= 8);
        must(secrets.length >= 2, `recorded secrets: ${secrets.length}`);
        const streams = { sent: mcp.sent.join('\n'), received: mcp.received.join('\n'), stderr: mcp.stderr };
        for (const [where, text] of Object.entries(streams)) {
            for (const s of secrets) must(!text.includes(s), `${where} contains a recorded secret (${s.length} chars)`);
            must(!/x-csrf-token|set-cookie|csrf-token/i.test(text), `${where} names an auth header`);
        }
        const keys = /** @type {string[]} */ ([]);
        for (const l of mcp.sent) JSON.parse(l, (k, v) => { keys.push(k); return v; });
        const listLine = mcp.received.find((l) => l.includes('"tools":['));
        if (listLine) JSON.parse(listLine, (k, v) => { keys.push(k); return v; });
        must(keys.every((k) => !/cookie|csrf/i.test(k)), 'an argument or schema key names cookie/csrf');
        return `${mcp.sent.length} requests + ${mcp.received.length} responses + ${mcp.stderr.length} B stderr scanned for ${secrets.length} recorded secrets: none; ${plugin.length} plugin calls all carried the session`;
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
