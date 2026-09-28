/**
 * POST /presets {native} (roadmap item 18, acceptance 11 native half) and the
 * clean-400 rule for non-preset input (acceptance 10), at the Store level.
 * Native import is lossless: a document exported from one library imports
 * into another byte-for-byte (same id when that id is free there). In the
 * SAME library an import never overwrites the existing document silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../plugin/store.js';
import { nativeShapeErrors } from '../shared/schema.js';

async function freshStore() {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-native-')));
    await store.init();
    return store;
}

function sampleSt() {
    return {
        temperature: 0.5,
        prompts: [
            { identifier: 'chatHistory', marker: true },
            { identifier: 'hdr', name: '=Pick one POV 👇 ====', content: '', role: 'system', enabled: false },
            { identifier: 'a', name: 'A', content: 'content a', role: 'system', enabled: true },
            { identifier: 'b', name: 'B', content: 'content b', role: 'system', enabled: false },
            { identifier: 'c', name: 'C', content: 'content c', role: 'user', enabled: true, injection_position: 1, injection_depth: 2 },
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

/** A library doc carrying every library-only layer (notes, tags, 2 loadouts, overrides, tunings). */
async function richDoc(store) {
    const imported = await store.importPreset({ st: sampleSt(), name: 'Rich', tags: ['x'] });
    const doc = store.getPreset(imported.id);
    doc.notes = 'preset notes';
    doc.blocks.a.notes = 'block notes';
    const lid = doc.activeLoadoutId;
    doc.loadouts.l_second = { ...structuredClone(doc.loadouts[lid]), id: 'l_second', name: 'Second', notes: 'loadout notes' };
    doc.loadouts.l_second.enabled.c = false;
    doc.loadouts[lid].overrides = { 'Kimi K3': { enabled: { b: true } } };
    doc.tuningOverrides = { 'Kimi K3': { temperature: 0.9 } };
    await store.savePreset(doc);
    return store.getPreset(imported.id);
}

test('native: export from one library imports into another identically (id kept when free)', async () => {
    const a = await freshStore();
    const exported = await richDoc(a);
    assert.equal(exported.rev, 2, 'precondition: the doc was saved once after import');
    const b = await freshStore();
    const imported = await b.importPreset({ native: structuredClone(exported) });
    assert.deepEqual(imported, exported);
    assert.deepEqual(b.getPreset(exported.id), exported);
    assert.equal(b.listLibrary().length, 1);
});

test('native: re-importing into the SAME library never overwrites silently (409 on the name)', async () => {
    const store = await freshStore();
    const exported = await richDoc(store);
    await assert.rejects(
        () => store.importPreset({ native: structuredClone(exported) }),
        (/** @type {any} */ err) => err.status === 409 && err.conflict === exported.id,
    );
    assert.deepEqual(store.getPreset(exported.id), exported, 'original untouched after the 409');
    assert.equal(store.listLibrary().length, 1);
});

test('native: same library under a new name → a second document with a fresh id, original untouched', async () => {
    const store = await freshStore();
    const exported = await richDoc(store);
    const copy = await store.importPreset({ native: { ...structuredClone(exported), name: 'Rich copy' } });
    assert.notEqual(copy.id, exported.id);
    const { id: _i1, name: _n1, ...restCopy } = copy;
    const { id: _i2, name: _n2, ...restOrig } = exported;
    assert.deepEqual(restCopy, restOrig);
    assert.deepEqual(store.getPreset(exported.id), exported);
    assert.equal(store.listLibrary().length, 2);
});

test('native: body.name imports a copy under that name (into a subfolder); original untouched', async () => {
    const store = await freshStore();
    const exported = await richDoc(store);
    const copy = await store.importPreset({ native: structuredClone(exported), name: 'Renamed copy', folder: 'deep/nest' });
    assert.equal(copy.name, 'Renamed copy');
    assert.equal(copy.folder, 'deep/nest');
    assert.notEqual(copy.id, exported.id);
    assert.ok(fs.existsSync(path.join(store.root, 'presets', 'deep', 'nest', 'Renamed copy.json')));
    assert.deepEqual(store.getPreset(exported.id), exported);
    assert.equal(store.listLibrary().length, 2);
});

test('replace: native replace:true keeps the SAME document identity and history', async () => {
    const store = await freshStore();
    const before = await richDoc(store);
    const revsBefore = store.listRevisions(before.id).length;
    const upload = structuredClone(before);
    upload.notes = 'replaced notes';
    const replaced = await store.importPreset({ native: upload, replace: true });
    assert.equal(replaced.id, before.id, 'replace keeps the id');
    assert.equal(replaced.createdAt, before.createdAt, 'replace keeps createdAt');
    assert.equal(replaced.rev, before.rev + 1, 'replace is a new revision of the same doc');
    assert.equal(replaced.notes, 'replaced notes');
    const { rev: _r1, updatedAt: _u1, notes: _n1, ...restNew } = replaced;
    const { rev: _r2, updatedAt: _u2, notes: _n2, ...restOld } = before;
    assert.deepEqual(restNew, restOld, 'everything else is the upload');
    assert.deepEqual(store.getPreset(before.id), replaced);
    const lib = store.listLibrary();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].id, before.id);
    const revs = store.listRevisions(before.id);
    assert.ok(revs.length >= revsBefore && revs.length >= 1, 'history kept (not deleted)');
    const newest = store.getRevision(before.id, revs.at(-1).rev);
    assert.deepEqual(newest.doc, before, 'the pre-replace document is snapshotted');
});

