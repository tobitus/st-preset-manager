/**
 * Round 2 review fixes, second pass. Each test states an invariant:
 * 1. Boot never aborts on a corrupt library file; valid content survives,
 *    the bad file is backed up, never rewritten.
 * 2. Any revision that existed before the upgrade, and the pre-upgrade
 *    state itself, can be restored after the upgrade.
 * 3. No operation (registry replace, tuning delete/rename, undo, redo,
 *    revision restore, save) can leave a document bound to a tuning name
 *    the current registry lacks; the slot always compiles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDoc, validateRegistry, deadTuningBindings } from '../shared/schema.js';
import { deriveStructure } from '../shared/outline.js';
import { compile } from '../shared/compile.js';
import { Store, stripLeafEnabled } from '../plugin/store.js';
import { registerRoutes } from '../plugin/routes.js';
import { createMcpServer } from '../mcp/server.js';

const B = (/** @type {string} */ id, content = `content ${id}`) => ({ identifier: id, name: id.toUpperCase(), content, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
const IDS = ['a', 'b', 'c', 'o1', 'o2', 'o3'];

/** @returns {any} R (root, active) + P (playstyle of R) */
function mkDoc(id = 'p_t') {
    return {
        format: 'st-preset-manager/library', version: 1, id, name: `Fix ${id}`, tags: [], notes: '', source: null,
        settings: {},
        markers: [],
        blocks: Object.fromEntries(IDS.map((i) => [i, B(i)])),
        sequences: [{ character_id: 100001, rows: [
            leaf('a'), leaf('b'),
            { kind: 'group', key: 'grp:k-o1', name: 'G', cardinality: 'pick-one', guessed: false, header: null, options: [leaf('o1'), leaf('o2'), leaf('o3')] },
            leaf('c'),
        ] }],
        loadouts: {
            R: { id: 'R', name: 'Root', notes: '', kind: 'root', parent: null,
                enabled: { a: true, b: false, c: false, o1: false, o2: false, o3: true }, overrides: {} },
            P: { id: 'P', name: 'Play', notes: '', kind: 'playstyle', parent: 'R', enabled: { b: true }, overrides: {} },
        },
        activeLoadoutId: 'R',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1,
    };
}

/**
 * A pre-round-2 document: one kindless loadout, an override without
 * `tuning`, preset-level `tuningOverrides`. Normalized the way rescan
 * normalizes before upgrading, so it equals the store's pre-upgrade state.
 * @returns {any}
 */
function legacyDoc(id = 'p_lo') {
    const d = mkDoc(id);
    delete d.loadouts.P;
    const r = d.loadouts.R;
    delete r.kind;
    delete r.parent;
    r.overrides = { M: { enabled: { a: false } } };
    d.tuningOverrides = { M: { temperature: 0.7 } };
    deriveStructure(d);
    stripLeafEnabled(d);
    return d;
}

const MODEL = () => ({
    id: 'm_m', name: 'M', matches: [], profiles: [], preferredProfile: null,
    tunings: { default: { temperature: 1 }, hot: { temperature: 1.5 } }, defaultTuning: 'default',
});

const status = (/** @type {number} */ n, /** @type {string[]} */ ...texts) => (/** @type {any} */ e) => {
    assert.equal(e?.status, n, `status ${e?.status} (${e?.message})`);
    for (const text of texts) assert.ok(String(e.message).includes(text), `message lacks ${JSON.stringify(text)}: ${e.message}`);
    return true;
};

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-fix2-'));

function quietConsole(/** @type {any} */ t) {
    const warn = t.mock.method(console, 'warn', () => {});
    const error = t.mock.method(console, 'error', () => {});
    return () => warn.mock.callCount() + error.mock.callCount();
}

/** The handler registerRoutes puts on `method path`, run as {status, body} | {error}. */
function route(/** @type {string} */ method, /** @type {string} */ p) {
    /** @type {{ m: string, p: any, hs: any[] }[]} */
    const routes = [];
    const router = new Proxy({}, { get: (_t, m) => (/** @type {any} */ rp, /** @type {any[]} */ ...hs) => { routes.push({ m: String(m), p: rp, hs }); } });
    registerRoutes(/** @type {any} */ (router));
    const found = routes.find((r) => r.m === method && r.p === p);
    assert.ok(found, `no route ${method} ${p}`);
    const handler = /** @type {any} */ (found).hs.at(-1);
    return (/** @type {any} */ req) => new Promise((resolve) => {
        /** @type {any} */
        const res = {
            code: 200,
            status(/** @type {number} */ c) { res.code = c; return res; },
            json(/** @type {any} */ body) { resolve({ status: res.code, body }); return res; },
        };
        Promise.resolve(handler(req, res, (/** @type {any} */ err) => resolve({ error: err }))).catch((err) => resolve({ error: err }));
    });
}

const pm = (/** @type {any} */ store) => ({ store, hub: { clientCount: 0, publish() {}, broadcast() {} } });

/** A store whose registry holds M {default, hot} and one preset `p_t`. */
async function setup() {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ version: 1, models: { M: MODEL() } }));
    const store = new Store(root);
    await store.init();
    const saved = await store.importPreset({ native: mkDoc('p_t') });
    return { root, store, id: saved.id };
}

