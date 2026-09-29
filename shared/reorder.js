/**
 * ST-panel reorder write-back (owner decision 2026-09-29, option (a)): apply
 * a reorder done in ST's own prompt-manager panel to the library as the
 * MINIMAL set of moved leaves, each landing on its new following neighbour
 * with v2's drop rules, instead of flattening the whole sequence to the
 * panel's order.
 *
 * ST's panel only shows leaves whose identifier survives compilation (a
 * suppressed empty section/group heading never appears), so `order` can
 * lack some of the sequence's identifiers. Leaves absent from `order` never
 * move: a moved row lands ABOVE the absent run glued over its new following
 * neighbour (so an invisible heading stays on the row that followed it),
 * unless the moved row already belonged to that heading's section/group.
 *
 * Among the PRESENT leaves, the ones that actually moved are the complement
 * of the heaviest strictly-increasing chain (by original index) over ST's
 * order — the same anchored-chain DP as `compare.js`'s `anchoredChain`,
 * weighting a section/group heading 3 and every other row 2 so that keeping
 * a heading in the chain only pays when it saves two or more rows from
 * moving. Each moved row is then spliced to sit directly above its new
 * following neighbour in `order` (skipping any absent leaves already glued
 * above that neighbour, unless the moved row itself belonged to the
 * heading governing them): a single item/option re-derives its rank by
 * v2's join-the-drop-target's-group rule; a group or section heading moved
 * alone takes its whole group/section with it, snapping to the group above
 * an option drop or to the section it lands inside. Any step that would
 * change the rank, group or section of a row that did NOT move is rejected
 * (reverted) rather than applied — the caller's next apply re-sends the
 * library's own order, which is therefore a fixed point.
 */

/** @param {any} e @returns {string} */
function id(e) {
    return e.leaf.ref ?? e.leaf.identifier;
}

/** @param {any} e @returns {string} */
function key(e) {
    return e.leaf.key;
}

/**
 * The group (heading key, if any, plus contiguous option keys) containing
 * index `i` of `arr` (an option or group-heading entry).
 * @param {any[]} arr
 * @param {number} i
 * @returns {Set<string>}
 */
function groupKeysAt(arr, i) {
    let start = i;
    while (start > 0 && arr[start - 1].rank === 'option') start--;
    if (start > 0 && arr[start - 1].rank === 'group') start--;
    /** @type {Set<string>} */
    const keys = new Set();
    let p = start;
    if (arr[p].rank === 'group') {
        keys.add(key(arr[p]));
        p++;
    }
    while (p < arr.length && arr[p].rank === 'option') {
        keys.add(key(arr[p]));
        p++;
    }
    return keys;
}

/**
 * Max-weight strictly-increasing-value chain over `values`/`weights`
 * (parallel arrays), O(k^2) DP mirroring `compare.js`'s `anchoredChain`:
 * for each i, the best j < i with a strictly smaller value wins (ties keep
 * the first found); the chain end is the first index attaining the max dp.
 * @param {number[]} values
 * @param {number[]} weights
 * @returns {Set<number>} chosen indices
 */
function heaviestChain(values, weights) {
    const n = values.length;
    const dp = new Array(n).fill(0);
    const pred = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
        let best = 0, bestJ = -1;
        for (let j = 0; j < i; j++) {
            if (values[j] < values[i] && dp[j] > best) {
                best = dp[j];
                bestJ = j;
            }
        }
        dp[i] = best + weights[i];
        pred[i] = bestJ;
    }
    let end = -1, bestDp = 0;
    for (let i = 0; i < n; i++) {
        if (dp[i] > bestDp) {
            bestDp = dp[i];
            end = i;
        }
    }
    /** @type {Set<number>} */
    const chosen = new Set();
    let k = end;
    while (k !== -1) {
        chosen.add(k);
        k = pred[k];
    }
    return chosen;
}