test('replace: replacing the slot preset (native or ST) keeps the slot bound and compilable', async () => {
    const { compile } = await import('../shared/compile.js');
    for (const kind of ['native', 'st']) {
        const store = await freshStore();
        const doc = await richDoc(store);
        const lid = doc.activeLoadoutId;
        await store.mutateState((st) => { st.presetId = doc.id; st.loadoutId = lid; });
        const changedBefore = store.slotChangedRev ?? 0;
        const body = kind === 'native'
            ? { native: { ...structuredClone(doc), notes: 'n2' }, replace: true }
            : { st: sampleSt(), name: doc.name, replace: true };
        const out = await store.importPreset(body);
        assert.equal(out.id, doc.id, `${kind}: id kept`);
        assert.equal(store.state.presetId, doc.id, `${kind}: slot still names the doc`);
        const live = store.getDocNow(store.state.presetId);
        assert.ok(live, `${kind}: the slot's document exists`);
        const lo = store.state.loadoutId ?? live.activeLoadoutId;
        assert.ok(live.loadouts[lo], `${kind}: the desired loadout exists in the new doc`);
        assert.doesNotThrow(() => compile(live, null, {}, lo));
        if (kind === 'native') assert.equal(store.state.loadoutId, lid, 'native: same loadout ids, desired loadout kept');
        assert.ok((store.slotChangedRev ?? 0) > changedBefore, `${kind}: slot marked changed (stale panel bases get 409)`);
    }
});

test('replace: a bad destination or invalid upload is rejected BEFORE anything is touched', async () => {
    const store = await freshStore();
    const before = await richDoc(store);
    const revs = store.listRevisions(before.id);
    const file = path.join(store.root, 'presets', 'Rich.json');
    assert.ok(fs.existsSync(file));
    const bad = [
        { native: { ...structuredClone(before), folder: '../outside' }, replace: true },
        { native: { ...structuredClone(before), folder: '/etc' }, replace: true },
        { native: { ...structuredClone(before), folder: 'a/../../b' }, replace: true },
        { native: { ...structuredClone(before), settings: { ...before.settings, custom_url: 'http://x' } }, replace: true },
        { st: sampleSt(), name: 'Rich', folder: '../outside', replace: true },
    ];
    for (const body of bad) {
        await assert.rejects(() => store.importPreset(body), (/** @type {any} */ err) => err.status === 400);
        assert.deepEqual(store.getPreset(before.id), before, 'original doc untouched');
        assert.deepEqual(store.listRevisions(before.id), revs, 'history untouched');
        assert.ok(fs.existsSync(file), 'file untouched');
        assert.equal(store.listLibrary().length, 1);
    }
    assert.equal(fs.existsSync(path.join(store.root, 'outside')), false);
});

test('native: malformed documents are a clean 400 (StoreError, never a TypeError) and write nothing', async () => {
    const store = await freshStore();
    const good = await richDoc(await freshStore());
    const bad = [
        'a string',
        42,
        [],
        [{ format: 'st-preset-manager/library' }],
        { format: 'something-else', version: 1 },
        { ...structuredClone(good), version: 2 },
        { ...structuredClone(good), sequences: 'x' },
        { ...structuredClone(good), sequences: [{ character_id: 100001, rows: 'x' }] },
        { ...structuredClone(good), sequences: [null] },
        // malformed rows deep inside, with and without loadouts (the default
        // loadout builder and the leaf-bit stripper both walk rows)
        { ...structuredClone(good), sequences: [{ character_id: 100001, rows: [null] }] },
        { ...structuredClone(good), loadouts: undefined, sequences: [{ character_id: 100001, rows: [null] }] },
        { ...structuredClone(good), loadouts: undefined, sequences: [{ character_id: 100001, rows: [{ kind: 'section', name: 's', header: null, rows: [null] }] }] },
        { ...structuredClone(good), sequences: [{ character_id: 100001, rows: [{ kind: 'group', name: 'g', cardinality: 'pick-one', guessed: true, header: null, options: 'x' }] }] },
        { ...structuredClone(good), loadouts: 'x' },
        { ...structuredClone(good), settings: { ...good.settings, chat_completion_source: 'openai' } },
    ];
    for (const native of bad) {
        await assert.rejects(
            () => store.importPreset({ native }),
            (/** @type {any} */ err) => {
                assert.equal(err instanceof TypeError, false, `TypeError for ${JSON.stringify(native).slice(0, 60)}: ${err.message}`);
                assert.equal(err.status, 400, `status for ${JSON.stringify(native).slice(0, 60)}`);
                assert.match(err.message, /native document/);
                return true;
            },
        );
    }
    assert.equal(store.listLibrary().length, 0);
    assert.equal(fs.readdirSync(path.join(store.root, 'presets')).length, 0);
});

