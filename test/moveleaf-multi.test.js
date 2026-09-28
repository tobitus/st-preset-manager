/**
 * moveLeaf with |delta| > 1 (sub-phase 2b: one drag = one op). A delta of n
 * is exactly n single sibling steps, applied atomically: if any step is
 * illegal the whole op fails and the document is untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, deriveStructure } from '../shared/outline.js';
import { applyDocOp } from '../shared/docops.js';
import { ensureDefaultLoadout } from '../plugin/store.js';

const REPO = path.resolve(import.meta.dirname, '..');

function ffDoc() {
    const st = JSON.parse(fs.readFileSync(path.join(REPO, 'dev/fixtures/presets', 'Freaky Frankenstein 5.4 Internal States (2).json'), 'utf8'));
    const doc = importStPreset(st, 'FF54');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    return doc;
}

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const topGroup = (/** @type {any} */ doc, /** @type {RegExp} */ re) => doc.sequences[0].rows.find(
    (/** @type {any} */ r) => r.kind === 'group' && re.test(r.name),
);

/** apply `delta` single steps of ±1 */
function stepwise(/** @type {any} */ doc, /** @type {string} */ key, /** @type {number} */ delta) {
    for (let i = 0; i < Math.abs(delta); i++) applyDocOp(doc, 'moveLeaf', { key, delta: Math.sign(delta) });
}

test('moveLeaf delta +2 on a top-level item equals two single steps (and passes whole groups)', () => {
    const a = ffDoc();
    const b = structuredClone(a);
    const tp = a.sequences[0].rows[1]; // Time and Place (item)
    applyDocOp(a, 'moveLeaf', { key: tp.key, delta: 2 });
    stepwise(b, tp.key, 2);
    assert.deepEqual(a.sequences, b.sequences);
    // it now sits after the Prose Style and POV groups
    const rows = a.sequences[0].rows;
    assert.match(rows[1].name, /Prose/);
    assert.match(rows[2].name, /POV/);
    assert.equal(rows[3].key, tp.key);
});

test('moveLeaf delta -2 undoes delta +2 exactly', () => {
    const doc = ffDoc();
    const before = structuredClone(doc.sequences);
    const tp = doc.sequences[0].rows[1];
    applyDocOp(doc, 'moveLeaf', { key: tp.key, delta: 2 });
    applyDocOp(doc, 'moveLeaf', { key: tp.key, delta: -2 });
    assert.deepEqual(doc.sequences, before);
});

test('moveLeaf delta +2 on a group option reorders within the group', () => {
    const doc = ffDoc();
    const pov = topGroup(doc, /POV/);
    const ids = pov.options.map(identOf);
    applyDocOp(doc, 'moveLeaf', { key: pov.options[0].key, delta: 2 });
    assert.deepEqual(topGroup(doc, /POV/).options.map(identOf), [ids[1], ids[2], ids[0], ids[3]]);
});

test('moveLeaf delta on a group heading moves the whole group, n steps = n single steps', () => {
    const a = ffDoc();
    const b = structuredClone(a);
    const nsfw = topGroup(a, /NSFW/);
    applyDocOp(a, 'moveLeaf', { key: nsfw.header.key, delta: -2 });
    stepwise(b, nsfw.header.key, -2);
    assert.deepEqual(a.sequences, b.sequences);
    const names = a.sequences[0].rows.map((/** @type {any} */ r) => r.name ?? identOf(r));
    const iN = names.findIndex((n) => /NSFW/.test(n));
    assert.match(names[iN + 1], /Prose/);
    assert.match(names[iN + 2], /POV/);
    assert.equal(topGroup(a, /NSFW/).options.length, 2, 'options travel with their heading');
});

test('moveLeaf never touches enabled bits or the identifier multiset', () => {
    const doc = ffDoc();
    const enabled = structuredClone(doc.loadouts);
    const ids = doc.sequences.flatMap((/** @type {any} */ s) => flattenSeq(s.rows)).map((e) => identOf(e.leaf)).sort();
    applyDocOp(doc, 'moveLeaf', { key: topGroup(doc, /POV/).header.key, delta: 3 });
    assert.deepEqual(doc.loadouts, enabled);
    assert.deepEqual(doc.sequences.flatMap((/** @type {any} */ s) => flattenSeq(s.rows)).map((e) => identOf(e.leaf)).sort(), ids);
});

test('moveLeaf with an out-of-range delta fails as a whole (400) and leaves the document untouched', () => {
    const doc = ffDoc();
    const snapshot = structuredClone(doc);
    const pov = topGroup(doc, /POV/);
    // 4 options: the first can move at most 3 down; the 4th step would leave the group
    assert.throws(() => applyDocOp(doc, 'moveLeaf', { key: pov.options[0].key, delta: 4 }), (/** @type {any} */ e) => e.status === 400);
    assert.deepEqual(doc, snapshot);
    assert.throws(() => applyDocOp(doc, 'moveLeaf', { key: doc.sequences[0].rows[0].key, delta: -1 }), (/** @type {any} */ e) => e.status === 400);
    assert.deepEqual(doc, snapshot);
});
