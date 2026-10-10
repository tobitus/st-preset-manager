/**
 * Round 2 B1: inheriting loadouts (root -> playstyle -> per-Model override)
 * and named per-Model tunings. Resolution + sources (shared/loadouts.js),
 * schema invariants, old-document / old-registry conversion (upgradeDoc,
 * upgradeRegistry), compile tuning precedence, the explicit-beats-inherited
 * pick-one rule, compare over the effective map, Model seed/merge shapes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveEnabled, inheritResetKeys } from '../shared/loadouts.js';
import { validateDoc, validateRegistry, upgradeDoc, upgradeRegistry } from '../shared/schema.js';
import { compile, exportSt, CompileError } from '../shared/compile.js';
import { comparePresets } from '../shared/compare.js';
import { seedFromProfiles, mergeModels } from '../shared/models.js';
import { Store } from '../plugin/store.js';

const B = (/** @type {string} */ id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
const IDS = ['a', 'b', 'c', 'o1', 'o2', 'o3'];

/**
 * a, b, c, then a headerless pick-one group {o1,o2,o3}.
 * R (root, active): a on, o3 on. P (playstyle of R): b on explicitly.
 * P × M override: a off.
 */
/** @returns {any} */
function mkDoc() {
    return {
        format: 'st-preset-manager/library', version: 1, id: 'p_lo', name: 'LO', tags: [], notes: '', source: null,
        settings: {},
        markers: [],
        blocks: Object.fromEntries(IDS.map((id) => [id, B(id)])),
        sequences: [{ character_id: 100001, rows: [
            leaf('a'), leaf('b'), leaf('c'),
            { kind: 'group', key: 'grp:k-o1', name: 'G', cardinality: 'pick-one', guessed: false, header: null, options: [leaf('o1'), leaf('o2'), leaf('o3')] },
        ] }],
        loadouts: {
            R: { id: 'R', name: 'Root', notes: '', kind: 'root', parent: null,
                enabled: { a: true, b: false, c: false, o1: false, o2: false, o3: true }, overrides: {} },
            P: { id: 'P', name: 'Play', notes: '', kind: 'playstyle', parent: 'R',
                enabled: { b: true }, overrides: { M: { enabled: { a: false }, tuning: null } } },
        },
        activeLoadoutId: 'R',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1,
    };
}

const MODEL = () => ({
    id: 'm_m', name: 'M', matches: [], profiles: [], preferredProfile: null,
    tunings: { default: { temperature: 1 }, hot: { temperature: 1.5 } }, defaultTuning: 'default',
});

const onIn = (/** @type {any} */ compiled, /** @type {string} */ id) =>
    compiled.prompt_order[0].order.find((/** @type {any} */ o) => o.identifier === id).enabled;

// ------------------------------------------------------------ resolution

test('effectiveEnabled: null Model = root ⊕ playstyle, with sources', () => {
    const { enabled, source } = effectiveEnabled(mkDoc(), 'P', null);
    assert.equal(enabled.a, true);
    assert.equal(enabled.b, true);
    assert.equal(enabled.c, false);
    assert.equal(source.a, 'root');
    assert.equal(source.b, 'loadout');
    assert.equal(source.c, 'root');
});

test('effectiveEnabled: Model M = root ⊕ playstyle ⊕ override', () => {
    const { enabled, source } = effectiveEnabled(mkDoc(), 'P', 'M');
    assert.deepEqual({ a: enabled.a, b: enabled.b, c: enabled.c }, { a: false, b: true, c: false });
    assert.equal(source.a, 'override');
    assert.equal(source.b, 'loadout');
});

test('effectiveEnabled: a root applies its own overrides; a playstyle never sees its parent\'s', () => {
    const doc = mkDoc();
    doc.loadouts.R.overrides = { M: { enabled: { c: true }, tuning: null } };
    const r = effectiveEnabled(doc, 'R', 'M');
    assert.equal(r.enabled.c, true);
    assert.equal(r.source.c, 'override');
    assert.equal(effectiveEnabled(doc, 'R', null).enabled.c, false);
    const p = effectiveEnabled(doc, 'P', 'M');
    assert.equal(p.enabled.c, false, 'the parent root\'s override leaked into the playstyle');
    assert.equal(p.source.c, 'root');
});

