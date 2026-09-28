/**
 * ST-format export (roadmap item 18, acceptance 9 export half + 11): the
 * export is plain ST preset JSON compiled from the ACTIVE loadout with no
 * Model tuning and no per-Model override; groups, notes and every other
 * library-only field never appear; a preset imported and exported unchanged
 * carries the source's order, enabled bits, prompt text/injection and
 * non-connection settings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exportSt } from '../shared/compile.js';
import { importStPreset } from '../shared/recognizers.js';
import { rebuildSeq, flattenSeq } from '../shared/outline.js';
import { CONNECTION_KEYS } from '../shared/st-keys.js';
import { ensureDefaultLoadout } from '../plugin/store.js';

const REPO = path.resolve(import.meta.dirname, '..');
const FF_FILE = 'Freaky Frankenstein 5.4 Internal States (2).json';

function loadFixture(rel) {
    for (const dir of [
        path.join(REPO, 'dev/fixtures/presets'),
        path.join(process.env.HOME ?? '', 'projects/sillysystem/st/data/default-user/OpenAI Settings'),
    ]) {
        const f = path.join(dir, rel);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    return null;
}

/** Same pipeline as Store.importPreset: recognize, default loadout, normalize structure. */
function docFrom(st, name = 'doc') {
    const doc = importStPreset(st, name);
    doc.id = 'p_export_test';
    doc.createdAt = doc.updatedAt = '2026-09-28T00:00:00.000Z';
    doc.rev = 1;
    ensureDefaultLoadout(doc);
    for (const seq of doc.sequences) seq.rows = rebuildSeq(flattenSeq(seq.rows));
    return doc;
}

/** Every key name anywhere in a JSON value. */
function allKeys(value, acc = new Set()) {
    if (Array.isArray(value)) for (const v of value) allKeys(v, acc);
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) { acc.add(k); allKeys(v, acc); }
    }
    return acc;
}

function smallSt() {
    return {
        temperature: 0.7,
        wi_format: '{0}',
        chat_completion_source: 'custom',
        custom_url: 'https://should.not.survive/v1',
        prompts: [
            { identifier: 'chatHistory', marker: true, name: 'Chat History', system_prompt: true },
            { identifier: 'hdr', name: '=Pick one POV 👇 ====', content: '', role: 'system', enabled: false },
            { identifier: 'o1', name: 'First person', content: 'one', role: 'system', enabled: true },
            { identifier: 'o2', name: 'Third person', content: 'two', role: 'system', enabled: false },
            { identifier: 'deep', name: 'Deep', content: 'deep text', role: 'user', enabled: true, injection_position: 1, injection_depth: 4 },
        ],
        // the group runs hdr..o2 and ends at the chatHistory marker (FF rule)
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'hdr', enabled: false },
            { identifier: 'o1', enabled: true },
            { identifier: 'o2', enabled: false },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'deep', enabled: true },
        ] }],
    };
}

test('exportSt: no library-only keys anywhere, even with notes/tunings/overrides set', () => {
    const doc = docFrom(smallSt());
    doc.notes = 'preset note';
    doc.tags = ['t'];
    doc.blocks.o1.notes = 'block note';
    doc.tuningOverrides = { 'Kimi K3': { temperature: 0.01 } };
    const lid = doc.activeLoadoutId;
    doc.loadouts[lid].notes = 'loadout note';
    doc.loadouts[lid].overrides = { 'Kimi K3': { enabled: { deep: false } } };
    const out = exportSt(doc);
    const keys = allKeys(out);
    for (const k of ['notes', 'groups', 'cardinality', 'guessed', 'options', 'rows', 'sequences',
        'loadouts', 'activeLoadoutId', 'tuningOverrides', 'blocks', 'markers', 'format', 'version',
        'source', 'tags', 'fields', 'id', 'rev', 'createdAt', 'updatedAt', 'folder', 'preset_settings_openai']) {
        assert.equal(keys.has(k), false, `export carries library-only key "${k}"`);
    }
    for (const k of CONNECTION_KEYS) assert.equal(k in out, false, `export carries connection key ${k}`);
    // no Model tuning, no override: the document's own value and the loadout bit
    assert.equal(out.temperature, 0.7);
    assert.equal(out.prompt_order[0].order.find((o) => o.identifier === 'deep').enabled, true);
    assert.equal(out.wi_format, '{0}');
});

test('exportSt: compiles the ACTIVE loadout, not the first one', () => {
    const doc = docFrom(smallSt());
    const a = doc.activeLoadoutId;
    doc.loadouts.l_b = { ...structuredClone(doc.loadouts[a]), id: 'l_b', name: 'B' };
    doc.loadouts.l_b.enabled.deep = false;
    assert.equal(exportSt(doc).prompt_order[0].order.find((o) => o.identifier === 'deep').enabled, true);
    doc.activeLoadoutId = 'l_b';
    const out = exportSt(doc);
    assert.equal(out.prompt_order[0].order.find((o) => o.identifier === 'deep').enabled, false);
    assert.equal(out.prompts.find((p) => p.identifier === 'deep').enabled, false);
});

test('exportSt: a pick-one group exports at most one option on', () => {
    const doc = docFrom(smallSt());
    const group = doc.sequences[0].rows.find((r) => r.kind === 'group');
    assert.ok(group, 'fixture must recognize the FF-style group');
    assert.equal(group.cardinality, 'pick-one');
    const lo = doc.loadouts[doc.activeLoadoutId];
    lo.enabled.o1 = true;
    lo.enabled.o2 = true;
    const order = exportSt(doc).prompt_order[0].order;
    const on = order.filter((o) => ['o1', 'o2'].includes(o.identifier) && o.enabled);
    assert.equal(on.length, 1);
});

test('exportSt: does not mutate the document', () => {
    const doc = docFrom(smallSt());
    const before = structuredClone(doc);
    exportSt(doc);
    assert.deepEqual(doc, before);
});

test('exportSt: FF 5.4 import → export keeps order, bits, prompt text/injection, settings', (t) => {
    const src = loadFixture(FF_FILE);
    if (!src) return t.skip(`fixture ${FF_FILE} not available`);
    const doc = docFrom(structuredClone(src), 'FF');
    const out = exportSt(doc);
    const keys = allKeys(out);
    for (const k of ['notes', 'groups', 'cardinality']) assert.equal(keys.has(k), false, k);
    assert.equal(out.prompt_order.length, src.prompt_order.length);
    src.prompt_order.forEach((seq, i) => {
        assert.equal(out.prompt_order[i].character_id, seq.character_id);
        assert.deepEqual(
            out.prompt_order[i].order.map((o) => [o.identifier, !!o.enabled]),
            seq.order.map((o) => [o.identifier, !!o.enabled]),
        );
    });
    const outById = new Map(out.prompts.map((p) => [p.identifier, p]));
    const seen = new Set();
    for (const p of src.prompts) {
        if (seen.has(p.identifier)) continue; // duplicate identifiers: first wins (v1)
        seen.add(p.identifier);
        const q = outById.get(p.identifier);
        assert.ok(q, `prompt ${p.identifier} missing from export`);
        for (const f of ['name', 'content', 'role', 'injection_position', 'injection_depth', 'injection_order', 'injection_trigger', 'forbid_overrides']) {
            if (p[f] !== undefined) assert.deepEqual(q[f], p[f], `${p.identifier}.${f}`);
        }
    }
    for (const [k, v] of Object.entries(src)) {
        if (k === 'prompts' || k === 'prompt_order' || CONNECTION_KEYS.includes(k)) continue;
        assert.deepEqual(out[k], v, `setting ${k}`);
    }
});
