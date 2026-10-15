/**
 * Phase 7: the MCP wrapper (mcp/server.js). Transport framing and JSON-RPC
 * error codes against a stub session; the tool table's argument -> HTTP
 * mapping; the auth flow (cookie + token from GET /csrf-token, optional
 * login, one refresh-and-retry on 403) against a fake HTTP server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { TOOLS, createMcpServer, createSession } from '../mcp/server.js';

const PLUGIN = '/api/plugins/st-preset-manager';

/** Every tool and the REST row it maps to (PLAN §1.6/§1.7 + Phases 4–6). */
const EXPECTED_TOOLS = {
    health: ['GET', '/health'],
    library_list: ['GET', '/library'],
    library_rescan: ['POST', '/rescan'],
    preset_get: ['GET', '/presets/:presetId'],
    preset_export: ['GET', '/presets/:presetId/export'],
    preset_import: ['POST', '/presets'],
    preset_save: ['PUT', '/presets/:presetId'],
    preset_delete: ['DELETE', '/presets/:presetId'],
    preset_fork: ['POST', '/presets/:presetId/fork'],
    preset_move: ['POST', '/presets/:presetId/move'],
    preset_set_meta: ['PATCH', '/presets/:presetId/meta'],
    preset_op: ['POST', '/presets/:presetId/ops'],
    loadout_create: ['POST', '/presets/:presetId/loadouts'],
    loadout_update: ['PATCH', '/presets/:presetId/loadouts/:loadoutId'],
    loadout_delete: ['DELETE', '/presets/:presetId/loadouts/:loadoutId'],
    loadout_activate: ['POST', '/presets/:presetId/loadouts/:loadoutId/activate'],
    loadout_set_override: ['PUT', '/presets/:presetId/loadouts/:loadoutId/overrides/:modelId'],
    loadout_patch_override: ['PATCH', '/presets/:presetId/loadouts/:loadoutId/overrides/:modelId'],
    loadout_delete_override: ['DELETE', '/presets/:presetId/loadouts/:loadoutId/overrides/:modelId'],
    models_list: ['GET', '/models'],
    models_replace: ['PUT', '/models'],
    models_set_tuning: ['PUT', '/models/:modelId/tunings/:name'],
    models_patch_tuning: ['PATCH', '/models/:modelId/tunings/:name'],
    models_delete_tuning: ['DELETE', '/models/:modelId/tunings/:name'],
    models_rename_tuning: ['POST', '/models/:modelId/tunings/rename'],
    models_set_default_tuning: ['PUT', '/models/:modelId/default-tuning'],
    models_rename: ['POST', '/models/rename'],
    models_merge: ['POST', '/models/merge'],
    models_seed: ['POST', '/models/seed'],
    profiles_list: ['GET', '/profiles'],
    profiles_backup: ['POST', '/profiles/backup'],
    slot_get: ['GET', '/slot'],
    slot_load: ['POST', '/slot/load'],
    slot_set_model: ['POST', '/slot/model'],
    diff_presets: ['POST', '/diff'],
    diff_blocks: ['POST', '/diff/blocks'],
    revisions_list: ['GET', '/presets/:presetId/revisions'],
    revision_get: ['GET', '/presets/:presetId/revisions/:rev'],
    revision_create: ['POST', '/presets/:presetId/revisions'],
    revision_restore: ['POST', '/presets/:presetId/restore'],
    preset_undo: ['POST', '/presets/:presetId/undo'],
    preset_redo: ['POST', '/presets/:presetId/redo'],
    preset_history: ['GET', '/presets/:presetId/history'],
    shelf_list: ['GET', '/shelf'],
    shelf_get: ['GET', '/shelf/:shelfId'],
    shelf_add: ['POST', '/shelf'],
    shelf_update: ['PATCH', '/shelf/:shelfId'],
    shelf_remove: ['DELETE', '/shelf/:shelfId'],
};

// ------------------------------------------------------------------ helpers

/**
 * An MCP server over a stub session. `respond(method, path, body)` returns
 * the stub's {status, json, text} (default 200 {ok:true}) or throws.
 * @param {(m: string, p: string, b: any) => any} [respond]
 */
function harness(respond) {
    /** @type {string[]} */
    const out = [];
    /** @type {{method: string, path: string, body: any}[]} */
    const calls = [];
    /** @type {string[]} */
    const logs = [];
    const session = {
        refresh: async () => {},
        /** @param {string} method @param {string} p @param {any} [body] */
        request: async (method, p, body) => {
            calls.push({ method, path: p, body });
            const r = respond ? await respond(method, p, body) : { status: 200, json: { ok: true } };
            return { status: r.status, json: r.json ?? null, text: r.text ?? JSON.stringify(r.json ?? null) };
        },
    };
    const server = createMcpServer({ session, write: (/** @type {string} */ s) => out.push(s), log: (/** @type {string} */ s) => logs.push(s) });
    /** parsed messages written so far */
    const msgs = () => out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { server, out, calls, logs, msgs };
}

