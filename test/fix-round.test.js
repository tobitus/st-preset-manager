/**
 * Round 2 fix round: corrupt library files never stop the plugin from
 * booting (upgrade* skip non-object entries, rescan validates and skips,
 * a corrupt models.json loads its valid entries and is backed up, never
 * rewritten at boot); override bits must be booleans; PATCH {parent:null}
 * is a 400; effectiveEnabled's `source` follows the pick-one collapse;
 * multi-key promote/demote across two sequences; resetInherit on a
 * pick-one group whose heading is a pick member; one version string.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDocOp } from '../shared/docops.js';
import { effectiveEnabled } from '../shared/loadouts.js';
import { validateDoc, validateRegistry, upgradeDoc, upgradeRegistry } from '../shared/schema.js';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, deriveStructure } from '../shared/outline.js';
import { buildOutline } from '../ext/outline-model.js';
import { Store, ensureDefaultLoadout } from '../plugin/store.js';
import { registerRoutes } from '../plugin/routes.js';
import { info } from '../plugin/index.js';

const REPO = path.resolve(import.meta.dirname, '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

const B = (/** @type {string} */ id, content = `content ${id}`) => ({ identifier: id, name: id.toUpperCase(), content, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
const IDS = ['a', 'b', 'c', 'o1', 'o2', 'o3'];

/**
 * a, b; pick-one group G {o1,o2,o3}; c.
 * R (root, active): a on, o3 on. P (playstyle of R): b on.
 * @returns {any}
 */
function mkDoc(id = 'p_fix') {
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

const MODEL = () => ({
    id: 'm_m', name: 'M', matches: [], profiles: [], preferredProfile: null,
    tunings: { default: { temperature: 1 } }, defaultTuning: 'default',
});

const status = (/** @type {number} */ n, /** @type {string} */ text = '') => (/** @type {any} */ e) => {
    assert.equal(e?.status, n, `status ${e?.status} (${e?.message})`);
    if (text) assert.ok(String(e.message).includes(text), `message: ${e.message}`);
    return true;
};

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-fix-'));

/** Silence and count console.warn/console.error for one test. */
function quietConsole(/** @type {any} */ t) {
    const warn = t.mock.method(console, 'warn', () => {});
    const error = t.mock.method(console, 'error', () => {});
    return () => warn.mock.callCount() + error.mock.callCount();
}

/**
 * The handler registerRoutes puts on `method path`, plus a runner that
 * resolves with {status, body} or the error passed to next().
 * @param {string} method
 * @param {string} route
 */
function route(method, route) {
    /** @type {{ m: string, p: any, hs: any[] }[]} */
    const routes = [];
    const router = new Proxy({}, { get: (_t, m) => (/** @type {any} */ p, /** @type {any[]} */ ...hs) => { routes.push({ m: String(m), p, hs }); } });
    registerRoutes(/** @type {any} */ (router));
    const found = routes.find((r) => r.m === method && r.p === route);
    assert.ok(found, `no route ${method} ${route}`);
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

// ------------------------------------------------------- upgrade* + validate

test('upgradeDoc skips a null loadout and a null override; validateDoc reports both', () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts).X = null;
    /** @type {any} */ (doc.loadouts.P).overrides = { M: null };
    assert.doesNotThrow(() => upgradeDoc(doc));
    assert.equal(doc.loadouts.X, null);
    assert.equal(doc.loadouts.P.overrides.M, null);
    const errs = validateDoc(doc);
    assert.ok(errs.some((e) => e.startsWith('loadouts.X')), `errs: ${errs}`);
    assert.ok(errs.some((e) => e.startsWith('loadouts.P.overrides.M')), `errs: ${errs}`);
});

test('upgradeDoc still upgrades the object entries next to a null one', () => {
    const doc = mkDoc();
    const old = /** @type {any} */ (doc.loadouts.R);
    delete old.kind;
    delete old.parent;
    old.overrides = { M: { enabled: {} }, N: null };
    /** @type {any} */ (doc).tuningOverrides = { M: { temperature: 1 } };
    upgradeDoc(doc);
    assert.equal(old.kind, 'root');
    assert.equal(old.parent, null);
    assert.equal(old.overrides.M.tuning, null);
    assert.equal(old.overrides.N, null);
    assert.ok(!('tuningOverrides' in doc));
});

test('upgradeRegistry skips a null Model entry; validateRegistry reports it; the old-shape neighbour upgrades', () => {
    const reg = { version: 1, models: {
        A: null,
        C: { id: 'm_c', name: 'C', matches: [], profiles: [], preferredProfile: null, tuning: { temperature: 0.7 } },
    } };
    assert.doesNotThrow(() => upgradeRegistry(reg));
    assert.equal(reg.models.A, null);
    assert.deepEqual(/** @type {any} */ (reg.models.C).tunings, { default: { temperature: 0.7 } });
    const errs = validateRegistry(reg);
    assert.ok(errs.some((e) => e.startsWith('models.A')), `errs: ${errs}`);
    assert.ok(!errs.some((e) => e.startsWith('models.C')), `errs: ${errs}`);
});

test('validateDoc rejects a non-boolean override bit and a non-object override', () => {
    for (const bad of ['yes', 1, null]) {
        const doc = mkDoc();
        /** @type {any} */ (doc.loadouts.R).overrides = { M: { enabled: { a: bad }, tuning: null } };
        assert.ok(validateDoc(doc).includes('loadouts.R.overrides.M.enabled.a'), `value ${JSON.stringify(bad)}: ${validateDoc(doc)}`);
    }
    const ok = mkDoc();
    /** @type {any} */ (ok.loadouts.R).overrides = { M: { enabled: { a: false }, tuning: null } };
    assert.deepEqual(validateDoc(ok), []);
    for (const bad of [null, 'x', []]) {
        const doc = mkDoc();
        /** @type {any} */ (doc.loadouts.R).overrides = { M: bad };
        assert.ok(validateDoc(doc).includes('loadouts.R.overrides.M'), `override ${JSON.stringify(bad)}: ${validateDoc(doc)}`);
    }
});

// ------------------------------------------------------------ rescan / init

/** Write `doc` as a library file under `<root>/presets/`. */
function writeLib(/** @type {string} */ root, /** @type {string} */ file, /** @type {any} */ doc) {
    fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'presets', file), JSON.stringify(doc));
}