/**
 * Per-key signature used to detect an unmoved row's structure changing:
 * rank, then (section name for a section heading; JSON gmeta for an
 * option/group; '' otherwise), then the key of the nearest preceding
 * section entry ('' for section headings themselves, tracked over every
 * entry whether excluded or not), then — for an option/group — the sorted,
 * comma-joined keys of its group's members (as `rebuildSeq` would group
 * them) with `exclude` keys removed ('' otherwise). Entries whose key is in
 * `exclude` get no signature at all.
 * @param {any[]} arr
 * @param {Set<string>} exclude
 * @returns {Map<string, string>}
 */
function sigs(arr, exclude) {
    const n = arr.length;
    /** @type {(string|null)[]} */
    const precedingSection = new Array(n).fill(null);
    let curSection = /** @type {string|null} */ (null);
    for (let i = 0; i < n; i++) {
        if (arr[i].rank === 'section') {
            precedingSection[i] = null;
            curSection = key(arr[i]);
        } else {
            precedingSection[i] = curSection;
        }
    }
    /** @type {number[]} */
    const groupIdOf = new Array(n).fill(-1);
    /** @type {string[][]} */
    const groups = [];
    let i = 0;
    while (i < n) {
        if (arr[i].rank === 'group') {
            const gidx = groups.length;
            /** @type {string[]} */
            const g = [key(arr[i])];
            groupIdOf[i] = gidx;
            let j = i + 1;
            while (j < n && arr[j].rank === 'option') {
                g.push(key(arr[j]));
                groupIdOf[j] = gidx;
                j++;
            }
            groups.push(g);
            i = j;
        } else if (arr[i].rank === 'option') {
            const gidx = groups.length;
            /** @type {string[]} */
            const g = [];
            let j = i;
            while (j < n && arr[j].rank === 'option') {
                g.push(key(arr[j]));
                groupIdOf[j] = gidx;
                j++;
            }
            groups.push(g);
            i = j;
        } else {
            i++;
        }
    }
    // one sorted member string per group (not per member): O(n log n) per call
    const groupStr = groups.map((g) => g.filter((mk) => !exclude.has(mk)).sort().join(','));
    /** @type {Map<string, string>} */
    const out = new Map();
    for (let idx = 0; idx < n; idx++) {
        const e = arr[idx];
        const k = key(e);
        if (exclude.has(k)) continue;
        let extra = '';
        if (e.rank === 'section') extra = e.sname ?? '';
        else if (e.rank === 'option' || e.rank === 'group') extra = JSON.stringify(e.gmeta);
        const precKey = e.rank === 'section' ? '' : (precedingSection[idx] ?? '');
        const groupPart = e.rank === 'option' || e.rank === 'group' ? (groupStr[groupIdOf[idx]] ?? '') : '';
        out.set(k, [e.rank, extra, precKey, groupPart].join('\u0001'));
    }
    return out;
}

/**
 * Bounds on one panel write-back (the server's work stays bounded; like
 * compare.js's MAX_DIFF_LEAVES): the chain DP is O(k^2) in the rows ST
 * shows, and each moved row costs O(n log n) (placement + structure check).
 * A drag in ST's panel moves one row per SETTINGS_UPDATED, so a larger moved
 * set is not a panel drag. Past either bound the write-back is refused
 * (document unchanged; the bridge's re-apply puts ST back on the library
 * order).
 */
export const MAX_PANEL_LEAVES = 5000;
export const MAX_PANEL_MOVES = 200;

/**
 * Reorder one sequence's flat rank entries to match ST's panel `order`,
 * preserving structure: identifiers absent from `order` never move; among
 * the present ones, only the minimal set outside the heaviest in-order
 * chain moves, each landing on its new neighbour with v2's drop rules. See
 * the module doc for the full rule set.
 * @param {any[]} entries flat rank entries (flattenSeq) of ONE sequence
 * @param {string[]} order ST's panel identifier order
 * @returns {any[]|null} the new flat entries, or null when nothing changes
 */
