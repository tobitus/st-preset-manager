/**
 * Preset-vs-preset diff (v1 pmcore/compare.py port; PLAN §1.6 /diff, §2
 * Phase 5).
 *
 * Matching: placed blocks are paired by identifier first; leftovers pair by
 * NORMALIZED NAME — whitespace-stripped and casefolded, with emoji stripped
 * too (FF authors rename "Kimi K3" -> "Kimi K3 JB (secondary)" while keeping
 * the identifier, and decorate names with emoji variants; both levels catch
 * that). The normalization is deliberately shallow: no stemming, no
 * punctuation folding beyond whitespace.
 *
 * Deliberate differences from v1:
 *   - name-match pass pairs duplicate names IN ORDER (FIFO queues per
 *     normalized name); v1 only ever paired the first right-hand candidate,
 *     leaving later duplicates unmatched.
 *   - "moved" is a longest-increasing-subsequence of matched rows' right
 *     positions (patience sort), not a raw index compare; v1 flagged every
 *     row shifted by an insertion/deletion as moved even though none of
 *     them actually changed position relative to each other.
 *
 * Row statuses:
 *   same        — identifier-or-name matched, nothing differs
 *   changed     — matched, but content / role / injection_position / depth /
 *                 order / enabled differ
 *   moved       — matched, all fields equal, but not part of the longest
 *                 in-order run of matched pairs
 *   only-left / only-right — unmatched
 *
 * Only PLACED blocks — the flat leaf sequence of `sequences[0]` — become
 * rows (v1 parity: unplaced library blocks and markers/ghosts are not
 * compared).
 */
import { flattenSeq } from './outline.js';
import { canonicalJson } from './canonical.js';

// fields whose difference makes a matched row "changed"
export const ROW_FIELDS = ['content', 'role', 'injection_position', 'injection_depth', 'injection_order', 'enabled'];

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{200D}♀♂]/gu;

/**
 * Whitespace-stripped, emoji-stripped, casefolded name for matching (v1
 * `norm_name`).
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function normName(name) {
    if (!name) return '';
    const stripped = String(name).replace(EMOJI_RE, '').normalize('NFKC');
    return stripped.replace(/\s+/g, '').toLowerCase();
}

/**
 * Placed blocks of a document's first sequence, in flat (publish) order,
 * 1-based. Markers, ghosts, dangling refs and blocks absent from the
 * sequence are excluded; a ref repeated in the sequence is counted once.
 * @param {any} doc
 * @returns {{pos: number, identifier: string}[]}
 */
export function blockOrder(doc) {
    const rows = doc.sequences?.[0]?.rows ?? [];
    const entries = flattenSeq(rows);
    const seen = new Set();
    /** @type {{pos: number, identifier: string}[]} */
    const out = [];
    for (const entry of entries) {
        const leaf = entry.leaf;
        if (leaf?.kind !== 'block') continue;
        const ref = leaf.ref;
        if (!ref || !doc.blocks?.[ref] || seen.has(ref)) continue;
        seen.add(ref);
        out.push({ pos: out.length + 1, identifier: ref });
    }
    return out;
}

/**
 * The comparable row fields of a block, as the ROW_FIELDS keys.
 * @param {any} doc
 * @param {string} identifier
 */
function blockRow(doc, identifier) {
    const block = doc.blocks[identifier];
    return {
        content: block.content ?? '',
        role: block.role ?? 'system',
        injection_position: block.fields?.injection_position ?? null,
        injection_depth: block.fields?.injection_depth ?? null,
        injection_order: block.fields?.injection_order ?? null,
        enabled: !!doc.loadouts?.[doc.activeLoadoutId]?.enabled?.[identifier],
    };
}

/**
 * @param {ReturnType<typeof blockRow>} ra
 * @param {ReturnType<typeof blockRow>} rb
 * @returns {{key: string, a: any, b: any}[]}
 */
function fieldDiffs(ra, rb) {
    /** @type {{key: string, a: any, b: any}[]} */
    const out = [];
    for (const key of ROW_FIELDS) {
        if (canonicalJson(ra[key]) !== canonicalJson(rb[key])) {
            out.push({ key, a: ra[key], b: rb[key] });
        }
    }
    return out;
}

/**
 * Indices (into `matchedRows`) that form a longest strictly-increasing
 * subsequence of `right.pos`, computed by patience sort with predecessor
 * links. O(n log n).
 * @param {{right: {pos: number}}[]} matchedRows
 * @returns {Set<number>}
 */
function longestIncreasingRun(matchedRows) {
    const n = matchedRows.length;
    const values = matchedRows.map((r) => r.right.pos);
    /** @type {number[]} */
    const tailsIdx = [];
    /** @type {number[]} */
    const pred = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
        const v = values[i];
        let lo = 0, hi = tailsIdx.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[tailsIdx[mid]] < v) lo = mid + 1; else hi = mid;
        }
        if (lo > 0) pred[i] = tailsIdx[lo - 1];
        if (lo === tailsIdx.length) tailsIdx.push(i); else tailsIdx[lo] = i;
    }
    /** @type {Set<number>} */
    const inRun = new Set();
    let k = tailsIdx.length ? tailsIdx[tailsIdx.length - 1] : -1;
    while (k !== -1) {
        inRun.add(k);
        k = pred[k];
    }
    return inRun;
}

