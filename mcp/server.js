#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP wrapper for Preset Manager's REST API.
 *
 * Configuration: ST_URL (default http://127.0.0.1:8002), and optional
 * ST_USER/ST_PASSWORD for a multi-user SillyTavern. A session is established
 * in memory from GET /csrf-token; authenticated installations then use POST
 * /api/users/login. A rejected plugin request refreshes once and retries once.
 *
 * omp registration:
 * {"st-preset-manager":{"command":"node","args":["<repo>/mcp/server.js"],"env":{"ST_URL":"http://127.0.0.1:8002"}}}
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PROTOCOL_VERSION = '2025-06-18';
const PLUGIN = '/api/plugins/st-preset-manager';
const obj = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const str = (description) => ({ type: 'string', description });
const integer = (description) => ({ type: 'integer', description });
const boolean = (description) => ({ type: 'boolean', description });
const object = (description) => ({ type: 'object', description });
const array = (description, items = {}) => ({ type: 'array', items, description });

/** @type {Array<{name:string,description:string,method:string,path:string,query?:string[],bodyArg?:string,inputSchema:any}>} */
export const TOOLS = [
    { name: 'health', description: 'Read plugin version, revision, library root and connected-client count.', method: 'GET', path: '/health', inputSchema: obj() },
    { name: 'library_list', description: 'List library entries, optionally filtered by tag.', method: 'GET', path: '/library', query: ['tag'], inputSchema: obj({ tag: str('Optional tag filter.') }) },
    { name: 'library_rescan', description: 'Rebuild the preset library index and return its item count.', method: 'POST', path: '/rescan', inputSchema: obj() },
    { name: 'preset_get', description: 'Read one native preset document.', method: 'GET', path: '/presets/:presetId', inputSchema: obj({ presetId: str('Preset id.') }, ['presetId']) },
    { name: 'preset_export', description: 'Export one preset as ST JSON or its native document.', method: 'GET', path: '/presets/:presetId/export', query: ['format'], inputSchema: obj({ presetId: str('Preset id.'), format: { type: 'string', enum: ['st', 'native'], description: 'Export format; defaults to st.' } }, ['presetId']) },
    { name: 'preset_import', description: 'Import an ST preset or native document and return the stored document.', method: 'POST', path: '/presets', inputSchema: obj({ st: object('ST preset JSON.'), native: object('Native preset document.'), name: str('Imported preset name.'), folder: str('Library folder.'), tags: array('Tags.', { type: 'string' }), replace: boolean('Replace a preset with a taken name.') }) },
    { name: 'preset_save', description: 'Replace one native preset document.', method: 'PUT', path: '/presets/:presetId', bodyArg: 'doc', inputSchema: obj({ presetId: str('Preset id.'), doc: object('Complete native preset document.') }, ['presetId', 'doc']) },
    { name: 'preset_delete', description: 'Delete one preset and return confirmation.', method: 'DELETE', path: '/presets/:presetId', inputSchema: obj({ presetId: str('Preset id.') }, ['presetId']) },
    { name: 'preset_fork', description: 'Fork a preset with fresh identifiers and return the new document.', method: 'POST', path: '/presets/:presetId/fork', inputSchema: obj({ presetId: str('Source preset id.'), name: str('New preset name.'), folder: str('New folder.'), tags: array('Tags.', { type: 'string' }), notes: str('Notes.') }, ['presetId', 'name']) },
    { name: 'preset_move', description: 'Move or rename a preset and return the document.', method: 'POST', path: '/presets/:presetId/move', inputSchema: obj({ presetId: str('Preset id.'), folder: str('New folder.'), name: str('New name.') }, ['presetId']) },
    { name: 'preset_set_meta', description: 'Update preset library metadata and return the document.', method: 'PATCH', path: '/presets/:presetId/meta', inputSchema: obj({ presetId: str('Preset id.'), name: str('Name.'), folder: str('Folder.'), tags: array('Tags.', { type: 'string' }), notes: str('Preset notes.'), blockNotes: object('Block identifier to notes mapping.') }, ['presetId']) },
    { name: 'preset_op', description: 'Apply one document operation and return the changed document and revision.', method: 'POST', path: '/presets/:presetId/ops', inputSchema: { ...obj({ presetId: str('Preset id.'), op: { type: 'string', enum: ['toggle', 'setGroup', 'setCardinality', 'promote', 'demote', 'moveLeaf', 'createGroup', 'renameGroup', 'addOption', 'removeOption', 'setContent', 'editBlock', 'renameBlock', 'addBlock', 'addSection', 'deleteBlock', 'setSettings', 'setBlockNotes', 'setNotes', 'copyBlock'], description: 'Operation name.' }, identifier: str('Block identifier.'), value: boolean('Toggle value.'), group: str('Group key or source group key.'), key: str('Outline row key.'), keys: array('Outline row keys used to create a group.', { type: 'string' }), headerKey: { type: ['string', 'null'], description: 'Optional group heading row key.' }, delta: integer('Sibling movement delta.'), cardinality: { type: 'string', enum: ['pick-one', 'pick-one-or-more'], description: 'Group cardinality.' }, name: str('Block or group name.'), content: str('Block content.'), role: str('Block role.'), fields: object('Block field values.'), notes: str('Notes.'), settings: object('Settings update.'), fromPresetId: str('Source preset id.'), shelfId: str('Shelf item id.'), before: { type: ['string', 'null'], description: 'Destination anchor.' }, outsideGroup: boolean('Keep the copy outside the anchor group.') }, ['presetId', 'op']), additionalProperties: true } },
    { name: 'loadout_create', description: 'Create a loadout copied from another loadout and return the document.', method: 'POST', path: '/presets/:presetId/loadouts', inputSchema: obj({ presetId: str('Preset id.'), name: str('New loadout name.'), from: str('Source loadout id; defaults to active.') }, ['presetId', 'name']) },
    { name: 'loadout_update', description: 'Rename or annotate a loadout and return the document.', method: 'PATCH', path: '/presets/:presetId/loadouts/:loadoutId', inputSchema: obj({ presetId: str('Preset id.'), loadoutId: str('Loadout id.'), name: str('New name.'), notes: str('Notes.') }, ['presetId', 'loadoutId']) },
    { name: 'loadout_delete', description: 'Delete a loadout other than the last one.', method: 'DELETE', path: '/presets/:presetId/loadouts/:loadoutId', inputSchema: obj({ presetId: str('Preset id.'), loadoutId: str('Loadout id.') }, ['presetId', 'loadoutId']) },
    { name: 'loadout_activate', description: 'Activate a preset loadout and return the current slot view.', method: 'POST', path: '/presets/:presetId/loadouts/:loadoutId/activate', inputSchema: obj({ presetId: str('Preset id.'), loadoutId: str('Loadout id.') }, ['presetId', 'loadoutId']) },
    { name: 'loadout_set_override', description: 'Replace one Model-specific loadout override.', method: 'PUT', path: '/presets/:presetId/loadouts/:loadoutId/overrides/:modelId', inputSchema: obj({ presetId: str('Preset id.'), loadoutId: str('Loadout id.'), modelId: str('Model id.'), enabled: object('Identifier to enabled-state mapping.') }, ['presetId', 'loadoutId', 'modelId', 'enabled']) },
    { name: 'loadout_patch_override', description: 'Patch one Model-specific loadout override.', method: 'PATCH', path: '/presets/:presetId/loadouts/:loadoutId/overrides/:modelId', inputSchema: obj({ presetId: str('Preset id.'), loadoutId: str('Loadout id.'), modelId: str('Model id.'), set: object('Enabled states to set.'), unset: array('Identifiers to remove.', { type: 'string' }) }, ['presetId', 'loadoutId', 'modelId']) },
    { name: 'loadout_delete_override', description: 'Delete one Model-specific loadout override.', method: 'DELETE', path: '/presets/:presetId/loadouts/:loadoutId/overrides/:modelId', inputSchema: obj({ presetId: str('Preset id.'), loadoutId: str('Loadout id.'), modelId: str('Model id.') }, ['presetId', 'loadoutId', 'modelId']) },
    { name: 'tuning_override_set', description: 'Replace one preset tuning override for a Model.', method: 'PUT', path: '/presets/:presetId/tuning-overrides/:modelId', bodyArg: 'tuning', inputSchema: obj({ presetId: str('Preset id.'), modelId: str('Model id.'), tuning: object('Tuning key values.') }, ['presetId', 'modelId', 'tuning']) },
    { name: 'tuning_override_patch', description: 'Patch one preset tuning override for a Model.', method: 'PATCH', path: '/presets/:presetId/tuning-overrides/:modelId', inputSchema: obj({ presetId: str('Preset id.'), modelId: str('Model id.'), set: object('Tuning values to set.'), unset: array('Tuning keys to remove.', { type: 'string' }) }, ['presetId', 'modelId']) },
    { name: 'tuning_override_delete', description: 'Delete one preset tuning override for a Model.', method: 'DELETE', path: '/presets/:presetId/tuning-overrides/:modelId', inputSchema: obj({ presetId: str('Preset id.'), modelId: str('Model id.') }, ['presetId', 'modelId']) },
    { name: 'models_list', description: 'Read the complete Model registry.', method: 'GET', path: '/models', inputSchema: obj() },
    { name: 'models_replace', description: 'Replace the complete Model registry.', method: 'PUT', path: '/models', bodyArg: 'registry', inputSchema: obj({ registry: object('Complete Model registry.') }, ['registry']) },
    { name: 'models_set_tuning', description: 'Replace one Model global tuning record.', method: 'PUT', path: '/models/:modelId/tuning', bodyArg: 'tuning', inputSchema: obj({ modelId: str('Model id.'), tuning: object('Tuning key values.') }, ['modelId', 'tuning']) },
    { name: 'models_patch_tuning', description: 'Patch one Model global tuning record.', method: 'PATCH', path: '/models/:modelId/tuning', inputSchema: obj({ modelId: str('Model id.'), set: object('Tuning values to set.'), unset: array('Tuning keys to remove.', { type: 'string' }) }, ['modelId']) },
    { name: 'models_rename', description: 'Rename a Model and migrate preset references.', method: 'POST', path: '/models/rename', inputSchema: obj({ from: str('Current Model name.'), to: str('New Model name.') }, ['from', 'to']) },
    { name: 'models_merge', description: 'Merge Models and migrate preset references.', method: 'POST', path: '/models/merge', inputSchema: obj({ names: array('Model names to merge.', { type: 'string' }), name: str('Surviving Model name.') }, ['names', 'name']) },
    { name: 'models_seed', description: 'Seed Models from supplied or stored connection profiles.', method: 'POST', path: '/models/seed', inputSchema: obj({ profiles: array('Optional connection profiles.', { type: 'object' }) }) },
    { name: 'profiles_list', description: 'List read-only Chat Completion connection profiles.', method: 'GET', path: '/profiles', inputSchema: obj() },
    { name: 'profiles_backup', description: 'Back up supplied or stored connection profiles.', method: 'POST', path: '/profiles/backup', inputSchema: obj({ profiles: array('Optional connection profiles.', { type: 'object' }) }) },
    { name: 'slot_get', description: 'Read the desired slot and compiled preset.', method: 'GET', path: '/slot', query: ['source', 'model', 'profileId'], inputSchema: obj({ source: str('Raw connection source.'), model: str('Raw connection model.'), profileId: str('Connection profile id.') }) },
    { name: 'slot_load', description: 'Load a preset and optional loadout into the working slot.', method: 'POST', path: '/slot/load', inputSchema: obj({ presetId: str('Preset id.'), loadoutId: str('Loadout id; defaults to active.') }, ['presetId']) },
    { name: 'slot_set_model', description: 'Report the current raw connection and return the slot view.', method: 'POST', path: '/slot/model', inputSchema: obj({ raw: object('Raw connection fields: source, model and profileId.') }, ['raw']) },
    { name: 'diff_presets', description: 'Compare two current or historical preset documents.', method: 'POST', path: '/diff', inputSchema: obj({ a: object('Left side: presetId and optional rev.'), b: object('Right side: presetId and optional rev.') }, ['a', 'b']) },
    { name: 'diff_blocks', description: 'Compare two block texts and return line-diff hunks.', method: 'POST', path: '/diff/blocks', inputSchema: obj({ a: object('Left block reference or raw text.'), b: object('Right block reference or raw text.'), context: { type: 'integer', minimum: 0, maximum: 1000, description: 'Context line count.' } }, ['a', 'b']) },
    { name: 'revisions_list', description: 'List saved revisions for a preset.', method: 'GET', path: '/presets/:presetId/revisions', inputSchema: obj({ presetId: str('Preset id.') }, ['presetId']) },
    { name: 'revision_get', description: 'Read one historical preset snapshot.', method: 'GET', path: '/presets/:presetId/revisions/:rev', inputSchema: obj({ presetId: str('Preset id.'), rev: { type: ['integer', 'string'], description: 'Positive revision number.' } }, ['presetId', 'rev']) },
    { name: 'revision_create', description: 'Create a labelled revision of the current preset.', method: 'POST', path: '/presets/:presetId/revisions', inputSchema: obj({ presetId: str('Preset id.'), label: str('Revision label.') }, ['presetId']) },
    { name: 'revision_restore', description: 'Restore a preset revision after preserving current content.', method: 'POST', path: '/presets/:presetId/restore', inputSchema: obj({ presetId: str('Preset id.'), rev: integer('Positive revision number.') }, ['presetId', 'rev']) },
    { name: 'shelf_list', description: 'List saved shelf items.', method: 'GET', path: '/shelf', inputSchema: obj() },
    { name: 'shelf_get', description: 'Read one saved shelf item.', method: 'GET', path: '/shelf/:shelfId', inputSchema: obj({ shelfId: str('Shelf item id.') }, ['shelfId']) },
    { name: 'shelf_add', description: 'Save a source block or supplied block on the shelf.', method: 'POST', path: '/shelf', inputSchema: obj({ fromPresetId: str('Source preset id.'), identifier: str('Source block identifier.'), block: object('Supplied block.'), name: str('Shelf name.'), notes: str('Shelf notes.'), tags: array('Tags.', { type: 'string' }) }) },
    { name: 'shelf_update', description: 'Update shelf item metadata.', method: 'PATCH', path: '/shelf/:shelfId', inputSchema: obj({ shelfId: str('Shelf item id.'), name: str('New name.'), notes: str('New notes.'), tags: array('Tags.', { type: 'string' }) }, ['shelfId']) },
    { name: 'shelf_remove', description: 'Remove one shelf item and return confirmation.', method: 'DELETE', path: '/shelf/:shelfId', inputSchema: obj({ shelfId: str('Shelf item id.') }, ['shelfId']) },
];

/** @param {Response} res @returns {Promise<{status:number,json:any,text:string}>} */
async function responseBody(res) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON response */ }
    return { status: res.status, json, text };
}