export function reorderEntries(entries, order) {
    /** @type {Map<string, number>} */
    const posInT = new Map();
    order.forEach((ident, i) => {
        if (!posInT.has(ident)) posInT.set(ident, i);
    });

    const seenIdent = new Set();
    /** @type {Set<string>} */
    const presentKeys = new Set();
    for (const e of entries) {
        const ident = id(e);
        if (!posInT.has(ident)) continue;
        if (seenIdent.has(ident)) continue;
        seenIdent.add(ident);
        presentKeys.add(key(e));
    }

    const Tp = entries
        .filter((e) => presentKeys.has(key(e)))
        .sort((a, b) => /** @type {number} */ (posInT.get(id(a))) - /** @type {number} */ (posInT.get(id(b))));
    if (Tp.length > MAX_PANEL_LEAVES) return null;

    const origIndex = new Map(entries.map((e, i) => [key(e), i]));
    const values = Tp.map((e) => /** @type {number} */ (origIndex.get(key(e))));
    const weights = Tp.map((e) => (e.rank === 'section' || e.rank === 'group' ? 3 : 2));
    const chainIdx = heaviestChain(values, weights);
    /** @type {Set<string>} */
    const chainKeys = new Set();
    for (const i of chainIdx) chainKeys.add(key(Tp[i]));

    const MOVED = Tp.filter((e) => !chainKeys.has(key(e)));
    if (MOVED.length === 0 || MOVED.length > MAX_PANEL_MOVES) return null;

    /** @type {Map<string, number>} */
    const tpIndexByKey = new Map(Tp.map((e, i) => [key(e), i]));

    // ---- original containers (from the entries as given, before any change)
    /** @type {Map<string, string|null>} */
    const origSection = new Map();
    {
        let curSec = /** @type {string|null} */ (null);
        for (const e of entries) {
            if (e.rank === 'section') {
                origSection.set(key(e), null);
                curSec = key(e);
            } else {
                origSection.set(key(e), curSec);
            }
        }
    }
    /** @type {Map<string, string|null>} */
    const origGroupHead = new Map();
    /** @type {Map<string, Set<string>>} */
    const origMates = new Map();
    {
        let i = 0;
        while (i < entries.length) {
            if (entries[i].rank === 'group') {
                const headKey = key(entries[i]);
                /** @type {string[]} */
                const groupKeys = [headKey];
                let j = i + 1;
                while (j < entries.length && entries[j].rank === 'option') {
                    groupKeys.push(key(entries[j]));
                    j++;
                }
                for (const gk of groupKeys) {
                    if (gk !== headKey) origGroupHead.set(gk, headKey);
                    origMates.set(gk, new Set(groupKeys.filter((x) => x !== gk)));
                }
                i = j;
            } else if (entries[i].rank === 'option') {
                /** @type {string[]} */
                const groupKeys = [];
                let j = i;
                while (j < entries.length && entries[j].rank === 'option') {
                    groupKeys.push(key(entries[j]));
                    j++;
                }
                for (const gk of groupKeys) {
                    origGroupHead.set(gk, null);
                    origMates.set(gk, new Set(groupKeys.filter((x) => x !== gk)));
                }
                i = j;
            } else {
                i++;
            }
        }
    }
    const wasMember = (/** @type {Set<string>} */ G, /** @type {string} */ xkey) => {
        const mates = origMates.get(xkey) ?? new Set();
        for (const gk of G) if (mates.has(gk)) return true;
        return false;
    };

    // ---- apply moves, descending ST order, each landing on its neighbour
    const movedSorted = MOVED.slice().sort(
        (a, b) => /** @type {number} */ (posInT.get(id(b))) - /** @type {number} */ (posInT.get(id(a))),
    );

    let cur = entries.slice();
    for (const X of movedSorted) {
        const snapshot = cur.slice();
        const xkey = key(X);
        const xi = cur.findIndex((e) => key(e) === xkey);
        const xEntry = cur[xi];
        const xRank = xEntry.rank;
        let xe;
        if (xRank === 'group') {
            xe = xi + 1;
            while (xe < cur.length && cur[xe].rank === 'option') xe++;
        } else if (xRank === 'section') {
            xe = xi + 1;
            while (xe < cur.length && cur[xe].rank !== 'section') xe++;
        } else {
            xe = xi + 1;
        }

        const ti = /** @type {number} */ (tpIndexByKey.get(xkey));
        const F = ti + 1 < Tp.length ? Tp[ti + 1] : null;
        const unitEntries = cur.slice(xi, xe);
        const unitKeysArr = unitEntries.map(key);
        if (F && unitKeysArr.includes(key(F))) continue;

        cur.splice(xi, xe - xi);

        let fi = F ? cur.findIndex((e) => key(e) === key(F)) : cur.length;
        let k2 = fi;
        while (k2 > 0 && !presentKeys.has(key(cur[k2 - 1]))) k2--;
        let at = k2;
        for (let j = k2; j < fi; j++) {
            if (
                (cur[j].rank === 'section' && key(cur[j]) === origSection.get(xkey)) ||
                (cur[j].rank === 'group' && key(cur[j]) === origGroupHead.get(xkey))
            ) {
                at = j + 1;
            }
        }

        if (xRank === 'section') {
            if (F === null) {
                at = cur.length;
            } else if (cur[at]?.rank === 'section') {
                // keep at
            } else {
                let j = at - 1;
                while (j >= 0 && cur[j].rank !== 'section') j--;
                if (j >= 0) {
                    at = j;
                } else {
                    let s = at;
                    while (s < cur.length && cur[s].rank !== 'section') s++;
                    at = s;
                }
            }
            cur.splice(at, 0, ...unitEntries);
        } else if (xRank === 'group') {
            if (cur[at]?.rank === 'option') {
                let j = at;
                while (j > 0 && cur[j - 1].rank === 'option') j--;
                if (j > 0 && cur[j - 1].rank === 'group') j--;
                at = j;
            }
            cur.splice(at, 0, ...unitEntries);
        } else {
            const A = cur[at];
            const B = at > 0 ? cur[at - 1] : undefined;
            let join, gm;
            if (A?.rank === 'option') {
                const G = groupKeysAt(cur, at);
                const inside = !!(B && (B.rank === 'option' || B.rank === 'group') && G.has(key(B)));
                join = inside || wasMember(G, xkey);
                gm = A.gmeta;
            } else if (B && (B.rank === 'option' || B.rank === 'group')) {
                const G = groupKeysAt(cur, at - 1);
                join = wasMember(G, xkey);
                gm = B.gmeta;
            } else {
                join = false;
            }
            if (xEntry.leaf.kind === 'marker' || xEntry.leaf.kind === 'ghost') join = false;
            const newEntry = join
                ? { ...xEntry, rank: 'option', gmeta: { ...gm } }
                : { ...xEntry, rank: 'item', gmeta: null };
            cur.splice(at, 0, newEntry);
        }

        const unitKeySet = new Set(unitKeysArr);
        const sigsBefore = sigs(snapshot, unitKeySet);
        const sigsAfter = sigs(cur, unitKeySet);
        let ok = true;
        for (const [k3, sig] of sigsBefore) {
            if (sigsAfter.get(k3) !== sig) {
                ok = false;
                break;
            }
        }
        if (!ok) cur = snapshot;
    }

    if (cur.length === entries.length) {
        let unchanged = true;
        for (let i = 0; i < cur.length; i++) {
            if (
                key(cur[i]) !== key(entries[i]) ||
                cur[i].rank !== entries[i].rank ||
                JSON.stringify(cur[i].gmeta) !== JSON.stringify(entries[i].gmeta) ||
                cur[i].sname !== entries[i].sname
            ) {
                unchanged = false;
                break;
            }
        }
        if (unchanged) return null;
    }
    return cur;
}
