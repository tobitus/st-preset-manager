/**
 * Fix round 4 (owner review 2026-10-15): section headings are no longer
 * move walls for items and groups. One `moveLeaf` step across a section
 * heading swaps the mover's block with THAT HEADING ONLY:
 *   down: the mover becomes the section's first row
 *   up:   the mover leaves the section and becomes the last row above the
 *         heading (the previous section, or the leading run)
 * Each step is exactly one-step invertible. Options still stop at their
 * group's edge and section-heading movers keep swapping whole blocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure, moveLeaf, OutlineError } from '../shared/outline.js';
import { applyDocOp } from '../shared/docops.js';
import { validateDoc } from '../shared/schema.js';
import { ensureDefaultLoadout } from '../plugin/store.js';

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const order = (/** @type {any} */ doc) => flat(doc).map((e) => identOf(e.leaf));
const keyOf = (/** @type {any} */ doc, /** @type {string} */ id) => flat(doc).find((e) => identOf(e.leaf) === id).leaf.key;
const entryOf = (/** @type {any} */ doc, /** @type {string} */ id) => flat(doc).find((e) => identOf(e.leaf) === id);

/** ids of every leaf under a nested rows array (headers included), in order */
function idsIn(/** @type {any[]} */ rows) {
    return flattenSeq(rows).map((e) => identOf(e.leaf));
}

/** the top-level section row whose header is `id` */
function sectionOf(/** @type {any} */ doc, /** @type {string} */ id) {
    return doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section' && r.header && identOf(r.header) === id) ?? null;
}

const MARKERS = new Set(['chatHistory', 'dialogueExamples']);

/**
 * Build a doc from `[id, rank]` pairs in flat order. `chatHistory` and
 * `dialogueExamples` are ST markers (always rank item). Section snames are the id upper-cased;
 * every group/option shares one gmeta per group heading (headerless runs
 * get their own).
 * @param {Array<[string, 'item'|'section'|'group'|'option']>} spec
 */
