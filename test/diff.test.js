/**
 * shared/diff.js — zero-dependency LCS line diff (PLAN §2 Phase 5).
 * Invariants over exact strings: the edit script must reconstruct both
 * inputs, keep exactly an LCS of them, and group deletions before
 * insertions inside each change run; hunks carry unified-diff style
 * 1-based starts with `context` lines around changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLines, diffLines, lineHunks, DiffError, MAX_CELLS, MAX_INPUT_CHARS } from '../shared/diff.js';

/** reference LCS length (plain DP, test-only) */
function lcsLen(/** @type {string[]} */ a, /** @type {string[]} */ b) {
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        const cur = new Array(b.length + 1).fill(0);
        for (let j = 1; j <= b.length; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        prev = cur;
    }
    return prev[b.length];
}

/** the three script invariants every diffLines result must satisfy */
function assertScript(/** @type {string[]} */ a, /** @type {string[]} */ b) {
    const script = diffLines(a, b);
    assert.deepEqual(script.filter((l) => l.op !== '+').map((l) => l.text), a, 'context + deletions rebuild a');
    assert.deepEqual(script.filter((l) => l.op !== '-').map((l) => l.text), b, 'context + insertions rebuild b');
    assert.equal(script.filter((l) => l.op === ' ').length, lcsLen(a, b), 'kept lines are a longest common subsequence');
    for (let i = 1; i < script.length; i++) {
        assert.ok(!(script[i - 1].op === '+' && script[i].op === '-'), `a deletion follows an insertion at ${i}: ${JSON.stringify(script)}`);
    }
    for (const l of script) assert.ok([' ', '-', '+'].includes(l.op));
    return script;
}

test('splitLines: empty text is no lines; \\n, \\r\\n and \\r all split; a trailing newline leaves a final empty line', () => {
    assert.deepEqual(splitLines(''), []);
    assert.deepEqual(splitLines(undefined), []);
    assert.deepEqual(splitLines(null), []);
    assert.deepEqual(splitLines('one'), ['one']);
    assert.deepEqual(splitLines('a\nb\r\nc\rd'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(splitLines('x\n'), ['x', '']);
});

test('diffLines: exact scripts for unambiguous cases', () => {
    assert.deepEqual(diffLines([], []), []);
    assert.deepEqual(diffLines(['a'], ['a']), [{ op: ' ', text: 'a' }]);
    assert.deepEqual(diffLines([], ['a', 'b']), [{ op: '+', text: 'a' }, { op: '+', text: 'b' }]);
    assert.deepEqual(diffLines(['a', 'b'], []), [{ op: '-', text: 'a' }, { op: '-', text: 'b' }]);
    assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'B', 'c']), [
        { op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'B' }, { op: ' ', text: 'c' },
    ]);
    assert.deepEqual(diffLines(['a', 'c'], ['a', 'b', 'c']), [
        { op: ' ', text: 'a' }, { op: '+', text: 'b' }, { op: ' ', text: 'c' },
    ]);
});

test('diffLines: reconstruction + LCS + deletions-first invariants on awkward inputs', () => {
    const cases = [
        [['a', 'b', 'c', 'a', 'b', 'b', 'a'], ['c', 'b', 'a', 'b', 'a', 'c']],
        [['x', 'x', 'x'], ['x', 'y', 'x', 'y', 'x']],
        [['', '', 'a'], ['a', '', '']],
        [['1', '2', '3', '4', '5', '6'], ['6', '5', '4', '3', '2', '1']],
        [['same', 'head', 'mid1', 'mid2', 'tail', 'same'], ['same', 'head', 'MID', 'tail', 'same']],
    ];
    for (const [a, b] of cases) assertScript(a, b);
});

test('diffLines: long texts with a small change stay fast (common prefix/suffix are not in the table)', () => {
    const a = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const b = a.slice();
    b[10000] = 'CHANGED';
    const t0 = Date.now();
    const script = diffLines(a, b);
    assert.ok(Date.now() - t0 < 2000, 'diff of 20k lines with one change took too long');
    assert.deepEqual(script.filter((l) => l.op !== '+').map((l) => l.text), a);
    assert.deepEqual(script.filter((l) => l.op !== '-').map((l) => l.text), b);
    assert.deepEqual(script.filter((l) => l.op !== ' '), [{ op: '-', text: 'line 10000' }, { op: '+', text: 'CHANGED' }]);
});

test('diffLines: a middle that would exceed MAX_CELLS throws DiffError instead of allocating', () => {
    const n = Math.ceil(Math.sqrt(MAX_CELLS)) + 10;
    const a = Array.from({ length: n }, (_, i) => `a${i}`);
    const b = Array.from({ length: n }, (_, i) => `b${i}`);
    assert.throws(() => diffLines(a, b), DiffError);
});

// Phase 5 review 1 (finding 1): /diff/blocks runs in ST's own process, so the
// work a request may cause is bounded, not just the table size.
test('work bounds: the review\'s 4,999 x 4,999 unequal lines are refused (413), and so is input over MAX_INPUT_CHARS', () => {
    assert.ok(MAX_CELLS <= 4_000_000, `MAX_CELLS ${MAX_CELLS} allows a table the event loop feels`);
    assert.ok(MAX_INPUT_CHARS <= 2_000_000, `MAX_INPUT_CHARS ${MAX_INPUT_CHARS}`);
    const a = Array.from({ length: 4999 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 4999 }, (_, i) => `b${i}`);
    assert.throws(() => diffLines(a, b), (/** @type {any} */ e) => e instanceof DiffError && e.status === 413);
    // one line each, but together over the character budget (a trimmed
    // middle of 1x1 cells: only the input bound can refuse it)
    const big = 'x'.repeat(Math.ceil(MAX_INPUT_CHARS / 2) + 10);
    assert.throws(() => lineHunks(`${big}1`, `${big}2`), (/** @type {any} */ e) => e instanceof DiffError && e.status === 413);
    // the budget counts the common prefix/suffix too (they are still split and scanned)
    const same = Array.from({ length: 50 }, () => 'y'.repeat(Math.ceil(MAX_INPUT_CHARS / 90))).join('\n');
    assert.throws(() => lineHunks(same, `${same}\nz`), DiffError);
});

