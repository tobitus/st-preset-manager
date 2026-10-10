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
 *   - "moved" is a maximum-weight chain of strictly-increasing full
 *     positions over matched block pairs AND markers present on both sides
 *     (patience-sort-shaped DP with predecessor links), not a raw index
 *     compare; v1 flagged every row shifted by an insertion/deletion as
 *     moved even though none of them actually changed position relative to
 *     each other. Markers — ST's fixed slots like `chatHistory` — are fixed
 *     anchors: a block moved across one that exists on both sides is
 *     "moved" even when block-only order is unchanged, and a marker is
 *     never sacrificed to keep blocks in order. Markers are never rows.
 *
 * Row statuses:
 *   same        — identifier-or-name matched, nothing differs
 *   changed     — matched, but content / role / injection_position / depth /
 *                 order / enabled differ
 *   moved       — matched, all fields equal, but not part of the
 *                 highest-weight anchored chain of matched pairs
 *   only-left / only-right — unmatched
 *
 * Only PLACED blocks — the flat leaf sequence of `sequences[0]` — become
 * rows (v1 parity: unplaced library blocks and markers/ghosts are not
 * compared).
 */
import { flattenSeq } from './outline.js';
import { canonicalJson } from './canonical.js';
import { effectiveEnabled } from './loadouts.js';

// fields whose difference makes a matched row "changed"
export const ROW_FIELDS = ['content', 'role', 'injection_position', 'injection_depth', 'injection_order', 'enabled'];

/**
 * Largest leaf count (blocks, markers, ghosts of sequences[0]) per side.
 * POST /diff runs comparePresets synchronously in ST's own process, and the
 * anchored move chain is O(k²); real presets have < 300 leaves, and 5,000
 * keeps the worst allowed case well under a second (Phase 5 review 2).
 */
export const MAX_DIFF_LEAVES = 5000;

/** A request too large to compare (413, like /diff/blocks' DiffError). */
export class CompareError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'CompareError';
        this.status = 413;
    }
}

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
 * The enabled map of a document's active loadout (inheritance resolved, no
 * Model override); no active loadout -> empty (every block reads as off).
 * @param {any} doc
 * @returns {Record<string, boolean>}
 */
function activeEnabled(doc) {
    if (!doc.loadouts?.[doc.activeLoadoutId]) return {};
    return effectiveEnabled(doc, doc.activeLoadoutId, null).enabled;
}

/**
 * The comparable row fields of a block, as the ROW_FIELDS keys.
 * @param {any} doc
 * @param {string} identifier
 * @param {Record<string, boolean>} enabledMap the document's effective active-loadout enabled map
 */