/** The three parseable-but-corrupt files the review named, plus one whose rows are garbage. */
function writeCorrupt(/** @type {string} */ root) {
    const nullLoadout = mkDoc('p_bad_loadout');
    /** @type {any} */ (nullLoadout.loadouts).X = null;
    writeLib(root, 'BadLoadout.json', nullLoadout);
    const nullOverride = mkDoc('p_bad_override');
    /** @type {any} */ (nullOverride.loadouts.R).overrides = { M: null };
    writeLib(root, 'BadOverride.json', nullOverride);
    const badBit = mkDoc('p_bad_bit');
    /** @type {any} */ (badBit.loadouts.R).overrides = { M: { enabled: { a: 'on' }, tuning: null } };
    writeLib(root, 'BadBit.json', badBit);
    const badRows = mkDoc('p_bad_rows');
    /** @type {any} */ (badRows.sequences) = [{ character_id: 100001, rows: [null, 7] }];
    writeLib(root, 'BadRows.json', badRows);
}

test('init boots past corrupt library files: they are skipped with a warning, the valid one loads', async (t) => {
    const logged = quietConsole(t);
    const root = tmpRoot();
    writeLib(root, 'Good.json', mkDoc('p_good'));
    writeCorrupt(root);
    const store = new Store(root);
    await store.init();
    assert.deepEqual([...store.index.keys()], ['p_good']);
    assert.ok(logged() >= 4, `warnings logged: ${logged()}`);
    // the skipped files are left on disk as they were
    assert.ok(fs.existsSync(path.join(root, 'presets', 'BadLoadout.json')));
});

test('rescan skips a corrupt file added after boot and keeps serving the rest', async (t) => {
    const logged = quietConsole(t);
    const root = tmpRoot();
    const store = new Store(root);
    await store.init();
    const saved = await store.importPreset({ native: mkDoc('p_ok') });
    writeCorrupt(root);
    await store.rescan();
    assert.deepEqual([...store.index.keys()], [saved.id]);
    assert.ok(logged() >= 4, `warnings logged: ${logged()}`);
});

/** @returns {string[]} backup files of models.json in `root` */
const backups = (/** @type {string} */ root) => fs.readdirSync(root).filter((f) => f.startsWith('models.json.corrupt-'));

