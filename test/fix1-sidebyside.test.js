/**
 * Fix round 1, item 4: `sideBySide(hunk)` turns one unified hunk into
 * side-by-side rows — old on the left, new on the right, changed lines
 * paired in order, unchanged context on both sides, 1-based line numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineHunks, sideBySide } from '../shared/diff.js';

const ctx = (/** @type {number} */ a, /** @type {number} */ b, /** @type {string} */ text) => ({
    left: { no: a, text, kind: 'ctx' }, right: { no: b, text, kind: 'ctx' },
});
const del = (/** @type {number} */ no, /** @type {string} */ text) => ({ no, text, kind: 'del' });
const add = (/** @type {number} */ no, /** @type {string} */ text) => ({ no, text, kind: 'add' });

test('a changed line pairs its old and new text on one row, context aligned around it', () => {
    const [h] = lineHunks('x\ny\nz', 'x\nY\nz');
    assert.deepEqual(sideBySide(h), [
        ctx(1, 1, 'x'),
        { left: del(2, 'y'), right: add(2, 'Y') },
        ctx(3, 3, 'z'),
    ]);
});

test('a pure insertion has an empty left cell; later context numbers shift on the right', () => {
    const [h] = lineHunks('a\nb', 'a\nNEW\nb');
    assert.deepEqual(sideBySide(h), [
        ctx(1, 1, 'a'),
        { left: null, right: add(2, 'NEW') },
        ctx(2, 3, 'b'),
    ]);
});

test('a pure deletion has an empty right cell', () => {
    const [h] = lineHunks('a\nOLD\nb', 'a\nb');
    assert.deepEqual(sideBySide(h), [
        ctx(1, 1, 'a'),
        { left: del(2, 'OLD'), right: null },
        ctx(3, 2, 'b'),
    ]);
});

test('uneven change runs pair in order; the extra old lines stand alone', () => {
    const [h] = lineHunks('a\n1\n2\n3\nb', 'a\nX\nb');
    assert.deepEqual(sideBySide(h), [
        ctx(1, 1, 'a'),
        { left: del(2, '1'), right: add(2, 'X') },
        { left: del(3, '2'), right: null },
        { left: del(4, '3'), right: null },
        ctx(5, 3, 'b'),
    ]);
});

test('an addition listed before its deletion inside one change run still pairs', () => {
    const hunk = { aStart: 4, aLines: 1, bStart: 7, bLines: 1, lines: [{ op: '+', text: 'N' }, { op: '-', text: 'O' }] };
    assert.deepEqual(sideBySide(/** @type {any} */ (hunk)), [{ left: del(4, 'O'), right: add(7, 'N') }]);
});

test('change runs separated by context pair independently', () => {
    const hunk = {
        aStart: 1, aLines: 2, bStart: 1, bLines: 2,
        lines: [{ op: '-', text: 'a' }, { op: ' ', text: 'c' }, { op: '+', text: 'b' }],
    };
    assert.deepEqual(sideBySide(/** @type {any} */ (hunk)), [
        { left: del(1, 'a'), right: null },
        ctx(2, 1, 'c'),
        { left: null, right: add(2, 'b') },
    ]);
});
