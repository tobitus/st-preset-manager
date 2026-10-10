/**
 * Fix round 1 review: Duplicate uses a source-relative `after` anchor on
 * copyBlock. The copy lands directly below the source row IN THE SOURCE'S
 * OWN SEQUENCE, keeping the source's place in the structure:
 *   option         -> an option of the same group, right after it
 *   item           -> an item right after it (never joins a following group)
 *   group heading  -> an item right after the group's whole option run
 *   section heading-> an item, the first row of that section
 * `after` is for block payloads only and excludes `before`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure } from '../shared/outline.js';
import { copyIntoDoc, copyPayloadFromDoc, OpError } from '../shared/docops.js';
import { validateDoc } from '../shared/schema.js';
import { Store, ensureDefaultLoadout } from '../plugin/store.js';

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc, i = 0) => flattenSeq(doc.sequences[i].rows);
const ids = (/** @type {any} */ doc, i = 0) => flat(doc, i).map((e) => identOf(e.leaf));
const keyOf = (/** @type {any} */ doc, /** @type {string} */ id, i = 0) => flat(doc, i).find((e) => identOf(e.leaf) === id).leaf.key;

const IDS0 = ['a', 's', 'b', 'g', 'o1', 'o2', 'c', 'p1', 'p2'];
const IDS1 = ['x', 'y', 'z'];

/**
 * Two sequences. Sequence 0 (character 100001): a, s(section){ b, g{o1,o2},
 * c, (headerless){p1,p2} }. Sequence 1 (character 100002): x, y, z.
 * (Not 100000 + 100001: F-066 drops 100000 when 100001 is present.)
 */