test('effectiveEnabled: missing loadout or missing/non-root parent throws', () => {
    const doc = mkDoc();
    assert.throws(() => effectiveEnabled(doc, 'nope', null));
    doc.loadouts.P.parent = 'gone';
    assert.throws(() => effectiveEnabled(doc, 'P', null));
    const d2 = mkDoc();
    /** @type {any} */ (d2.loadouts).Q = { id: 'Q', name: 'Q', notes: '', kind: 'playstyle', parent: 'P', enabled: {}, overrides: {} };
    assert.throws(() => effectiveEnabled(d2, 'Q', null), 'a playstyle parent must be a root');
});

test('pick-one: an explicit playstyle choice beats the inherited one (even when outline-earlier)', () => {
    const doc = mkDoc();
    // R has o3 on (outline-last); P explicitly picks o1 without writing siblings
    doc.loadouts.P.enabled = { o1: true };
    const { enabled, source } = effectiveEnabled(doc, 'P', null);
    assert.deepEqual([enabled.o1, enabled.o2, enabled.o3], [true, false, false]);
    assert.equal(source.o1, 'loadout');
    const out = compile(doc, null, {}, 'P').compiled;
    assert.deepEqual(['o1', 'o2', 'o3'].map((id) => onIn(out, id)), [true, false, false]);
});

test('pick-one: P writes o2 on (completeOverride form) over R\'s o1 -> o2 on, o1 off; compile never emits two on', () => {
    const doc = mkDoc();
    doc.loadouts.R.enabled.o3 = false;
    doc.loadouts.R.enabled.o1 = true;
    doc.loadouts.P.enabled = { o1: false, o2: true, o3: false };
    const { enabled } = effectiveEnabled(doc, 'P', null);
    assert.deepEqual([enabled.o1, enabled.o2, enabled.o3], [false, true, false]);
    for (const lid of ['R', 'P']) {
        for (const m of [null, MODEL()]) {
            const out = compile(doc, m, {}, lid).compiled;
            assert.ok(['o1', 'o2', 'o3'].filter((id) => onIn(out, id)).length <= 1, `${lid}/${m?.name}: two on`);
        }
    }
});

test('pick-one: an explicit override choice beats the root\'s inherited one', () => {
    const doc = mkDoc();
    doc.loadouts.R.overrides = { M: { enabled: { o1: true }, tuning: null } };
    const { enabled } = effectiveEnabled(doc, 'R', 'M');
    assert.deepEqual([enabled.o1, enabled.o2, enabled.o3], [true, false, false]);
});

test('inheritResetKeys: a pick-one member resets its whole group; a plain block resets itself', () => {
    const doc = mkDoc();
    assert.deepEqual([...inheritResetKeys(doc, 'o2')].sort(), ['o1', 'o2', 'o3']);
    assert.deepEqual(inheritResetKeys(doc, 'a'), ['a']);
});

// ------------------------------------------------------------ validation

test('validateDoc: the fixture is valid', () => {
    assert.deepEqual(validateDoc(mkDoc()), []);
});

test('validateDoc: no chaining — a playstyle parented to a playstyle fails', () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts).Q = { id: 'Q', name: 'Q', notes: '', kind: 'playstyle', parent: 'P', enabled: {}, overrides: {} };
    assert.ok(validateDoc(doc).includes('loadouts.Q.parent (parent must be a root)'), JSON.stringify(validateDoc(doc)));
});

test('validateDoc: playstyle parent missing; root with a parent; bad kind', () => {
    const d1 = mkDoc();
    d1.loadouts.P.parent = 'gone';
    assert.ok(validateDoc(d1).includes('loadouts.P.parent'), JSON.stringify(validateDoc(d1)));
    const d2 = mkDoc();
    /** @type {any} */ (d2.loadouts.R).parent = 'P';
    assert.ok(validateDoc(d2).includes('loadouts.R.parent'), JSON.stringify(validateDoc(d2)));
    const d3 = mkDoc();
    /** @type {any} */ (d3.loadouts.R).kind = 'branch';
    assert.ok(validateDoc(d3).includes('loadouts.R.kind'), JSON.stringify(validateDoc(d3)));
});

test('validateDoc: every root covers every leaf (not only the active one)', () => {
    const doc = mkDoc();
    doc.activeLoadoutId = 'P';
    delete (/** @type {any} */ (doc.loadouts.R.enabled)).c;
    assert.ok(validateDoc(doc).includes('loadouts.R.enabled.c (missing leaf)'), JSON.stringify(validateDoc(doc)));
});