/**
 * Create the in-memory SillyTavern session used by the MCP transport.
 * @param {{stUrl:string,user?:string,password?:string,log:(message:string)=>void}} options
 */
export function createSession({ stUrl, user, password, log }) {
    const base = stUrl.replace(/\/+$/, '');
    const jar = new Map();
    let token = null;
    let generation = 0;
    /** @type {Promise<void>|null} */
    let refreshing = null;

    /** @param {Headers} headers */
    function takeCookies(headers) {
        const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
        for (const value of values) {
            const pair = value.split(';', 1)[0];
            const i = pair.indexOf('=');
            if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
        }
    }
    function cookieHeader() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); }
    /** @param {string} url @param {RequestInit} [init] */
    async function send(url, init = {}) {
        const headers = new Headers(init.headers);
        const cookie = cookieHeader();
        if (cookie) headers.set('cookie', cookie);
        const res = await fetch(url, { ...init, headers });
        takeCookies(res.headers);
        return res;
    }
    async function fetchToken() {
        const res = await send(`${base}/csrf-token`);
        const out = await responseBody(res);
        if (out.status < 200 || out.status >= 300 || typeof out.json?.token !== 'string' || !out.json.token) {
            throw new Error(`csrf-token: ${out.status} ${out.json?.error ?? out.text}`.trim());
        }
        token = out.json.token;
    }
    async function doRefresh() {
        await fetchToken();
        if (user) {
            const res = await send(`${base}/api/users/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-csrf-token': /** @type {string} */ (token) },
                body: JSON.stringify({ handle: user, password: password ?? '' }),
            });
            const out = await responseBody(res);
            if (out.status < 200 || out.status >= 300) {
                throw new Error(`login failed: ${out.status} ${out.json?.error ?? out.text}`.trim());
            }
            await fetchToken();
        }
        generation += 1;
    }
    async function refresh() {
        if (!refreshing) {
            refreshing = doRefresh().finally(() => { refreshing = null; });
        }
        return refreshing;
    }
    /** @param {string} method @param {string} pluginPath @param {any} [body] */
    async function request(method, pluginPath, body = undefined) {
        if (!token) await refresh();
        const run = async () => {
            const usedGeneration = generation;
            const headers = new Headers({ 'x-csrf-token': /** @type {string} */ (token) });
            if (body !== undefined) headers.set('content-type', 'application/json');
            const res = await send(`${base}${PLUGIN}${pluginPath}`, {
                method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { out: await responseBody(res), usedGeneration };
        };
        let attempt = await run();
        if (attempt.out.status === 403) {
            if (attempt.usedGeneration === generation) await refresh();
            attempt = await run();
        }
        return attempt.out;
    }
    void log;
    return { refresh, request };
}

/** @param {any} value */
function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject empty URL path arguments and dot segments, including successfully decoded forms. @param {any} value */
function unsafePathArgument(value) {
    if (value === undefined || value === null || value === '') return true;
    let decoded = String(value);
    for (let i = 0; i < 4; i++) {
        if (decoded === '.' || decoded === '..') return true;
        let next;
        try { next = decodeURIComponent(decoded); }
        catch { return false; }
        if (next === decoded) return false;
        decoded = next;
    }
    return decoded === '.' || decoded === '..';
}

/**
 * Create the newline-delimited JSON-RPC transport.
 * @param {{session:{refresh:()=>Promise<void>,request:(method:string,path:string,body?:any)=>Promise<{status:number,json:any,text:string}>},write:(line:string)=>void,log:(message:string)=>void}} options
 */
export function createMcpServer({ session, write, log }) {
    const decoder = new TextDecoder();
    let buffer = '';
    /** @type {Set<Promise<void>>} */
    const pending = new Set();
    const emit = (/** @type {any} */ msg) => write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    const error = (/** @type {any} */ id, /** @type {number} */ code, /** @type {string} */ message) => emit({ id, error: { code, message } });

    /** @param {any} id @param {any} params */
    async function toolCall(id, params) {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return error(id, -32602, `Unknown tool: ${params?.name}`);
        const args = plainObject(params?.arguments) ? params.arguments : {};
        const pathNames = [...tool.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
        for (const name of pathNames) {
            if (unsafePathArgument(args[name])) {
                return error(id, -32602, `Invalid path argument: ${name}`);
            }
        }
        let path = tool.path.replace(/:(\w+)/g, (_m, name) => encodeURIComponent(String(args[name])));
        const search = new URLSearchParams();
        for (const name of tool.query ?? []) {
            if (args[name] !== undefined && args[name] !== null) search.set(name, String(args[name]));
        }
        if (search.size) path += `?${search}`;
        let body;
        if (tool.method !== 'GET' && tool.method !== 'DELETE') {
            if (tool.bodyArg) body = args[tool.bodyArg];
            else {
                body = { ...args };
                for (const name of [...pathNames, ...(tool.query ?? [])]) delete body[name];
            }
        }
        try {
            const out = await session.request(tool.method, path, body);
            if (out.status >= 200 && out.status < 300) {
                emit({ id, result: { content: [{ type: 'text', text: out.json !== null ? JSON.stringify(out.json) : out.text }] } });
            } else {
                const details = plainObject(out.json) ? out.json : { error: out.text };
                emit({ id, result: { content: [{ type: 'text', text: JSON.stringify({ status: out.status, ...details }) }], isError: true } });
            }
        } catch (err) {
            emit({ id, result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } });
        }
    }

    /** @param {any} message */
    async function handle(message) {
        if (!plainObject(message)) return error(null, -32600, 'Invalid Request');
        const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
        if (message.method === undefined && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))) return;
        if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(hasId ? message.id ?? null : null, -32600, 'Invalid Request');
        if (!hasId) return;
        const id = message.id;
        try {
            switch (message.method) {
                case 'initialize':
                    if (!plainObject(message.params) || typeof message.params.protocolVersion !== 'string') {
                        error(id, -32602, 'Invalid initialize params');
                        break;
                    }
                    emit({ id, result: { protocolVersion: message.params.protocolVersion === PROTOCOL_VERSION ? message.params.protocolVersion : PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'st-preset-manager', version: VERSION } } });
                    break;
                case 'ping': emit({ id, result: {} }); break;
                case 'tools/list': emit({ id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } }); break;
                case 'tools/call': await toolCall(id, message.params); break;
                default: error(id, -32601, `Method not found: ${message.method}`);
            }
        } catch (err) {
            log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
            error(id, -32603, err instanceof Error ? err.message : String(err));
        }
    }

    /** @param {string|Buffer} chunk */
    function feed(chunk) {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        for (;;) {
            const i = buffer.indexOf('\n');
            if (i < 0) break;
            const line = buffer.slice(0, i).replace(/\r$/, '');
            buffer = buffer.slice(i + 1);
            if (!line.trim()) continue;
            let message;
            try { message = JSON.parse(line); }
            catch { error(null, -32700, 'Parse error'); continue; }
            const task = handle(message);
            pending.add(task);
            void task.finally(() => pending.delete(task));
        }
    }
    async function idle() {
        while (pending.size) await Promise.all([...pending]);
    }
    return { feed, idle };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const log = (/** @type {string} */ message) => process.stderr.write(`[st-pm-mcp] ${message}\n`);
    const session = createSession({
        stUrl: process.env.ST_URL ?? 'http://127.0.0.1:8002',
        user: process.env.ST_USER,
        password: process.env.ST_PASSWORD,
        log,
    });
    let writes = 0;
    /** @type {(() => void)[]} */
    let writeWaiters = [];
    const write = (/** @type {string} */ line) => {
        writes += 1;
        process.stdout.write(line, () => {
            writes -= 1;
            if (writes === 0) {
                const waiters = writeWaiters;
                writeWaiters = [];
                for (const resolve of waiters) resolve();
            }
        });
    };
    /** @returns {Promise<void>} */
    function writesIdle() {
        if (writes === 0) return Promise.resolve();
        return new Promise((resolve) => writeWaiters.push(resolve));
    }
    const server = createMcpServer({ session, write, log });
    void session.refresh().catch((err) => log(`startup session unavailable: ${err instanceof Error ? err.message : String(err)}`));
    process.stdin.on('data', (chunk) => server.feed(chunk));
    process.stdin.on('end', async () => {
        await server.idle();
        await writesIdle();
        // Every stdout callback has fired, so forced exit cannot truncate a
        // response and cannot be held open by the best-effort startup fetch.
        process.exit(0);
    });
    process.stdin.resume();
}
