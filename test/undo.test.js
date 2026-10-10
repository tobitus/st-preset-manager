/**
 * Round 2 A3 (owner note item 52): server-side, per-preset, in-memory
 * undo/redo of whole-document snapshots. Every `_savePresetNow` on an
 * existing document (and the copyBlock `_commit`) pushes the pre-save doc
 * and clears redo; cap 100; whole-document swaps (import replace:true,
 * restore) and Model rename/merge migrations clear both stacks; undo/redo
 * go through the `_replaceDocNow` body (slot-changed marker + desired
 * loadout fallback, exactly as restore).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../plugin/store.js';

function sampleSt() {
    return {
        temperature: 0.5,
        prompts: [
            { identifier: 'chatHistory', marker: true },
            { identifier: 'a', name: 'A', content: 'content a', role: 'system', enabled: true },
            { identifier: 'b', name: 'B', content: 'content b', role: 'system', enabled: true },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
        ] }],
    };
}

async function storeWithDoc() {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-undo-')));
    await store.init();
    const doc = await store.importPreset({ st: sampleSt(), name: 'Undo Preset' });
    return { store, id: doc.id };
}

/** The document minus the fields every save rewrites. */
const body = (/** @type {any} */ d) => {
    const { rev: _r, updatedAt: _u, ...rest } = structuredClone(d);
    return rest;
};

/** One ordinary edit: flip block a in the active loadout. */
async function toggleA(/** @type {Store} */ store, /** @type {string} */ id) {
    const d = structuredClone(store.getPreset(id));
    const lid = d.activeLoadoutId;
    d.loadouts[lid].enabled.a = !d.loadouts[lid].enabled.a;
    return store.savePreset(d);
}

const status = (/** @type {number} */ n) => (/** @type {any} */ e) => e?.status === n;

test('op -> undo restores the pre-op doc, redo re-applies it; depths follow', async () => {
    const { store, id } = await storeWithDoc();
    assert.deepEqual(store.historyDepth(id), { undo: 0, redo: 0 });
    const pre = store.getPreset(id);
    await toggleA(store, id);
    const post = store.getPreset(id);
    assert.deepEqual(store.historyDepth(id), { undo: 1, redo: 0 });

    const u = await store.undo(id);
    assert.deepEqual(body(store.getPreset(id)), body(pre), 'undo = the pre-op document');
    assert.deepEqual(u.doc, store.getPreset(id));
    assert.equal(u.doc.rev, post.rev + 1, 'undo is a new save (rev moves forward)');
    assert.deepEqual(u.history, { undo: 0, redo: 1 });
    assert.deepEqual(store.historyDepth(id), { undo: 0, redo: 1 });

    const r = await store.redo(id);
    assert.deepEqual(body(store.getPreset(id)), body(post), 'redo = the post-op document');
    assert.deepEqual(r.history, { undo: 1, redo: 0 });
    assert.deepEqual(store.historyDepth(id), { undo: 1, redo: 0 });
});

test('a new edit after an undo clears redo', async () => {
    const { store, id } = await storeWithDoc();
    await toggleA(store, id);
    await toggleA(store, id);
    await store.undo(id);
    assert.deepEqual(store.historyDepth(id), { undo: 1, redo: 1 });
    const d = structuredClone(store.getPreset(id));
    d.notes = 'fresh edit';
    await store.savePreset(d);
    assert.deepEqual(store.historyDepth(id), { undo: 2, redo: 0 });
    await assert.rejects(() => store.redo(id), status(409));
});

test('undo/redo on an empty stack -> 409 and nothing is written; unknown preset -> 404', async () => {
    const { store, id } = await storeWithDoc();
    const before = store.getPreset(id);
    const rev = store.rev;
    await assert.rejects(() => store.undo(id), status(409));
    await assert.rejects(() => store.redo(id), status(409));
    assert.deepEqual(store.getPreset(id), before);
    assert.equal(store.rev, rev);
    await assert.rejects(() => store.undo('p_nope'), status(404));
    await assert.rejects(() => store.redo('p_nope'), status(404));
    assert.throws(() => store.historyDepth('p_nope'), status(404));
});

test('101 edits keep the newest 100 undo entries; 100 undos reach the state after edit 1', async () => {
    const { store, id } = await storeWithDoc();
    /** @type {any[]} */
    const states = [store.getPreset(id)];
    for (let i = 1; i <= 101; i++) {
        const d = structuredClone(store.getPreset(id));
        d.notes = `edit ${i}`;
        states.push(await store.savePreset(d));
    }
    assert.deepEqual(store.historyDepth(id), { undo: 100, redo: 0 });
    for (let i = 0; i < 100; i++) await store.undo(id);
    assert.equal(store.getPreset(id).notes, 'edit 1');
    assert.deepEqual(body(store.getPreset(id)), body(states[1]));
    assert.deepEqual(store.historyDepth(id), { undo: 0, redo: 100 });
    await assert.rejects(() => store.undo(id), status(409));
});

test('import replace:true clears both stacks', async () => {
    const { store, id } = await storeWithDoc();
    await toggleA(store, id);
    await toggleA(store, id);
    await store.undo(id);
    assert.deepEqual(store.historyDepth(id), { undo: 1, redo: 1 });
    await store.importPreset({ st: sampleSt(), name: 'Undo Preset', replace: true });
    assert.deepEqual(store.historyDepth(id), { undo: 0, redo: 0 });
    await assert.rejects(() => store.undo(id), status(409));
});

