/**
 * Phase 4 plugin side (PLAN §1.2 models.json, §1.4 model reporting, §1.5
 * profile backup, §1.4 panel routing): registry seed/replace/tuning, the
 * slot's Model state, the profile backup file, and panel routing of toggles
 * and sampler edits onto the matching layer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StoreError } from '../plugin/store.js';
import { routePanelDiff } from '../plugin/slot.js';
import { compile } from '../shared/compile.js';

async function tmpStore() {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-p4-')));
    await store.init();
    return store;
}

/** @param {string} id @param {string} model @param {{preset?: string, exclude?: string[]}} [o] */
const P = (id, model, { preset, exclude = ['preset'] } = {}) => ({
    id, name: id, mode: 'cc', api: 'custom', model, exclude, ...(preset ? { preset } : {}),
});
const FIXTURE = [
    P('p-mock', 'mock'),
    P('p-mock-default', 'mock', { preset: 'Default', exclude: [] }),
    P('p-hap', 'hapuppy/kimi-k3'),
    P('p-nano', 'nanogpt-payg/moonshotai/kimi-k3'),
];

const onDisk = (store) => JSON.parse(fs.readFileSync(path.join(store.root, 'models.json'), 'utf8'));

function kimiRegistry() {
    return { version: 1, models: {
        'Kimi K3': { id: 'm_kimi', name: 'Kimi K3', profiles: ['p-hap', 'p-nano'], preferredProfile: 'p-hap', tuning: { temperature: 0.3 },
            matches: [{ source: 'custom', model: 'hapuppy/kimi-k3' }, { source: 'custom', model: 'nanogpt-payg/moonshotai/kimi-k3' }] },
        Mock: { id: 'm_mock', name: 'Mock', profiles: ['p-mock'], preferredProfile: 'p-mock', tuning: { temperature: 1.1 },
            matches: [{ source: 'custom', model: 'mock' }] },
    } };
}

// ------------------------------------------------------------------ models

test('seedModels: writes one Model per distinct id, returns added + suggestions; a re-seed adds nothing and does not bump rev', async () => {
    const store = await tmpStore();
    const r1 = await store.seedModels(FIXTURE);
    assert.deepEqual(r1.added, ['mock', 'hapuppy/kimi-k3', 'nanogpt-payg/moonshotai/kimi-k3']);
    assert.deepEqual(Object.keys(onDisk(store).models), r1.added, 'written to models.json');
    assert.deepEqual(Object.keys(r1.models), r1.added, 'returns the full registry models');
    assert.deepEqual(r1.mergeSuggestions, [['hapuppy/kimi-k3', 'nanogpt-payg/moonshotai/kimi-k3']]);
    const rev = store.rev;
    const r2 = await store.seedModels(FIXTURE);
    assert.deepEqual(r2.added, []);
    assert.equal(store.rev, rev, 'nothing added -> no write, no rev bump');
    assert.deepEqual(r2.mergeSuggestions, [['hapuppy/kimi-k3', 'nanogpt-payg/moonshotai/kimi-k3']]);
});

test('replaceModels: validated whole-registry replace; an invalid body is a 400 and changes nothing', async () => {
    const store = await tmpStore();
    await store.replaceModels(kimiRegistry());
    assert.deepEqual(onDisk(store), kimiRegistry());
    const bad = kimiRegistry();
    /** @type {any} */ (bad.models.Mock).tuning = { custom_url: 'x' };
    await assert.rejects(() => store.replaceModels(bad), (e) => e instanceof StoreError && e.status === 400);
    assert.deepEqual(onDisk(store), kimiRegistry());
    assert.deepEqual(store.models, kimiRegistry());
});

test('setModelTuning: replaces one Model\'s global tuning; unknown Model 404, non-tuning key 400', async () => {
    const store = await tmpStore();
    await store.replaceModels(kimiRegistry());
    const m = await store.setModelTuning('Kimi K3', { temperature: 0.55, top_p: 0.8 });
    assert.deepEqual(m.tuning, { temperature: 0.55, top_p: 0.8 });
    assert.deepEqual(onDisk(store).models['Kimi K3'].tuning, { temperature: 0.55, top_p: 0.8 });
    assert.deepEqual(onDisk(store).models.Mock.tuning, { temperature: 1.1 }, 'other Models untouched');
    await assert.rejects(() => store.setModelTuning('Nope', { temperature: 1 }), (e) => e instanceof StoreError && e.status === 404);
    await assert.rejects(() => store.setModelTuning('Mock', { custom_model: 'x' }), (e) => e instanceof StoreError && e.status === 400);
    assert.deepEqual(onDisk(store).models.Mock.tuning, { temperature: 1.1 });
});

