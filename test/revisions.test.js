/**
 * Revisions (PLAN §1.2, §1.6, §2 Phase 5 check 3): coalescing keeps the
 * PRE-burst state, a labelled snapshot is always its own revision and is
 * never coalesced into, restore snapshots the current state first (labelled)
 * and marks the desired slot changed when the restored preset is in it.
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
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-rev-')));
    await store.init();
    const doc = await store.importPreset({ st: sampleSt(), name: 'Rev Preset' });
    return { store, doc };
}
const revs = (/** @type {any} */ store, /** @type {string} */ id) => store.listRevisions(id).map((/** @type {any} */ r) => r.rev);

test('a burst of unlabelled saves makes ONE snapshot, and it holds the state from before the burst', async () => {
    const { store, doc } = await storeWithDoc();
    const before = store.getPreset(doc.id);
    let cur = before;
    for (let i = 0; i < 10; i++) {
        cur = structuredClone(cur);
        cur.notes = `burst ${i}`;
        cur = await store.savePreset(cur);
    }
    assert.equal(cur.rev, before.rev + 10, 'all ten saves landed');
    assert.deepEqual(revs(store, doc.id), [1]);
    const snap = store.getRevision(doc.id, 1);
    assert.deepEqual(snap.doc, before, 'the coalesced snapshot is the pre-burst document');
    assert.equal(snap.label, null);
});

test('snapshotRevision(label) always writes; the next unlabelled save is not coalesced into it', async () => {
    const { store, doc } = await storeWithDoc();
    const d1 = structuredClone(store.getPreset(doc.id));
    d1.notes = 'one';
    await store.savePreset(d1);
    assert.deepEqual(revs(store, doc.id), [1]);
    const current = store.getPreset(doc.id);
    const globalRev = store.rev;
    const entry = await store.snapshotRevision(doc.id, '  my checkpoint  ');
    assert.equal(entry.rev, 2);
    assert.equal(entry.label, 'my checkpoint');
    assert.equal(typeof entry.at, 'string');
    assert.deepEqual(revs(store, doc.id), [1, 2]);
    assert.deepEqual(store.getRevision(doc.id, 2).doc, current, 'labelled snapshot = the current document');
    assert.deepEqual(store.getPreset(doc.id), current, 'a snapshot does not change the document');
    assert.equal(store.rev, globalRev, 'a snapshot is not a library mutation');
    const d2 = structuredClone(current);
    d2.notes = 'two';
    await store.savePreset(d2);
    assert.deepEqual(revs(store, doc.id), [1, 2, 3], 'the labelled snapshot was not coalesced into');
    assert.equal(store.getRevision(doc.id, 2).label, 'my checkpoint');
    assert.deepEqual(store.getRevision(doc.id, 2).doc, current, 'the labelled snapshot is untouched');
});

test('snapshotRevision rejects an empty label (400) and an unknown preset (404)', async () => {
    const { store, doc } = await storeWithDoc();
    await assert.rejects(() => store.snapshotRevision(doc.id, '   '), (/** @type {any} */ e) => e.status === 400);
    await assert.rejects(() => store.snapshotRevision(doc.id, /** @type {any} */ (42)), (/** @type {any} */ e) => e.status === 400);
    await assert.rejects(() => store.snapshotRevision('p_nope', 'x'), (/** @type {any} */ e) => e.status === 404);
    assert.deepEqual(revs(store, doc.id), []);
});

test('listRevisions / getRevision 404 for a preset that is not in the library (no path escapes)', async () => {
    const { store } = await storeWithDoc();
    assert.throws(() => store.listRevisions('..'), (/** @type {any} */ e) => e.status === 404);
    assert.throws(() => store.listRevisions('p_nope'), (/** @type {any} */ e) => e.status === 404);
    assert.throws(() => store.getRevision('..', 1), (/** @type {any} */ e) => e.status === 404);
});