function mkDoc(spec) {
    const st = {
        prompts: spec.map(([id]) => (MARKERS.has(id)
            ? { identifier: id, marker: true }
            : { identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system', enabled: true })),
        prompt_order: [{ character_id: 100001, order: spec.map(([id]) => ({ identifier: id, enabled: true })) }],
    };
    const doc = importStPreset(st, 'T');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    const entries = flat(doc);
    let gm = null;
    for (const [id, rank] of spec) {
        const e = entries.find((x) => identOf(x.leaf) === id);
        if (rank === 'section') Object.assign(e, { rank, sname: id.toUpperCase(), gmeta: null });
        else if (rank === 'group') {
            gm = { name: id.toUpperCase(), cardinality: 'pick-one-or-more', guessed: false };
            Object.assign(e, { rank, gmeta: { ...gm } });
        } else if (rank === 'option') {
            gm ??= { name: '', cardinality: 'pick-one-or-more', guessed: false };
            Object.assign(e, { rank, gmeta: { ...gm } });
        } else {
            gm = null;
            Object.assign(e, { rank: 'item', gmeta: null });
        }
        if (rank === 'section') gm = null;
    }
    doc.sequences[0].rows = rebuildSeq(entries);
    Object.assign(doc, { id: 'p_test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1 });
    assert.deepEqual(validateDoc(doc), [], 'fixture doc is valid');
    assert.deepEqual(order(doc), spec.map(([id]) => id), 'fixture order');
    return doc;
}

/**
 * chatHistory (marker), x(item),
 * sA(section: a1, gA{p1,p2}), sB(section: b1, b2, dialogueExamples (marker)), sC(section: c1)
 */
const SPEC = /** @type {Array<[string, any]>} */ ([
    ['chatHistory', 'item'], ['x', 'item'],
    ['sA', 'section'], ['a1', 'item'], ['gA', 'group'], ['p1', 'option'], ['p2', 'option'],
    ['sB', 'section'], ['b1', 'item'], ['b2', 'item'], ['dialogueExamples', 'item'],
    ['sC', 'section'], ['c1', 'item'],
]);

function wellFormed(/** @type {any} */ doc) {
    assert.deepEqual(validateDoc(doc), []);
    const rows = doc.sequences[0].rows;
    assert.deepEqual(rebuildSeq(flattenSeq(rows)), rows, 'rebuildSeq(flattenSeq(rows)) is a fixed point');
}

/** move `id` by `delta` (one step), assert well-formed, then the inverse step restores the sequences exactly */
function roundTrip(/** @type {any} */ doc, /** @type {string} */ id, /** @type {1|-1} */ delta) {
    const before = structuredClone(doc.sequences);
    moveLeaf(doc, keyOf(doc, id), delta);
    wellFormed(doc);
    const after = structuredClone(doc.sequences);
    const probe = structuredClone(doc);
    moveLeaf(probe, keyOf(probe, id), /** @type {1|-1} */ (-delta));
    assert.deepEqual(probe.sequences, before, `one ${-delta} step undoes ${delta} exactly`);
    return after;
}

test('an item directly above a section heading moves down into it as the first row, and back', () => {
    const doc = mkDoc(SPEC);
    roundTrip(doc, 'x', 1);
    assert.deepEqual(order(doc), ['chatHistory', 'sA', 'x', 'a1', 'gA', 'p1', 'p2', 'sB', 'b1', 'b2', 'dialogueExamples', 'sC', 'c1']);
    assert.deepEqual(idsIn(sectionOf(doc, 'sA').rows), ['x', 'a1', 'gA', 'p1', 'p2']);
    assert.equal(entryOf(doc, 'x').rank, 'item');
    assert.equal(entryOf(doc, 'x').sname, 'SA');
    assert.equal(doc.sequences[0].rows[0].kind, 'marker', 'chatHistory stays in the leading run');
});

test('the first row of a section moves up out of it, above the heading, and back', () => {
    const doc = mkDoc(SPEC);
    roundTrip(doc, 'a1', -1);
    assert.deepEqual(order(doc), ['chatHistory', 'x', 'a1', 'sA', 'gA', 'p1', 'p2', 'sB', 'b1', 'b2', 'dialogueExamples', 'sC', 'c1']);
    assert.equal(entryOf(doc, 'a1').sname, null, 'a1 is in the leading run');
    assert.deepEqual(idsIn(sectionOf(doc, 'sA').rows), ['gA', 'p1', 'p2']);
});

test('the last row of section A moves down to be the first row of section B, and back', () => {
    const doc = mkDoc(SPEC);
    roundTrip(doc, 'dialogueExamples', 1); // a marker is an item: it crosses like one
    assert.deepEqual(idsIn(sectionOf(doc, 'sB').rows), ['b1', 'b2']);
    assert.deepEqual(idsIn(sectionOf(doc, 'sC').rows), ['dialogueExamples', 'c1']);
    assert.equal(entryOf(doc, 'dialogueExamples').rank, 'item', 'a marker lands as a plain row');
    assert.equal(sectionOf(doc, 'sC').rows[0].kind, 'marker');
});

test('the first row of section B moves up to be the last row of section A (after its group, not in it), and back', () => {
    const doc = mkDoc(SPEC);
    roundTrip(doc, 'b1', -1);
    assert.deepEqual(idsIn(sectionOf(doc, 'sA').rows), ['a1', 'gA', 'p1', 'p2', 'b1']);
    assert.equal(entryOf(doc, 'b1').rank, 'item', 'b1 does not join the group above');
    const gA = sectionOf(doc, 'sA').rows.find((/** @type {any} */ r) => r.kind === 'group');
    assert.deepEqual(gA.options.map(identOf), ['p1', 'p2']);
    assert.deepEqual(idsIn(sectionOf(doc, 'sB').rows), ['b2', 'dialogueExamples']);
});

test('a group heading directly above a section heading moves down into it with its options, and back', () => {
    const doc = mkDoc(SPEC);
    roundTrip(doc, 'gA', 1);
    assert.deepEqual(idsIn(sectionOf(doc, 'sA').rows), ['a1']);
    assert.deepEqual(idsIn(sectionOf(doc, 'sB').rows), ['gA', 'p1', 'p2', 'b1', 'b2', 'dialogueExamples']);
    const gA = sectionOf(doc, 'sB').rows[0];
    assert.equal(gA.kind, 'group');
    assert.deepEqual(gA.options.map(identOf), ['p1', 'p2']);
});

test('a top-level item with nothing above it moves into the first section, then back to the leading run', () => {
    const doc = mkDoc([['x', 'item'], ['sA', 'section'], ['a1', 'item']]);
    roundTrip(doc, 'x', 1);
    assert.deepEqual(order(doc), ['sA', 'x', 'a1']);
    assert.equal(doc.sequences[0].rows.length, 1, 'only the section at the top level');
    moveLeaf(doc, keyOf(doc, 'x'), -1);
    assert.deepEqual(order(doc), ['x', 'sA', 'a1']);
    assert.equal(doc.sequences[0].rows[0].kind, 'block', 'x is top level again');
});

test('an item moves into a section whose first rows are a headerless group: the group stays intact', () => {
    const doc = mkDoc([['y', 'item'], ['sD', 'section'], ['r1', 'option'], ['r2', 'option']]);
    roundTrip(doc, 'y', 1);
    const rows = sectionOf(doc, 'sD').rows;
    assert.equal(rows[0].kind, 'block');
    assert.equal(identOf(rows[0]), 'y');
    assert.equal(rows[1].kind, 'group');
    assert.deepEqual(rows[1].options.map(identOf), ['r1', 'r2']);
});

test('a group cannot move into a section whose first rows are a headerless group (they would merge); doc untouched', () => {
    const doc = mkDoc([['gX', 'group'], ['q1', 'option'], ['sD', 'section'], ['r1', 'option'], ['r2', 'option']]);
    const snap = structuredClone(doc);
    assert.throws(() => moveLeaf(doc, keyOf(doc, 'gX'), 1), (/** @type {any} */ e) => e instanceof OutlineError);
    assert.deepEqual(doc, snap);
    assert.throws(() => applyDocOp(doc, 'moveLeaf', { key: keyOf(doc, 'gX'), delta: 1 }), (/** @type {any} */ e) => e instanceof OutlineError);
    assert.deepEqual(doc, snap);
});

test('options still stop at their group edge', () => {
    const doc = mkDoc(SPEC);
    const snap = structuredClone(doc);
    assert.throws(() => moveLeaf(doc, keyOf(doc, 'p2'), 1), (/** @type {any} */ e) => e instanceof OutlineError && /below the group/.test(e.message));
    assert.throws(() => moveLeaf(doc, keyOf(doc, 'p1'), -1), (/** @type {any} */ e) => e instanceof OutlineError && /above the group heading/.test(e.message));
    assert.deepEqual(doc, snap);
});

test('a section-heading mover still swaps whole sections', () => {
    const doc = mkDoc(SPEC);
    moveLeaf(doc, keyOf(doc, 'sB'), -1);
    wellFormed(doc);
    assert.deepEqual(order(doc), ['chatHistory', 'x', 'sB', 'b1', 'b2', 'dialogueExamples', 'sA', 'a1', 'gA', 'p1', 'p2', 'sC', 'c1']);
    moveLeaf(doc, keyOf(doc, 'sB'), 1);
    assert.deepEqual(order(doc), SPEC.map(([id]) => id));
});

test('moveLeaf delta 2 across a section heading equals two single steps (atomic op)', () => {
    const a = mkDoc(SPEC);
    const b = structuredClone(a);
    applyDocOp(a, 'moveLeaf', { key: keyOf(a, 'x'), delta: 2 });
    for (let i = 0; i < 2; i++) applyDocOp(b, 'moveLeaf', { key: keyOf(b, 'x'), delta: 1 });
    assert.deepEqual(a.sequences, b.sequences);
    assert.deepEqual(idsIn(sectionOf(a, 'sA').rows), ['a1', 'x', 'gA', 'p1', 'p2']);
    wellFormed(a);
});

test('the last row of the document still refuses to move down; the first still refuses up', () => {
    const doc = mkDoc(SPEC);
    assert.throws(() => moveLeaf(doc, keyOf(doc, 'c1'), 1), (/** @type {any} */ e) => e instanceof OutlineError && /bottom/.test(e.message));
    assert.throws(() => moveLeaf(doc, keyOf(doc, 'chatHistory'), -1), (/** @type {any} */ e) => e instanceof OutlineError && /top/.test(e.message));
});