// --------------------------------------------------------------- slot model

test('setSlotModel: resolves the raw id; identical raw is a no-op; same Model via another provider keeps slotChangedRev; another Model bumps it', async () => {
    const store = await tmpStore();
    await store.replaceModels(kimiRegistry());

    const a = await store.setSlotModel({ source: 'custom', model: 'hapuppy/kimi-k3', profileId: 'p-hap' });
    assert.equal(a.modelId, 'Kimi K3');
    assert.equal(a.changed, true);
    assert.equal(a.modelChanged, true);
    assert.equal(store.state.modelId, 'Kimi K3');
    assert.deepEqual(store.state.raw, { source: 'custom', model: 'hapuppy/kimi-k3', profileId: 'p-hap' });
    const persisted = JSON.parse(fs.readFileSync(path.join(store.root, 'state.json'), 'utf8'));
    assert.deepEqual(persisted.raw, store.state.raw, 'state.json persisted');
    const scr1 = store.slotChangedRev;

    const revBefore = store.rev;
    const same = await store.setSlotModel({ source: 'custom', model: 'hapuppy/kimi-k3', profileId: 'p-hap' });
    assert.equal(same.changed, false);
    assert.equal(store.rev, revBefore, 'identical raw: no write');

    const nano = await store.setSlotModel({ source: 'custom', model: 'nanogpt-payg/moonshotai/kimi-k3', profileId: 'p-nano' });
    assert.equal(nano.modelId, 'Kimi K3');
    assert.equal(nano.changed, true);
    assert.equal(nano.modelChanged, false);
    assert.equal(store.slotChangedRev, scr1, 'same Model -> the panel base stays valid');

    const mock = await store.setSlotModel({ source: 'custom', model: 'mock', profileId: 'p-mock' });
    assert.equal(mock.modelId, 'Mock');
    assert.equal(mock.modelChanged, true);
    assert.ok(store.slotChangedRev > scr1, 'another Model -> slot changed');

    const none = await store.setSlotModel({ source: 'custom', model: 'unknown', profileId: 'p-x' });
    assert.equal(none.modelId, null);
    assert.equal(store.state.modelId, null);
});

test('replaceModels: a registry change that re-resolves the slot\'s raw id marks the slot changed', async () => {
    const store = await tmpStore();
    await store.replaceModels(kimiRegistry());
    await store.setSlotModel({ source: 'custom', model: 'mock', profileId: 'p-mock' });
    const scr = store.slotChangedRev;
    await store.replaceModels(kimiRegistry()); // same resolution
    assert.equal(store.slotChangedRev, scr);
    const renamed = kimiRegistry();
    renamed.models.Mocky = { ...renamed.models.Mock, name: 'Mocky' };
    delete renamed.models.Mock;
    await store.replaceModels(renamed);
    assert.ok(store.slotChangedRev > scr);
    assert.equal(store.state.modelId, 'Mocky');
});

// ----------------------------------------------------------- profile backup

test('backupProfiles: writes backups/profiles-*.json with every profile verbatim; never overwrites', async () => {
    const store = await tmpStore();
    const r1 = await store.backupProfiles(FIXTURE);
    assert.equal(r1.count, 4);
    assert.ok(r1.file.startsWith(path.join(store.root, 'backups') + path.sep));
    assert.match(path.basename(r1.file), /^profiles-.+\.json$/);
    const body = JSON.parse(fs.readFileSync(r1.file, 'utf8'));
    assert.deepEqual(body.profiles, FIXTURE);
    const r2 = await store.backupProfiles(FIXTURE.slice(0, 1));
    assert.notEqual(r2.file, r1.file);
    assert.deepEqual(JSON.parse(fs.readFileSync(r1.file, 'utf8')).profiles, FIXTURE, 'first backup intact');
    await assert.rejects(() => store.backupProfiles(/** @type {any} */ ('nope')), (e) => e instanceof StoreError && e.status === 400);
});

// ------------------------------------------------------------ panel routing

function routingDoc() {
    return {
        settings: {},
        markers: [],
        blocks: Object.fromEntries(['hdr', 'a', 'b', 'c', 'kimi'].map((id) => [id, { identifier: id, name: id, content: id, role: 'system', fields: {} }])),
        sequences: [{ character_id: 100001, rows: [
            { kind: 'group', key: 'g', name: 'POV', cardinality: 'pick-one', header: { kind: 'block', ref: 'hdr', key: 'k0' },
                options: [{ kind: 'block', ref: 'a', key: 'k1' }, { kind: 'block', ref: 'b', key: 'k2' }] },
            { kind: 'block', ref: 'c', key: 'k3' },
            { kind: 'block', ref: 'kimi', key: 'k4' },
        ] }],
        loadouts: { L: { id: 'L', name: 'L', notes: '', enabled: { hdr: false, a: true, b: false, c: true, kimi: false },
            overrides: { 'Kimi K3': { enabled: { kimi: true } } } } },
        activeLoadoutId: 'L',
        tuningOverrides: {},
    };
}
const toggle = (id, on) => ({ prompt_order: { changed: false, order: [{ identifier: id, enabled: on }] } });
const KIMI = { name: 'Kimi K3', tuning: { temperature: 0.3 } };

