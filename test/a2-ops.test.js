/**
 * Round 2 A2 ops: dissolveGroup {key} (a group row's every option becomes a
 * plain item in place, atomically; a headed group's heading becomes a plain
 * item too) and promote/demote with `keys: string[]` (document order,
 * all-or-nothing, one op). `key` stays accepted for one row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure } from '../shared/outline.js';
import { applyDocOp } from '../shared/docops.js';
import { validateDoc } from '../shared/schema.js';
import { ensureDefaultLoadout } from '../plugin/store.js';

const IDS = ['a', 'g', 'o1', 'o2', 'c', 's', 'b', 'p1', 'p2', 'p3'];
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const keyOf = (/** @type {any} */ doc, /** @type {string} */ id) => flat(doc).find((e) => identOf(e.leaf) === id).leaf.key;

/**
 * [a, G{g: o1,o2} (headed, pick-one), c, s(section){ b, (headerless){p1,p2,p3} }]
 * — the canonical rebuildSeq form (a section runs to the end of the sequence).
 */
function mkDoc() {
    const st = {
        prompts: IDS.map((id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system' })),
        prompt_order: [{ character_id: 100001, order: IDS.map((id) => ({ identifier: id, enabled: id !== 'p2' && id !== 'o2' })) }],
    };
    const doc = importStPreset(st, 'T');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    const entries = flat(doc);
    const at = (/** @type {string} */ id) => entries.find((e) => identOf(e.leaf) === id);
    const pm = { name: '', cardinality: 'pick-one-or-more', guessed: false };
    const gm = { name: 'G', cardinality: 'pick-one', guessed: false };
    Object.assign(at('s'), { rank: 'section', sname: 'S' });
    for (const id of ['b', 'p1', 'p2', 'p3']) at(id).sname = 'S';
    for (const id of ['p1', 'p2', 'p3']) Object.assign(at(id), { rank: 'option', gmeta: { ...pm } });
    Object.assign(at('g'), { rank: 'group', gmeta: { ...gm } });
    for (const id of ['o1', 'o2']) Object.assign(at(id), { rank: 'option', gmeta: { ...gm } });
    const rows = rebuildSeq(entries);
    doc.sequences[0].rows = rows;
    // a second loadout with different bits: dissolve must not touch any loadout
    const lid0 = doc.activeLoadoutId;
    doc.loadouts.l2 = { ...structuredClone(doc.loadouts[lid0]), id: 'l2', name: 'second' };
    doc.loadouts.l2.enabled.p1 = false;
    doc.loadouts.l2.enabled.p3 = false;
    Object.assign(doc, { id: 'p_test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1 });
    assert.deepEqual(validateDoc(doc), []);
    // shape precondition
    assert.deepEqual(doc.sequences[0].rows.map((/** @type {any} */ r) => r.kind), ['block', 'group', 'block', 'section']);
    assert.deepEqual(rows[3].rows.map((/** @type {any} */ r) => r.kind), ['block', 'group']);
    assert.equal(rows[3].rows[1].header, null);
    assert.equal(identOf(rows[1].header), 'g');
    // canonical: re-deriving the structure changes nothing
    assert.deepEqual(rebuildSeq(flattenSeq(rows)), rows);
    return doc;
}

const without = (/** @type {any} */ doc) => {
    const { sequences, ...rest } = doc;
    return rest;
};

test('dissolveGroup on a headerless 3-option group: 3 plain items in place, bits and the rest of the doc unchanged', () => {
    const doc = mkDoc();
    const before = structuredClone(doc);
    const grp = doc.sequences[0].rows[3].rows[1];
    const res = applyDocOp(doc, 'dissolveGroup', { key: grp.key });
    assert.ok(res && typeof res === 'object');
    const expected = structuredClone(before.sequences);
    const bsec = expected[0].rows[3];
    bsec.rows.splice(1, 1, ...bsec.rows[1].options);
    assert.deepEqual(doc.sequences, expected);
    assert.deepEqual(without(doc), without(before));
    assert.deepEqual(flat(doc).map((e) => identOf(e.leaf)), flat(before).map((e) => identOf(e.leaf)));
    for (const id of ['p1', 'p2', 'p3']) {
        const e = flat(doc).find((x) => identOf(x.leaf) === id);
        assert.equal(e.rank, 'item');
        assert.equal(e.sname, 'S', `${id} stays inside the section`);
        assert.equal(e.leaf._gmeta, undefined, `${id} carries no group stash`);
    }
    assert.deepEqual(validateDoc(doc), []);
});

test('dissolveGroup on a headed group: the heading and both options become plain items in place', () => {
    const doc = mkDoc();
    const before = structuredClone(doc);
    const grp = doc.sequences[0].rows[1];
    applyDocOp(doc, 'dissolveGroup', { key: grp.key });
    const expected = structuredClone(before.sequences);
    const g = expected[0].rows[1];
    expected[0].rows.splice(1, 1, g.header, ...g.options);
    assert.deepEqual(doc.sequences, expected);
    assert.deepEqual(without(doc), without(before));
    for (const id of ['g', 'o1', 'o2']) {
        const e = flat(doc).find((x) => identOf(x.leaf) === id);
        assert.equal(e.rank, 'item');
        assert.equal(e.sname, null);
        assert.equal(e.leaf._gmeta, undefined);
    }
    assert.deepEqual(validateDoc(doc), []);
});

test('dissolveGroup: missing key -> 400, unknown group / a leaf key -> 404, doc untouched', () => {
    const doc = mkDoc();
    const snap = structuredClone(doc);
    assert.throws(() => applyDocOp(doc, 'dissolveGroup', {}), (/** @type {any} */ e) => e.status === 400);
    assert.throws(() => applyDocOp(doc, 'dissolveGroup', { key: 'grp:nope' }), (/** @type {any} */ e) => e.status === 404);
    assert.throws(() => applyDocOp(doc, 'dissolveGroup', { key: keyOf(doc, 'a') }), (/** @type {any} */ e) => e.status === 404);
    assert.deepEqual(doc, snap);
});

test('promote {keys} equals single promotes applied in document order, whatever order the keys come in', () => {
    const a = mkDoc();
    const b = structuredClone(a);
    const k1 = keyOf(a, 'p1');
    const k3 = keyOf(a, 'p3');
    const res = applyDocOp(a, 'promote', { keys: [k3, k1] });
    assert.deepEqual(res.keys, [k1, k3]);
    applyDocOp(b, 'promote', { key: k1 });
    applyDocOp(b, 'promote', { key: k3 });
    assert.deepEqual(a, b);
});

test('demote {keys} equals single demotes applied in document order', () => {
    const a = mkDoc();
    const b = structuredClone(a);
    const kc = keyOf(a, 'c');
    const ka = keyOf(a, 'a');
    applyDocOp(a, 'demote', { keys: [kc, ka] });
    applyDocOp(b, 'demote', { key: ka });
    applyDocOp(b, 'demote', { key: kc });
    assert.deepEqual(a, b);
});

test('promote/demote {keys}: one illegal step fails the whole op (400) and leaves the doc untouched', () => {
    const doc = mkDoc();
    const snap = structuredClone(doc);
    // s is already a section heading: top of the ladder
    assert.throws(() => applyDocOp(doc, 'promote', { keys: [keyOf(doc, 'b'), keyOf(doc, 's')] }), (/** @type {any} */ e) => e.status === 400);
    assert.deepEqual(doc, snap);
    // p1 is already an option: bottom of the ladder; a is demotable and comes first
    assert.throws(() => applyDocOp(doc, 'demote', { keys: [keyOf(doc, 'a'), keyOf(doc, 'p1')] }), (/** @type {any} */ e) => e.status === 400);
    assert.deepEqual(doc, snap);
});

test('promote/demote {keys}: bad shapes are 400, an unknown key is 404, doc untouched', () => {
    const doc = mkDoc();
    const snap = structuredClone(doc);
    for (const body of [{ keys: [] }, { keys: 'x' }, { keys: [1] }, { keys: [keyOf(doc, 'a'), keyOf(doc, 'a')] }, { key: keyOf(doc, 'a'), keys: [keyOf(doc, 'c')] }, {}]) {
        assert.throws(() => applyDocOp(doc, 'promote', body), (/** @type {any} */ e) => e.status === 400, JSON.stringify(body));
        assert.throws(() => applyDocOp(doc, 'demote', body), (/** @type {any} */ e) => e.status === 400, JSON.stringify(body));
    }
    assert.throws(() => applyDocOp(doc, 'promote', { keys: [keyOf(doc, 'a'), 'nope'] }), (/** @type {any} */ e) => e.status === 404);
    assert.deepEqual(doc, snap);
});

test('promote {key} (single) still works and returns {key}', () => {
    const doc = mkDoc();
    const k = keyOf(doc, 'c');
    assert.deepEqual(applyDocOp(doc, 'promote', { key: k }), { key: k });
    assert.equal(flat(doc).find((e) => e.leaf.key === k).rank, 'group');
});

test('buildOutline: every leaf (headings included) carries pos = its 1-based flat position in its sequence', async () => {
    const { buildOutline } = await import('../ext/outline-model.js');
    const doc = mkDoc();
    // a second sequence restarts at 1
    doc.sequences.push({ character_id: 100002, rows: structuredClone(doc.sequences[0].rows) });
    const out = buildOutline(doc);
    for (const [si, seq] of out.sequences.entries()) {
        /** @type {[string, number][]} */
        const got = [];
        const walk = (/** @type {any[]} */ nodes) => {
            for (const n of nodes) {
                if (n.type === 'leaf') got.push([n.key, n.pos]);
                else {
                    if (n.header) got.push([n.header.key, n.header.pos]);
                    walk(n.options ?? n.nodes ?? []);
                }
            }
        };
        walk(seq.nodes);
        const want = flattenSeq(doc.sequences[si].rows).map((e, i) => [e.leaf.key, i + 1]);
        assert.deepEqual(got, want, `sequence ${si}`);
    }
});