/** Every loadout of the preset compiles against every Model and against none. */
function assertCompiles(/** @type {Store} */ store, /** @type {string} */ id) {
    const doc = store.getPreset(id);
    for (const lid of Object.keys(doc.loadouts)) {
        assert.doesNotThrow(() => compile(structuredClone(doc), null, {}, lid), `loadout ${lid}, no Model`);
        for (const m of Object.values(store.models.models)) {
            assert.doesNotThrow(() => compile(structuredClone(doc), m, {}, lid), `loadout ${lid}, Model ${m.name}`);
        }
    }
}

const bindHot = (/** @type {Store} */ store, /** @type {string} */ id) => store.setLoadoutOverride(id, 'R', 'M', { enabled: {}, tuning: 'hot' });
const unbind = (/** @type {Store} */ store, /** @type {string} */ id) => store.patchLoadoutOverride(id, 'R', 'M', { tuning: null });

// ------------------------------------------------- 1. primitive Model entries

test('validateRegistry reports (does not throw on) number, string, boolean and array Model entries', () => {
    for (const bad of [7, 'x', true, false, [], null]) {
        const reg = { version: 1, models: { broken: bad, M: MODEL() } };
        /** @type {string[]} */
        let errs = [];
        assert.doesNotThrow(() => { errs = validateRegistry(reg); }, `entry ${JSON.stringify(bad)}`);
        assert.ok(errs.some((e) => e.startsWith('models.broken')), `entry ${JSON.stringify(bad)}: ${errs}`);
        assert.ok(!errs.some((e) => e.startsWith('models.M')), `entry ${JSON.stringify(bad)}: ${errs}`);
    }
});

test('deadTuningBindings lists non-null bindings whose (registered) Model lacks the tuning; skips absent Models, null and malformed entries', () => {
    const reg = { version: 1, models: { M: MODEL() } };
    const doc = mkDoc();
    doc.loadouts.R.overrides = {
        M: { enabled: {}, tuning: 'hot' }, // live
        Gone: { enabled: {}, tuning: 'x' }, // Model absent -> inert (compile never reads it), not dead
        Free: { enabled: {}, tuning: null }, // no binding
        Bad: null, // malformed: skipped
    };
    doc.loadouts.P.overrides = { M: { enabled: {}, tuning: 'ghost' } }; // tuning absent -> dead
    /** @type {any} */ (doc.loadouts).Junk = 7; // malformed: skipped
    assert.deepEqual(deadTuningBindings(doc, reg), [
        { loadoutId: 'P', loadoutName: 'Play', model: 'M', tuning: 'ghost' },
    ]);
    assert.deepEqual(deadTuningBindings(mkDoc(), reg), []);
    assert.deepEqual(deadTuningBindings({}, reg), []);
    // inherited prototype keys are not tunings
    const proto = mkDoc();
    proto.loadouts.R.overrides = { M: { enabled: {}, tuning: 'toString' } };
    assert.deepEqual(deadTuningBindings(proto, reg), [{ loadoutId: 'R', loadoutName: 'Root', model: 'M', tuning: 'toString' }]);
});