const line = (/** @type {any} */ o) => `${JSON.stringify(o)}\n`;
const req = (/** @type {any} */ id, /** @type {string} */ method, /** @type {any} */ params = undefined) => line({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const call = (/** @type {any} */ id, /** @type {string} */ name, /** @type {any} */ args) => req(id, 'tools/call', { name, arguments: args });

/** tools/call through the stub; returns {result, calls}. */
async function callTool(/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ respond = undefined) {
    const h = harness(respond);
    h.server.feed(call(7, name, args));
    await h.server.idle();
    const [m] = h.msgs();
    assert.equal(m.id, 7);
    return { m, result: m.result, calls: h.calls };
}

// ------------------------------------------------------------------ framing

test('initialize negotiates only the supported protocol version', async () => {
    const h = harness();
    h.server.feed(req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } }));
    await h.server.idle();
    const [m] = h.msgs();
    assert.equal(m.jsonrpc, '2.0');
    assert.equal(m.id, 1);
    assert.equal(m.result.protocolVersion, '2025-06-18');
    assert.equal(m.result.serverInfo.name, 'st-preset-manager');
    assert.equal(typeof m.result.serverInfo.version, 'string');
    assert.deepEqual(m.result.capabilities, { tools: {} });
    for (const version of ['2025-03-26', '2024-11-05', '2099-01-01']) {
        const unsupported = harness();
        unsupported.server.feed(req(version, 'initialize', { protocolVersion: version, capabilities: {} }));
        await unsupported.server.idle();
        assert.equal(unsupported.msgs()[0].result.protocolVersion, '2025-06-18');
        assert.equal(unsupported.msgs()[0].id, version);
    }
});

test('initialize rejects malformed params with -32602', async () => {
    for (const params of [undefined, null, [], {}, { protocolVersion: 7 }]) {
        const h = harness();
        h.server.feed(req(1, 'initialize', params));
        await h.server.idle();
        assert.equal(h.msgs()[0].error?.code, -32602, JSON.stringify(params));
    }
});

test('every output is one JSON object on one line, newline-terminated', async () => {
    const h = harness(() => ({ status: 200, json: { text: 'multi\nline\ncontent' } }));
    h.server.feed(req(1, 'initialize', { protocolVersion: '2025-06-18' }) + req(2, 'tools/list') + call(3, 'preset_get', { presetId: 'p1' }));
    await h.server.idle();
    assert.equal(h.out.length, 3);
    for (const s of h.out) {
        assert.ok(s.endsWith('\n'), 'newline-terminated');
        assert.equal(s.indexOf('\n'), s.length - 1, 'no embedded newline');
        JSON.parse(s);
    }
});

