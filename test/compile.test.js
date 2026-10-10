/**
 * Compile + groups unit tests: layer order (item 21), pick-one normalisation
 * through compile, connection-key stripping, base fallback, hash stability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, stripConnectionKeys, diffKeys } from '../shared/compile.js';
import { normalize } from '../shared/groups.js';
import { importStPreset } from '../shared/recognizers.js';
import { ensureDefaultLoadout } from '../plugin/store.js';

function fixtureDoc() {
    const st = {
        temperature: 0.7,
        stream_openai: true,
        chat_completion_source: 'custom',
        custom_url: 'https://should.not.survive/v1',
        proxy_password: 'sekrit',
        prompts: [
            { identifier: 'chatHistory', marker: true, name: 'Chat History', system_prompt: true },
            { identifier: 'aaa', name: 'Alpha', content: 'alpha text', role: 'system', enabled: true },
            { identifier: 'bbb', name: 'Beta', content: 'beta text', role: 'user', enabled: false, injection_position: 1, injection_depth: 4 },
            { identifier: 'ccc', name: 'Gamma', content: 'gamma text', role: 'system', enabled: true },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'aaa', enabled: true },
            { identifier: 'bbb', enabled: false },
            { identifier: 'ccc', enabled: true },
        ] }],
    };
    const doc = importStPreset(st, 'fixture');
    doc.id = 'p_test';
    doc.createdAt = doc.updatedAt = new Date().toISOString();
    doc.rev = 1;
    ensureDefaultLoadout(doc);
    return doc;
}

const MODEL = {
    name: 'Kimi K3',
    tunings: { default: { temperature: 0.3, top_p: 0.95 }, ov: { temperature: 0.9 } },
    defaultTuning: 'default',
};

test('compile: loadout bits drive prompt_order; markers ride verbatim', () => {
    const doc = fixtureDoc();
    const { compiled } = compile(doc, null, {});
    const order = compiled.prompt_order[0].order;
    assert.deepEqual(order, [
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'aaa', enabled: true },
        { identifier: 'bbb', enabled: false },
        { identifier: 'ccc', enabled: true },
    ]);
    const marker = compiled.prompts.find((p) => p.identifier === 'chatHistory');
    assert.equal(marker.marker, true);
    const beta = compiled.prompts.find((p) => p.identifier === 'bbb');
    assert.equal(beta.injection_depth, 4); // fields ride verbatim
    assert.equal(beta.enabled, false);
    assert.equal('notes' in beta, false); // no library fields leak
});

test('compile: strips connection keys and preset selector', () => {
    const doc = fixtureDoc();
    const { compiled } = compile(doc, null, {});
    for (const key of ['chat_completion_source', 'custom_url', 'proxy_password']) {
        assert.equal(key in compiled, false, `${key} must be stripped`);
    }
    assert.equal('preset_settings_openai' in compiled, false);
});

test('compile: tunings layer order is the default tuning -> a loadout override bound to a named tuning (items 16+21)', () => {
    const doc = fixtureDoc();
    const lid = doc.activeLoadoutId;
    const dflt = compile(doc, MODEL, {});
    assert.equal(dflt.compiled.temperature, 0.3); // default tuning applies with no binding
    assert.equal(dflt.compiled.top_p, 0.95);
    doc.loadouts[lid].overrides['Kimi K3'] = { enabled: {}, tuning: 'ov' };
    const withModel = compile(doc, MODEL, {});
    assert.equal(withModel.compiled.temperature, 0.9); // bound tuning beats the default
    const noModel = compile(doc, null, {});
    assert.equal(noModel.compiled.temperature, 0.7); // document settings survive (imported passthrough)
});

test('compile: loadout per-model override applies on top of loadout (item 21)', () => {
    const doc = fixtureDoc();
    const lid = doc.activeLoadoutId;
    doc.loadouts[lid].enabled.aaa = false;
    doc.loadouts[lid].overrides['Kimi K3'] = { enabled: { aaa: true, ccc: false }, tuning: null };
    const { compiled } = compile(doc, MODEL, {});
    const order = Object.fromEntries(compiled.prompt_order[0].order.map((o) => [o.identifier, o.enabled]));
    assert.equal(order.aaa, true); // override wins under Kimi
    assert.equal(order.ccc, false);
    // and without a model the loadout stands
    const { compiled: bare } = compile(doc, null, {});
    const bareOrder = Object.fromEntries(bare.prompt_order[0].order.map((o) => [o.identifier, o.enabled]));
    assert.equal(bareOrder.aaa, false);
    assert.equal(bareOrder.ccc, true);
});

test('compile: pick-one collapses to the last enabled member (groups.normalize)', () => {
    const doc = fixtureDoc();
    // turn doc into a pick-one group over bbb/ccc via a group row
    doc.sequences[0].rows.push({
        kind: 'group', key: 'grp:test', name: 'choice', cardinality: 'pick-one', guessed: false,
        header: { kind: 'block', ref: 'aaa', enabled: true, key: 'x1' },
        options: [
            { kind: 'block', ref: 'bbb', enabled: true, key: 'x2' },
            { kind: 'block', ref: 'ccc', enabled: true, key: 'x3' },
        ],
    });
    const lid = doc.activeLoadoutId;
    for (const k of ['aaa', 'bbb', 'ccc']) doc.loadouts[lid].enabled[k] = true;
    const { compiled } = compile(doc, null, {});
    const order = Object.fromEntries(compiled.prompt_order[0].order.map((o) => [o.identifier, o.enabled]));
    // the group has three members (heading aaa + options bbb/ccc); the last
    // enabled one in outline order wins, siblings go off
    assert.equal(order.aaa, false);
    assert.equal(order.bbb, false);
    assert.equal(order.ccc, true);
});

test('groups.normalize: mutating map in place, reports flips', () => {
    const doc = fixtureDoc();
    doc.sequences[0].rows.push({
        kind: 'group', key: 'grp:test', name: 'choice', cardinality: 'pick-one', guessed: false,
        header: null,
        options: [
            { kind: 'block', ref: 'bbb', enabled: true, key: 'x2' },
            { kind: 'block', ref: 'ccc', enabled: true, key: 'x3' },
        ],
    });
    const enabled = { aaa: true, bbb: true, ccc: true, chatHistory: true };
    const changed = [];
    normalize(doc, enabled, changed);
    assert.equal(enabled.bbb, false);
    assert.equal(enabled.ccc, true);
    assert.deepEqual(changed, ['bbb']);
});

test('groups.normalize: the option just switched on wins over outline order', () => {
    const doc = fixtureDoc();
    doc.sequences[0].rows.push({
        kind: 'group', key: 'grp:test', name: 'choice', cardinality: 'pick-one', guessed: false,
        header: null,
        options: [
            { kind: 'block', ref: 'bbb', enabled: true, key: 'x2' },
            { kind: 'block', ref: 'ccc', enabled: false, key: 'x3' },
        ],
    });
    // panel turns the EARLIER option (bbb) on while the LATER one (ccc) is
    // selected: bbb must win; without the preferred hint the old code kept
    // ccc (last in outline order) and instantly reverted the user's click
    const enabled = { aaa: true, bbb: true, ccc: true, chatHistory: true };
    const changed = [];
    normalize(doc, enabled, changed, 'bbb');
    assert.equal(enabled.bbb, true);
    assert.equal(enabled.ccc, false);
    assert.deepEqual(changed, ['ccc']);
    // an ambiguous bulk state (no preferred) still collapses to outline order
    const enabled2 = { aaa: true, bbb: true, ccc: true, chatHistory: true };
    const changed2 = [];
    normalize(doc, enabled2, changed2, null);
    assert.equal(enabled2.bbb, false);
    assert.equal(enabled2.ccc, true);
    // a preferred that is not in the group is ignored
    const enabled3 = { aaa: true, bbb: true, ccc: true, chatHistory: true };
    normalize(doc, enabled3, [], 'chatHistory');
    assert.equal(enabled3.bbb, false);
    assert.equal(enabled3.ccc, true);
});

test('compile: base fills keys the document lacks (Default.json base, PLAN §1.3)', () => {
    const doc = fixtureDoc();
    const base = { temperature: 5, openai_max_tokens: 300, names_behavior: 0, proxy_password: 'nope' };
    const { compiled } = compile(doc, null, base);
    assert.equal(compiled.openai_max_tokens, 300);
    assert.equal(compiled.names_behavior, 0);
    assert.equal(compiled.temperature, 0.7); // document settings still win over base
    assert.equal('proxy_password' in compiled, false);
});

test('compile: hash is stable and input-sensitive', () => {
    const doc = fixtureDoc();
    const a = compile(doc, null, {});
    const b = compile(doc, null, {});
    assert.equal(a.hash, b.hash);
    doc.settings.temperature = 0.99;
    const c = compile(doc, null, {});
    assert.notEqual(a.hash, c.hash);
});

test('stripConnectionKeys + diffKeys behave', () => {
    const snap = { temperature: 1, custom_url: 'x', prompts: [] };
    const clean = stripConnectionKeys(snap);
    assert.equal('custom_url' in clean, false);
    assert.deepEqual(diffKeys({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }), ['b', 'c']);
});