/**
 * Diff canonical library docs a (left) and b (right).
 * @param {any} a
 * @param {any} b
 * @returns {{rows: any[], settings: {key: string, a?: any, b?: any}[], counts: Record<string, number>, identical: boolean}}
 */
export function comparePresets(a, b) {
    const leftOrder = blockOrder(a);
    const rightOrder = blockOrder(b);
    const rightById = new Map(rightOrder.map((r) => [r.identifier, r]));
    const usedRight = new Set();
    /** @type {Map<string, {right: {pos: number, identifier: string}, matchedBy: 'id'|'name'}>} */
    const pairs = new Map();

    // pass 1: by identifier
    for (const l of leftOrder) {
        const r = rightById.get(l.identifier);
        if (r && !usedRight.has(r.identifier)) {
            pairs.set(l.identifier, { right: r, matchedBy: 'id' });
            usedRight.add(r.identifier);
        }
    }

    // pass 2: by normalized name, FIFO queues per name in right order
    /** @type {Map<string, {pos: number, identifier: string}[]>} */
    const rightByName = new Map();
    for (const r of rightOrder) {
        if (usedRight.has(r.identifier)) continue;
        const nm = normName(b.blocks[r.identifier]?.name ?? r.identifier);
        if (!nm) continue;
        if (!rightByName.has(nm)) rightByName.set(nm, []);
        rightByName.get(nm).push(r);
    }
    for (const l of leftOrder) {
        if (pairs.has(l.identifier)) continue;
        const nm = normName(a.blocks[l.identifier]?.name ?? l.identifier);
        if (!nm) continue;
        const queue = rightByName.get(nm);
        if (queue && queue.length) {
            const r = queue.shift();
            pairs.set(l.identifier, { right: r, matchedBy: 'name' });
            usedRight.add(r.identifier);
        }
    }

    // build rows in left order; unmatched left blocks become only-left rows
    /** @type {any[]} */
    const rows = [];
    /** @type {any[]} */
    const matchedRows = [];
    for (const l of leftOrder) {
        const leftBlock = a.blocks[l.identifier];
        const leftEntry = { pos: l.pos, identifier: l.identifier, name: leftBlock.name ?? l.identifier };
        const pair = pairs.get(l.identifier);
        if (pair) {
            const r = pair.right;
            const rightBlock = b.blocks[r.identifier];
            const rightEntry = { pos: r.pos, identifier: r.identifier, name: rightBlock.name ?? r.identifier };
            const fields = fieldDiffs(blockRow(a, l.identifier), blockRow(b, r.identifier));
            const row = {
                status: 'same',
                matchedBy: pair.matchedBy,
                name: leftEntry.name,
                left: leftEntry,
                right: rightEntry,
                fields,
            };
            rows.push(row);
            matchedRows.push(row);
        } else {
            rows.push({ status: 'only-left', name: leftEntry.name, left: leftEntry, fields: [] });
        }
    }

    // moved detection: matched rows NOT on the longest in-order run
    const inRun = longestIncreasingRun(matchedRows);
    matchedRows.forEach((row, i) => {
        if (!inRun.has(i)) row.movedFrom = row.left.pos;
        row.status = row.fields.length ? 'changed' : (row.movedFrom !== undefined ? 'moved' : 'same');
    });

    // unmatched right blocks: insert each right after the row holding its
    // right-hand predecessor (pos-1); pos 1 goes at the front.
    const unmatchedRight = rightOrder
        .filter((r) => !usedRight.has(r.identifier))
        .map((r) => {
            const rightBlock = b.blocks[r.identifier];
            const rightEntry = { pos: r.pos, identifier: r.identifier, name: rightBlock.name ?? r.identifier };
            return { status: 'only-right', name: rightEntry.name, right: rightEntry, fields: [] };
        });
    for (const row of unmatchedRight) {
        const p = row.right.pos;
        const insertAt = p === 1 ? 0 : rows.findIndex((rr) => rr.right?.pos === p - 1) + 1;
        rows.splice(insertAt, 0, row);
    }

    const counts = { same: 0, changed: 0, moved: 0, 'only-left': 0, 'only-right': 0 };
    for (const row of rows) counts[row.status]++;

    const sa = a.settings ?? {};
    const sb = b.settings ?? {};
    const keys = Array.from(new Set([...Object.keys(sa), ...Object.keys(sb)])).sort();
    /** @type {{key: string, a?: any, b?: any}[]} */
    const settings = [];
    for (const key of keys) {
        const hasA = Object.prototype.hasOwnProperty.call(sa, key);
        const hasB = Object.prototype.hasOwnProperty.call(sb, key);
        if (hasA && hasB && canonicalJson(sa[key]) === canonicalJson(sb[key])) continue;
        /** @type {{key: string, a?: any, b?: any}} */
        const entry = { key };
        if (hasA) entry.a = sa[key];
        if (hasB) entry.b = sb[key];
        settings.push(entry);
    }

    const identical = counts.same === rows.length && settings.length === 0;
    return { rows, settings, counts, identical };
}
