/**
 * Phase 6: the shelf panel's drag-source rows for another open preset
 * (ext/outline-model.js sourceItems). A group is ONE draggable row (copies
 * heading + options + cardinality) followed by its options as single rows;
 * ghosts are never offered (nothing to copy); markers ARE offered (the
 * server refuses them with a 400, which the UI surfaces as a toast).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq } from '../shared/outline.js';
import { sourceItems } from '../ext/outline-model.js';

function doc() {
    const ids = ['a', 'g', 'o1', 'o2', 's1', 'c'];
    const d = importStPreset({
        prompts: [{ identifier: 'chatHistory', marker: true }, ...ids.map((id) => ({ identifier: id, name: id.toUpperCase(), content: id, role: 'system' }))],
        prompt_order: [{ character_id: 100001, order: [...ids, 'chatHistory'].map((identifier) => ({ identifier, enabled: false })) }],
    }, 'Src');
    const leaf = Object.fromEntries(flattenSeq(d.sequences[0].rows).map((e) => [e.leaf.ref ?? e.leaf.identifier, e.leaf]));
    const gm = { name: 'Pick', cardinality: 'pick-one', guessed: false };
    const ghost = { kind: 'ghost', identifier: 'gone', key: 'row_ghost' };
    d.sequences[0].rows = rebuildSeq([
        { leaf: leaf.a, rank: 'item', gmeta: null, sname: null },
        { leaf: ghost, rank: 'item', gmeta: null, sname: null },
        { leaf: leaf.g, rank: 'group', gmeta: { ...gm }, sname: null },
        { leaf: leaf.o1, rank: 'option', gmeta: { ...gm }, sname: null },
        { leaf: leaf.o2, rank: 'option', gmeta: { ...gm }, sname: null },
        { leaf: leaf.s1, rank: 'section', gmeta: null, sname: 'Sec' },
        { leaf: leaf.c, rank: 'item', gmeta: null, sname: 'Sec' },
        { leaf: leaf.chatHistory, rank: 'item', gmeta: null, sname: 'Sec' },
    ]);
    return { d, leaf };
}

test('sourceItems: one group row (whole-group copy) then its options; section heading then its rows; no ghosts', () => {
    const { d, leaf } = doc();
    const items = sourceItems(d);
    assert.deepEqual(items, [
        { kind: 'leaf', identifier: 'a', leafKind: 'block', name: 'A', depth: 0, heading: null },
        { kind: 'group', groupKey: 'grp:' + leaf.g.key, name: 'G', cardinality: 'pick-one', count: 3, depth: 0 },
        { kind: 'leaf', identifier: 'o1', leafKind: 'block', name: 'O1', depth: 1, heading: null },
        { kind: 'leaf', identifier: 'o2', leafKind: 'block', name: 'O2', depth: 1, heading: null },
        { kind: 'leaf', identifier: 's1', leafKind: 'block', name: 'Sec', depth: 0, heading: 'section' },
        { kind: 'leaf', identifier: 'c', leafKind: 'block', name: 'C', depth: 1, heading: null },
        { kind: 'leaf', identifier: 'chatHistory', leafKind: 'marker', name: 'chatHistory', depth: 1, heading: null },
    ]);
});

test('sourceItems: a headerless group is named by the group name and counts its block options only', () => {
    const { d, leaf } = doc();
    const gm = { name: 'Loose', cardinality: 'pick-one-or-more', guessed: false };
    d.sequences[0].rows = rebuildSeq([
        { leaf: leaf.o1, rank: 'option', gmeta: { ...gm }, sname: null },
        { leaf: leaf.o2, rank: 'option', gmeta: { ...gm }, sname: null },
    ]);
    const items = sourceItems(d);
    assert.deepEqual(items[0], { kind: 'group', groupKey: 'grp:' + leaf.o1.key, name: 'Loose', cardinality: 'pick-one-or-more', count: 2, depth: 0 });
    assert.equal(items.length, 3);
});