test('routing: a toggle of a block the Model override lists goes to the override, loadout untouched', () => {
    const doc = routingDoc();
    const { routed } = routePanelDiff(doc, null, toggle('kimi', false), KIMI);
    assert.equal(doc.loadouts.L.overrides['Kimi K3'].enabled.kimi, false);
    assert.equal(doc.loadouts.L.enabled.kimi, false);
    assert.deepEqual(routed, [{ key: 'kimi', layer: 'override:Kimi K3' }]);
});

test('routing: a toggle of a block the override does NOT list goes to the loadout (item 21), override untouched', () => {
    const doc = routingDoc();
    const { routed } = routePanelDiff(doc, null, toggle('c', false), KIMI);
    assert.equal(doc.loadouts.L.enabled.c, false);
    assert.deepEqual(doc.loadouts.L.overrides['Kimi K3'].enabled, { kimi: true });
    assert.deepEqual(routed, [{ key: 'c', layer: 'loadout' }]);
});

test('routing: with another Model (no override) the same toggle goes to the loadout', () => {
    const doc = routingDoc();
    routePanelDiff(doc, null, toggle('kimi', true), { name: 'Mock', tuning: {} });
    assert.equal(doc.loadouts.L.enabled.kimi, true);
    assert.deepEqual(doc.loadouts.L.overrides['Kimi K3'].enabled, { kimi: true });
});

test('routing: a pick-one option the override lists, switched on, turns its siblings off IN THE OVERRIDE; compile shows it', () => {
    const doc = routingDoc();
    doc.loadouts.L.overrides['Kimi K3'].enabled.b = false;
    routePanelDiff(doc, null, toggle('b', true), KIMI);
    const ov = doc.loadouts.L.overrides['Kimi K3'].enabled;
    assert.equal(ov.b, true);
    assert.equal(ov.a, false);
    assert.equal(ov.hdr, false);
    assert.equal(doc.loadouts.L.enabled.a, true, 'loadout keeps its own choice');
    assert.equal(doc.loadouts.L.enabled.b, false);
    const { enabled } = compile(doc, KIMI, {});
    assert.equal(enabled.b, true);
    assert.equal(enabled.a, false);
});

test('routing: temperature goes to the preset\'s tuning override when one exists for the Model, else to the global tuning', () => {
    const withOv = routingDoc();
    withOv.tuningOverrides['Kimi K3'] = { temperature: 0.9 };
    const r1 = routePanelDiff(withOv, null, { temperature: 0.55 }, KIMI);
    assert.equal(withOv.tuningOverrides['Kimi K3'].temperature, 0.55);
    assert.equal(r1.globalTuning, null);

    const noOv = routingDoc();
    const r2 = routePanelDiff(noOv, null, { temperature: 0.55 }, KIMI);
    assert.deepEqual(r2.globalTuning, { temperature: 0.55 });
    assert.deepEqual(noOv.tuningOverrides, {});
    assert.equal(noOv.settings.temperature, undefined);
});

test('compile with the resolved Model: global tuning, then the preset override, then the loadout override', async () => {
    const { resolveModel } = await import('../shared/models.js');
    const reg = kimiRegistry();
    const doc = routingDoc();
    const kimi = resolveModel(reg, { source: 'custom', model: 'nanogpt-payg/moonshotai/kimi-k3', profileId: null });
    const mock = resolveModel(reg, { source: 'custom', model: 'mock', profileId: null });
    assert.equal(compile(doc, kimi, {}).compiled.temperature, 0.3, 'global Kimi tuning');
    assert.equal(compile(doc, mock, {}).compiled.temperature, 1.1, 'global Mock tuning');
    assert.equal(compile(doc, kimi, {}).enabled.kimi, true, 'Kimi loadout override on');
    assert.equal(compile(doc, mock, {}).enabled.kimi, false, 'loadout bit for other Models');
    doc.tuningOverrides['Kimi K3'] = { temperature: 0.9 };
    assert.equal(compile(doc, kimi, {}).compiled.temperature, 0.9, 'preset override beats global');
    assert.equal(compile(doc, mock, {}).compiled.temperature, 1.1);
});
