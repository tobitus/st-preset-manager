/**
 * Round 2 B2: server side of inheriting loadouts + named tunings —
 * docops (toggle/setGroup with loadoutId and sparse playstyle writes,
 * resetInherit/resetAllInherit, new-block defaults, setCardinality over
 * EFFECTIVE maps), store loadout CRUD (create/convert/re-parent/delete
 * rules), override tuning binding, named-tuning CRUD with reference checks,
 * Model rename/merge migration, ST-panel write-back routing per layer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDocOp, OpError } from '../shared/docops.js';
import { effectiveEnabled } from '../shared/loadouts.js';
import { validateDoc } from '../shared/schema.js';
import { routePanelDiff } from '../plugin/slot.js';
import { Store } from '../plugin/store.js';

const B = (/** @type {string} */ id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
const IDS = ['a', 'b', 'c', 'o1', 'o2', 'o3', 'q1', 'q2'];

/**
 * a, b; pick-one group G {o1,o2,o3}; c (keeps the two headerless groups
 * apart — adjacent headerless groups merge on import); pick-one-or-more
 * group Q {q1,q2}.
 * R (root, active): a on, o3 on, q1 on. P (playstyle of R): b on.
 */
/** @returns {any} */
function mkDoc() {
    return {
        format: 'st-preset-manager/library', version: 1, id: 'p_ops', name: 'Ops', tags: [], notes: '', source: null,
        settings: {},
        markers: [],
        blocks: Object.fromEntries(IDS.map((id) => [id, B(id)])),
        sequences: [{ character_id: 100001, rows: [
            leaf('a'), leaf('b'),
            { kind: 'group', key: 'grp:k-o1', name: 'G', cardinality: 'pick-one', guessed: false, header: null, options: [leaf('o1'), leaf('o2'), leaf('o3')] },
            leaf('c'),
            { kind: 'group', key: 'grp:k-q1', name: 'Q', cardinality: 'pick-one-or-more', guessed: false, header: null, options: [leaf('q1'), leaf('q2')] },
        ] }],
        loadouts: {
            R: { id: 'R', name: 'Root', notes: '', kind: 'root', parent: null,
                enabled: { a: true, b: false, c: false, o1: false, o2: false, o3: true, q1: true, q2: false }, overrides: {} },
            P: { id: 'P', name: 'Play', notes: '', kind: 'playstyle', parent: 'R', enabled: { b: true }, overrides: {} },
        },
        activeLoadoutId: 'R',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1,
    };
}

const MODEL = () => ({
    id: 'm_m', name: 'M', matches: [], profiles: [], preferredProfile: null,
    tunings: { default: { temperature: 1 }, hot: { temperature: 1.5 } }, defaultTuning: 'default',
});

const status = (/** @type {number} */ n, /** @type {string[]} */ [text] = []) => (/** @type {any} */ e) => {
    assert.equal(e?.status, n, `status ${e?.status} (${e?.message})`);
    if (text) assert.ok(e.message.includes(text), `message: ${e.message}`);
    return true;
};

async function storeWithDoc(/** @type {any} */ doc = mkDoc()) {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-b2-')));
    await store.init();
    await store.replaceModels({ version: 1, models: { M: MODEL() } });
    const saved = await store.importPreset({ native: doc });
    return { store, id: saved.id };
}

// ------------------------------------------------------------ docops

test('toggle on a playstyle writes only that key and never touches the root', () => {
    const doc = mkDoc();
    const root = structuredClone(doc.loadouts.R);
    applyDocOp(doc, 'toggle', { identifier: 'c', value: true, loadoutId: 'P' });
    assert.deepEqual(doc.loadouts.P.enabled, { b: true, c: true });
    assert.deepEqual(doc.loadouts.R, root);
    // no value: flips the EFFECTIVE bit (a is inherited on -> explicit off)
    applyDocOp(doc, 'toggle', { identifier: 'a', loadoutId: 'P' });
    assert.equal(/** @type {any} */ (doc.loadouts.P.enabled).a, false);
    assert.deepEqual(doc.loadouts.R, root);
    assert.deepEqual(validateDoc(doc), []);
});

