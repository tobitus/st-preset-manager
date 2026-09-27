/**
 * Store + schema + slot routing tests (plugin side, pure fs on a tmp root).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, ensureDefaultLoadout } from '../plugin/store.js';
import { validateDoc, validateRegistry, splitSnapshot } from '../shared/schema.js';
import { routePanelDiff, applyOrderToSequences, deleteBlockFromDoc } from '../plugin/slot.js';
import { compile } from '../shared/compile.js';
import { importStPreset } from '../shared/recognizers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-test-'));
    return new Store(root);
}

function sampleSt() {
    return {
        temperature: 0.5,
        prompts: [
            { identifier: 'chatHistory', marker: true },
            { identifier: 'a', name: 'A', content: 'content a', role: 'system', enabled: true },
            { identifier: 'b', name: 'B', content: 'content b', role: 'system', enabled: true },
            { identifier: 'c', name: 'C', content: 'content c', role: 'system', enabled: false },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
            { identifier: 'c', enabled: false },
        ] }],
    };
}

async function storeWithDoc() {
    const store = tmpStore();
    await store.init();
    const doc = await store.importPreset({ st: sampleSt(), name: 'Test Preset' });
    return { store, doc };
}

test('store: import -> library -> get roundtrip; name conflict is 409', async () => {
    const { store, doc } = await storeWithDoc();
    const lib = store.listLibrary();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].name, 'Test Preset');
    assert.equal(lib[0].loadouts.length, 1);
    assert.deepEqual(store.getPreset(doc.id), doc);
    await assert.rejects(
        () => store.importPreset({ st: sampleSt(), name: 'Test Preset' }),
        (err) => /** @type {{status?: number}} */ (err).status === 409,
    );
    // replace: true wins
    const doc2 = await store.importPreset({ st: sampleSt(), name: 'Test Preset', replace: true });
    assert.notEqual(doc2.id, doc.id);
});

test('store: import rejects non-CC JSON with 400', async () => {
    const store = tmpStore();
    await store.init();
    await assert.rejects(
        () => store.importPreset({ st: { foo: 'bar' }, name: 'x' }),
        (err) => /** @type {{status?: number, message?: string}} */ (err).status === 400
            && /not a Chat Completion preset/.test(/** @type {{message?: string}} */ (err).message ?? ''),
    );
});

test('store: savePreset bumps doc rev, writes a revision, rename moves the file', async () => {
    const { store, doc } = await storeWithDoc();
    doc.notes = 'edited';
    const saved = await store.savePreset(doc);
    assert.equal(saved.rev, 2);
    assert.equal(saved.notes, 'edited');
    assert.deepEqual(store.listRevisions(doc.id).map((r) => r.rev), [1]);
    saved.name = 'Renamed';
    await store.savePreset(saved);
    assert.ok(store.findByName('Renamed'));
    assert.equal(store.findByName('Test Preset'), null);
    assert.ok(fs.readdirSync(path.join(store.root, 'presets')).includes('Renamed.json'));
});

test('store: revisions coalesce within 5 minutes, labelled always writes', async () => {
    const { store, doc } = await storeWithDoc();
    doc.notes = 'first';
    await store.savePreset(doc);
    doc.notes = 'second';
    await store.savePreset(doc); // coalesced into revision 1
    assert.deepEqual(store.listRevisions(doc.id).map((r) => r.rev), [1]);
    doc.notes = 'third';
    await store.savePreset(doc, { label: 'checkpoint' });
    assert.deepEqual(store.listRevisions(doc.id).map((r) => r.rev), [1, 2]);
    assert.equal(store.getRevision(doc.id, 2).label, 'checkpoint');
});

test('store: state + models mutation bump the global rev monotonically', async () => {
    const { store } = await storeWithDoc();
    const r0 = store.rev;
    await store.mutateState((st) => { st.presetId = 'p_x'; });
    await store.mutateModels((reg) => { reg.models['Kimi K3'] = { id: 'm_1', name: 'Kimi K3', matches: [], profiles: [], preferredProfile: null, tuning: {} }; });
    assert.equal(store.rev, r0 + 2);
    assert.equal(store.state.presetId, 'p_x');
    assert.ok(store.models.models['Kimi K3']);
});

test('schema: validateDoc rejects bad documents with paths', () => {
    assert.deepEqual(validateDoc({ format: 'st-preset-manager/library' }), [
        'version', 'id', 'name', 'tags', 'notes', 'source', 'settings', 'markers', 'blocks', 'sequences',
        'loadouts', 'activeLoadoutId', 'tuningOverrides', 'createdAt', 'updatedAt', 'rev',
    ]);
    const st = sampleSt();
    const doc = importStPreset(st, 'ok');
    ensureDefaultLoadout(doc);
    doc.id = 'p_x';
    doc.createdAt = doc.updatedAt = 'now';
    doc.rev = 1;
    assert.deepEqual(validateDoc(doc), []);
    doc.settings.chat_completion_source = 'custom'; // connection key must never be stored
    assert.ok(validateDoc(doc).includes('settings.chat_completion_source (connection key — never stored)'));
});

test('schema: registry validation', () => {
    assert.deepEqual(validateRegistry({ version: 1, models: {} }), []);
    const errs = validateRegistry({ version: 1, models: { M: { id: '', name: 'M', matches: [{}], profiles: null, preferredProfile: 5, tuning: { evil: 1 } } } });
    assert.ok(errs.length >= 5);
});

test('schema: splitSnapshot classifies keys', () => {
    const { settings, tuning, rejected } = splitSnapshot({ temperature: 1, custom_url: 'x', wi_format: 'f', prompts: [], prompt_order: [] });
    assert.deepEqual(tuning, { temperature: 1 });
    assert.deepEqual(settings, { wi_format: 'f' });
    assert.deepEqual(rejected, ['custom_url']);
});