test('restoreRevision: snapshots the current state first (labelled), restores content, keeps id/name/folder', async () => {
    const { store, doc } = await storeWithDoc();
    const orig = store.getPreset(doc.id);
    const edited = structuredClone(orig);
    edited.notes = 'edited';
    edited.blocks.a.content = 'changed a';
    await store.savePreset(edited); // rev 1 = orig
    const renamed = structuredClone(store.getPreset(doc.id));
    renamed.name = 'Rev Preset Renamed';
    await store.savePreset(renamed, { label: 'rename' }); // rev 2 (labelled)
    const current = store.getPreset(doc.id);
    const pathBefore = store.index.get(doc.id).path;

    const out = await store.restoreRevision(doc.id, 1);
    const after = store.getPreset(doc.id);
    assert.deepEqual(out.doc, after);
    assert.equal(out.snapshotRev, 3);
    // content from revision 1
    assert.equal(after.notes, orig.notes);
    assert.equal(after.blocks.a.content, 'content a');
    assert.deepEqual(after.loadouts, orig.loadouts);
    // identity and location from the current document
    assert.equal(after.id, doc.id);
    assert.equal(after.name, 'Rev Preset Renamed');
    assert.equal(after.createdAt, current.createdAt);
    assert.equal(after.rev, current.rev + 1);
    assert.equal(store.index.get(doc.id).path, pathBefore, 'the file did not move back to the old name');
    // the pre-restore state is its own labelled revision
    assert.deepEqual(revs(store, doc.id), [1, 2, 3]);
    const pre = store.getRevision(doc.id, 3);
    assert.deepEqual(pre.doc, current);
    assert.match(pre.label, /restore/i);
    assert.match(pre.label, /1/);
    // the restored-from snapshot is untouched
    assert.equal(store.getRevision(doc.id, 1).doc.notes, orig.notes);
});

test('restoreRevision: unknown revision / preset is a 404 and writes nothing', async () => {
    const { store, doc } = await storeWithDoc();
    const before = store.getPreset(doc.id);
    await assert.rejects(() => store.restoreRevision(doc.id, 7), (/** @type {any} */ e) => e.status === 404);
    await assert.rejects(() => store.restoreRevision('p_nope', 1), (/** @type {any} */ e) => e.status === 404);
    assert.deepEqual(revs(store, doc.id), []);
    assert.deepEqual(store.getPreset(doc.id), before);
});

test('restoreRevision of the slotted preset marks the desired slot changed; a vanished desired loadout falls back to the active one', async () => {
    const { store, doc } = await storeWithDoc();
    const orig = store.getPreset(doc.id);
    // add a second loadout and make the slot desire it
    const two = structuredClone(orig);
    two.loadouts.l_second = { ...structuredClone(two.loadouts[two.activeLoadoutId]), id: 'l_second', name: 'Second' };
    await store.savePreset(two); // rev 1 = orig (one loadout)
    await store.mutateState((/** @type {any} */ st) => { st.presetId = doc.id; st.loadoutId = 'l_second'; });
    const revBefore = store.rev;
    const changedBefore = store.slotChangedRev;
    const out = await store.restoreRevision(doc.id, 1);
    assert.equal(out.wasDesired, true);
    assert.ok(store.slotChangedRev > revBefore, `slotChangedRev ${store.slotChangedRev} moved past ${revBefore} (was ${changedBefore})`);
    assert.ok(store.slotChangedRev <= store.rev);
    assert.equal(store.state.loadoutId, null, 'desired loadout l_second no longer exists');
    assert.equal(store.state.presetId, doc.id);
    // persisted, not just in memory
    const onDisk = JSON.parse(fs.readFileSync(store.stateFile, 'utf8'));
    assert.equal(onDisk.slotChangedRev, store.slotChangedRev);
    assert.equal(onDisk.loadoutId, null);
    assert.equal(onDisk.rev, store.rev);
});

test('restoreRevision of a preset NOT in the slot leaves the slot state alone', async () => {
    const { store, doc } = await storeWithDoc();
    const other = await store.importPreset({ st: sampleSt(), name: 'Other' });
    await store.mutateState((/** @type {any} */ st) => { st.presetId = other.id; st.loadoutId = null; });
    const e = structuredClone(store.getPreset(doc.id));
    e.notes = 'x';
    await store.savePreset(e);
    const changedBefore = store.slotChangedRev;
    const out = await store.restoreRevision(doc.id, 1);
    assert.equal(out.wasDesired, false);
    assert.equal(store.slotChangedRev, changedBefore);
    assert.equal(store.state.presetId, other.id);
});