test('nativeShapeErrors: [] for a stored doc, messages for the wrong shape', async () => {
    const good = await richDoc(await freshStore());
    assert.deepEqual(nativeShapeErrors(good), []);
    assert.ok(nativeShapeErrors('x').length > 0);
    assert.ok(nativeShapeErrors([]).length > 0);
    assert.ok(nativeShapeErrors({ ...good, format: 'x' }).some((e) => /format/.test(e)));
    assert.ok(nativeShapeErrors({ ...good, sequences: [{ character_id: 1, rows: {} }] }).some((e) => /sequences/.test(e)));
});

test('st: a non-preset JSON (array of regex scripts) is a 400 "not a Chat Completion preset", with or without a name', async () => {
    const store = await freshStore();
    const regexSuite = [{ id: 'r1', scriptName: 'x', findRegex: '/a/g', replaceString: 'b' }];
    for (const body of [{ st: regexSuite, name: 'FF5 Regex 3.0 Suite' }, { st: regexSuite }, { st: { scriptName: 'x' } }]) {
        await assert.rejects(
            () => store.importPreset(structuredClone(body)),
            (/** @type {any} */ err) => err.status === 400 && /not a Chat Completion preset/.test(err.message),
        );
    }
    assert.equal(store.listLibrary().length, 0);
});

/**
 * GET /slot runs OUTSIDE the store queue (routes.js slotView). Replicate its
 * read: the slot's doc + (desired loadout ?? the doc's active loadout).
 */
function slotRead(store, compile) {
    const doc = store.getDocNow(store.state.presetId);
    if (!doc) return { ok: false, err: 'no doc' };
    const lid = store.state.loadoutId ?? doc.activeLoadoutId;
    try {
        compile(doc, null, {}, lid);
        return { ok: true, id: doc.id, lid, notes: doc.notes };
    } catch (err) {
        return { ok: false, err: /** @type {Error} */ (err).message };
    }
}

test('replace: a GET /slot interleaved at every await of a slot replace never sees doc/loadout out of step', async () => {
    const { compile } = await import('../shared/compile.js');
    for (const kind of ['st', 'native-without-that-loadout']) {
        const store = await freshStore();
        const doc = await richDoc(store);
        await store.mutateState((st) => { st.presetId = doc.id; st.loadoutId = 'l_second'; });
        assert.ok(slotRead(store, compile).ok, 'precondition: slot compiles');
        /** @type {any[]} */
        const reads = [];
        // inject a slot read at each filesystem await of the write path
        for (const m of ['_writeRevision', '_writeDoc', '_bumpRev']) {
            const orig = store[m].bind(store);
            store[m] = async (...args) => {
                reads.push({ at: `${m}:before`, ...slotRead(store, compile) });
                const r = await orig(...args);
                reads.push({ at: `${m}:after`, ...slotRead(store, compile) });
                return r;
            };
        }
        const body = kind === 'st'
            ? { st: sampleSt(), name: doc.name, replace: true } // ST import re-mints loadout ids
            : { native: { ...structuredClone(doc), loadouts: { [doc.activeLoadoutId]: structuredClone(doc.loadouts[doc.activeLoadoutId]) } }, replace: true };
        await store.importPreset(body);
        assert.ok(reads.length >= 4, `${kind}: reads were injected (${reads.length})`);
        const bad = reads.filter((r) => !r.ok);
        assert.deepEqual(bad, [], `${kind}: every interleaved slot read compiles`);
        const final = slotRead(store, compile);
        assert.ok(final.ok, `${kind}: final slot compiles`);
        assert.equal(store.state.presetId, doc.id);
    }
});

test('replace: a slot replace that fails at the file move leaves the slot marker and state untouched', async () => {
    const store = await freshStore();
    const doc = await richDoc(store);
    await store.mutateState((st) => { st.presetId = doc.id; st.loadoutId = doc.activeLoadoutId; });
    // an unindexed file already sits at the move target
    fs.mkdirSync(path.join(store.root, 'presets', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(store.root, 'presets', 'sub', 'Rich.json'), '{}');
    const markerBefore = store.slotChangedRev ?? 0;
    const stateBefore = structuredClone(store.state);
    await assert.rejects(
        () => store.importPreset({ native: { ...structuredClone(doc), folder: 'sub', notes: 'x' }, replace: true }),
        (/** @type {any} */ err) => err.status === 409,
    );
    assert.equal(store.slotChangedRev ?? 0, markerBefore, 'no spurious slot-changed marker (it would 409 fresh panel posts)');
    assert.deepEqual(store.state, stateBefore);
    assert.deepEqual(store.getPreset(doc.id), doc);
});