test('restoreRevision clears both stacks', async () => {
    const { store, id } = await storeWithDoc();
    await toggleA(store, id);
    await toggleA(store, id);
    await store.undo(id);
    assert.deepEqual(store.historyDepth(id), { undo: 1, redo: 1 });
    await store.restoreRevision(id, 1);
    assert.deepEqual(store.historyDepth(id), { undo: 0, redo: 0 });
});

test('undo of a meta rename moves the file back to the old name', async () => {
    const { store, id } = await storeWithDoc();
    const oldPath = store.index.get(id).path;
    const d = structuredClone(store.getPreset(id));
    d.name = 'Undo Preset Renamed';
    await store.savePreset(d);
    assert.notEqual(store.index.get(id).path, oldPath);
    await store.undo(id);
    assert.equal(store.getPreset(id).name, 'Undo Preset');
    assert.equal(store.index.get(id).path, oldPath);
    assert.ok(fs.existsSync(oldPath));
});

test('undo of deleting the desired loadout brings it back; the slot falls back exactly as restore does', async () => {
    const { store, id } = await storeWithDoc();
    const two = structuredClone(store.getPreset(id));
    two.loadouts.l_second = { ...structuredClone(two.loadouts[two.activeLoadoutId]), id: 'l_second', name: 'Second' };
    await store.savePreset(two);
    await store.mutateState((/** @type {any} */ st) => { st.presetId = id; st.loadoutId = 'l_second'; });
    // the DELETE /presets/:id/loadouts/:lid route body, verbatim in store terms
    await store.enqueue(async () => {
        const d = store.getDocNow(id);
        delete d.loadouts.l_second;
        store._markSlotChanged();
        await store._mutateStateNow((/** @type {any} */ st) => { st.loadoutId = null; });
        await store._savePresetNow(d);
    });
    assert.equal(store.getPreset(id).loadouts.l_second, undefined);
    assert.equal(store.state.loadoutId, null);
    const revBefore = store.rev;
    const out = await store.undo(id);
    assert.equal(out.wasDesired, true);
    assert.equal(store.getPreset(id).loadouts.l_second?.name, 'Second', 'the loadout is back');
    assert.ok(store.slotChangedRev > revBefore, 'slot marked changed (in-flight panel posts 409 and re-base)');
    assert.equal(store.state.presetId, id);
    assert.equal(store.state.loadoutId, null, 'the slot stays on the active loadout');
    const onDisk = JSON.parse(fs.readFileSync(store.stateFile, 'utf8'));
    assert.equal(onDisk.slotChangedRev, store.slotChangedRev);
    assert.equal(onDisk.rev, store.rev);
});

test('undo of creating the desired loadout drops the desired loadout id (restore fallback)', async () => {
    const { store, id } = await storeWithDoc();
    const two = structuredClone(store.getPreset(id));
    two.loadouts.l_new = { ...structuredClone(two.loadouts[two.activeLoadoutId]), id: 'l_new', name: 'New' };
    await store.savePreset(two);
    await store.mutateState((/** @type {any} */ st) => { st.presetId = id; st.loadoutId = 'l_new'; });
    await store.undo(id);
    assert.equal(store.getPreset(id).loadouts.l_new, undefined);
    assert.equal(store.state.loadoutId, null);
});

test('undo of a preset not in the slot leaves the slot state alone', async () => {
    const { store, id } = await storeWithDoc();
    const other = await store.importPreset({ st: sampleSt(), name: 'Other' });
    await store.mutateState((/** @type {any} */ st) => { st.presetId = other.id; st.loadoutId = null; });
    await toggleA(store, id);
    const changedBefore = store.slotChangedRev;
    const out = await store.undo(id);
    assert.equal(out.wasDesired, false);
    assert.equal(store.slotChangedRev, changedBefore);
    assert.equal(store.state.presetId, other.id);
});

test('copyBlock (a _commit write) is undoable', async () => {
    const { store, id } = await storeWithDoc();
    const src = await store.importPreset({ st: sampleSt(), name: 'Source' });
    const pre = store.getPreset(id);
    await store.copyBlock(id, { fromPresetId: src.id, identifier: 'a' });
    assert.notDeepEqual(body(store.getPreset(id)).blocks, body(pre).blocks);
    assert.deepEqual(store.historyDepth(id), { undo: 1, redo: 0 });
    await store.undo(id);
    assert.deepEqual(body(store.getPreset(id)), body(pre));
});

test('a Model rename that migrates the document clears its stacks; other documents keep theirs', async () => {
    const { store, id } = await storeWithDoc();
    const other = await store.importPreset({ st: sampleSt(), name: 'Other' });
    const entry = (/** @type {string} */ name, /** @type {string} */ mid, /** @type {string} */ model) => ({ id: mid, name, matches: [{ source: 'custom', model }], profiles: [], preferredProfile: null, tunings: { default: {} }, defaultTuning: 'default' });
    await store.replaceModels({ version: 1, models: { A: entry('A', 'm_a', 'x/a') } });
    const d = structuredClone(store.getPreset(id));
    d.loadouts[d.activeLoadoutId].overrides = { A: { enabled: { a: false, b: true }, tuning: null } };
    await store.savePreset(d);
    await toggleA(store, other.id);
    assert.deepEqual(store.historyDepth(id), { undo: 1, redo: 0 });
    const res = await store.renameModel('A', 'Alpha');
    assert.deepEqual(res.migrated, [id]);
    assert.deepEqual(store.historyDepth(id), { undo: 0, redo: 0 }, 'snapshots name the old Model: dropped');
    assert.deepEqual(store.historyDepth(other.id), { undo: 1, redo: 0 });
});

test('deleting a preset drops its stacks', async () => {
    const { store, id } = await storeWithDoc();
    await toggleA(store, id);
    await store.deletePreset(id);
    assert.equal(store._undo.has(id), false);
});
