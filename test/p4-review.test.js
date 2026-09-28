/**
 * Phase 4 review round 1, store level:
 *  F1 Model rename / merge migrate every document reference in one
 *     transaction (labelled revision of each touched doc first);
 *  F4 semantic tuning / override patches applied inside the store queue;
 *  F6 a registry write publishes atomically (readers never see the new
 *     registry with the old rev; a failed write leaves memory unchanged).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StoreError } from '../plugin/store.js';
import { compile } from '../shared/compile.js';
import { resolveModel } from '../shared/models.js';

async function tmpStore() {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-p4r-')));
    await store.init();
    return store;
}

function sampleSt() {
    return {
        temperature: 0.5,
        prompts: [
            { identifier: 'chatHistory', marker: true },
            { identifier: 'hdr', name: '=Pick one POV 👇 ====', content: '', role: 'system' },
            { identifier: 'a', name: 'A', content: 'a', role: 'system' },
            { identifier: 'b', name: 'B', content: 'b', role: 'system' },
            { identifier: 'c', name: 'C', content: 'c', role: 'system' },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'hdr', enabled: false },
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: false },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'c', enabled: true },
        ] }],
    };
}

const entry = (name, id, model, tuning = {}) => ({
    id, name, matches: [{ source: 'custom', model }], profiles: [], preferredProfile: null, tuning,
});
const reg2 = () => ({ version: 1, models: {
    A: entry('A', 'm_a', 'x/a', { temperature: 0.3 }),
    B: entry('B', 'm_b', 'y/a', { temperature: 1.5, top_k: 40 }),
    Other: entry('Other', 'm_o', 'other'),
} });

/** A doc with overrides for A and B, and an untouched doc. */
async function fixture() {
    const store = await tmpStore();
    await store.replaceModels(reg2());
    const imp = await store.importPreset({ st: sampleSt(), name: 'P' });
    const doc = store.getPreset(imp.id);
    const lid = doc.activeLoadoutId;
    doc.tuningOverrides = { A: { temperature: 0.9 }, B: { temperature: 0.5, top_p: 0.8 } };
    doc.loadouts[lid].overrides = { A: { enabled: { a: true } }, B: { enabled: { b: true, c: false } } };
    await store.savePreset(doc);
    const plain = await store.importPreset({ st: sampleSt(), name: 'Untouched' });
    return { store, id: imp.id, lid, plainId: plain.id };
}

// ------------------------------------------------------------------ F1