test('validateDoc: a playstyle may be sparse but only names known leaves; so do overrides', () => {
    const doc = mkDoc();
    assert.deepEqual(validateDoc(doc), [], 'sparse playstyle is valid');
    /** @type {any} */ (doc.loadouts.P.enabled).zz = true;
    /** @type {any} */ (doc.loadouts.P.overrides.M.enabled).yy = false;
    const errs = validateDoc(doc);
    assert.ok(errs.includes('loadouts.P.enabled.zz (unknown leaf)'), JSON.stringify(errs));
    assert.ok(errs.includes('loadouts.P.overrides.M.enabled.yy (unknown leaf)'), JSON.stringify(errs));
});

test('validateDoc: a document with zero roots fails', () => {
    const doc = mkDoc();
    doc.loadouts = /** @type {any} */ ({ P: { ...doc.loadouts.P, parent: 'X' } });
    doc.activeLoadoutId = 'P';
    assert.ok(validateDoc(doc).includes('loadouts (no root loadout)'), JSON.stringify(validateDoc(doc)));
});

test('validateDoc: override tuning is null or a non-empty string (and present)', () => {
    for (const bad of ['', 5, undefined]) {
        const doc = mkDoc();
        /** @type {any} */ (doc.loadouts.P.overrides.M).tuning = bad;
        if (bad === undefined) delete (/** @type {any} */ (doc.loadouts.P.overrides.M)).tuning;
        assert.ok(validateDoc(doc).includes('loadouts.P.overrides.M.tuning'), `${String(bad)}: ${JSON.stringify(validateDoc(doc))}`);
    }
    const ok = mkDoc();
    /** @type {any} */ (ok.loadouts.P.overrides.M).tuning = 'hot';
    assert.deepEqual(validateDoc(ok), []);
});

test('validateDoc: tuningOverrides present fails', () => {
    const doc = /** @type {any} */ (mkDoc());
    doc.tuningOverrides = {};
    assert.ok(validateDoc(doc).includes('tuningOverrides (removed)'));
});

// ------------------------------------------------------------ conversion

/** A 2c12a40-format document: no kind/parent, active loadout complete, a sparse second loadout, tuningOverrides. */
function oldDoc() {
    const doc = /** @type {any} */ (mkDoc());
    doc.loadouts = {
        L1: { id: 'L1', name: 'Current', notes: '', enabled: { a: true, b: false, c: true, o1: false, o2: true, o3: false },
            overrides: { M: { enabled: { a: false } } } },
        L2: { id: 'L2', name: 'Other', notes: '', enabled: { a: false, b: true }, overrides: {} },
    };
    doc.activeLoadoutId = 'L1';
    doc.tuningOverrides = { M: { temperature: 0.7 } };
    return doc;
}

test('upgradeDoc: old shape loads, validates, every loadout is a root, compile is unchanged for a null Model', () => {
    const before = oldDoc();
    const pre = compile(structuredClone(before), null, {}).compiled.prompt_order;
    const doc = oldDoc();
    const ret = upgradeDoc(doc);
    assert.equal(ret, doc, 'upgradeDoc mutates and returns the same object');
    assert.deepEqual(validateDoc(doc), []);
    for (const lid of ['L1', 'L2']) {
        assert.equal(doc.loadouts[lid].kind, 'root');
        assert.equal(doc.loadouts[lid].parent, null);
    }
    assert.equal(doc.loadouts.L2.enabled.c, false, 'ensureAllLeaves fills missing leaves with false');
    assert.equal(doc.loadouts.L1.overrides.M.tuning, null);
    assert.deepEqual(doc.loadouts.L1.overrides.M.enabled, { a: false });
    assert.ok(!('tuningOverrides' in doc));
    const post = compile(doc, null, {}).compiled.prompt_order;
    assert.equal(JSON.stringify(post), JSON.stringify(pre), 'prompt_order byte-identical');
    assert.equal(JSON.stringify(compile(doc, null, {}, 'L2').compiled.prompt_order),
        JSON.stringify(compile(oldDoc(), null, {}, 'L2').compiled.prompt_order), 'non-active loadout compile unchanged');
});

