/**
 * Fix round 4 (owner review 2026-10-15), Insert placement: `addBlock` and
 * `addSection` accept `after: <leaf key>` (exclusive with `before`) and land
 * BELOW the anchor row:
 *   addBlock   item/marker -> directly below it, same section
 *              option -> the next option of that group
 *              group heading -> the group's first option
 *              section heading -> the section's first row
 *   addSection item/marker -> directly below it (rows from there to the next
 *              heading become its children)
 *              option / group heading -> after the whole group
 *              section heading -> after the whole section (an empty sibling)
 * `after: null` (or absent, with no `before`) appends to the end.
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

/** the group row headed by `id`, anywhere in the first sequence */
function groupOf(/** @type {any} */ doc, /** @type {string} */ id) {
    /** @param {any[]} rows @returns {any} */
    const walk = (rows) => {
        for (const r of rows) {
            if (r.kind === 'group' && r.header && identOf(r.header) === id) return r;
            if (r.kind === 'section') {
                const hit = walk(r.rows);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(doc.sequences[0].rows);
}

/**
 * chatHistory(marker item), a(item), s1(section: b, g{o1,o2}, c), s2(section: d).
 * Flat: chatHistory a s1 b g o1 o2 c s2 d. Two loadouts: the active one and 'L2'.
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
    assert.deepEqual(order(doc), ['chatHistory', 'a', 's1', 'b', 'g', 'o1', 'o2', 'c', 's2', 'd'], 'fixture order');
    return doc;
}

/** every result is a valid doc whose nested rows are a rebuild fixed point */
function wellFormed(/** @type {any} */ doc) {
    assert.deepEqual(validateDoc(doc), []);
    const rows = doc.sequences[0].rows;
    assert.deepEqual(rebuildSeq(flattenSeq(rows)), rows, 'rebuildSeq(flattenSeq(rows)) is a fixed point');
}

/** apply addBlock after `anchorId`; returns { doc, res } */
function blockAfter(/** @type {string} */ anchorId) {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addBlock', { name: 'N', after: keyOf(doc, anchorId) });
    wellFormed(doc);
    const e = entryOf(doc, res.identifier);
    assert.equal(e.leaf.key, res.key, 'result key is the new row key');
    return { doc, res, e };
}

/** apply addSection after `anchorId`; returns { doc, res } */
function sectionAfter(/** @type {string} */ anchorId) {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addSection', { name: '== N ==', after: keyOf(doc, anchorId) });
    wellFormed(doc);
    const e = entryOf(doc, res.identifier);
    assert.equal(e.leaf.key, res.key, 'result key is the new row key');
    assert.equal(e.rank, 'section');
    return { doc, res, e };
}

// ------------------------------------------------------------------ addBlock after

test('addBlock after a top-level item lands directly below it, still top level', () => {
    const { doc, res, e } = blockAfter('a');
    assert.deepEqual(order(doc), ['chatHistory', 'a', res.identifier, 's1', 'b', 'g', 'o1', 'o2', 'c', 's2', 'd']);
    assert.equal(e.rank, 'item');
    assert.equal(e.sname, null);
    assert.ok(doc.sequences[0].rows.some((/** @type {any} */ r) => r.key === res.key), 'a top-level row');
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', 'c']);
    for (const l of Object.values(doc.loadouts)) assert.equal(/** @type {any} */ (l).enabled[res.identifier], false, 'off in every root');
});

test('addBlock after an item inside a section lands directly below it, same section', () => {
    const { doc, res, e } = blockAfter('b');
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', res.identifier, 'g', 'o1', 'o2', 'c']);
    assert.equal(e.rank, 'item');
    assert.equal(e.sname, 'S1');
});

test('addBlock after the last row of a section stays in that section', () => {
    const { doc, res } = blockAfter('c');
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', 'c', res.identifier]);
    assert.deepEqual(idsIn(sectionOf(doc, 's2').rows), ['d']);
});

test('addBlock after a section heading is the section\'s first row', () => {
    const { doc, res, e } = blockAfter('s1');
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), [res.identifier, 'b', 'g', 'o1', 'o2', 'c']);
    assert.equal(sectionOf(doc, 's1').rows[0].key, res.key);
    assert.equal(e.rank, 'item');
    assert.equal(e.sname, 'S1');
});

test('addBlock after a group heading is the group\'s first option', () => {
    const { doc, res, e } = blockAfter('g');
    assert.deepEqual(groupOf(doc, 'g').options.map(identOf), [res.identifier, 'o1', 'o2']);
    assert.equal(e.rank, 'option');
    assert.deepEqual(e.gmeta, { name: 'G', cardinality: 'pick-one-or-more', guessed: false });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', res.identifier, 'o1', 'o2', 'c']);
});

test('addBlock after a middle option is the next option of that group', () => {
    const { doc, res, e } = blockAfter('o1');
    assert.deepEqual(groupOf(doc, 'g').options.map(identOf), ['o1', res.identifier, 'o2']);
    assert.equal(e.rank, 'option');
});

test('addBlock after the last option joins the group as its last option', () => {
    const { doc, res, e } = blockAfter('o2');
    assert.deepEqual(groupOf(doc, 'g').options.map(identOf), ['o1', 'o2', res.identifier]);
    assert.equal(e.rank, 'option');
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', res.identifier, 'c']);
});

test('addBlock after the last row of the document lands at the end', () => {
    const { doc, res } = blockAfter('d');
    assert.equal(order(doc).at(-1), res.identifier);
    assert.deepEqual(idsIn(sectionOf(doc, 's2').rows), ['d', res.identifier]);
});

test('addBlock after a marker lands directly below it as a plain row', () => {
    const { doc, res, e } = blockAfter('chatHistory');
    assert.deepEqual(order(doc).slice(0, 3), ['chatHistory', res.identifier, 'a']);
    assert.equal(e.rank, 'item');
});

test('addBlock after: null appends to the end (as no anchor)', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addBlock', { name: 'N', after: null });
    wellFormed(doc);
    assert.equal(order(doc).at(-1), res.identifier);
});