test('init with a models.json holding a null Model: valid entries load (old shape upgraded), the file is backed up, never rewritten', async (t) => {
    const logged = quietConsole(t);
    const root = tmpRoot();
    const bytes = JSON.stringify({ version: 1, models: {
        A: null,
        B: { ...MODEL(), id: 'm_b', name: 'B' },
        C: { id: 'm_c', name: 'C', matches: [], profiles: [], preferredProfile: null, tuning: { temperature: 0.7 } },
        D: { id: 'm_d', name: 'WRONG', matches: [], profiles: [], preferredProfile: null, tunings: { default: {} }, defaultTuning: 'default' },
    } });
    fs.writeFileSync(path.join(root, 'models.json'), bytes);
    const store = new Store(root);
    await store.init();
    assert.deepEqual(Object.keys(store.models.models).sort(), ['B', 'C']);
    assert.deepEqual(store.models.models.C.tunings, { default: { temperature: 0.7 } });
    assert.deepEqual(validateRegistry(store.models), []);
    assert.equal(fs.readFileSync(path.join(root, 'models.json'), 'utf8'), bytes);
    const b = backups(root);
    assert.equal(b.length, 1, `backups: ${b}`);
    assert.equal(fs.readFileSync(path.join(root, b[0]), 'utf8'), bytes);
    assert.ok(logged() >= 1);
});

test('init with an unparseable or non-object models.json starts with an empty registry and backs the file up', async (t) => {
    quietConsole(t);
    for (const bytes of ['{not json', 'null', '[]', '{"version":1,"models":null}', '{"version":2,"models":{}}']) {
        const root = tmpRoot();
        fs.writeFileSync(path.join(root, 'models.json'), bytes);
        const store = new Store(root);
        await store.init();
        assert.deepEqual(store.models, { version: 1, models: {} }, `bytes ${bytes}`);
        assert.equal(fs.readFileSync(path.join(root, 'models.json'), 'utf8'), bytes, `bytes ${bytes}`);
        const b = backups(root);
        assert.equal(b.length, 1, `bytes ${bytes}: backups ${b}`);
        assert.equal(fs.readFileSync(path.join(root, b[0]), 'utf8'), bytes);
    }
});

test('init with a valid models.json (and with none) writes no backup', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ version: 1, models: { B: { ...MODEL(), id: 'm_b', name: 'B' } } }));
    const store = new Store(root);
    await store.init();
    assert.deepEqual(Object.keys(store.models.models), ['B']);
    assert.deepEqual(backups(root), []);
    const root2 = tmpRoot();
    await new Store(root2).init();
    assert.deepEqual(backups(root2), []);
});

// ------------------------------------------------------------------ routes

test('PUT /presets/:id with a null loadout, a null override or a non-boolean bit -> 400, doc unchanged', async () => {
    const store = new Store(tmpRoot());
    await store.init();
    const saved = await store.importPreset({ native: mkDoc('p_put') });
    const before = JSON.stringify(store.getPreset(saved.id));
    const put = route('put', '/presets/:id');
    const variants = [
        (/** @type {any} */ d) => { d.loadouts.X = null; },
        (/** @type {any} */ d) => { d.loadouts.R.overrides = { M: null }; },
        (/** @type {any} */ d) => { d.loadouts.R.overrides = { M: { enabled: { a: 1 }, tuning: null } }; },
    ];
    for (const mutate of variants) {
        const body = structuredClone(store.getPreset(saved.id));
        mutate(body);
        const r = /** @type {any} */ (await put({ params: { id: saved.id }, body, pm: pm(store) }));
        const code = r.error ? r.error.status : r.status;
        assert.equal(code, 400, `got ${code} ${r.error?.message ?? JSON.stringify(r.body)}`);
    }
    assert.equal(JSON.stringify(store.getPreset(saved.id)), before);
});

test('PATCH loadout {parent:null} -> 400 on a playstyle and on a root; {kind:"root", parent:null} converts', async () => {
    const store = new Store(tmpRoot());
    await store.init();
    const saved = await store.importPreset({ native: mkDoc('p_patch') });
    const msg = 'parent must be the id of a root loadout';
    await assert.rejects(store.updateLoadout(saved.id, 'P', { parent: null }), status(400, msg));
    await assert.rejects(store.updateLoadout(saved.id, 'R', { parent: null }), status(400, msg));
    await assert.rejects(store.updateLoadout(saved.id, 'P', { name: 'Renamed', parent: null }), status(400, msg));
    assert.equal(store.getPreset(saved.id).loadouts.P.name, 'Play');
    const patch = route('patch', '/presets/:id/loadouts/:lid');
    const r = /** @type {any} */ (await patch({ params: { id: saved.id, lid: 'P' }, body: { parent: null }, pm: pm(store) }));
    assert.equal(r.error?.status ?? r.status, 400);
    assert.equal(store.getPreset(saved.id).loadouts.P.kind, 'playstyle');
    const d = await store.updateLoadout(saved.id, 'P', { kind: 'root', parent: null });
    assert.equal(d.loadouts.P.kind, 'root');
    assert.equal(d.loadouts.P.parent, null);
});

