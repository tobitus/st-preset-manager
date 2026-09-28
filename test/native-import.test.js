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

test('native: replace:true on a taken name replaces it with an otherwise identical doc', async () => {
    const store = await freshStore();
    const exported = await richDoc(store);
    const replaced = await store.importPreset({ native: structuredClone(exported), replace: true });
    const { id: _a, ...r1 } = replaced;
    const { id: _b, ...r2 } = exported;
    assert.deepEqual(r1, r2);
    const lib = store.listLibrary();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].id, replaced.id);
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
