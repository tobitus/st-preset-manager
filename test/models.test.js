/**
 * Model registry helpers (roadmap items 21, 22; PLAN §1.2 models.json):
 * seed from connection profiles, merge suggestions, owner-driven merge,
 * resolution, and pick-one completion of per-Model loadout overrides.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeTail, sourceOfApi, resolveModel, seedFromProfiles, suggestMerges, mergeModels,
} from '../shared/models.js';
import { completeOverride } from '../shared/groups.js';
import { validateRegistry } from '../shared/schema.js';

/** @param {string} id @param {string|undefined} api @param {string|undefined} model @param {{preset?: string, exclude?: string[], mode?: string, name?: string}} [o] */
const P = (id, api, model, { preset, exclude = ['preset'], mode = 'cc', name } = {}) => ({
    id, name: name ?? id, mode, api, model, exclude, ...(preset ? { preset } : {}),
});

const FIXTURE = [
    P('p-mock', 'custom', 'mock'),
    P('p-mock-default', 'custom', 'mock', { preset: 'Default', exclude: [] }),
    P('p-hap', 'custom', 'hapuppy/kimi-k3'),
    P('p-nano', 'custom', 'nanogpt-payg/moonshotai/kimi-k3'),
];

const empty = () => ({ version: 1, models: {} });

test('normalizeTail: lower-case, provider prefix up to the last / dropped', () => {
    assert.equal(normalizeTail('hapuppy/kimi-k3'), 'kimi-k3');
    assert.equal(normalizeTail('nanogpt-sub/moonshotai/kimi-K3'), 'kimi-k3');
    assert.equal(normalizeTail('mock'), 'mock');
    assert.equal(normalizeTail('A/'), '');
});

test('sourceOfApi: profile api -> chat_completion_source (ST CONNECT_API_MAP aliases)', () => {
    assert.equal(sourceOfApi('custom'), 'custom');
    assert.equal(sourceOfApi('openrouter'), 'openrouter');
    assert.equal(sourceOfApi('oai'), 'openai');
    assert.equal(sourceOfApi('google'), 'makersuite');
    assert.equal(sourceOfApi(undefined), '');
});

test('seedFromProfiles: one Model per distinct (source, model), named by the raw id, valid registry', () => {
    const { models, mergeSuggestions } = seedFromProfiles(FIXTURE, empty());
    assert.deepEqual(Object.keys(models), ['mock', 'hapuppy/kimi-k3', 'nanogpt-payg/moonshotai/kimi-k3']);
    assert.deepEqual(models.mock.matches, [{ source: 'custom', model: 'mock' }]);
    assert.deepEqual(models.mock.profiles, ['p-mock', 'p-mock-default']);
    assert.equal(models.mock.name, 'mock');
    assert.deepEqual(models.mock.tuning, {});
    assert.equal(typeof models.mock.id, 'string');
    const ids = Object.values(models).map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'Model ids are unique');
    assert.deepEqual(validateRegistry({ version: 1, models }), []);
    // suggestions are raw-id groups by normalized tail; nothing is merged
    assert.deepEqual(mergeSuggestions, [['hapuppy/kimi-k3', 'nanogpt-payg/moonshotai/kimi-k3']]);
});

test('seedFromProfiles: preferredProfile = first connection-only profile (exclude has preset), else first', () => {
    const profiles = [
        P('linked', 'custom', 'mock', { preset: 'Default', exclude: [] }),
        P('clean', 'custom', 'mock'),
        P('only-linked', 'custom', 'x/y', { preset: 'FF', exclude: [] }),
    ];
    const { models } = seedFromProfiles(profiles, empty());
    assert.equal(models.mock.preferredProfile, 'clean');
    assert.equal(models['x/y'].preferredProfile, 'only-linked');
});