// ------------------------------------------------------- effectiveEnabled

test('effectiveEnabled: an id the pick-one collapse turns OFF takes the source of the member its group kept', () => {
    // P's sparse map names o1 only (no sibling falses): the root's o3 collides
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts.P.enabled).o1 = true;
    const raw = effectiveEnabled(doc, 'P', null, { raw: true });
    assert.deepEqual([raw.enabled.o1, raw.enabled.o3], [true, true]);
    assert.deepEqual([raw.source.o1, raw.source.o3], ['loadout', 'root']);
    const eff = effectiveEnabled(doc, 'P', null);
    assert.deepEqual([eff.enabled.o1, eff.enabled.o2, eff.enabled.o3], [true, false, false]);
    assert.deepEqual([eff.source.o1, eff.source.o2, eff.source.o3], ['loadout', 'root', 'loadout']);
    // untouched ids keep their layer
    assert.deepEqual([eff.source.a, eff.source.b], ['root', 'loadout']);
});

test('effectiveEnabled: an explicit playstyle pick switched off by an override pick is labelled override', () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts.P.enabled).o1 = true;
    /** @type {any} */ (doc.loadouts.P).overrides = { M: { enabled: { o2: true }, tuning: null } };
    const eff = effectiveEnabled(doc, 'P', 'M');
    assert.deepEqual([eff.enabled.o1, eff.enabled.o2, eff.enabled.o3], [false, true, false]);
    assert.deepEqual([eff.source.o1, eff.source.o2, eff.source.o3], ['override', 'override', 'override']);
    // no collapse -> labels exactly as layered
    const plain = effectiveEnabled(mkDoc(), 'P', null);
    assert.deepEqual(plain.source, { a: 'root', b: 'loadout', c: 'root', o1: 'root', o2: 'root', o3: 'root' });
});

test('outline on that collapse edge: raw layered bits, o1 explicit, o3 inherited, conflict flagged', () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts.P.enabled).o1 = true;
    const grp = /** @type {any} */ (buildOutline(doc, 'P').sequences[0].nodes.find((/** @type {any} */ n) => n.type === 'group'));
    const by = Object.fromEntries(grp.options.map((/** @type {any} */ o) => [o.identifier, o]));
    assert.deepEqual([by.o1.enabled, by.o1.explicit, by.o1.inherited], [true, true, false]);
    assert.deepEqual([by.o2.enabled, by.o2.explicit, by.o2.inherited], [false, false, true]);
    assert.deepEqual([by.o3.enabled, by.o3.explicit, by.o3.inherited], [true, false, true]);
    assert.equal(grp.conflict, true);
});

// -------------------------------------------- multi-key across two sequences

const identOf = (/** @type {any} */ l) => l.ref ?? l.identifier;

