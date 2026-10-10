/**
 * Fix round 1, item 1: the `addSection` op inserts an FF-style section
 * heading (empty content, ON in the active loadout, rank section from the
 * start) as ONE atomic doc op. Rows below it up to the next section heading
 * become its children; an anchor inside a group snaps above the whole group.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure } from '../shared/outline.js';
import { applyDocOp, OpError } from '../shared/docops.js';
import { validateDoc } from '../shared/schema.js';
import { ensureDefaultLoadout } from '../plugin/store.js';

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const keyOf = (/** @type {any} */ doc, /** @type {string} */ id) => flat(doc).find((e) => identOf(e.leaf) === id).leaf.key;

/** ids of every leaf under a nested rows array (headers included), in order */
function idsIn(/** @type {any[]} */ rows) {
    return flattenSeq(rows).map((e) => identOf(e.leaf));
}

/** the top-level section row whose header is `id` */
function sectionOf(/** @type {any} */ doc, /** @type {string} */ id) {
    return doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section' && r.header && identOf(r.header) === id) ?? null;
}

/**
 * chatHistory(marker item), a(item), s1(section: b, g{o1,o2}, c), s2(section: d).
 * Two loadouts: the active one and 'L2'.
 */
function mkDoc() {
    const ids = ['a', 's1', 'b', 'g', 'o1', 'o2', 'c', 's2', 'd'];
    const st = {
        prompts: [
            { identifier: 'chatHistory', marker: true },
            ...ids.map((id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system', enabled: true })),
        ],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }, ...ids.map((id) => ({ identifier: id, enabled: true }))] }],
    };
    const doc = importStPreset(st, 'T');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    const entries = flat(doc);
    const at = (/** @type {string} */ id) => entries.find((e) => identOf(e.leaf) === id);
    const gm = { name: 'G', cardinality: 'pick-one-or-more', guessed: false };
    Object.assign(at('s1'), { rank: 'section', sname: 'S1' });
    Object.assign(at('g'), { rank: 'group', gmeta: { ...gm } });
    Object.assign(at('o1'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('o2'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('s2'), { rank: 'section', sname: 'S2' });
    doc.sequences[0].rows = rebuildSeq(entries);
    const active = doc.loadouts[doc.activeLoadoutId];
    doc.loadouts.L2 = { id: 'L2', name: 'Other', notes: '', kind: 'root', parent: null, enabled: { ...active.enabled }, overrides: {} };
    Object.assign(doc, { id: 'p_test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1 });
    assert.deepEqual(validateDoc(doc), [], 'fixture doc is valid');
    return doc;
}

test('addSection: no anchor appends an empty section heading at the end, ON in the active loadout only', () => {
    const doc = mkDoc();
    const before = new Set([...Object.keys(doc.blocks), ...doc.markers.map((/** @type {any} */ m) => m.identifier)]);
    const res = applyDocOp(doc, 'addSection', { name: '== New section ==' });
    assert.equal(typeof res.identifier, 'string');
    assert.equal(typeof res.key, 'string');
    assert.ok(!before.has(res.identifier), 'fresh identifier');
    const last = flat(doc).at(-1);
    assert.equal(identOf(last.leaf), res.identifier);
    assert.equal(last.leaf.key, res.key);
    assert.equal(last.rank, 'section');
    const block = doc.blocks[res.identifier];
    assert.equal(block.name, '== New section ==');
    assert.equal(block.content, '');
    assert.equal(block.role, 'system');
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled[res.identifier], true);
    assert.equal(doc.loadouts.L2.enabled[res.identifier], false);
    const sec = sectionOf(doc, res.identifier);
    assert.ok(sec, 'a top-level section row headed by the new block');
    assert.equal(sec.name, '== New section ==');
    assert.deepEqual(sec.rows, []);
    // s2 keeps d
    assert.deepEqual(idsIn(sectionOf(doc, 's2').rows), ['d']);
    assert.deepEqual(validateDoc(doc), []);
});

test('addSection: the name is trimmed', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addSection', { name: '   == X ==  ' });
    assert.equal(doc.blocks[res.identifier].name, '== X ==');
});

test('addSection before the first row of a section takes every row of that section', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addSection', { name: '== N ==', before: keyOf(doc, 'b') });
    assert.deepEqual(sectionOf(doc, 's1').rows, []);
    assert.deepEqual(idsIn(sectionOf(doc, res.identifier).rows), ['b', 'g', 'o1', 'o2', 'c']);
    assert.deepEqual(idsIn(sectionOf(doc, 's2').rows), ['d']);
    assert.deepEqual(flat(doc).map((e) => identOf(e.leaf)),
        ['chatHistory', 'a', 's1', res.identifier, 'b', 'g', 'o1', 'o2', 'c', 's2', 'd']);
    assert.deepEqual(validateDoc(doc), []);
});

test('addSection mid-section splits it: rows from the anchor to the next section heading move under the new heading', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addSection', { name: '== N ==', before: keyOf(doc, 'c') });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2']);
    assert.deepEqual(idsIn(sectionOf(doc, res.identifier).rows), ['c']);
    assert.deepEqual(idsIn(sectionOf(doc, 's2').rows), ['d']);
});

test('addSection anchored on a group option snaps above the whole group (the group stays intact)', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addSection', { name: '== N ==', before: keyOf(doc, 'o2') });
    const sec = sectionOf(doc, res.identifier);
    assert.deepEqual(idsIn(sec.rows), ['g', 'o1', 'o2', 'c']);
    const grp = sec.rows.find((/** @type {any} */ r) => r.kind === 'group');
    assert.equal(identOf(grp.header), 'g');
    assert.deepEqual(grp.options.map(identOf), ['o1', 'o2']);
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b']);
});

test('addSection anchored on a group heading lands right above it', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addSection', { name: '== N ==', before: keyOf(doc, 'g') });
    assert.deepEqual(idsIn(sectionOf(doc, res.identifier).rows), ['g', 'o1', 'o2', 'c']);
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b']);
});

test('addSection before a top-level item takes the rows up to the next section heading', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addSection', { name: '== N ==', before: keyOf(doc, 'a') });
    assert.deepEqual(idsIn(sectionOf(doc, res.identifier).rows), ['a']);
    assert.equal(doc.sequences[0].rows[0].kind, 'marker', 'the marker above stays at the top level');
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', 'c']);
});

test('addSection before a section heading makes an empty section right above it', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addSection', { name: '== N ==', before: keyOf(doc, 's2') });
    assert.deepEqual(sectionOf(doc, res.identifier).rows, []);
    assert.deepEqual(idsIn(sectionOf(doc, 's2').rows), ['d']);
    const order = flat(doc).map((e) => identOf(e.leaf));
    assert.equal(order.indexOf(res.identifier) + 1, order.indexOf('s2'));
});

test('addSection refuses an unknown anchor with 404 and leaves the doc untouched', () => {
    const doc = mkDoc();
    const snap = structuredClone(doc);
    assert.throws(() => applyDocOp(doc, 'addSection', { name: '== N ==', before: 'no-such-key' }),
        (/** @type {any} */ e) => e instanceof OpError && e.status === 404);
    assert.deepEqual(doc, snap);
});

test('addSection refuses a missing or blank name with 400 and leaves the doc untouched', () => {
    for (const a of [{}, { name: '' }, { name: '   ' }, { name: 7 }]) {
        const doc = mkDoc();
        const snap = structuredClone(doc);
        assert.throws(() => applyDocOp(doc, 'addSection', a),
            (/** @type {any} */ e) => e instanceof OpError && e.status === 400, JSON.stringify(a));
        assert.deepEqual(doc, snap);
    }
});