test('a message split across chunks is answered once, after its newline', async () => {
    const h = harness();
    h.server.feed('{"jsonrpc":"2.0","id":1,"me');
    await h.server.idle();
    assert.equal(h.out.length, 0);
    h.server.feed('thod":"pi');
    await h.server.idle();
    assert.equal(h.out.length, 0);
    h.server.feed('ng"}\n');
    await h.server.idle();
    assert.deepEqual(h.msgs(), [{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('a multi-byte character split across Buffer chunks survives', async () => {
    const h = harness();
    const bytes = Buffer.from(call(4, 'preset_get', { presetId: 'p_「x」' }));
    const cut = bytes.indexOf(Buffer.from('「')) + 1; // inside the 3-byte sequence
    h.server.feed(bytes.subarray(0, cut));
    h.server.feed(bytes.subarray(cut));
    await h.server.idle();
    assert.equal(h.calls[0].path, `/presets/${encodeURIComponent('p_「x」')}`);
});

test('several messages in one chunk (blank lines, CRLF) are answered in order', async () => {
    const h = harness();
    h.server.feed(`${req(1, 'ping')}\n   \n${req(2, 'ping').replace('\n', '\r\n')}${req(3, 'ping')}`);
    await h.server.idle();
    assert.deepEqual(h.msgs().map((m) => m.id), [1, 2, 3]);
    assert.ok(h.msgs().every((m) => JSON.stringify(m.result) === '{}'));
});

test('parse error -> -32700 with id null; the stream keeps going', async () => {
    const h = harness();
    h.server.feed(`{not json\n${req(2, 'ping')}`);
    await h.server.idle();
    const [a, b] = h.msgs();
    assert.equal(a.id, null);
    assert.equal(a.error.code, -32700);
    assert.equal(b.id, 2);
});

test('invalid requests -> -32600', async () => {
    const h = harness();
    h.server.feed(line({ id: 1, method: 'ping' })); // no jsonrpc
    h.server.feed(line({ jsonrpc: '2.0', id: 2, method: 5 })); // method not a string
    h.server.feed(line([{ jsonrpc: '2.0', id: 3, method: 'ping' }])); // batches are not MCP
    h.server.feed('42\n');
    await h.server.idle();
    const m = h.msgs();
    assert.equal(m.length, 4);
    assert.ok(m.every((x) => x.error?.code === -32600), JSON.stringify(m));
    assert.equal(m[0].id, 1);
    assert.equal(m[1].id, 2);
});

test('unknown method -> -32601 with the id; unknown notification -> no reply', async () => {
    const h = harness();
    h.server.feed(req(9, 'resources/list'));
    h.server.feed(line({ jsonrpc: '2.0', method: 'notifications/whatever' }));
    h.server.feed(line({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    h.server.feed(line({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }));
    await h.server.idle();
    const m = h.msgs();
    assert.equal(m.length, 1);
    assert.equal(m[0].id, 9);
    assert.equal(m[0].error.code, -32601);
});

test('a client response (no method) is ignored', async () => {
    const h = harness();
    h.server.feed(line({ jsonrpc: '2.0', id: 5, result: {} }));
    await h.server.idle();
    assert.equal(h.out.length, 0);
});

test('concurrent tools/call replies carry their own ids', async () => {
    /** @type {Record<string, (v: any) => void>} */
    const gates = {};
    const h = harness((_m, p) => new Promise((r) => { gates[p] = r; }));
    h.server.feed(call(1, 'preset_get', { presetId: 'a' }) + call(2, 'preset_get', { presetId: 'b' }));
    await new Promise((r) => setImmediate(r));
    gates['/presets/b']({ status: 200, json: { id: 'b' } });
    gates['/presets/a']({ status: 200, json: { id: 'a' } });
    await h.server.idle();
    const byId = Object.fromEntries(h.msgs().map((m) => [m.id, JSON.parse(m.result.content[0].text).id]));
    assert.deepEqual(byId, { 1: 'a', 2: 'b' });
});

// ------------------------------------------------------------------ tools/list

test('tools/list: exactly the mapped tools, each with an object input schema', async () => {
    const h = harness();
    h.server.feed(req(1, 'tools/list'));
    await h.server.idle();
    const tools = h.msgs()[0].result.tools;
    assert.deepEqual(tools.map((/** @type {any} */ t) => t.name).sort(), Object.keys(EXPECTED_TOOLS).sort());
    for (const t of tools) {
        assert.ok(typeof t.description === 'string' && t.description.length > 10, `${t.name} description`);
        assert.equal(t.inputSchema?.type, 'object', `${t.name} schema`);
        const [, route] = EXPECTED_TOOLS[/** @type {keyof typeof EXPECTED_TOOLS} */ (t.name)];
        for (const p of route.match(/:(\w+)/g) ?? []) {
            const k = p.slice(1);
            assert.ok(t.inputSchema.properties?.[k], `${t.name}: path param ${k} in the schema`);
            assert.ok(t.inputSchema.required?.includes(k), `${t.name}: path param ${k} required`);
        }
    }
    // no auth material is ever a tool argument
    const keys = /** @type {string[]} */ ([]);
    JSON.stringify(tools, (k, v) => { keys.push(k); return v; });
    assert.ok(!JSON.stringify(tools).match(/cookie|csrf/i), 'tools/list mentions cookie/csrf');
    assert.ok(keys.every((k) => !/cookie|csrf|token/i.test(k)), 'an auth-like property');
});

test('TOOLS export matches the route table', () => {
    for (const t of TOOLS) {
        assert.deepEqual([t.method, t.path], EXPECTED_TOOLS[/** @type {keyof typeof EXPECTED_TOOLS} */ (t.name)], t.name);
    }
    assert.equal(TOOLS.length, Object.keys(EXPECTED_TOOLS).length);
});

// ------------------------------------------------------------------ tools/call mapping

test('slot_load -> POST /slot/load with the arguments as the body', async () => {
    const { result, calls } = await callTool('slot_load', { presetId: 'p1', loadoutId: 'l2' },
        () => ({ status: 200, json: { rev: 3, desired: { presetId: 'p1', loadoutId: 'l2', modelId: null } } }));
    assert.deepEqual(calls, [{ method: 'POST', path: '/slot/load', body: { presetId: 'p1', loadoutId: 'l2' } }]);
    assert.ok(!result.isError);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify({ rev: 3, desired: { presetId: 'p1', loadoutId: 'l2', modelId: null } }) }]);
});

test('path params are URL-encoded and never sent in the body', async () => {
    let r = await callTool('preset_get', { presetId: 'p x/1' });
    assert.deepEqual(r.calls, [{ method: 'GET', path: '/presets/p%20x%2F1', body: undefined }]);
    r = await callTool('loadout_set_override', { presetId: 'p1', loadoutId: 'l1', modelId: 'or/claude 4', enabled: { a: true } });
    assert.deepEqual(r.calls, [{ method: 'PUT', path: '/presets/p1/loadouts/l1/overrides/or%2Fclaude%204', body: { enabled: { a: true } } }]);
    r = await callTool('models_set_tuning', { modelId: '100% local', name: 'hot/1', tuning: { temperature: 0.5 } });
    assert.deepEqual(r.calls, [{ method: 'PUT', path: '/models/100%25%20local/tunings/hot%2F1', body: { temperature: 0.5 } }]);
    r = await callTool('revision_get', { presetId: 'p1', rev: 4 });
    assert.deepEqual(r.calls, [{ method: 'GET', path: '/presets/p1/revisions/4', body: undefined }]);
    r = await callTool('shelf_remove', { shelfId: 's_1' });
    assert.deepEqual(r.calls, [{ method: 'DELETE', path: '/shelf/s_1', body: undefined }]);
    r = await callTool('loadout_activate', { presetId: 'p1', loadoutId: 'l1' });
    assert.deepEqual(r.calls, [{ method: 'POST', path: '/presets/p1/loadouts/l1/activate', body: {} }]);
});

test('query arguments go to the query string; absent ones are omitted', async () => {
    let r = await callTool('library_list', {});
    assert.deepEqual(r.calls, [{ method: 'GET', path: '/library', body: undefined }]);
    r = await callTool('library_list', undefined); // arguments omitted entirely
    assert.equal(r.calls[0].path, '/library');
    r = await callTool('library_list', { tag: 'a b&c' });
    const u = new URL(r.calls[0].path, 'http://x');
    assert.equal(u.pathname, '/library');
    assert.equal(u.searchParams.get('tag'), 'a b&c');
    r = await callTool('preset_export', { presetId: 'p1', format: 'native' });
    assert.equal(r.calls[0].path, '/presets/p1/export?format=native');
    r = await callTool('slot_get', { source: 'openai', model: 'gpt-x' });
    const s = new URL(r.calls[0].path, 'http://x');
    assert.equal(s.pathname, '/slot');
    assert.deepEqual([...s.searchParams.entries()].sort(), [['model', 'gpt-x'], ['source', 'openai']]);
});

test('preset_op passes every op argument through untouched', async () => {
    const { calls } = await callTool('preset_op', { presetId: 'p1', op: 'copyBlock', fromPresetId: 'p2', identifier: 'x', before: null, outsideGroup: true });
    assert.deepEqual(calls, [{ method: 'POST', path: '/presets/p1/ops', body: { op: 'copyBlock', fromPresetId: 'p2', identifier: 'x', before: null, outsideGroup: true } }]);
});

test('whole-body tools send that one argument as the body', async () => {
    const doc = { id: 'p1', name: 'N', blocks: {} };
    let r = await callTool('preset_save', { presetId: 'p1', doc });
    assert.deepEqual(r.calls, [{ method: 'PUT', path: '/presets/p1', body: doc }]);
    r = await callTool('models_replace', { registry: { version: 1, models: {} } });
    assert.deepEqual(r.calls, [{ method: 'PUT', path: '/models', body: { version: 1, models: {} } }]);
    r = await callTool('models_set_tuning', { modelId: 'M', name: 'hot', tuning: { temperature: 0.7 } });
    assert.deepEqual(r.calls, [{ method: 'PUT', path: '/models/M/tunings/hot', body: { temperature: 0.7 } }]);
    r = await callTool('loadout_set_override', { presetId: 'p1', loadoutId: 'l1', modelId: 'M', enabled: {}, tuning: 'hot' });
    assert.deepEqual(r.calls, [{ method: 'PUT', path: '/presets/p1/loadouts/l1/overrides/M', body: { enabled: {}, tuning: 'hot' } }]);
    r = await callTool('models_rename_tuning', { modelId: 'M', from: 'hot', to: 'spicy' });
    assert.deepEqual(r.calls, [{ method: 'POST', path: '/models/M/tunings/rename', body: { from: 'hot', to: 'spicy' } }]);
    r = await callTool('models_set_default_tuning', { modelId: 'M', name: 'hot' });
    assert.deepEqual(r.calls, [{ method: 'PUT', path: '/models/M/default-tuning', body: { name: 'hot' } }]);
});

test('diff_blocks and revision_restore send their bodies as given', async () => {
    let r = await callTool('diff_blocks', { a: { presetId: 'p1', identifier: 'x' }, b: { text: 'hi' }, context: 1 });
    assert.deepEqual(r.calls, [{ method: 'POST', path: '/diff/blocks', body: { a: { presetId: 'p1', identifier: 'x' }, b: { text: 'hi' }, context: 1 } }]);
    r = await callTool('revision_restore', { presetId: 'p1', rev: 2 });
    assert.deepEqual(r.calls, [{ method: 'POST', path: '/presets/p1/restore', body: { rev: 2 } }]);
});

test('HTTP error -> isError with the status and the server\'s error body', async () => {
    let r = await callTool('preset_get', { presetId: 'p_nope' }, () => ({ status: 404, json: { error: 'preset p_nope not found' } }));
    assert.equal(r.result.isError, true);
    assert.deepEqual(JSON.parse(r.result.content[0].text), { status: 404, error: 'preset p_nope not found' });
    r = await callTool('preset_import', { st: {}, name: 'X' }, () => ({ status: 409, json: { error: 'name "X" is already taken', conflict: 'p_1' } }));
    assert.deepEqual(JSON.parse(r.result.content[0].text), { status: 409, error: 'name "X" is already taken', conflict: 'p_1' });
    r = await callTool('health', {}, () => ({ status: 502, json: null, text: 'Bad Gateway' }));
    assert.equal(r.result.isError, true);
    assert.deepEqual(JSON.parse(r.result.content[0].text), { status: 502, error: 'Bad Gateway' });
});

test('loadout tools: create requires kind (a 400 surfaces as isError); update/override carry the new fields; preset_op knows the reset ops', async () => {
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    assert.deepEqual([...byName.loadout_create.inputSchema.required].sort(), ['kind', 'name', 'presetId']);
    assert.deepEqual(byName.loadout_create.inputSchema.properties.kind.enum, ['root', 'playstyle']);
    assert.ok(byName.loadout_create.inputSchema.properties.parent);
    assert.ok(byName.loadout_create.inputSchema.properties.from);
    assert.ok(byName.loadout_update.inputSchema.properties.parent);
    assert.ok(byName.loadout_update.inputSchema.properties.kind);
    assert.ok(byName.loadout_set_override.inputSchema.properties.tuning);
    assert.ok(byName.loadout_patch_override.inputSchema.properties.tuning);
    const ops = byName.preset_op.inputSchema.properties.op.enum;
    assert.ok(ops.includes('resetInherit') && ops.includes('resetAllInherit'), JSON.stringify(ops));
    assert.ok(ops.includes('addGroup'), JSON.stringify(ops));
    const r = await callTool('loadout_create', { presetId: 'p_1', name: 'X' }, () => ({ status: 400, json: { error: 'loadouts create needs {kind}' } }));
    assert.equal(r.result.isError, true);
    assert.deepEqual(JSON.parse(r.result.content[0].text), { status: 400, error: 'loadouts create needs {kind}' });
});

test('missing or unsafe path argument -> -32602; no HTTP call', async () => {
    for (const loadoutId of [undefined, null, '', '.', '..', '%2e', '%2E%2e', '%252e%252e']) {
        const h = harness();
        h.server.feed(call(7, 'loadout_delete', { presetId: 'p1', ...(loadoutId === undefined ? {} : { loadoutId }) }));
        await h.server.idle();
        const [m] = h.msgs();
        assert.equal(m.error?.code, -32602, `loadoutId=${String(loadoutId)}: ${JSON.stringify(m)}`);
        assert.match(m.error.message, /loadoutId/);
        assert.equal(h.calls.length, 0);
    }
});

test('network failure -> isError with the message', async () => {
    const { result } = await callTool('library_list', {}, () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8002'); });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ECONNREFUSED/);
});

test('unknown tool -> JSON-RPC -32602', async () => {
    const h = harness();
    h.server.feed(call(3, 'no_such_tool', {}));
    await h.server.idle();
    const [m] = h.msgs();
    assert.equal(m.id, 3);
    assert.equal(m.error.code, -32602);
    assert.equal(h.calls.length, 0);
});

// ------------------------------------------------------------------ auth (fake HTTP server)

/**
 * A fake ST: /csrf-token hands out a cookie pair and a token (rotating per
 * `rotate`), /api/users/login, and the plugin paths answered by `plugin`.
 * @param {{ plugin?: (req: http.IncomingMessage, body: string, st: any) => {status: number, json?: any, html?: string, headers?: Record<string, string|string[]>}|Promise<{status: number, json?: any, html?: string, headers?: Record<string, string|string[]>}>, login?: (body: any, st: any) => {status: number, json?: any, headers?: any} }} opts
 */
async function fakeSt(opts = {}) {
    const st = {
        n: 0,
        token: 'tk0zq',
        /** @type {{method: string, url: string, headers: http.IncomingHttpHeaders, body: string}[]} */
        seen: [],
        count: (/** @type {string} */ prefix) => st.seen.filter((s) => s.url.startsWith(prefix)).length,
    };
    const srv = http.createServer((rq, rs) => {
        let body = '';
        rq.on('data', (c) => (body += c));
        rq.on('end', async () => {
            st.seen.push({ method: rq.method ?? '', url: rq.url ?? '', headers: rq.headers, body });
            /** @param {{status: number, json?: any, html?: string, headers?: any}} r */
            const send = (r) => {
                rs.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
                if (r.html !== undefined) rs.end(r.html);
                else rs.end(r.json === undefined ? '' : JSON.stringify(r.json));
            };
            if (rq.url === '/csrf-token') {
                st.n += 1;
                st.token = `tk${st.n}zq`;
                const cookie = rq.headers.cookie ?? '';
                // a fresh session only when the client has none (like cookie-session)
                const setCookie = cookie.includes('session-abc=') ? [] : ['session-abc=ckA1; path=/; httponly', 'session-abc.sig=sgA1; path=/; httponly'];
                return send({ status: 200, json: { token: st.token }, headers: setCookie.length ? { 'set-cookie': setCookie } : {} });
            }
            if (rq.url === '/api/users/login') {
                return send(opts.login ? opts.login(JSON.parse(body || '{}'), st) : { status: 200, json: { handle: 'u' } });
            }
            if (rq.url?.startsWith(PLUGIN)) {
                return send(opts.plugin ? await opts.plugin(rq, body, st) : { status: 200, json: { ok: true } });
            }
            send({ status: 404, json: { error: 'nope' } });
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(null)));
    const url = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
    return { st, url, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(null)); }) };
}

/** Cookie header -> {name: value}. */
const cookies = (/** @type {string|undefined} */ h) => Object.fromEntries((h ?? '').split(/;\s*/).filter(Boolean).map((p) => p.split('=')));

test('refresh: GET /csrf-token; every call sends the cookie pair and the token', async () => {
    const f = await fakeSt();
    try {
        const s = createSession({ stUrl: f.url, log: () => {} });
        await s.refresh();
        const r = await s.request('POST', '/slot/load', { presetId: 'p1' });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, { ok: true });
        const hit = f.st.seen.find((x) => x.url === `${PLUGIN}/slot/load`);
        assert.ok(hit);
        assert.deepEqual(cookies(hit.headers.cookie), { 'session-abc': 'ckA1', 'session-abc.sig': 'sgA1' });
        assert.equal(hit.headers['x-csrf-token'], 'tk1zq');
        assert.match(String(hit.headers['content-type']), /application\/json/);
        assert.deepEqual(JSON.parse(hit.body), { presetId: 'p1' });
        // GETs carry them too
        await s.request('GET', '/library');
        const g = f.st.seen.find((x) => x.url === `${PLUGIN}/library`);
        assert.equal(g?.headers['x-csrf-token'], 'tk1zq');
        assert.equal(cookies(g?.headers.cookie)['session-abc'], 'ckA1');
        assert.equal(f.st.count('/csrf-token'), 1);
    } finally { await f.close(); }
});

test('lazy: the first call without a session fetches one first', async () => {
    const f = await fakeSt();
    try {
        const s = createSession({ stUrl: f.url, log: () => {} });
        const r = await s.request('GET', '/health');
        assert.equal(r.status, 200);
        assert.deepEqual(f.st.seen.map((x) => x.url), ['/csrf-token', `${PLUGIN}/health`]);
        // concurrent first calls share ONE refresh
        const f2 = await fakeSt();
        try {
            const s2 = createSession({ stUrl: f2.url, log: () => {} });
            await Promise.all([s2.request('GET', '/a'), s2.request('GET', '/b'), s2.request('GET', '/c')]);
            assert.equal(f2.st.count('/csrf-token'), 1);
        } finally { await f2.close(); }
    } finally { await f.close(); }
});

test('403 -> one refresh, one retry with the new token', async () => {
    let calls = 0;
    const f = await fakeSt({
        plugin: (rq, _b, st) => {
            calls += 1;
            return rq.headers['x-csrf-token'] === st.token && calls > 1 ? { status: 200, json: { ok: 'retried' } } : { status: 403, json: { error: 'Invalid CSRF token' } };
        },
    });
    try {
        const s = createSession({ stUrl: f.url, log: () => {} });
        await s.refresh();
        const r = await s.request('POST', '/presets/p1/ops', { op: 'toggle', identifier: 'main' });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, { ok: 'retried' });
        assert.equal(f.st.count('/csrf-token'), 2);
        const plugin = f.st.seen.filter((x) => x.url.startsWith(PLUGIN));
        assert.equal(plugin.length, 2);
        assert.equal(plugin[0].headers['x-csrf-token'], 'tk1zq');
        assert.equal(plugin[1].headers['x-csrf-token'], 'tk2zq');
        assert.equal(plugin[1].body, plugin[0].body, 'the retry resends the same body');
    } finally { await f.close(); }
});
test('staggered 403s from one stale session share one completed refresh', async () => {
    let stale = 0;
    const f = await fakeSt({
        plugin: async (rq) => {
            const sent = rq.headers['x-csrf-token'];
            if (sent === 'tk1zq') {
                const delay = stale++ * 40;
                await new Promise((r) => setTimeout(r, delay));
                return { status: 403, json: { error: 'stale' } };
            }
            return { status: 200, json: { token: sent } };
        },
    });
    try {
        const s = createSession({ stUrl: f.url, log: () => {} });
        await s.refresh();
        const out = await Promise.all(['/a', '/b', '/c'].map((p) => s.request('GET', p)));
        assert.ok(out.every((r) => r.status === 200));
        assert.ok(out.every((r) => r.json.token === 'tk2zq'));
        assert.equal(f.st.count('/csrf-token'), 2, 'initial session + exactly one refresh');
        assert.equal(f.st.count(PLUGIN), 6, 'three rejected attempts + one retry each');
    } finally { await f.close(); }
});

test('403 twice -> the 403 is returned; no second retry', async () => {
    const f = await fakeSt({ plugin: () => ({ status: 403, json: { error: 'Forbidden' } }) });
    try {
        const s = createSession({ stUrl: f.url, log: () => {} });
        const r = await s.request('POST', '/slot/load', { presetId: 'p1' });
        assert.equal(r.status, 403);
        assert.deepEqual(r.json, { error: 'Forbidden' });
        assert.equal(f.st.count(PLUGIN), 2);
        assert.equal(f.st.count('/csrf-token'), 2); // lazy start + the one refresh
    } finally { await f.close(); }
});

test('an HTML 403 (ST\'s default error page) twice -> isError with the status and the raw text', async () => {
    const html = '<!DOCTYPE html><html><body><pre>ForbiddenError: invalid csrf token</pre></body></html>';
    const f = await fakeSt({ plugin: () => ({ status: 403, html }) });
    try {
        const out = /** @type {string[]} */ ([]);
        const server = createMcpServer({ session: createSession({ stUrl: f.url, log: () => {} }), write: (/** @type {string} */ s) => out.push(s), log: () => {} });
        server.feed(call(1, 'library_list', {}));
        await server.idle();
        const res = JSON.parse(out[0]);
        assert.equal(res.result.isError, true);
        assert.deepEqual(JSON.parse(res.result.content[0].text), { status: 403, error: html });
        assert.equal(f.st.count(PLUGIN), 2);
        assert.equal(f.st.count('/csrf-token'), 2);
    } finally { await f.close(); }
});

test('Set-Cookie on an API response updates the jar for later calls', async () => {
    let n = 0;
    const f = await fakeSt({
        plugin: () => (++n === 1 ? { status: 200, json: {}, headers: { 'set-cookie': ['session-abc=v2; path=/'] } } : { status: 200, json: {} }),
    });
    try {
        const s = createSession({ stUrl: f.url, log: () => {} });
        await s.request('GET', '/one');
        await s.request('GET', '/two');
        const two = f.st.seen.find((x) => x.url === `${PLUGIN}/two`);
        assert.deepEqual(cookies(two?.headers.cookie), { 'session-abc': 'v2', 'session-abc.sig': 'sgA1' });
    } finally { await f.close(); }
});

test('ST_USER/ST_PASSWORD: login with the session, then a fresh token', async () => {
    const f = await fakeSt({
        login: (body) => (body.handle === 'u' && body.password === 'pw'
            ? { status: 200, json: { handle: 'u' }, headers: { 'set-cookie': ['session-abc=logged; path=/', 'session-abc.sig=s9; path=/'] } }
            : { status: 403, json: { error: 'Incorrect credentials' } }),
    });
    try {
        const s = createSession({ stUrl: f.url, user: 'u', password: 'pw', log: () => {} });
        await s.request('GET', '/library');
        assert.deepEqual(f.st.seen.map((x) => x.url), ['/csrf-token', '/api/users/login', '/csrf-token', `${PLUGIN}/library`]);
        const login = f.st.seen[1];
        assert.equal(login.method, 'POST');
        assert.deepEqual(JSON.parse(login.body), { handle: 'u', password: 'pw' });
        assert.equal(login.headers['x-csrf-token'], 'tk1zq');
        assert.equal(cookies(login.headers.cookie)['session-abc'], 'ckA1');
        const lib = f.st.seen[3];
        assert.deepEqual(cookies(lib.headers.cookie), { 'session-abc': 'logged', 'session-abc.sig': 's9' });
        assert.equal(lib.headers['x-csrf-token'], 'tk2zq');
    } finally { await f.close(); }
    const bad = await fakeSt({ login: () => ({ status: 403, json: { error: 'Incorrect credentials' } }) });
    try {
        const s = createSession({ stUrl: bad.url, user: 'u', password: 'wrong', log: () => {} });
        await assert.rejects(s.refresh(), /403.*Incorrect credentials|Incorrect credentials.*403/);
    } finally { await bad.close(); }
});

test('end to end over the fake: a tool call never leaks the cookie or the token', async () => {
    const f = await fakeSt({ plugin: () => ({ status: 200, json: [{ id: 'p1', name: 'A' }] }) });
    try {
        const out = /** @type {string[]} */ ([]);
        const server = createMcpServer({ session: createSession({ stUrl: f.url, log: () => {} }), write: (/** @type {string} */ s) => out.push(s), log: () => {} });
        server.feed(req(1, 'initialize', { protocolVersion: '2025-06-18' }) + req(2, 'tools/list') + call(3, 'library_list', {}) + call(4, 'preset_get', {}));
        await server.idle();
        const text = out.join('');
        const res = out.map((s) => JSON.parse(s)).find((m) => m.id === 3);
        assert.deepEqual(JSON.parse(res.result.content[0].text), [{ id: 'p1', name: 'A' }]);
        for (const secret of ['ckA1', 'sgA1', 'tk1zq', 'session-abc']) {
            assert.ok(!text.includes(secret), `output contains ${secret}`);
        }
        assert.ok(!/cookie|csrf/i.test(text));
    } finally { await f.close(); }
});

test('main drains a large response from stdout after stdin EOF', async () => {
    const blob = 'x'.repeat(2 * 1024 * 1024);
    const f = await fakeSt({ plugin: () => ({ status: 200, json: { id: 'p_big', blob } }) });
    try {
        const child = spawn(process.execPath, ['mcp/server.js'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, ST_URL: f.url, ST_USER: '', ST_PASSWORD: '' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.stdin.end(call(1, 'preset_get', { presetId: 'p_big' }));
        const code = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MCP child did not exit')); }, 10000);
            child.on('error', reject);
            child.on('close', (c) => { clearTimeout(timer); resolve(c); });
        });
        assert.equal(code, 0, stderr);
        const lines = stdout.split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
        const message = JSON.parse(lines[0]);
        const result = JSON.parse(message.result.content[0].text);
        assert.equal(result.id, 'p_big');
        assert.equal(result.blob.length, blob.length);
        assert.equal(result.blob, blob);
    } finally { await f.close(); }
});

test('main exits after draining initialize when startup authentication stalls', async () => {
    const stalled = http.createServer(() => { /* deliberately never answer */ });
    await new Promise((resolve) => stalled.listen(0, '127.0.0.1', () => resolve(null)));
    const stUrl = `http://127.0.0.1:${/** @type {any} */ (stalled.address()).port}`;
    try {
        const child = spawn(process.execPath, ['mcp/server.js'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, ST_URL: stUrl, ST_USER: '', ST_PASSWORD: '' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (c) => (stdout += c));
        child.stdin.end(req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }));
        const code = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error('MCP child stayed alive on its stalled startup request'));
            }, 1000);
            child.on('error', reject);
            child.on('close', (c) => { clearTimeout(timer); resolve(c); });
        });
        assert.equal(code, 0);
        const lines = stdout.split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
        const message = JSON.parse(lines[0]);
        assert.equal(message.id, 1);
        assert.equal(message.result.protocolVersion, '2025-06-18');
    } finally {
        stalled.closeAllConnections?.();
        await new Promise((resolve) => stalled.close(() => resolve(null)));
    }
});