test('toggle a pick-one member on a playstyle writes the member + its siblings false, root untouched', () => {
    const doc = mkDoc();
    const root = structuredClone(doc.loadouts.R);
    applyDocOp(doc, 'toggle', { identifier: 'o1', value: true, loadoutId: 'P' });
    assert.deepEqual(doc.loadouts.P.enabled, { b: true, o1: true, o2: false, o3: false });
    assert.deepEqual(doc.loadouts.R, root);
    const eff = effectiveEnabled(doc, 'P', null).enabled;
    assert.deepEqual([eff.o1, eff.o2, eff.o3], [true, false, false]);
});

test('setGroup on a playstyle: sparse write with siblings false; root untouched', () => {
    const doc = mkDoc();
    const root = structuredClone(doc.loadouts.R);
    applyDocOp(doc, 'setGroup', { group: 'grp:k-o1', identifier: 'o2', loadoutId: 'P' });
    assert.deepEqual(doc.loadouts.P.enabled, { b: true, o1: false, o2: true, o3: false });
    assert.deepEqual(doc.loadouts.R, root);
});

test('toggle/setGroup without loadoutId keep writing the active root (pick-one collapses there)', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'toggle', { identifier: 'o1', value: true });
    assert.deepEqual([doc.loadouts.R.enabled.o1, doc.loadouts.R.enabled.o3], [true, false]);
    assert.deepEqual(doc.loadouts.P.enabled, { b: true });
    applyDocOp(doc, 'setGroup', { group: 'grp:k-o1', identifier: 'o2' });
    assert.deepEqual([doc.loadouts.R.enabled.o1, doc.loadouts.R.enabled.o2], [false, true]);
});

test('toggle: unknown loadout -> 404; unknown leaf on a playstyle -> 404', () => {
    assert.throws(() => applyDocOp(mkDoc(), 'toggle', { identifier: 'a', loadoutId: 'nope' }), status(404));
    assert.throws(() => applyDocOp(mkDoc(), 'toggle', { identifier: 'zz', value: true, loadoutId: 'P' }), status(404));
});

test('resetInherit on a pick-one member removes every member key; on a plain block only that key', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'setGroup', { group: 'grp:k-o1', identifier: 'o2', loadoutId: 'P' });
    applyDocOp(doc, 'toggle', { identifier: 'c', value: true, loadoutId: 'P' });
    applyDocOp(doc, 'resetInherit', { loadoutId: 'P', identifier: 'o2' });
    assert.deepEqual(doc.loadouts.P.enabled, { b: true, c: true });
    applyDocOp(doc, 'resetInherit', { loadoutId: 'P', identifier: 'c' });
    assert.deepEqual(doc.loadouts.P.enabled, { b: true });
});

test('resetAllInherit empties the playstyle map; both reset ops refuse a root with 400', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'toggle', { identifier: 'c', value: true, loadoutId: 'P' });
    applyDocOp(doc, 'resetAllInherit', { loadoutId: 'P' });
    assert.deepEqual(doc.loadouts.P.enabled, {});
    assert.throws(() => applyDocOp(mkDoc(), 'resetAllInherit', { loadoutId: 'R' }), status(400));
    assert.throws(() => applyDocOp(mkDoc(), 'resetInherit', { loadoutId: 'R', identifier: 'a' }), status(400));
    assert.throws(() => applyDocOp(mkDoc(), 'resetInherit', { loadoutId: 'nope', identifier: 'a' }), status(404));
});

test('new blocks: every root gets false, playstyles get no entry; addSection is ON in the active loadout (explicit on a playstyle)', () => {
    const doc = mkDoc();
    const { identifier } = /** @type {any} */ (applyDocOp(doc, 'addBlock', { name: 'New' }));
    assert.equal(/** @type {any} */ (doc.loadouts.R.enabled)[identifier], false);
    assert.ok(!(identifier in doc.loadouts.P.enabled));
    const s1 = /** @type {any} */ (applyDocOp(doc, 'addSection', { name: 'Sec1' }));
    assert.equal(/** @type {any} */ (doc.loadouts.R.enabled)[s1.identifier], true, 'active root: on');
    assert.ok(!(s1.identifier in doc.loadouts.P.enabled));
    doc.activeLoadoutId = 'P';
    const s2 = /** @type {any} */ (applyDocOp(doc, 'addSection', { name: 'Sec2' }));
    assert.equal(/** @type {any} */ (doc.loadouts.R.enabled)[s2.identifier], false, 'root: false');
    assert.equal(/** @type {any} */ (doc.loadouts.P.enabled)[s2.identifier], true, 'active playstyle: explicit on');
    assert.deepEqual(validateDoc(doc), []);
});