function blockRow(doc, identifier, enabledMap) {
    const block = doc.blocks[identifier];
    return {
        content: block.content ?? '',
        role: block.role ?? 'system',
        injection_position: block.fields?.injection_position ?? null,
        injection_depth: block.fields?.injection_depth ?? null,
        injection_order: block.fields?.injection_order ?? null,
        enabled: !!enabledMap[identifier],
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
 * Every leaf of a document's first sequence in flat (publish) order:
 * placed blocks (same inclusion rule as `blockOrder`) and markers, each
 * counted once at its first occurrence. The array index is the leaf's
 * FULL position (blocks and markers interleaved), unlike `blockOrder`'s
 * block-only `pos`.
 * @param {any} doc
 * @returns {{kind: 'block'|'marker', identifier: string}[]}
 */
function leafOrder(doc) {
    const rows = doc.sequences?.[0]?.rows ?? [];
    const entries = flattenSeq(rows);
    const seenBlocks = new Set();
    const seenMarkers = new Set();
    /** @type {{kind: 'block'|'marker', identifier: string}[]} */
    const out = [];
    for (const entry of entries) {
        const leaf = entry.leaf;
        if (leaf?.kind === 'block') {
            const ref = leaf.ref;
            if (!ref || !doc.blocks?.[ref] || seenBlocks.has(ref)) continue;
            seenBlocks.add(ref);
            out.push({ kind: 'block', identifier: ref });
        } else if (leaf?.kind === 'marker') {
            const id = leaf.ref ?? leaf.identifier;
            if (!id || seenMarkers.has(id)) continue;
            seenMarkers.add(id);
            out.push({ kind: 'marker', identifier: id });
        }
    }
    return out;
}

/**
 * Left block identifiers that belong to the maximum-weight chain of
 * strictly-increasing full (right-side) positions over matched block pairs
 * and markers present in both docs' `leafOrder`. A marker weighs
 * `matchedPairCount + 1` so it always outweighs any all-blocks
 * alternative — it is never dropped to keep blocks in order — while a
 * block pair weighs 1, so among chains with the same markers the one
 * keeping the most blocks wins. O(k^2) DP with predecessor links; ties
 * broken by keeping the first (strictly-greater) predecessor found.
 * @param {any} a
 * @param {any} b
 * @param {Map<string, {right: {pos: number, identifier: string}, matchedBy: 'id'|'name'}>} pairs
 * @returns {Set<string>}
 */
function anchoredChain(a, b, pairs) {
    const leftLeaves = leafOrder(a);
    const rightLeaves = leafOrder(b);
    /** @type {Map<string, number>} */
    const rightBlockFullPos = new Map();
    /** @type {Map<string, number>} */
    const rightMarkerFullPos = new Map();
    rightLeaves.forEach((leaf, i) => {
        (leaf.kind === 'block' ? rightBlockFullPos : rightMarkerFullPos).set(leaf.identifier, i);
    });

    const markerWeight = pairs.size + 1;
    /** @type {{leftIdentifier: string|null, value: number, weight: number}[]} */
    const items = [];
    for (const leaf of leftLeaves) {
        if (leaf.kind === 'block') {
            const pair = pairs.get(leaf.identifier);
            if (!pair) continue;
            const value = rightBlockFullPos.get(pair.right.identifier);
            if (value === undefined) continue;
            items.push({ leftIdentifier: leaf.identifier, value, weight: 1 });
        } else {
            const value = rightMarkerFullPos.get(leaf.identifier);
            if (value === undefined) continue;
            items.push({ leftIdentifier: null, value, weight: markerWeight });
        }
    }

    const n = items.length;
    const dp = new Array(n).fill(0);
    const pred = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
        let best = 0, bestJ = -1;
        for (let j = 0; j < i; j++) {
            if (items[j].value < items[i].value && dp[j] > best) {
                best = dp[j];
                bestJ = j;
            }
        }
        dp[i] = best + items[i].weight;
        pred[i] = bestJ;
    }

    let end = -1, bestDp = 0;
    for (let i = 0; i < n; i++) {
        if (dp[i] > bestDp) {
            bestDp = dp[i];
            end = i;
        }
    }

    /** @type {Set<string>} */
    const chosen = new Set();
    let k = end;
    while (k !== -1) {
        if (items[k].leftIdentifier !== null) chosen.add(items[k].leftIdentifier);
        k = pred[k];
    }
    return chosen;
}

/**
 * Diff canonical library docs a (left) and b (right).
 * @param {any} a
 * @param {any} b
 * @returns {{rows: any[], settings: {key: string, a?: any, b?: any}[], counts: Record<string, number>, identical: boolean}}
 */
export function comparePresets(a, b) {
    for (const [label, doc] of [['a', a], ['b', b]]) {
        const leaves = flattenSeq(doc.sequences?.[0]?.rows ?? []).length;
        if (leaves > MAX_DIFF_LEAVES) {
            throw new CompareError(`preset ${label} too large to compare (${leaves} leaves, limit ${MAX_DIFF_LEAVES})`);
        }
    }
    const enabledA = activeEnabled(a);
    const enabledB = activeEnabled(b);
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
            const fields = fieldDiffs(blockRow(a, l.identifier, enabledA), blockRow(b, r.identifier, enabledB));
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

    // moved detection: matched pairs NOT on the highest-weight anchored chain
    const chosen = anchoredChain(a, b, pairs);
    matchedRows.forEach((row) => {
        if (!chosen.has(row.left.identifier)) row.movedFrom = row.left.pos;
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