test('work bounds: the worst case the bounds allow (a full table of long, distinct lines sharing a long prefix) finishes fast', () => {
    const side = Math.floor(Math.sqrt(MAX_CELLS)) - 2;
    // lines of equal length sharing all but their tail: the costliest string
    // comparisons, filling the character budget
    const width = Math.floor(MAX_INPUT_CHARS / (2 * side)) - 12;
    const pre = 'p'.repeat(Math.max(0, width));
    const a = Array.from({ length: side }, (_, i) => `${pre}a${String(i).padStart(6, '0')}`);
    const b = Array.from({ length: side }, (_, i) => `${pre}${i % 7 === 0 ? 'a' : 'b'}${String(i).padStart(6, '0')}`);
    const chars = [...a, ...b].reduce((s, l) => s + l.length + 1, 0);
    assert.ok(chars <= MAX_INPUT_CHARS && (side + 1) * (side + 1) <= MAX_CELLS, 'precondition: the case is within the bounds');
    const t0 = performance.now();
    const script = diffLines(a, b);
    const ms = performance.now() - t0;
    console.log(`# worst allowed case: ${side}x${side} lines, ${chars} chars -> ${ms.toFixed(1)} ms`);
    assert.ok(ms < 400, `worst allowed case took ${ms.toFixed(0)} ms`);
    assert.deepEqual(script.filter((l) => l.op !== '+').map((l) => l.text), a);
    assert.deepEqual(script.filter((l) => l.op !== '-').map((l) => l.text), b);
    assert.equal(script.filter((l) => l.op === ' ').length, a.filter((_, i) => i % 7 === 0).length);
});

test('lineHunks: identical texts give no hunks', () => {
    assert.deepEqual(lineHunks('a\nb', 'a\nb'), []);
    assert.deepEqual(lineHunks('', ''), []);
});

test('lineHunks: one change with 1-based starts and full context', () => {
    assert.deepEqual(lineHunks('a\nb\nc', 'a\nB\nc'), [{
        aStart: 1, aLines: 3, bStart: 1, bLines: 3,
        lines: [{ op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'B' }, { op: ' ', text: 'c' }],
    }]);
});

test('lineHunks: context is clipped to `context` lines on each side', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const b = a.slice();
    b[4] = 'five';
    const hunks = lineHunks(a.join('\n'), b.join('\n'), 2);
    assert.deepEqual(hunks, [{
        aStart: 3, aLines: 5, bStart: 3, bLines: 5,
        lines: [
            { op: ' ', text: '3' }, { op: ' ', text: '4' },
            { op: '-', text: '5' }, { op: '+', text: 'five' },
            { op: ' ', text: '6' }, { op: ' ', text: '7' },
        ],
    }]);
});

test('lineHunks: changes up to 2*context lines apart merge; further apart they split', () => {
    const base = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);
    // changes at lines 2 and 9: 6 unchanged lines between (3..8) = 2*3 -> one hunk
    const merged = base.slice();
    merged[1] = 'X2';
    merged[8] = 'X9';
    const h1 = lineHunks(base.join('\n'), merged.join('\n'), 3);
    assert.equal(h1.length, 1);
    assert.equal(h1[0].aStart, 1);
    assert.equal(h1[0].aLines, 12);
    // changes at lines 2 and 10: 7 unchanged lines between -> two hunks
    const split = base.slice();
    split[1] = 'X2';
    split[9] = 'X10';
    const h2 = lineHunks(base.join('\n'), split.join('\n'), 3);
    assert.equal(h2.length, 2);
    assert.deepEqual([h2[0].aStart, h2[0].aLines, h2[1].aStart, h2[1].aLines], [1, 5, 7, 6]);
    assert.deepEqual(h2[1].lines.map((l) => l.op + l.text), [' L7', ' L8', ' L9', '-L10', '+X10', ' L11', ' L12']);
});

test('lineHunks: pure insertion / deletion hunks count starts as lines-before + 1', () => {
    assert.deepEqual(lineHunks('', 'new'), [{ aStart: 1, aLines: 0, bStart: 1, bLines: 1, lines: [{ op: '+', text: 'new' }] }]);
    assert.deepEqual(lineHunks('old', ''), [{ aStart: 1, aLines: 1, bStart: 1, bLines: 0, lines: [{ op: '-', text: 'old' }] }]);
    const h = lineHunks('a\nb\nc\nd\ne', 'a\nb\nc\nd\ne\nf', 0);
    assert.deepEqual(h, [{ aStart: 6, aLines: 0, bStart: 6, bLines: 1, lines: [{ op: '+', text: 'f' }] }]);
});

test('lineHunks: a trailing newline difference is a real change', () => {
    const h = lineHunks('x', 'x\n');
    assert.equal(h.length, 1);
    assert.deepEqual(h[0].lines.filter((l) => l.op !== ' '), [{ op: '+', text: '' }]);
});