test('deleteBlock drops the key from playstyle maps and overrides too', () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts.P).overrides = { M: { enabled: { c: true }, tuning: null } };
    /** @type {any} */ (doc.loadouts.P.enabled).c = true;
    applyDocOp(doc, 'deleteBlock', { identifier: 'c' });
    assert.ok(!('c' in doc.loadouts.P.enabled));
    assert.ok(!('c' in /** @type {any} */ (doc.loadouts.P).overrides.M.enabled));
    assert.ok(!('c' in doc.loadouts.R.enabled));
});

test('setCardinality to pick-one is refused when a playstyle\'s EFFECTIVE map has 2 on (sparse map has 1)', () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts.P.enabled).q2 = true; // q1 inherited on from R
    const before = JSON.stringify(doc.loadouts);
    assert.throws(() => applyDocOp(doc, 'setCardinality', { key: 'grp:k-q1', cardinality: 'pick-one' }), (/** @type {any} */ e) => {
        assert.ok(e instanceof OpError);
        assert.equal(e.status, 409);
        assert.ok(e.message.startsWith('more than one option currently selected'), e.message);
        assert.ok(e.message.includes('in loadout "Play"'), e.message);
        return true;
    });
    assert.equal(JSON.stringify(doc.loadouts), before);
    // same through a playstyle × Model override effective map
    const d2 = mkDoc();
    d2.loadouts.R.enabled.q1 = false;
    /** @type {any} */ (d2.loadouts.P).overrides = { M: { enabled: { q1: true, q2: true }, tuning: null } };
    assert.throws(() => applyDocOp(d2, 'setCardinality', { key: 'grp:k-q1', cardinality: 'pick-one' }), status(409, ['for Model "M"']));
    // and allowed once no effective map has 2 on
    const d3 = mkDoc();
    applyDocOp(d3, 'setCardinality', { key: 'grp:k-q1', cardinality: 'pick-one' });
});

// ------------------------------------------------------------ store: loadouts

test('createLoadout: kind required; playstyle needs a ROOT parent; playstyle starts empty', async () => {
    const { store, id } = await storeWithDoc();
    await assert.rejects(store.createLoadout(id, { name: 'X' }), status(400));
    await assert.rejects(store.createLoadout(id, { name: 'X', kind: 'playstyle' }), status(400));
    await assert.rejects(store.createLoadout(id, { name: 'X', kind: 'playstyle', parent: 'P' }), status(400));
    await assert.rejects(store.createLoadout(id, { name: 'X', kind: 'playstyle', parent: 'nope' }), status(400));
    await assert.rejects(store.createLoadout(id, { name: 'Play', kind: 'playstyle', parent: 'R' }), status(409));
    const doc = await store.createLoadout(id, { name: 'P2', kind: 'playstyle', parent: 'R' });
    const p2 = /** @type {any} */ (Object.values(doc.loadouts).find((/** @type {any} */ l) => l.name === 'P2'));
    assert.equal(p2.kind, 'playstyle');
    assert.equal(p2.parent, 'R');
    assert.deepEqual(p2.enabled, {});
    assert.deepEqual(p2.overrides, {});
});

test('createLoadout root: copies the effective map of `from` (default: the active loadout\'s root)', async () => {
    const { store, id } = await storeWithDoc();
    const d1 = await store.createLoadout(id, { name: 'R2', kind: 'root' });
    const r2 = /** @type {any} */ (Object.values(d1.loadouts).find((/** @type {any} */ l) => l.name === 'R2'));
    assert.equal(r2.kind, 'root');
    assert.equal(r2.parent, null);
    assert.deepEqual(r2.enabled, mkDoc().loadouts.R.enabled);
    const d2 = await store.createLoadout(id, { name: 'R3', kind: 'root', from: 'P' });
    const r3 = /** @type {any} */ (Object.values(d2.loadouts).find((/** @type {any} */ l) => l.name === 'R3'));
    assert.deepEqual(r3.enabled, effectiveEnabled(mkDoc(), 'P', null).enabled);
});