test('slot routing: toggle in panel goes to loadout; pick-one sibling collapses', () => {
    const st = {
        temperature: 0.5,
        prompts: [
            { identifier: 'chatHistory', marker: true },
            { identifier: 'h', name: 'H', content: 'h', role: 'system', enabled: true },
            { identifier: 'o1', name: 'O1', content: '1', role: 'system', enabled: true },
            { identifier: 'o2', name: 'O2', content: '2', role: 'system', enabled: false },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'h', enabled: true },
            { identifier: 'o1', enabled: true },
            { identifier: 'o2', enabled: false },
        ] }],
    };
    const doc = importStPreset(st, 'g');
    ensureDefaultLoadout(doc);
    doc.sequences[0].rows.push({
        kind: 'group', key: 'grp:x', name: 'pick', cardinality: 'pick-one', guessed: false, header: null,
        options: [
            { kind: 'block', ref: 'o1', enabled: true, key: 'k1' },
            { kind: 'block', ref: 'o2', enabled: false, key: 'k2' },
        ],
    });
    const { compiled } = compile(doc, null, {});
    // panel turns o2 on while o1 is on: loadout gets o2 on, normalize turns o1 off
    const snap = structuredClone(compiled);
    snap.prompt_order[0].order.find((o) => o.identifier === 'o2').enabled = true;
    const { routed } = routePanelDiff(doc, compiled, snap, null);
    assert.ok(routed.some((r) => r.key === 'o2' && r.layer === 'loadout'));
    assert.ok(routed.some((r) => r.layer === 'group:pick-one'));
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled.o2, true);
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled.o1, false);
});

test('slot routing: no Model -> temperature goes to doc settings with warning', () => {
    const st = sampleSt();
    const doc = importStPreset(st, 'x');
    ensureDefaultLoadout(doc);
    const { compiled } = compile(doc, null, {});
    const snap = structuredClone(compiled);
    snap.temperature = 0.42;
    const { routed, warnings, globalTuning } = routePanelDiff(doc, compiled, snap, null);
    assert.equal(doc.settings.temperature, 0.42);
    assert.ok(routed.some((r) => r.key === 'temperature' && r.layer === 'settings'));
    assert.equal(warnings.length, 1);
    assert.equal(globalTuning, null);
});

test('slot routing: with a Model override, tuning goes to the preset override (item 21)', () => {
    const st = sampleSt();
    const doc = importStPreset(st, 'x');
    ensureDefaultLoadout(doc);
    doc.tuningOverrides['Kimi K3'] = {};
    const { compiled } = compile(doc, { name: 'Kimi K3', tuning: {} }, {});
    const snap = structuredClone(compiled);
    snap.temperature = 0.55;
    const { routed } = routePanelDiff(doc, compiled, snap, /** @type {{name: string, tuning?: Record<string, unknown>|null}|null} */ ({ name: 'Kimi K3', tuning: {} }));
    assert.equal(doc.tuningOverrides['Kimi K3'].temperature, 0.55);
    assert.ok(routed.some((r) => r.key === 'temperature' && r.layer === 'tuningOverride:Kimi K3'));
});

test('slot routing: reorder in panel reorders sequences (blocks layer)', () => {
    const st = sampleSt();
    const doc = importStPreset(st, 'x');
    ensureDefaultLoadout(doc);
    const { compiled } = compile(doc, null, {});
    const snap = structuredClone(compiled);
    const order = snap.prompt_order[0].order;
    // move b before a: a, b, c -> b, a, c
    const reordered = [order.find((o) => o.identifier === 'chatHistory'), order.find((o) => o.identifier === 'b'), order.find((o) => o.identifier === 'a'), order.find((o) => o.identifier === 'c')];
    snap.prompt_order[0].order = reordered;
    const { routed } = routePanelDiff(doc, compiled, snap, null);
    assert.ok(routed.some((r) => r.key === 'prompt_order.order'));
    const flat = doc.sequences[0].rows.filter((r) => r.kind === 'block').map((r) => r.ref);
    assert.deepEqual(flat, ['b', 'a', 'c']);
});

test('slot routing: panel order moves leaves out of groups/sections verbatim', () => {
    const doc = {
        sequences: [{ character_id: 1, rows: [
            { kind: 'section', key: 's', name: 'S', header: { kind: 'block', ref: 'h1', enabled: true, key: 'k1' }, rows: [
                { kind: 'block', ref: 'a', enabled: true, key: 'k2' },
                { kind: 'block', ref: 'b', enabled: true, key: 'k3' },
            ] },
        ] }],
        loadouts: {}, activeLoadoutId: null, blocks: {},
    };
    applyOrderToSequences(doc, ['b', 'a', 'h1']);
    const flat = doc.sequences[0].rows.map((r) => r.ref ?? r.identifier);
    assert.deepEqual(flat, ['b', 'a', 'h1']);
    deleteBlockFromDoc(doc, 'a');
    const flat2 = doc.sequences[0].rows.map((r) => r.ref ?? r.identifier);
    assert.deepEqual(flat2, ['b', 'h1']);
    assert.equal(doc.blocks.a, undefined);
});

test('store: shelf add/list/remove', async () => {
    const { store, doc } = await storeWithDoc();
    const entry = await store.shelfAdd({ fromPresetId: doc.id, identifier: 'a' });
    assert.equal(entry.name, 'A');
    assert.equal(store.shelfList().length, 1);
    await store.shelfRemove(entry.id);
    assert.equal(store.shelfList().length, 0);
    await assert.rejects(() => store.shelfAdd({ fromPresetId: doc.id, identifier: 'nope' }), (/** @type {{status?: number}} */ e) => e.status === 404);
});
