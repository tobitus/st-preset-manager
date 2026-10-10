/**
 * F-066: ST's chat completion reads only prompt_order character 100001. A
 * preset carrying BOTH 100000 and 100001 imports only the 100001 sequence and
 * records the drop in `source.recognizer.notes`. Every other combination of
 * ids imports unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq } from '../shared/outline.js';

const NOTE = 'dropped prompt_order 100000: ST chat completion reads only 100001 (F-066)';

/** @param {number[]} charIds @returns {any} */
function st(charIds) {
    const ids = ['a', 'b', 'c'];
    return {
        prompts: ids.map((id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system' })),
        prompt_order: charIds.map((cid, i) => ({
            character_id: cid,
            // a distinct order per entry so the kept one is identifiable
            order: (i % 2 ? [...ids].reverse() : ids).map((identifier) => ({ identifier, enabled: true })),
        })),
    };
}
const order = (/** @type {any} */ seq) => flattenSeq(seq.rows).map((e) => e.leaf.ref ?? e.leaf.identifier);

test('F-066: 100000 + 100001 imports one sequence (100001) and notes the drop', () => {
    const doc = importStPreset(st([100000, 100001]), 'both');
    assert.equal(doc.sequences.length, 1);
    assert.equal(doc.sequences[0].character_id, 100001);
    assert.deepEqual(order(doc.sequences[0]), ['c', 'b', 'a']);
    assert.ok(doc.source.recognizer.notes.includes(NOTE), JSON.stringify(doc.source.recognizer.notes));
});

test('F-066: order of the entries does not matter (100001 first)', () => {
    const doc = importStPreset(st([100001, 100000]), 'both reversed');
    assert.equal(doc.sequences.length, 1);
    assert.equal(doc.sequences[0].character_id, 100001);
    assert.deepEqual(order(doc.sequences[0]), ['a', 'b', 'c']);
    assert.ok(doc.source.recognizer.notes.includes(NOTE));
});

test('F-066: only 100000 is unchanged (kept, no note)', () => {
    const doc = importStPreset(st([100000]), 'only 100000');
    assert.equal(doc.sequences.length, 1);
    assert.equal(doc.sequences[0].character_id, 100000);
    assert.ok(!doc.source.recognizer.notes.some((n) => n.includes('100000')));
});

test('F-066: 100001 + 100002 is unchanged (two sequences, no note)', () => {
    const doc = importStPreset(st([100001, 100002]), 'two others');
    assert.deepEqual(doc.sequences.map((s) => s.character_id), [100001, 100002]);
    assert.ok(!doc.source.recognizer.notes.some((n) => n.includes('F-066')));
});