test('init with primitive/array Model entries boots: valid Models load, the file is backed up and never rewritten', async (t) => {
    const logged = quietConsole(t);
    const root = tmpRoot();
    const bytes = JSON.stringify({ version: 1, models: { n: 7, s: 'x', b: true, arr: [], nul: null, M: MODEL() } });
    fs.writeFileSync(path.join(root, 'models.json'), bytes);
    const store = new Store(root);
    await store.init();
    assert.deepEqual(Object.keys(store.models.models), ['M']);
    assert.deepEqual(validateRegistry(store.models), []);
    assert.equal(fs.readFileSync(path.join(root, 'models.json'), 'utf8'), bytes);
    const b = fs.readdirSync(root).filter((f) => f.startsWith('models.json.corrupt-'));
    assert.equal(b.length, 1, `backups: ${b}`);
    assert.equal(fs.readFileSync(path.join(root, b[0]), 'utf8'), bytes);
    assert.ok(logged() >= 1);
});

// ---------------------------------------- 2. restore legacy-shape revisions

test('restoring a revision written before the upgrade (legacy shape) succeeds and yields an upgraded doc; the stored snapshot is untouched', async () => {
    const root = tmpRoot();
    const store = new Store(root);
    await store.init();
    const saved = await store.importPreset({ native: mkDoc('p_r') });
    const legacy = legacyDoc('p_r');
    const dir = path.join(root, 'revisions', 'p_r');
    fs.mkdirSync(dir, { recursive: true });
    const revFile = path.join(dir, '1.json');
    const revBytes = JSON.stringify({ rev: 1, at: '2025-01-01T00:00:00.000Z', label: null, doc: legacy }, null, 2);
    fs.writeFileSync(revFile, revBytes);

    const out = await store.restoreRevision(saved.id, 1);
    assert.deepEqual(validateDoc(out.doc), []);
    assert.equal(out.doc.loadouts.R.kind, 'root');
    assert.equal(out.doc.loadouts.R.parent, null);
    assert.equal(out.doc.loadouts.R.overrides.M.tuning, null);
    assert.deepEqual(out.doc.loadouts.R.overrides.M.enabled, { a: false });
    assert.ok(!('tuningOverrides' in out.doc));
    assert.equal(out.doc.loadouts.P, undefined);
    assert.equal(fs.readFileSync(revFile, 'utf8'), revBytes, 'stored snapshot unchanged');
    assert.deepEqual(store.getPreset(saved.id).loadouts.R.kind, 'root');
});

test('the first-save pre-upgrade backup revision restores, yielding the upgraded doc', async () => {
    const root = tmpRoot();
    const legacy = legacyDoc();
    fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'presets', 'LO.json'), JSON.stringify(legacy, null, 2));
    const store = new Store(root);
    await store.init();
    const doc = store.getPreset('p_lo');
    doc.notes = 'edited';
    await store.savePreset(doc);
    const backup = store.listRevisions('p_lo').map((r) => store.getRevision('p_lo', r.rev)).find((s) => JSON.stringify(s.doc) === JSON.stringify(legacy));
    assert.ok(backup, 'a revision equal to the pre-upgrade state exists');

    const out = await store.restoreRevision('p_lo', backup.rev);
    assert.deepEqual(validateDoc(out.doc), []);
    assert.equal(out.doc.notes, '');
    assert.equal(out.doc.loadouts.R.kind, 'root');
    assert.equal(out.doc.loadouts.R.overrides.M.tuning, null);
    assert.ok(!('tuningOverrides' in out.doc));
});

