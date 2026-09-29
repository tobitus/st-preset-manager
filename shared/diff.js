/**
 * Zero-dependency LCS line diff (PLAN §2 Phase 5).
 * `diffLines` produces a minimal edit script (' '/'-'/'+') between two line
 * arrays; `lineHunks` groups a diff of two texts into unified-diff style
 * hunks with a configurable amount of surrounding context. No dependencies.
 *
 * `POST /diff/blocks` runs `lineHunks` synchronously inside SillyTavern's own
 * server process, so a single request can stall it: two bounds keep a
 * request's work small enough to not be felt. `MAX_CELLS` caps the
 * `(n+1)*(m+1)` LCS table allocated over the *trimmed* middle (after common
 * prefix/suffix removal) at 4,000,000 cells. `MAX_INPUT_CHARS` caps the total
 * character count of *all* input lines (both texts, prefix/suffix included,
 * since they are still split and scanned) at 2,000,000, so a small number of
 * huge lines can't pass the cell bound and still make the DP compare
 * multi-megabyte strings on every step. Before the DP runs, every distinct
 * line in the trimmed middle is interned to a small integer id, so the table
 * fill and backtrack compare integers, never strings.
 */

/**
 * @typedef {{ op: ' '|'-'|'+', text: string }} DiffLine
 */

/**
 * @typedef {{
 *   aStart: number,
 *   aLines: number,
 *   bStart: number,
 *   bLines: number,
 *   lines: DiffLine[],
 * }} Hunk
 */

export class DiffError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'DiffError';
        this.status = 413;
    }
}

/** Largest (n+1)*(m+1) LCS table we will allocate, over the trimmed middle. */
export const MAX_CELLS = 4_000_000;

/** Largest total character count (all lines of both texts) we will diff. */
export const MAX_INPUT_CHARS = 2_000_000;

/**
 * Split text into lines on \n, \r\n or \r. Empty/nullish text has no lines.
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function splitLines(text) {
    if (text === '' || text === null || text === undefined) return [];
    return String(text).split(/\r\n|\n|\r/);
}

/**
 * Longest common subsequence line diff between `a` and `b`.
 * Strips common prefix/suffix (emitted as context) before running the DP
 * table on the remaining middle, so large inputs with small changes stay
 * fast. Within each run of changes, deletions are emitted before insertions.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {DiffLine[]}
 */
export function diffLines(a, b) {
    let chars = 0;
    for (const line of a) chars += line.length + 1;
    for (const line of b) chars += line.length + 1;
    if (chars > MAX_INPUT_CHARS) {
        throw new DiffError(`texts too large to diff (${chars} characters, limit ${MAX_INPUT_CHARS})`);
    }

    let start = 0;
    const maxPrefix = Math.min(a.length, b.length);
    while (start < maxPrefix && a[start] === b[start]) start++;

    let aEnd = a.length;
    let bEnd = b.length;
    while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
        aEnd--;
        bEnd--;
    }

    const midA = a.slice(start, aEnd);
    const midB = b.slice(start, bEnd);
    const n = midA.length;
    const m = midB.length;

    if ((n + 1) * (m + 1) > MAX_CELLS) {
        throw new DiffError(`texts too large to diff (${n}×${m} lines)`);
    }

    // Intern the middle's lines to small integer ids so the DP and backtrack
    // below compare integers, never strings (string equality on long, mostly
    // shared-prefix lines is the costly part of a worst-case table fill).
    const ids = new Map();
    const ia = new Int32Array(n);
    const ib = new Int32Array(m);
    for (let k = 0; k < n; k++) {
        let id = ids.get(midA[k]);
        if (id === undefined) {
            id = ids.size;
            ids.set(midA[k], id);
        }
        ia[k] = id;
    }
    for (let k = 0; k < m; k++) {
        let id = ids.get(midB[k]);
        if (id === undefined) {
            id = ids.size;
            ids.set(midB[k], id);
        }
        ib[k] = id;
    }

    // Flat (n+1)x(m+1) DP table, row-major: table[i*(m+1)+j]. The LCS length
    // never exceeds min(n, m), so a 16-bit table suffices whenever that is
    // small enough, halving memory traffic for the common lopsided case.
    const width = m + 1;
    const table = Math.min(n, m) < 65535 ? new Uint16Array((n + 1) * width) : new Uint32Array((n + 1) * width);
    for (let i = 1; i <= n; i++) {
        const rowBase = i * width;
        const prevRowBase = (i - 1) * width;
        for (let j = 1; j <= m; j++) {
            if (ia[i - 1] === ib[j - 1]) {
                table[rowBase + j] = table[prevRowBase + j - 1] + 1;
            } else {
                const up = table[prevRowBase + j];
                const left = table[rowBase + j - 1];
                table[rowBase + j] = up >= left ? up : left;
            }
        }
    }

    /** @type {DiffLine[]} */
    const middleScript = [];
    let i = n;
    let j = m;
    /** @type {string[]} */
    let pendingDel = [];
    /** @type {string[]} */
    let pendingIns = [];
    const flushPending = () => {
        for (const text of pendingIns) middleScript.push({ op: '+', text });
        for (const text of pendingDel) middleScript.push({ op: '-', text });
        pendingDel = [];
        pendingIns = [];
    };
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && ia[i - 1] === ib[j - 1]) {
            flushPending();
            middleScript.push({ op: ' ', text: midA[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || table[i * width + j - 1] >= table[(i - 1) * width + j])) {
            pendingIns.push(midB[j - 1]);
            j--;
        } else {
            pendingDel.push(midA[i - 1]);
            i--;
        }
    }
    flushPending();
    middleScript.reverse();

    /** @type {DiffLine[]} */
    const script = [];
    for (let k = 0; k < start; k++) script.push({ op: ' ', text: a[k] });
    for (const line of middleScript) script.push(line);
    for (let k = aEnd; k < a.length; k++) script.push({ op: ' ', text: a[k] });
    return script;
}