test('seedFromProfiles: skips non-cc, model-less and already-matched profiles; api alias maps to source', () => {
    const reg = { version: 1, models: {
        'Kimi K3': { id: 'm_kimi', name: 'Kimi K3', matches: [{ source: 'custom', model: 'hapuppy/kimi-k3' }], profiles: [], preferredProfile: null, tuning: { temperature: 0.3 } },
    } };
    const profiles = [
        P('tc', 'kobold', 'whatever', { mode: 'tc' }),
        P('nomodel', 'custom', undefined),
        P('empty', 'custom', ''),
        P('hap', 'custom', 'hapuppy/kimi-k3'),
        P('g', 'google', 'gemini-9'),
    ];
    const { models, mergeSuggestions } = seedFromProfiles(profiles, reg);
    assert.deepEqual(Object.keys(models), ['gemini-9'], 'only the new Model is returned');
    assert.deepEqual(models['gemini-9'].matches, [{ source: 'makersuite', model: 'gemini-9' }]);
    assert.deepEqual(mergeSuggestions, []);
});

test('seedFromProfiles: same model id under two sources -> two Models, no name collision', () => {
    const profiles = [P('a', 'custom', 'glm-5'), P('b', 'openrouter', 'glm-5')];
    const { models } = seedFromProfiles(profiles, empty());
    const names = Object.keys(models);
    assert.equal(names.length, 2);
    assert.equal(names[0], 'glm-5');
    assert.notEqual(names[1], 'glm-5');
    assert.deepEqual(models[names[1]].matches, [{ source: 'openrouter', model: 'glm-5' }]);
    assert.equal(models[names[1]].name, names[1]);
    assert.notEqual(models[names[0]].id, models[names[1]].id);
    assert.deepEqual(validateRegistry({ version: 1, models }), []);
});

test('seedFromProfiles: a name already taken in the registry is not reused', () => {
    const reg = { version: 1, models: {
        mock: { id: 'm_mock', name: 'mock', matches: [{ source: 'openai', model: 'other' }], profiles: [], preferredProfile: null, tuning: {} },
    } };
    const { models } = seedFromProfiles([P('p', 'custom', 'mock')], reg);
    const [name] = Object.keys(models);
    assert.ok(name && name !== 'mock', `seeded name ${name} must not collide`);
    assert.notEqual(models[name].id, 'm_mock');
});

test('suggestMerges: groups Model NAMES sharing a normalized tail; singletons omitted', () => {
    const { models } = seedFromProfiles([
        ...FIXTURE,
        P('p-sub', 'custom', 'nanogpt-sub/moonshotai/kimi-K3'),
    ], empty());
    const reg = { version: 1, models };
    assert.deepEqual(suggestMerges(reg), [['hapuppy/kimi-k3', 'nanogpt-payg/moonshotai/kimi-k3', 'nanogpt-sub/moonshotai/kimi-K3']]);
    assert.deepEqual(suggestMerges(empty()), []);
});

test('mergeModels: owner merge of two ids -> one Model with both matches; input untouched', () => {
    const { models } = seedFromProfiles(FIXTURE, empty());
    models['hapuppy/kimi-k3'].tuning = { temperature: 0.3, top_p: 0.9 };
    models['nanogpt-payg/moonshotai/kimi-k3'].tuning = { temperature: 1.5, top_k: 40 };
    const reg = { version: 1, models };
    const before = JSON.stringify(reg);
    const out = mergeModels(reg, ['hapuppy/kimi-k3', 'nanogpt-payg/moonshotai/kimi-k3'], 'Kimi K3');
    assert.equal(JSON.stringify(reg), before, 'input registry not mutated');
    assert.deepEqual(Object.keys(out.models), ['mock', 'Kimi K3'], 'merged Model takes the first merged name\'s position');
    const k = out.models['Kimi K3'];
    assert.equal(k.name, 'Kimi K3');
    assert.equal(k.id, models['hapuppy/kimi-k3'].id);
    assert.deepEqual(k.matches, [
        { source: 'custom', model: 'hapuppy/kimi-k3' },
        { source: 'custom', model: 'nanogpt-payg/moonshotai/kimi-k3' },
    ]);
    assert.deepEqual(k.profiles, ['p-hap', 'p-nano']);
    assert.equal(k.preferredProfile, 'p-hap');
    assert.deepEqual(k.tuning, { temperature: 0.3, top_p: 0.9, top_k: 40 }, 'first listed wins on conflicts');
    assert.deepEqual(validateRegistry(out), []);
    // both raw ids now resolve to the merged Model
    assert.equal(resolveModel(out, { source: 'custom', model: 'nanogpt-payg/moonshotai/kimi-k3' })?.name, 'Kimi K3');
    assert.equal(resolveModel(out, { source: 'custom', model: 'hapuppy/kimi-k3' })?.name, 'Kimi K3');
});