test('F1 renameModel: registry and every document reference move to the new name; compile still applies them', async () => {
    const { store, id, lid, plainId } = await fixture();
    const plainRev = store.getPreset(plainId).rev;
    const res = await store.renameModel('A', 'Alpha');
    assert.deepEqual(Object.keys(res.models), ['Alpha', 'B', 'Other'], 'key order kept');
    assert.equal(res.models.Alpha.name, 'Alpha');
    assert.deepEqual(res.migrated, [id]);
    const doc = store.getPreset(id);
    assert.deepEqual(doc.tuningOverrides, { Alpha: { temperature: 0.9 }, B: { temperature: 0.5, top_p: 0.8 } });
    assert.deepEqual(Object.keys(doc.loadouts[lid].overrides).sort(), ['Alpha', 'B']);
    assert.deepEqual(doc.loadouts[lid].overrides.Alpha, { enabled: { a: true } });
    assert.equal(store.getPreset(plainId).rev, plainRev, 'a doc without references is untouched');
    const model = resolveModel(store.models, { source: 'custom', model: 'x/a', profileId: null });
    assert.equal(model?.name, 'Alpha');
    assert.equal(compile(doc, model, {}).compiled.temperature, 0.9, 'the preset override still applies');
    const labels = store.listRevisions(id).map((r) => r.label);
    assert.ok(labels.includes('Model rename: A -> Alpha'), `labels ${JSON.stringify(labels)}`);
    // persisted
    const onDisk = JSON.parse(fs.readFileSync(path.join(store.root, 'models.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk.models), ['Alpha', 'B', 'Other']);
});

test('F1 renameModel: refuses unknown, empty and taken names without writing', async () => {
    const { store, id } = await fixture();
    const rev = store.rev;
    const docRev = store.getPreset(id).rev;
    await assert.rejects(() => store.renameModel('Nope', 'X'), (e) => e instanceof StoreError && e.status === 404);
    await assert.rejects(() => store.renameModel('A', '  '), (e) => e instanceof StoreError && e.status === 400);
    await assert.rejects(() => store.renameModel('A', 'B'), (e) => e instanceof StoreError && e.status === 400);
    assert.equal(store.rev, rev);
    assert.equal(store.getPreset(id).rev, docRev);
    assert.ok(store.models.models.A);
});

test('F1 mergeModelsTx: documents merge first-listed-wins, pick-one completed in the override, losers kept in a labelled revision', async () => {
    const { store, id, lid } = await fixture();
    const before = store.getPreset(id);
    const res = await store.mergeModelsTx(['A', 'B'], 'AB');
    assert.deepEqual(Object.keys(res.models), ['AB', 'Other']);
    assert.deepEqual(res.migrated, [id]);
    assert.deepEqual(res.models.AB.tuning, { temperature: 0.3, top_k: 40 });
    const doc = store.getPreset(id);
    assert.deepEqual(doc.tuningOverrides, { AB: { temperature: 0.9, top_p: 0.8 } });
    const ov = doc.loadouts[lid].overrides;
    assert.deepEqual(Object.keys(ov), ['AB']);
    assert.equal(ov.AB.enabled.a, true, 'A (first listed) keeps its option');
    assert.equal(ov.AB.enabled.b, false, 'B\'s competing pick-one option is turned off');
    assert.equal(ov.AB.enabled.hdr, false);
    assert.equal(ov.AB.enabled.c, false, 'non-conflicting B entries survive');
    const revs = store.listRevisions(id);
    const r = revs.find((x) => x.label === 'Model merge: A + B -> AB');
    assert.ok(r, `labels ${JSON.stringify(revs.map((x) => x.label))}`);
    const snap = store.getRevision(id, r.rev);
    const snapDoc = snap.doc ?? snap;
    assert.deepEqual(snapDoc.tuningOverrides, before.tuningOverrides, 'the pre-merge values are recoverable');
    const model = resolveModel(store.models, { source: 'custom', model: 'y/a', profileId: null });
    assert.equal(model?.name, 'AB');
    assert.equal(compile(doc, model, {}).compiled.temperature, 0.9);
});

test('F1 mergeModelsTx: bad input is a 400 and nothing changes', async () => {
    const { store, id } = await fixture();
    const docRev = store.getPreset(id).rev;
    await assert.rejects(() => store.mergeModelsTx(['A'], 'X'), (e) => e instanceof StoreError && e.status === 400);
    await assert.rejects(() => store.mergeModelsTx(['A', 'B'], 'Other'), (e) => e instanceof StoreError && e.status === 400);
    assert.equal(store.getPreset(id).rev, docRev);
    assert.deepEqual(Object.keys(store.models.models), ['A', 'B', 'Other']);
});

// ------------------------------------------------------------------ F4

test('F4 patchTuningOverride: per-key set/unset keeps keys other writers stored', async () => {
    const { store, id } = await fixture();
    // a flushed panel edit lands first (temperature), then the panel's own top_p patch
    await store.patchTuningOverride(id, 'B', { set: { temperature: 0.61 } });
    await store.patchTuningOverride(id, 'B', { set: { top_p: 0.7 } });
    assert.deepEqual(store.getPreset(id).tuningOverrides.B, { temperature: 0.61, top_p: 0.7 });
    await store.patchTuningOverride(id, 'B', { unset: ['temperature'] });
    assert.deepEqual(store.getPreset(id).tuningOverrides.B, { top_p: 0.7 });
    await assert.rejects(() => store.patchTuningOverride(id, 'Other', { set: { temperature: 1 } }), (e) => e instanceof StoreError && e.status === 404);
    await assert.rejects(() => store.patchTuningOverride(id, 'B', { set: { custom_url: 'x' } }), (e) => e instanceof StoreError && e.status === 400);
    assert.deepEqual(store.getPreset(id).tuningOverrides.B, { top_p: 0.7 });
});

test('F4 patchModelTuning: per-key set/unset on the global tuning', async () => {
    const { store } = await fixture();
    await store.patchModelTuning('B', { set: { top_p: 0.9 } });
    await store.patchModelTuning('B', { unset: ['top_k'] });
    assert.deepEqual(store.models.models.B.tuning, { temperature: 1.5, top_p: 0.9 });
    await assert.rejects(() => store.patchModelTuning('Nope', { set: { top_p: 1 } }), (e) => e instanceof StoreError && e.status === 404);
    await assert.rejects(() => store.patchModelTuning('B', { unset: ['custom_model'] }), (e) => e instanceof StoreError && e.status === 400);
});

test('F4 patchLoadoutOverride: per-identifier set/unset; an option switched on turns its pick-one siblings off in the override only', async () => {
    const { store, id, lid } = await fixture();
    const loadoutBefore = structuredClone(store.getPreset(id).loadouts[lid].enabled);
    await store.patchLoadoutOverride(id, lid, 'A', { set: { c: false } });
    const ov0 = store.getPreset(id).loadouts[lid].overrides.A.enabled;
    assert.equal(ov0.a, true, 'the stored entry survives');
    assert.equal(ov0.c, false);
    assert.ok(!ov0.b && !ov0.hdr, 'pick-one siblings of the chosen option are off (or absent)');
    await store.patchLoadoutOverride(id, lid, 'A', { set: { b: true } });
    const ov = store.getPreset(id).loadouts[lid].overrides.A.enabled;
    assert.equal(ov.b, true);
    assert.equal(ov.a, false);
    assert.equal(ov.c, false, 'the earlier entry survives');
    await store.patchLoadoutOverride(id, lid, 'A', { unset: ['c'] });
    assert.equal('c' in store.getPreset(id).loadouts[lid].overrides.A.enabled, false);
    assert.deepEqual(store.getPreset(id).loadouts[lid].enabled, loadoutBefore, 'loadout untouched');
    await assert.rejects(() => store.patchLoadoutOverride(id, lid, 'Other', { set: { a: true } }), (e) => e instanceof StoreError && e.status === 404);
    await assert.rejects(() => store.patchLoadoutOverride(id, lid, 'A', { set: { nope: true } }), (e) => e instanceof StoreError && e.status === 404);
    await assert.rejects(() => store.patchLoadoutOverride(id, lid, 'A', /** @type {any} */ ({ set: { a: 'yes' } })), (e) => e instanceof StoreError && e.status === 400);
});

// ------------------------------------------------------------------ F6

test('F6 replaceModels: a reader outside the queue never sees the new registry with the old rev', async () => {
    const store = await tmpStore();
    await store.replaceModels(reg2());
    const rev0 = store.rev;
    const next = reg2();
    next.models.B.tuning = { temperature: 0.2 };
    let done = false;
    /** @type {{t: any, rev: number}[]} */
    const seen = [];
    const p = store.replaceModels(next).then(() => { done = true; });
    while (!done) {
        seen.push({ t: store.models.models.B.tuning.temperature, rev: store.rev });
        await new Promise((r) => setImmediate(r));
    }
    await p;
    assert.ok(seen.length > 1, 'precondition: the reader ran while the write was in flight');
    const half = seen.filter((s) => s.t === 0.2 && s.rev === rev0);
    assert.equal(half.length, 0, `half-published reads: ${half.length}/${seen.length}`);
    assert.equal(store.models.models.B.tuning.temperature, 0.2);
    assert.equal(store.rev, rev0 + 1);
});

test('F6 replaceModels: a failed write leaves the published registry and rev unchanged', async () => {
    const store = await tmpStore();
    await store.replaceModels(reg2());
    const before = structuredClone(store.models);
    const rev0 = store.rev;
    // a directory where the models file should go: the rename onto it fails
    const blocked = path.join(store.root, 'blocked-models.json');
    fs.mkdirSync(path.join(blocked, 'x'), { recursive: true });
    store.modelsFile = blocked;
    const next = reg2();
    next.models.B.tuning = { temperature: 0.2 };
    await assert.rejects(() => store.replaceModels(next));
    assert.deepEqual(store.models, before);
    assert.equal(store.rev, rev0);
});