// ------------------------------- 3. the pre-upgrade snapshot is never coalesced

/** A legacy file on disk plus a recent unlabelled revision that differs from it. */
function legacyWithRecentRevision() {
    const root = tmpRoot();
    const legacy = legacyDoc();
    fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'presets', 'LO.json'), JSON.stringify(legacy, null, 2));
    const older = structuredClone(legacy);
    older.notes = 'older content';
    const dir = path.join(root, 'revisions', 'p_lo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ rev: 1, at: new Date().toISOString(), label: null, doc: older }, null, 2));
    return { root, legacy };
}

/** @returns {any} the labelled revision equal to `legacy` */
function legacyRevision(/** @type {Store} */ store, /** @type {any} */ legacy) {
    const snaps = store.listRevisions('p_lo').map((r) => store.getRevision('p_lo', r.rev));
    const hit = snaps.find((s) => JSON.stringify(s.doc) === JSON.stringify(legacy));
    assert.ok(hit, `no revision equals the pre-upgrade file; revisions: ${snaps.map((s) => `#${s.rev} ${s.label}`).join(', ')}`);
    assert.equal(typeof hit.label, 'string', 'the pre-upgrade revision is labelled (never a coalescing target)');
    return hit;
}

test('first save of a legacy doc writes the exact pre-upgrade state as a labelled revision even after a recent unlabelled one', async () => {
    const { root, legacy } = legacyWithRecentRevision();
    const store = new Store(root);
    await store.init();
    const doc = store.getPreset('p_lo');
    doc.notes = 'edited';
    await store.savePreset(doc);
    legacyRevision(store, legacy);
    // later saves coalesce as usual and never overwrite it
    const again = store.getPreset('p_lo');
    again.notes = 'edited twice';
    await store.savePreset(again);
    legacyRevision(store, legacy);
});

test('first commit (copyBlock) of a legacy doc writes the exact pre-upgrade state as a labelled revision even after a recent unlabelled one', async () => {
    const { root, legacy } = legacyWithRecentRevision();
    const store = new Store(root);
    await store.init();
    const src = await store.importPreset({ native: mkDoc('p_src') });
    await store.copyBlock('p_lo', { fromPresetId: src.id, identifier: 'a' });
    legacyRevision(store, legacy);
});

// --------------------------- 4. registry replace vs existing tuning bindings

test('replaceModels refuses (409) a registry that removes or renames a bound tuning; nothing changes', async () => {
    const { root, store, id } = await setup();
    await bindHot(store, id);
    const before = fs.readFileSync(path.join(root, 'models.json'), 'utf8');
    const withTunings = (/** @type {any} */ tunings) => ({ version: 1, models: { M: { ...MODEL(), tunings } } });
    for (const reg of [
        withTunings({ default: {} }), // removed
        withTunings({ default: {}, spicy: { temperature: 1.5 } }), // renamed
    ]) {
        await assert.rejects(store.replaceModels(reg), status(409, 'Fix p_t', 'Root', 'M', 'hot'), JSON.stringify(reg));
        assert.deepEqual(Object.keys(store.models.models.M.tunings), ['default', 'hot']);
        assert.equal(fs.readFileSync(path.join(root, 'models.json'), 'utf8'), before);
    }
    // keeping the bound tuning is fine
    await store.replaceModels(withTunings({ default: {}, hot: { temperature: 2 }, extra: {} }));
    assert.deepEqual(store.models.models.M.tunings.hot, { temperature: 2 });
    assertCompiles(store, id);
    // dropping the whole Model leaves the override inert (compile never reads it) ...
    await store.replaceModels({ version: 1, models: {} });
    assertCompiles(store, id);
    // ... but bringing the Model back without the bound tuning is refused
    await assert.rejects(store.replaceModels(withTunings({ default: {} })), status(409, 'Fix p_t', 'Root', 'M', 'hot'));
    assert.deepEqual(store.models.models, {});
});

test('PUT /models answers 409 naming the binding; models_replace over MCP surfaces the same 409', async () => {
    const { store, id } = await setup();
    await bindHot(store, id);
    const reg = { version: 1, models: { M: { ...MODEL(), tunings: { default: {} } } } };
    const put = route('put', '/models');
    const r = /** @type {any} */ (await put({ body: structuredClone(reg), pm: pm(store) }));
    assert.equal(r.error?.status ?? r.status, 409, `got ${r.error?.message ?? JSON.stringify(r.body)}`);
    for (const text of ['Fix p_t', 'Root', 'M', 'hot']) assert.ok(r.error.message.includes(text), r.error.message);

    // MCP: models_replace -> PUT /models on the real route + store
    /** @type {string[]} */
    const out = [];
    const session = {
        refresh: async () => {},
        request: async (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body) => {
            assert.equal(method, 'PUT');
            assert.equal(p, '/models');
            const res = /** @type {any} */ (await route('put', '/models')({ body, pm: pm(store) }));
            const json = res.error ? { error: res.error.message } : res.body;
            const code = res.error ? (res.error.status ?? 500) : res.status;
            return { status: code, json, text: JSON.stringify(json) };
        },
    };
    const server = createMcpServer({ session, write: (/** @type {string} */ s) => out.push(s), log: () => {} });
    server.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'models_replace', arguments: { registry: reg } } })}\n`);
    await server.idle();
    const m = JSON.parse(out.join('').split('\n').filter(Boolean)[0]);
    assert.equal(m.result.isError, true);
    const payload = JSON.parse(m.result.content[0].text);
    assert.equal(payload.status, 409);
    assert.ok(payload.error.includes('hot'), payload.error);
    assert.ok('hot' in store.models.models.M.tunings);
    assertCompiles(store, id);
});

// ------------------- 5. history cannot republish a deleted/renamed binding

test('delete a tuning bound only in undo history: undo cannot republish it (409), the slot compiles', async () => {
    const { store, id } = await setup();
    await bindHot(store, id);
    await unbind(store, id);
    await store.deleteModelTuning('M', 'hot');
    await assert.rejects(store.undo(id), status(409));
    assert.equal(store.getPreset(id).loadouts.R.overrides.M.tuning, null);
    assertCompiles(store, id);
});

test('delete a tuning bound only in redo history: redo cannot republish it (409), the slot compiles', async () => {
    const { store, id } = await setup();
    await bindHot(store, id);
    await store.undo(id); // redo now holds the hot binding
    await store.deleteModelTuning('M', 'hot');
    await assert.rejects(store.redo(id), status(409));
    assertCompiles(store, id);
});

test('rename a tuning bound only in history: undo/redo bring back the RENAMED binding, the slot compiles', async () => {
    const { store, id } = await setup();
    await bindHot(store, id);
    await unbind(store, id);
    await store.renameModelTuning('M', 'hot', 'spicy');
    const undone = await store.undo(id);
    assert.equal(undone.doc.loadouts.R.overrides.M.tuning, 'spicy');
    assertCompiles(store, id);
    const redone = await store.redo(id);
    assert.equal(redone.doc.loadouts.R.overrides.M.tuning, null);
    assertCompiles(store, id);
});

test('a registry replace that drops a tuning bound only in history: undo cannot republish it, the slot compiles', async () => {
    const { store, id } = await setup();
    await bindHot(store, id);
    await unbind(store, id);
    await store.replaceModels({ version: 1, models: { M: { ...MODEL(), tunings: { default: {} } } } });
    await assert.rejects(store.undo(id), status(409));
    assertCompiles(store, id);
});

test('restoring a revision bound to a since-deleted tuning is refused (409) naming it; the doc is unchanged and compiles', async () => {
    const { store, id } = await setup();
    await bindHot(store, id);
    const { rev } = await store.snapshotRevision(id, 'with hot');
    await unbind(store, id);
    await store.deleteModelTuning('M', 'hot');
    const before = JSON.stringify(store.getPreset(id));
    await assert.rejects(store.restoreRevision(id, rev), status(409, 'Root', 'M', 'hot'));
    assert.equal(JSON.stringify(store.getPreset(id)), before);
    assertCompiles(store, id);
});

test('restoring a revision bound to a since-renamed tuning is refused (409) naming it; the doc is unchanged and compiles', async () => {
    const { store, id } = await setup();
    await bindHot(store, id);
    const { rev } = await store.snapshotRevision(id, 'with hot');
    await unbind(store, id);
    await store.renameModelTuning('M', 'hot', 'spicy');
    const before = JSON.stringify(store.getPreset(id));
    await assert.rejects(store.restoreRevision(id, rev), status(409, 'Root', 'M', 'hot'));
    assert.equal(JSON.stringify(store.getPreset(id)), before);
    assertCompiles(store, id);
});

test('saving a doc that binds a tuning the registry lacks is refused (409)', async () => {
    const { store, id } = await setup();
    const doc = store.getPreset(id);
    doc.loadouts.R.overrides = { M: { enabled: {}, tuning: 'ghost' } };
    await assert.rejects(store.savePreset(doc), status(409, 'Root', 'M', 'ghost'));
    assertCompiles(store, id);
});

test('a dead binding already on disk does not block unrelated saves or registry writes', async (t) => {
    quietConsole(t);
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ version: 1, models: { M: MODEL() } }));
    const stale = mkDoc('p_stale');
    stale.loadouts.R.overrides = { M: { enabled: {}, tuning: 'ghost' } };
    fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'presets', 'Stale.json'), JSON.stringify(stale, null, 2));
    const store = new Store(root);
    await store.init();
    const doc = store.getPreset('p_stale');
    doc.notes = 'unrelated edit';
    await store.savePreset(doc);
    await store.setModelTuning('M', 'extra', { temperature: 0.3 });
    assert.ok('extra' in store.models.models.M.tunings);
    // and unbinding the dead tuning makes it compile
    await store.patchLoadoutOverride('p_stale', 'R', 'M', { tuning: null });
    assertCompiles(store, 'p_stale');
});

test('restoring a revision is refused (409) on ANY dead binding, even one already dead on disk: making a dead inactive loadout active cannot break the slot', async (t) => {
    quietConsole(t);
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ version: 1, models: { M: MODEL() } }));
    const stale = mkDoc('p_stale');
    stale.loadouts.P.overrides = { M: { enabled: {}, tuning: 'ghost' } }; // inactive loadout, dead binding
    fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
    const file = path.join(root, 'presets', 'Stale.json');
    fs.writeFileSync(file, JSON.stringify(stale, null, 2));
    const revived = structuredClone(stale);
    revived.activeLoadoutId = 'P';
    const dir = path.join(root, 'revisions', 'p_stale');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ rev: 1, at: '2025-01-01T00:00:00.000Z', label: null, doc: revived }, null, 2));
    const store = new Store(root);
    await store.init();
    const diskBefore = fs.readFileSync(file, 'utf8');
    const docBefore = JSON.stringify(store.getPreset('p_stale'));
    await assert.rejects(store.restoreRevision('p_stale', 1), status(409, 'Play', 'M', 'ghost'));
    assert.equal(fs.readFileSync(file, 'utf8'), diskBefore);
    assert.equal(JSON.stringify(store.getPreset('p_stale')), docBefore);
    assert.deepEqual(store.listRevisions('p_stale').map((r) => r.rev), [1], 'no pre-restore revision written');
    const doc = store.getPreset('p_stale');
    assert.equal(doc.activeLoadoutId, 'R');
    assert.doesNotThrow(() => compile(doc, store.models.models.M, {}, doc.activeLoadoutId));
});