test('mergeModels: the new name may reuse a merged name; duplicate matches/profiles collapse', () => {
    const reg = { version: 1, models: {
        A: { id: 'm_a', name: 'A', matches: [{ source: 'custom', model: 'x' }], profiles: ['p1'], preferredProfile: null, tuning: {} },
        B: { id: 'm_b', name: 'B', matches: [{ source: 'custom', model: 'x' }, { source: 'custom', model: 'y' }], profiles: ['p1', 'p2'], preferredProfile: 'p2', tuning: {} },
    } };
    const out = mergeModels(reg, ['A', 'B'], 'B');
    assert.deepEqual(Object.keys(out.models), ['B']);
    assert.deepEqual(out.models.B.matches, [{ source: 'custom', model: 'x' }, { source: 'custom', model: 'y' }]);
    assert.deepEqual(out.models.B.profiles, ['p1', 'p2']);
    assert.equal(out.models.B.preferredProfile, 'p2', 'first non-null preferredProfile');
});

test('mergeModels: refuses <2 names, unknown names, an empty name, and a name owned by another Model', () => {
    const reg = { version: 1, models: {
        A: { id: 'm_a', name: 'A', matches: [], profiles: [], preferredProfile: null, tuning: {} },
        B: { id: 'm_b', name: 'B', matches: [], profiles: [], preferredProfile: null, tuning: {} },
        C: { id: 'm_c', name: 'C', matches: [], profiles: [], preferredProfile: null, tuning: {} },
    } };
    assert.throws(() => mergeModels(reg, ['A'], 'X'));
    assert.throws(() => mergeModels(reg, ['A', 'Z'], 'X'));
    assert.throws(() => mergeModels(reg, ['A', 'B'], '   '));
    assert.throws(() => mergeModels(reg, ['A', 'B'], 'C'));
});

test('resolveModel: exact (source, model) first, then connection-profile id; source matters', () => {
    const reg = { version: 1, models: {
        ByProfile: { id: 'm_1', name: 'ByProfile', matches: [], profiles: ['prof-9'], preferredProfile: null, tuning: {} },
        ByMatch: { id: 'm_2', name: 'ByMatch', matches: [{ source: 'custom', model: 'm' }], profiles: [], preferredProfile: null, tuning: {} },
    } };
    assert.equal(resolveModel(reg, { source: 'custom', model: 'm', profileId: 'prof-9' })?.name, 'ByMatch');
    assert.equal(resolveModel(reg, { source: 'openrouter', model: 'm', profileId: 'prof-9' })?.name, 'ByProfile');
    assert.equal(resolveModel(reg, { source: 'openrouter', model: 'm', profileId: null }), null);
});

// ---------------------------------------------------------------- overrides

const GROUP_DOC = {
    sequences: [{ character_id: 100001, rows: [
        { kind: 'group', key: 'g', name: 'POV', cardinality: 'pick-one', header: { kind: 'block', ref: 'hdr', key: 'k0' },
            options: [{ kind: 'block', ref: 'a', key: 'k1' }, { kind: 'block', ref: 'b', key: 'k2' }] },
        { kind: 'group', key: 'g2', name: 'Extras', cardinality: 'pick-one-or-more', header: null,
            options: [{ kind: 'block', ref: 'x', key: 'k3' }, { kind: 'block', ref: 'y', key: 'k4' }] },
        { kind: 'block', ref: 'c', key: 'k5' },
    ] }],
};

test('completeOverride: a pick-one option switched on pulls its siblings off in the override', () => {
    const out = completeOverride(GROUP_DOC, { b: true });
    assert.deepEqual(out, { b: true, hdr: false, a: false });
});

test('completeOverride: non-pick-one members and plain blocks are left as given', () => {
    assert.deepEqual(completeOverride(GROUP_DOC, { x: true, c: true }), { x: true, c: true });
    assert.deepEqual(completeOverride(GROUP_DOC, { a: false }), { a: false });
});

test('completeOverride: two options on in one pick-one group -> the later key wins; input untouched', () => {
    const input = { a: true, b: true };
    const out = completeOverride(GROUP_DOC, input);
    assert.deepEqual(out, { a: false, b: true, hdr: false });
    assert.deepEqual(input, { a: true, b: true });
});