// ------------------------------------------------------------------ addSection after

test('addSection after an item: heading directly below it, rows up to the next heading are its children', () => {
    const { doc, res } = sectionAfter('b');
    assert.deepEqual(order(doc), ['chatHistory', 'a', 's1', 'b', res.identifier, 'g', 'o1', 'o2', 'c', 's2', 'd']);
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b']);
    assert.deepEqual(idsIn(sectionOf(doc, res.identifier).rows), ['g', 'o1', 'o2', 'c']);
    assert.equal(doc.blocks[res.identifier].content, '');
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled[res.identifier], true);
    assert.equal(doc.loadouts.L2.enabled[res.identifier], false);
});

test('addSection after a top-level item followed by a section heading makes an empty section there', () => {
    const { doc, res } = sectionAfter('a');
    assert.deepEqual(order(doc), ['chatHistory', 'a', res.identifier, 's1', 'b', 'g', 'o1', 'o2', 'c', 's2', 'd']);
    assert.deepEqual(sectionOf(doc, res.identifier).rows, []);
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', 'c']);
});

test('addSection after a group option lands after the whole group (the group stays intact)', () => {
    const { doc, res } = sectionAfter('o1');
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2']);
    assert.deepEqual(idsIn(sectionOf(doc, res.identifier).rows), ['c']);
    assert.deepEqual(groupOf(doc, 'g').options.map(identOf), ['o1', 'o2']);
});

test('addSection after a group heading lands after the whole group', () => {
    const { doc, res } = sectionAfter('g');
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2']);
    assert.deepEqual(idsIn(sectionOf(doc, res.identifier).rows), ['c']);
    assert.deepEqual(groupOf(doc, 'g').options.map(identOf), ['o1', 'o2']);
});

test('addSection after a section heading lands after the whole section: an empty sibling section', () => {
    const { doc, res } = sectionAfter('s1');
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', 'c']);
    assert.deepEqual(sectionOf(doc, res.identifier).rows, []);
    assert.deepEqual(order(doc), ['chatHistory', 'a', 's1', 'b', 'g', 'o1', 'o2', 'c', res.identifier, 's2', 'd']);
});

test('addSection after the last section heading lands at the end, empty', () => {
    const { doc, res } = sectionAfter('s2');
    assert.equal(order(doc).at(-1), res.identifier);
    assert.deepEqual(idsIn(sectionOf(doc, 's2').rows), ['d']);
    assert.deepEqual(sectionOf(doc, res.identifier).rows, []);
});

test('addSection after the last row lands at the end, empty', () => {
    const { doc, res } = sectionAfter('d');
    assert.equal(order(doc).at(-1), res.identifier);
    assert.deepEqual(idsIn(sectionOf(doc, 's2').rows), ['d']);
    assert.deepEqual(sectionOf(doc, res.identifier).rows, []);
});

test('addSection after a marker: heading directly below it', () => {
    const { doc, res } = sectionAfter('chatHistory');
    assert.deepEqual(order(doc).slice(0, 3), ['chatHistory', res.identifier, 'a']);
    assert.deepEqual(idsIn(sectionOf(doc, res.identifier).rows), ['a']);
});

test('addSection after: null appends to the end (as no anchor)', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'addSection', { name: '== N ==', after: null });
    wellFormed(doc);
    assert.equal(order(doc).at(-1), res.identifier);
});

// ------------------------------------------------------------------ refusals

for (const opName of ['addBlock', 'addSection']) {
    const name = opName === 'addBlock' ? 'N' : '== N ==';

    test(`${opName} refuses before + after together with 400 'use before or after, not both', doc untouched`, () => {
        const doc = mkDoc();
        const snap = structuredClone(doc);
        assert.throws(() => applyDocOp(doc, opName, { name, before: keyOf(doc, 'b'), after: keyOf(doc, 'c') }),
            (/** @type {any} */ e) => e instanceof OpError && e.status === 400 && /use before or after, not both/.test(e.message));
        assert.deepEqual(doc, snap);
    });

    test(`${opName} refuses an unknown after key with 404, doc untouched`, () => {
        const doc = mkDoc();
        const snap = structuredClone(doc);
        assert.throws(() => applyDocOp(doc, opName, { name, after: 'no-such-key' }),
            (/** @type {any} */ e) => e instanceof OpError && e.status === 404 && /no row with key "no-such-key"/.test(e.message));
        assert.deepEqual(doc, snap);
    });

    test(`${opName} refuses a non-string after with 400, doc untouched`, () => {
        const doc = mkDoc();
        const snap = structuredClone(doc);
        assert.throws(() => applyDocOp(doc, opName, { name, after: 7 }),
            (/** @type {any} */ e) => e instanceof OpError && e.status === 400);
        assert.deepEqual(doc, snap);
    });
}