test('deleteLoadout: root with children -> 409 with the count; playstyle deletable; last root -> 409', async () => {
    const { store, id } = await storeWithDoc();
    await assert.rejects(store.deleteLoadout(id, 'R'), status(409, ['root "Root" has 1 playstyle loadout(s); delete or re-parent them first']));
    await store.deleteLoadout(id, 'P');
    await assert.rejects(store.deleteLoadout(id, 'R'), status(409, ['last root']));
    assert.ok(store.getPreset(id).loadouts.R);
});

test('updateLoadout: convert root -> playstyle keeps the effective map; enabled holds only differing keys', async () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts).R2 = { id: 'R2', name: 'Root2', notes: '', kind: 'root', parent: null,
        enabled: { ...doc.loadouts.R.enabled, c: true, a: false }, overrides: {} };
    const { store, id } = await storeWithDoc(doc);
    const before = effectiveEnabled(store.getPreset(id), 'R2', null).enabled;
    const saved = await store.updateLoadout(id, 'R2', { kind: 'playstyle', parent: 'R' });
    assert.equal(saved.loadouts.R2.kind, 'playstyle');
    assert.equal(saved.loadouts.R2.parent, 'R');
    assert.deepEqual(saved.loadouts.R2.enabled, { a: false, c: true });
    assert.deepEqual(effectiveEnabled(saved, 'R2', null).enabled, before);
});

test('updateLoadout: root with children cannot become a playstyle (409); playstyle -> root materialises the complete map', async () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts).R2 = { id: 'R2', name: 'Root2', notes: '', kind: 'root', parent: null, enabled: { ...doc.loadouts.R.enabled }, overrides: {} };
    const { store, id } = await storeWithDoc(doc);
    await assert.rejects(store.updateLoadout(id, 'R', { kind: 'playstyle', parent: 'R2' }), status(409));
    const before = effectiveEnabled(store.getPreset(id), 'P', null).enabled;
    const saved = await store.updateLoadout(id, 'P', { kind: 'root' });
    assert.equal(saved.loadouts.P.kind, 'root');
    assert.equal(saved.loadouts.P.parent, null);
    assert.deepEqual(saved.loadouts.P.enabled, before);
});

test('updateLoadout: re-parent keeps explicit sets; a playstyle parent or a parent on a root -> 400', async () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts).R2 = { id: 'R2', name: 'Root2', notes: '', kind: 'root', parent: null, enabled: { ...doc.loadouts.R.enabled }, overrides: {} };
    /** @type {any} */ (doc.loadouts).P2 = { id: 'P2', name: 'Play2', notes: '', kind: 'playstyle', parent: 'R', enabled: {}, overrides: {} };
    const { store, id } = await storeWithDoc(doc);
    const saved = await store.updateLoadout(id, 'P', { parent: 'R2' });
    assert.equal(saved.loadouts.P.parent, 'R2');
    assert.deepEqual(saved.loadouts.P.enabled, { b: true });
    await assert.rejects(store.updateLoadout(id, 'P', { parent: 'P2' }), status(400));
    await assert.rejects(store.updateLoadout(id, 'R', { parent: 'R2' }), status(400));
    const renamed = await store.updateLoadout(id, 'P', { name: 'Play!', notes: 'n' });
    assert.equal(renamed.loadouts.P.name, 'Play!');
});

// ------------------------------------------------------------ store: override tuning binding

test('override PUT/PATCH carry a tuning name validated against the Model\'s tunings', async () => {
    const { store, id } = await storeWithDoc();
    const d1 = await store.setLoadoutOverride(id, 'P', 'M', { enabled: { a: false }, tuning: 'hot' });
    assert.deepEqual(d1.loadouts.P.overrides.M, { enabled: { a: false }, tuning: 'hot' });
    const d2 = await store.setLoadoutOverride(id, 'R', 'M', { enabled: {} });
    assert.equal(d2.loadouts.R.overrides.M.tuning, null, 'absent tuning -> null');
    await assert.rejects(store.setLoadoutOverride(id, 'P', 'M', { enabled: {}, tuning: 'nope' }), status(400));
    await assert.rejects(store.setLoadoutOverride(id, 'P', 'Ghost', { enabled: {}, tuning: 'hot' }), status(400));
    const d3 = await store.patchLoadoutOverride(id, 'P', 'M', { set: { c: true } });
    assert.equal(d3.loadouts.P.overrides.M.tuning, 'hot', 'set/unset keep the binding');
    const d4 = await store.patchLoadoutOverride(id, 'P', 'M', { tuning: null });
    assert.deepEqual(d4.loadouts.P.overrides.M, { enabled: { a: false, c: true }, tuning: null });
    await assert.rejects(store.patchLoadoutOverride(id, 'P', 'M', { tuning: 'nope' }), status(400));
});