/**
 * Group a diff of `aText`/`bText` into unified-diff style hunks: each hunk
 * carries up to `context` unchanged lines before its first change and after
 * its last change, and two changes separated by a run of unchanged lines no
 * longer than `2*context` merge into a single hunk. Identical inputs give
 * no hunks.
 * @param {string} aText
 * @param {string} bText
 * @param {number} [context]
 * @returns {Hunk[]}
 */
export function lineHunks(aText, bText, context = 3) {
    const script = diffLines(splitLines(aText), splitLines(bText));

    /** @type {{ start: number, end: number }[]} */
    const changeRuns = [];
    let runStart = -1;
    for (let k = 0; k < script.length; k++) {
        if (script[k].op !== ' ') {
            if (runStart === -1) runStart = k;
        } else if (runStart !== -1) {
            changeRuns.push({ start: runStart, end: k });
            runStart = -1;
        }
    }
    if (runStart !== -1) changeRuns.push({ start: runStart, end: script.length });

    if (changeRuns.length === 0) return [];

    /** @type {{ lo: number, hi: number }[]} */
    const spans = [];
    for (const run of changeRuns) {
        const lo = Math.max(0, run.start - context);
        const hi = Math.min(script.length, run.end + context);
        const last = spans[spans.length - 1];
        if (last && lo <= last.hi) {
            last.hi = Math.max(last.hi, hi);
        } else {
            spans.push({ lo, hi });
        }
    }

    // Prefix counts of a/b lines consumed by script[0..k).
    const aBefore = new Array(script.length + 1);
    const bBefore = new Array(script.length + 1);
    aBefore[0] = 0;
    bBefore[0] = 0;
    for (let k = 0; k < script.length; k++) {
        aBefore[k + 1] = aBefore[k] + (script[k].op !== '+' ? 1 : 0);
        bBefore[k + 1] = bBefore[k] + (script[k].op !== '-' ? 1 : 0);
    }

    /** @type {Hunk[]} */
    const hunks = [];
    for (const { lo, hi } of spans) {
        const lines = script.slice(lo, hi);
        const aLines = lines.filter((l) => l.op !== '+').length;
        const bLines = lines.filter((l) => l.op !== '-').length;
        hunks.push({
            aStart: aBefore[lo] + 1,
            aLines,
            bStart: bBefore[lo] + 1,
            bLines,
            lines,
        });
    }
    return hunks;
}