/** Two sequences (100001: a b c, 100002: x y z), all plain items. */
function twoSeqDoc() {
    const st = {
        prompts: ['a', 'b', 'c', 'x', 'y', 'z'].map((id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system' })),
        prompt_order: [
            { character_id: 100001, order: ['a', 'b', 'c'].map((id) => ({ identifier: id, enabled: true })) },
            { character_id: 100002, order: ['x', 'y', 'z'].map((id) => ({ identifier: id, enabled: true })) },
        ],
    };
    const doc = importStPreset(st, 'Two');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    assert.equal(doc.sequences.length, 2);
    return doc;
}

const keyIn = (/** @type {any} */ doc, /** @type {number} */ s, /** @type {string} */ id) =>
    flattenSeq(doc.sequences[s].rows).find((e) => identOf(e.leaf) === id)?.leaf.key;

test('promote {keys} spanning two sequences equals single promotes in document order', () => {
    const a = twoSeqDoc();
    const b = structuredClone(a);
    const kb = keyIn(a, 0, 'b');
    const ky = keyIn(a, 1, 'y');
    const res = /** @type {any} */ (applyDocOp(a, 'promote', { keys: [ky, kb] }));
    assert.deepEqual(res.keys, [kb, ky]);
    applyDocOp(b, 'promote', { key: kb });
    applyDocOp(b, 'promote', { key: ky });
    assert.deepEqual(a.sequences, b.sequences);
    assert.notDeepEqual(a.sequences, twoSeqDoc().sequences);
});

test('demote {keys} spanning two sequences equals single demotes in document order', () => {
    const a = twoSeqDoc();
    for (const k of [keyIn(a, 0, 'b'), keyIn(a, 1, 'y')]) applyDocOp(a, 'promote', { key: k });
    const b = structuredClone(a);
    const kb = keyIn(a, 0, 'b');
    const ky = keyIn(a, 1, 'y');
    const res = /** @type {any} */ (applyDocOp(a, 'demote', { keys: [ky, kb] }));
    assert.deepEqual(res.keys, [kb, ky]);
    applyDocOp(b, 'demote', { key: kb });
    applyDocOp(b, 'demote', { key: ky });
    assert.deepEqual(a.sequences, b.sequences);
});

test('promote {keys} spanning two sequences is all-or-nothing: an illegal step in the 2nd leaves the 1st untouched', () => {
    const doc = twoSeqDoc();
    // y to the top of the ladder
    for (let i = 0; i < 10; i++) {
        try { applyDocOp(doc, 'promote', { key: keyIn(doc, 1, 'y') }); } catch { break; }
    }
    const snap = structuredClone(doc);
    assert.throws(() => applyDocOp(doc, 'promote', { keys: [keyIn(doc, 0, 'b'), keyIn(doc, 1, 'y')] }), status(400));
    assert.deepEqual(doc, snap);
});

// --------------------------------------- resetInherit with a headed group

/**
 * a; headed pick-one group G {heading g, options o1, o2}. The heading is never
 * a pick-one member; `silentHeading` makes it comment-only.
 */
function headedDoc(silentHeading = false) {
    const doc = mkDoc();
    doc.blocks = { a: B('a'), g: B('g', silentHeading ? '{{// heading note}}{{trim}}' : 'heading text'), o1: B('o1'), o2: B('o2') };
    doc.sequences = [{ character_id: 100001, rows: [
        leaf('a'),
        { kind: 'group', key: 'grp:k-g', name: 'G', cardinality: 'pick-one', guessed: false, header: leaf('g'), options: [leaf('o1'), leaf('o2')] },
    ] }];
    doc.loadouts = {
        R: { id: 'R', name: 'Root', notes: '', kind: 'root', parent: null, enabled: { a: true, g: false, o1: true, o2: false }, overrides: {} },
        P: { id: 'P', name: 'Play', notes: '', kind: 'playstyle', parent: 'R', enabled: { a: false, g: true, o1: false, o2: false }, overrides: {} },
    };
    assert.deepEqual(validateDoc(doc), []);
    return doc;
}

test('resetInherit on a headed pick-one group: from the heading clears only the heading, from an option clears the options', () => {
    const fromG = headedDoc();
    const resG = /** @type {any} */ (applyDocOp(fromG, 'resetInherit', { loadoutId: 'P', identifier: 'g' }));
    assert.deepEqual(resG.removed, ['g']);
    assert.deepEqual(fromG.loadouts.P.enabled, { a: false, o1: false, o2: false });
    assert.deepEqual(effectiveEnabled(fromG, 'P', null).enabled, { a: false, g: false, o1: false, o2: false });
    const fromO = headedDoc();
    const resO = /** @type {any} */ (applyDocOp(fromO, 'resetInherit', { loadoutId: 'P', identifier: 'o1' }));
    assert.deepEqual([...resO.removed].sort(), ['o1', 'o2']);
    assert.deepEqual(fromO.loadouts.P.enabled, { a: false, g: true });
    assert.deepEqual(effectiveEnabled(fromO, 'P', null).enabled, { a: false, g: true, o1: true, o2: false });
});

test('resetInherit with a comment-only heading (not a member) clears only the options', () => {
    const doc = headedDoc(true);
    const res = /** @type {any} */ (applyDocOp(doc, 'resetInherit', { loadoutId: 'P', identifier: 'o2' }));
    assert.deepEqual([...res.removed].sort(), ['o1', 'o2']);
    assert.deepEqual(doc.loadouts.P.enabled, { a: false, g: true });
});

// ------------------------------------------------------------------ version

test('one version: plugin info, /health, manifest.json all equal package.json', async () => {
    assert.equal(info.version, PKG_VERSION);
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, PKG_VERSION);
    const health = route('get', '/health');
    const r = /** @type {any} */ (await health({ pm: pm({ rev: 0, root: '/x' }) }));
    assert.equal(r.body.version, PKG_VERSION);
});