test('upgradeDoc: idempotent; a new-shape doc is untouched', () => {
    const once = upgradeDoc(oldDoc());
    const twice = upgradeDoc(structuredClone(once));
    assert.deepEqual(twice, once);
    const fresh = mkDoc();
    assert.deepEqual(upgradeDoc(structuredClone(fresh)), fresh);
});

test('upgradeRegistry: tuning -> tunings{default}, defaultTuning; idempotent; valid', () => {
    const reg = { version: 1, models: {
        M: { id: 'm_m', name: 'M', matches: [], profiles: [], preferredProfile: null, tuning: { temperature: 1 } },
        N: { id: 'm_n', name: 'N', matches: [], profiles: [], preferredProfile: null },
    } };
    const ret = upgradeRegistry(reg);
    assert.equal(ret, reg);
    const m = /** @type {any} */ (reg.models.M);
    assert.deepEqual(m.tunings, { default: { temperature: 1 } });
    assert.equal(m.defaultTuning, 'default');
    assert.ok(!('tuning' in m));
    assert.deepEqual(/** @type {any} */ (reg.models.N).tunings, { default: {} });
    assert.deepEqual(validateRegistry(reg), []);
    assert.deepEqual(upgradeRegistry(structuredClone(reg)), reg);
});

test('validateRegistry: tunings shape, defaultTuning, removed tuning', () => {
    const reg = () => ({ version: 1, models: { M: MODEL() } });
    assert.deepEqual(validateRegistry(reg()), []);
    const r1 = /** @type {any} */ (reg());
    r1.models.M.tuning = {};
    assert.ok(validateRegistry(r1).includes('models.M.tuning (removed)'), JSON.stringify(validateRegistry(r1)));
    const r2 = /** @type {any} */ (reg());
    r2.models.M.defaultTuning = 'nope';
    assert.ok(validateRegistry(r2).includes('models.M.defaultTuning'));
    const r3 = /** @type {any} */ (reg());
    r3.models.M.tunings = {};
    assert.ok(validateRegistry(r3).includes('models.M.tunings'));
    const r4 = /** @type {any} */ (reg());
    r4.models.M.tunings.hot.foo = 1;
    assert.ok(validateRegistry(r4).includes('models.M.tunings.hot.foo'), JSON.stringify(validateRegistry(r4)));
});

test('store: an old-format file upgrades on load; the first save keeps the old bytes in a revision; old models.json upgrades on init', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-b1-'));
    fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'presets', 'LO.json'), JSON.stringify(oldDoc(), null, 2));
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ version: 1, models: {
        M: { id: 'm_m', name: 'M', matches: [], profiles: [], preferredProfile: null, tuning: { temperature: 0.4 } },
    } }));
    const store = new Store(root);
    await store.init();
    assert.deepEqual(store.models.models.M.tunings, { default: { temperature: 0.4 } });
    assert.equal(store.models.models.M.defaultTuning, 'default');
    const doc = store.getPreset('p_lo');
    assert.ok(!('tuningOverrides' in doc));
    assert.equal(doc.loadouts.L1.kind, 'root');
    doc.notes = 'edited';
    await store.savePreset(doc);
    const revs = store.listRevisions('p_lo');
    assert.ok(revs.length >= 1);
    const snap = store.getRevision('p_lo', revs[0].rev);
    assert.deepEqual(snap.doc.tuningOverrides, { M: { temperature: 0.7 } });
});