function st() {
    const all = [...IDS0, ...IDS1];
    return {
        prompts: all.map((id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system', enabled: true })),
        prompt_order: [
            { character_id: 100001, order: IDS0.map((id) => ({ identifier: id, enabled: true })) },
            { character_id: 100002, order: IDS1.map((id) => ({ identifier: id, enabled: true })) },
        ],
    };
}

function shape(/** @type {any} */ doc) {
    const entries = flat(doc, 0);
    const at = (/** @type {string} */ id) => entries.find((e) => identOf(e.leaf) === id);
    const gm = { name: 'G', cardinality: 'pick-one-or-more', guessed: false };
    const pm = { name: '', cardinality: 'pick-one-or-more', guessed: false };
    Object.assign(at('s'), { rank: 'section', sname: 'S' });
    Object.assign(at('g'), { rank: 'group', gmeta: { ...gm } });
    Object.assign(at('o1'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('o2'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('p1'), { rank: 'option', gmeta: { ...pm } });
    Object.assign(at('p2'), { rank: 'option', gmeta: { ...pm } });
    doc.sequences[0].rows = rebuildSeq(entries);
    return doc;
}

function mkDoc() {
    const doc = importStPreset(st(), 'T');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    shape(doc);
    Object.assign(doc, { id: 'p_test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1 });
    assert.equal(doc.sequences.length, 2, 'fixture has two sequences');
    assert.deepEqual(validateDoc(doc), []);
    return doc;
}

/** duplicate `id` of sequence `i` via the after anchor; returns the new identifier */
function dup(/** @type {any} */ doc, /** @type {string} */ id, i = 0) {
    const payload = copyPayloadFromDoc(doc, { identifier: id });
    const res = copyIntoDoc(doc, payload, null, { after: keyOf(doc, id, i) });
    return res.identifiers[0];
}

/** the group row (in sequence 0) whose options include `id` */
function groupHolding(/** @type {any} */ doc, /** @type {string} */ id) {
    const walk = (/** @type {any[]} */ rows) => {
        for (const r of rows) {
            if (r.kind === 'group' && (r.options ?? []).some((/** @type {any} */ o) => identOf(o) === id)) return r;
            if (r.kind === 'section') { const g = walk(r.rows ?? []); if (g) return g; }
        }
        return null;
    };
    return walk(doc.sequences[0].rows);
}

test('after: the last row of a NON-first sequence -> the copy ends that sequence; sequence 0 untouched', () => {
    const doc = mkDoc();
    const seq0 = JSON.stringify(doc.sequences[0]);
    const n = dup(doc, 'z', 1);
    assert.deepEqual(ids(doc, 1), ['x', 'y', 'z', n]);
    assert.equal(JSON.stringify(doc.sequences[0]), seq0);
    assert.deepEqual(validateDoc(doc), []);
});

test('after: a mid row of a non-first sequence -> directly below it there', () => {
    const doc = mkDoc();
    const n = dup(doc, 'x', 1);
    assert.deepEqual(ids(doc, 1), ['x', n, 'y', 'z']);
});

test('after: the last option of a group -> an option of that group, right after it', () => {
    const doc = mkDoc();
    const n = dup(doc, 'o2');
    assert.deepEqual(groupHolding(doc, n)?.options.map(identOf), ['o1', 'o2', n]);
    assert.equal(identOf(groupHolding(doc, n).header), 'g');
});

test('after: a group heading -> a plain item right after the whole group', () => {
    const doc = mkDoc();
    const n = dup(doc, 'g');
    const f = flat(doc);
    const i = f.findIndex((e) => identOf(e.leaf) === n);
    assert.equal(f[i].rank, 'item');
    assert.equal(identOf(f[i - 1].leaf), 'o2');
    assert.equal(identOf(f[i + 1].leaf), 'c');
    assert.deepEqual(groupHolding(doc, 'o1').options.map(identOf), ['o1', 'o2']);
});

test('after: a section heading -> a plain item, the first row of that section', () => {
    const doc = mkDoc();
    const n = dup(doc, 's');
    const sec = doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section');
    assert.equal(identOf(sec.header), 's');
    assert.equal(identOf(sec.rows[0]), n);
    assert.equal(sec.rows[0].kind, 'block');
});

test('after: an item followed by a headerless option run -> an item before the run; the group stays intact', () => {
    const doc = mkDoc();
    const n = dup(doc, 'c');
    const f = flat(doc);
    const i = f.findIndex((e) => identOf(e.leaf) === n);
    assert.equal(f[i].rank, 'item');
    assert.equal(identOf(f[i - 1].leaf), 'c');
    assert.deepEqual(groupHolding(doc, 'p1').options.map(identOf), ['p1', 'p2']);
});

test('after: refusals leave the doc untouched (unknown key 404; with before 400; group payload 400; non-string 400)', () => {
    const cases = [
        { a: (/** @type {any} */ d) => [copyPayloadFromDoc(d, { identifier: 'a' }), null, { after: 'nope' }], status: 404 },
        { a: (/** @type {any} */ d) => [copyPayloadFromDoc(d, { identifier: 'a' }), keyOf(d, 'b'), { after: keyOf(d, 'a') }], status: 400 },
        { a: (/** @type {any} */ d) => [copyPayloadFromDoc(d, { group: groupHolding(d, 'o1').key }), null, { after: keyOf(d, 'a') }], status: 400 },
        { a: (/** @type {any} */ _d) => [copyPayloadFromDoc(_d, { identifier: 'a' }), null, { after: 7 }], status: 400 },
    ];
    for (const c of cases) {
        const doc = mkDoc();
        const snap = structuredClone(doc);
        const [payload, before, opts] = c.a(doc);
        assert.throws(() => copyIntoDoc(doc, payload, before, /** @type {any} */ (opts)),
            (/** @type {any} */ e) => e instanceof OpError && e.status === c.status);
        assert.deepEqual(doc, snap);
    }
});

test('store.copyBlock {fromPresetId: self, identifier, after} lands in the source sequence', async () => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-dup-')));
    await store.init();
    const doc = await store.importPreset({ st: st(), name: 'Dup' });
    const zKey = keyOf(doc, 'z', 1);
    const out = await store.copyBlock(doc.id, { fromPresetId: doc.id, identifier: 'z', after: zKey });
    const saved = store.getDocNow(doc.id);
    assert.deepEqual(ids(saved, 1), ['x', 'y', 'z', out.identifiers[0]]);
    assert.deepEqual(ids(saved, 0), IDS0);
});