// ------------------------------------------------------------ store: named tunings

test('named tunings: set creates/replaces, patch edits, default switch; bad keys 400, missing 404', async () => {
    const { store } = await storeWithDoc();
    const m1 = await store.setModelTuning('M', 'cold', { temperature: 0.2 });
    assert.deepEqual(m1.tunings.cold, { temperature: 0.2 });
    const m2 = await store.patchModelTuning('M', 'cold', { set: { top_p: 0.9 }, unset: ['temperature'] });
    assert.deepEqual(m2.tunings.cold, { top_p: 0.9 });
    await assert.rejects(store.patchModelTuning('M', 'nope', { set: { temperature: 1 } }), status(404));
    await assert.rejects(store.setModelTuning('M', 'x', { foo: 1 }), status(400));
    await assert.rejects(store.setModelTuning('Ghost', 'x', {}), status(404));
    const m3 = await store.setDefaultTuning('M', 'cold');
    assert.equal(m3.defaultTuning, 'cold');
    await assert.rejects(store.setDefaultTuning('M', 'nope'), status(404));
});

test('named tunings: delete refuses the default and a referenced tuning (409); deletes an unreferenced one', async () => {
    const { store, id } = await storeWithDoc();
    await store.setLoadoutOverride(id, 'P', 'M', { enabled: {}, tuning: 'hot' });
    await assert.rejects(store.deleteModelTuning('M', 'default'), status(409));
    await assert.rejects(store.deleteModelTuning('M', 'hot'), status(409, ['Ops']));
    await store.setModelTuning('M', 'spare', {});
    const m = await store.deleteModelTuning('M', 'spare');
    assert.ok(!('spare' in m.tunings));
    await assert.rejects(store.deleteModelTuning('M', 'spare'), status(404));
});

test('named tunings: rename migrates override references in one labelled transaction (and the default)', async () => {
    const { store, id } = await storeWithDoc();
    await store.setLoadoutOverride(id, 'P', 'M', { enabled: {}, tuning: 'hot' });
    await store.setDefaultTuning('M', 'hot');
    const revsBefore = store.listRevisions(id).length;
    const out = await store.renameModelTuning('M', 'hot', 'spicy');
    assert.deepEqual(out.migrated, [id]);
    const m = store.models.models.M;
    assert.ok(!('hot' in m.tunings));
    assert.deepEqual(m.tunings.spicy, { temperature: 1.5 });
    assert.equal(m.defaultTuning, 'spicy');
    assert.equal(store.getPreset(id).loadouts.P.overrides.M.tuning, 'spicy');
    const revs = store.listRevisions(id);
    assert.ok(revs.length > revsBefore);
    assert.ok(revs.some((/** @type {any} */ r) => /tuning rename/i.test(r.label ?? '')), JSON.stringify(revs));
    assert.deepEqual(store.historyDepth(id), { undo: 0, redo: 0 }, 'a reference-rewriting registry change clears undo');
    await assert.rejects(store.renameModelTuning('M', 'spicy', 'default'), status(409));
    await assert.rejects(store.renameModelTuning('M', 'nope', 'x'), status(404));
});

test('Model rename migrates override keys; merge unions tunings and keeps the first-listed binding', async () => {
    const { store, id } = await storeWithDoc();
    await store.setLoadoutOverride(id, 'P', 'M', { enabled: { a: false }, tuning: 'hot' });
    await store.renameModel('M', 'M2');
    assert.deepEqual(store.getPreset(id).loadouts.P.overrides.M2, { enabled: { a: false }, tuning: 'hot' });
    await store.replaceModels({ version: 1, models: {
        M2: store.models.models.M2,
        N: { id: 'm_n', name: 'N', matches: [], profiles: [], preferredProfile: null, tunings: { default: {}, cold: { temperature: 0.1 } }, defaultTuning: 'cold' },
    } });
    await store.setLoadoutOverride(id, 'R', 'N', { enabled: {}, tuning: 'cold' });
    await store.mergeModelsTx(['M2', 'N'], 'MN');
    const reg = store.models.models.MN;
    assert.deepEqual(Object.keys(reg.tunings).sort(), ['cold', 'default', 'hot']);
    assert.deepEqual(reg.tunings.default, { temperature: 1 }, 'first-listed wins by name');
    assert.equal(reg.defaultTuning, 'default');
    const d = store.getPreset(id);
    assert.equal(d.loadouts.P.overrides.MN.tuning, 'hot');
    assert.equal(d.loadouts.R.overrides.MN.tuning, 'cold');
    assert.deepEqual(validateDoc(d), []);
});