test('store: a fresh import has exactly one valid root loadout', async () => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-b1-')));
    await store.init();
    const doc = await store.importPreset({ name: 'Fresh', st: {
        prompts: [{ identifier: 'a', name: 'A', content: 'x', role: 'system', enabled: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
    } });
    const ls = Object.values(doc.loadouts);
    assert.equal(ls.length, 1);
    assert.equal(/** @type {any} */ (ls[0]).kind, 'root');
    assert.equal(/** @type {any} */ (ls[0]).parent, null);
    assert.ok(!('tuningOverrides' in doc));
    assert.deepEqual(validateDoc(doc), []);
});

// ------------------------------------------------------------ compile

test('compile: Model tuning = override\'s named tuning, else the Model default', () => {
    const doc = mkDoc();
    assert.equal(compile(doc, MODEL(), {}, 'R').compiled.temperature, 1, 'no override -> default');
    assert.equal(compile(doc, MODEL(), {}, 'P').compiled.temperature, 1, 'override tuning null -> default');
    doc.loadouts.P.overrides.M.tuning = /** @type {any} */ ('hot');
    assert.equal(compile(doc, MODEL(), {}, 'P').compiled.temperature, 1.5);
    assert.equal(compile(doc, MODEL(), {}, 'R').compiled.temperature, 1, 'P\'s binding does not leak into R');
    assert.equal(compile(doc, null, { temperature: 0.2 }, 'P').compiled.temperature, 0.2, 'no Model -> base');
});

test('compile: an unknown tuning name throws CompileError', () => {
    const doc = mkDoc();
    doc.loadouts.P.overrides.M.tuning = /** @type {any} */ ('nope');
    assert.throws(() => compile(doc, MODEL(), {}, 'P'), (/** @type {any} */ e) =>
        e instanceof CompileError && e.message.includes('unknown tuning nope'));
});

test('compile: enabled precedence override > playstyle > root', () => {
    const doc = mkDoc();
    doc.loadouts.P.overrides.M.enabled = { b: false };
    assert.equal(onIn(compile(doc, null, {}, 'R').compiled, 'b'), false, 'root');
    assert.equal(onIn(compile(doc, null, {}, 'P').compiled, 'b'), true, 'playstyle beats root');
    assert.equal(onIn(compile(doc, MODEL(), {}, 'P').compiled, 'b'), false, 'override beats playstyle');
});

test('exportSt: no registry tuning; a playstyle active exports root ⊕ playstyle', () => {
    const doc = mkDoc();
    doc.activeLoadoutId = 'P';
    const out = exportSt(doc);
    assert.ok(!('temperature' in out));
    assert.equal(onIn(out, 'b'), true);
    assert.equal(onIn(out, 'a'), true, 'the playstyle\'s override for M never applies to export');
});

// ------------------------------------------------------------ compare

test('compare: enabled reads the active loadout\'s EFFECTIVE map (playstyle inherits its root)', () => {
    const a = mkDoc();
    a.activeLoadoutId = 'P';
    const b = mkDoc();
    b.activeLoadoutId = 'P';
    b.loadouts.R.enabled.a = false; // inherited by P
    const res = comparePresets(a, b);
    const row = res.rows.find((/** @type {any} */ r) => r.left?.identifier === 'a');
    assert.equal(row.status, 'changed');
    assert.deepEqual(row.fields, [{ key: 'enabled', a: true, b: false }]);
    const same = comparePresets(mkDoc(), Object.assign(mkDoc(), { activeLoadoutId: 'P' }));
    const rb = same.rows.find((/** @type {any} */ r) => r.left?.identifier === 'b');
    assert.deepEqual(rb.fields, [{ key: 'enabled', a: false, b: true }], 'P\'s explicit b counts');
});

// ------------------------------------------------------------ Models

test('seedFromProfiles: new Models carry tunings {default:{}} and defaultTuning "default"', () => {
    const { models } = seedFromProfiles([{ id: 'p1', mode: 'cc', api: 'custom', model: 'mock' }], { version: 1, models: {} });
    const m = /** @type {any} */ (models.mock);
    assert.deepEqual(m.tunings, { default: {} });
    assert.equal(m.defaultTuning, 'default');
    assert.ok(!('tuning' in m));
});

test('mergeModels: tunings union by name (first-listed wins), defaultTuning from the first-listed', () => {
    const base = { matches: [], profiles: [], preferredProfile: null };
    const reg = { version: 1, models: {
        A: { ...base, id: 'm_a', name: 'A', tunings: { default: { temperature: 1 }, hot: { temperature: 1.5 } }, defaultTuning: 'hot' },
        B: { ...base, id: 'm_b', name: 'B', tunings: { default: { temperature: 2 }, cold: { temperature: 0.2 } }, defaultTuning: 'default' },
    } };
    const out = mergeModels(reg, ['A', 'B'], 'AB');
    const m = /** @type {any} */ (out.models.AB);
    assert.deepEqual(m.tunings, { default: { temperature: 1 }, hot: { temperature: 1.5 }, cold: { temperature: 0.2 } });
    assert.equal(m.defaultTuning, 'hot');
    assert.ok(!('tuning' in m));
    assert.deepEqual(validateRegistry(out), []);
});