test('listLibrary: loadouts carry {id,name,kind,parent}; hasOverrides is gone', async () => {
    const { store, id } = await storeWithDoc();
    const item = /** @type {any} */ (store.listLibrary().find((/** @type {any} */ i) => i.id === id));
    assert.deepEqual(item.loadouts, [
        { id: 'R', name: 'Root', kind: 'root', parent: null },
        { id: 'P', name: 'Play', kind: 'playstyle', parent: 'R' },
    ]);
    assert.ok(!('hasOverrides' in item));
});

// ------------------------------------------------------------ slot write-back routing

const order = (/** @type {any[]} */ entries) => ({ prompt_order: { changed: false, order: entries }, prompts: [] });

test('panel tick on a playstyle-desired slot lands in the playstyle\'s sparse map; root untouched', () => {
    const doc = mkDoc();
    const root = structuredClone(doc.loadouts.R);
    const { routed } = routePanelDiff(doc, null, order([{ identifier: 'c', enabled: true }]), null, 'P');
    assert.deepEqual(doc.loadouts.P.enabled, { b: true, c: true });
    assert.deepEqual(doc.loadouts.R, root);
    assert.ok(routed.some((r) => r.key === 'c' && r.layer === 'loadout'), JSON.stringify(routed));
    routePanelDiff(doc, null, order([{ identifier: 'o1', enabled: true }]), null, 'P');
    assert.deepEqual(doc.loadouts.P.enabled, { b: true, c: true, o1: true, o2: false, o3: false });
    assert.deepEqual(doc.loadouts.R, root);
});

test('panel tick on a root-desired slot lands in the root (pick-one normalised there)', () => {
    const doc = mkDoc();
    routePanelDiff(doc, null, order([{ identifier: 'o1', enabled: true }]), null, 'R');
    assert.deepEqual([doc.loadouts.R.enabled.o1, doc.loadouts.R.enabled.o3], [true, false]);
    assert.deepEqual(doc.loadouts.P.enabled, { b: true });
});

test('panel tick on an id the override controls lands in the override', () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts.P).overrides = { M: { enabled: { a: false }, tuning: null } };
    const { routed } = routePanelDiff(doc, null, order([{ identifier: 'a', enabled: true }]), MODEL(), 'P');
    assert.equal(/** @type {any} */ (doc.loadouts.P).overrides.M.enabled.a, true);
    assert.ok(!('a' in doc.loadouts.P.enabled));
    assert.ok(routed.some((r) => r.layer === 'override:M'), JSON.stringify(routed));
});

test('panel sampler change writes the tuning IN EFFECT: the override\'s binding, else the Model default; no Model -> settings', () => {
    const doc = mkDoc();
    /** @type {any} */ (doc.loadouts.P).overrides = { M: { enabled: {}, tuning: 'hot' } };
    const r1 = routePanelDiff(doc, null, { ...order([]), temperature: 1.7 }, MODEL(), 'P');
    assert.deepEqual(r1.tuningWrite, { name: 'hot', values: { temperature: 1.7 } });
    const r2 = routePanelDiff(doc, null, { ...order([]), temperature: 0.3 }, MODEL(), 'R');
    assert.deepEqual(r2.tuningWrite, { name: 'default', values: { temperature: 0.3 } });
    const r3 = routePanelDiff(doc, null, { ...order([]), temperature: 0.9 }, null, 'P');
    assert.equal(r3.tuningWrite, null);
    assert.equal(/** @type {any} */ (doc.settings).temperature, 0.9);
    assert.ok(r3.warnings.length > 0);
    assert.ok(!('globalTuning' in r1));
});
