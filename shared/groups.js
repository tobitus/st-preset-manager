/**
 * Group semantics over the enabled map.
 *
 * A document's `sequences` hold the outline; the loadout's `enabled` map
 * holds the on/off bits. A pick-one group's choice is "the one member whose
 * enabled is true". `normalize` enforces ≤1 on every compile and write path:
 * the last one switched on wins, siblings go off. `none` stays legal for
 * pick-one (v1 rule).
 *
 * Pure functions: doc sequences + enabled map in, corrected map out.
 */

/**
 * All group nodes in a document's sequences.
 * @param {any} doc
 * @returns {any[]}
 */
export function collectGroups(doc) {
    /** @type {any[]} */
    const out = [];
    for (const seq of doc.sequences ?? []) {
        walk(seq.rows ?? [], out);
    }
    return out;
}

function walk(rows, out) {
    for (const row of rows) {
        if (row.kind === 'group') out.push(row);
        for (const f of ['rows', 'options']) {
            const child = row[f];
            if (Array.isArray(child)) walk(child, out);
        }
    }
}

/**
 * True when `content` is non-blank but holds nothing besides `{{// … }}` ST
 * comments and `{{trim}}` macros (Nemo's `{{// … }}{{trim}}` headings).
 * Blank or missing content is NOT comment-only.
 * @param {any} content
 * @returns {boolean}
 */
export function isCommentOnly(content) {
    const s = String(content ?? '');
    if (s.trim() === '') return false;
    return s.replace(/\{\{\/\/[\s\S]*?\}\}/g, '').replace(/\{\{trim\}\}/gi, '').trim() === '';
}

/**
 * The leaves that count toward a pick-one group's "at most one on" rule: its
 * options, then the leaves its `remote` keys resolve to (linked members, in
 * remote order; unresolved keys are skipped). The heading is never a choice,
 * whatever its content (round 3).
 * @param {any} doc
 * @param {any} grp
 * @returns {any[]}
 */
export function pickOneMembers(doc, grp) {
    const members = [...(grp.options ?? [])];
    if (grp.remote?.length) {
        const byKey = new Map(iterLeaves(doc).map((l) => [l.key, l]));
        for (const key of grp.remote) {
            const leaf = byKey.get(key);
            if (leaf) members.push(leaf);
        }
    }
    return members;
}

/**
 * Leaf identifier -> the owning group row (first group that lists the leaf
 * as a member). Members = options + linked (remote) members; a heading
 * never belongs to a group's member map.
 * @param {any} doc
 * @returns {Map<string, any>} identifier -> group
 */
export function groupOfLeaf(doc) {
    /** @type {Map<string, any>} */
    const m = new Map();
    for (const grp of collectGroups(doc)) {
        const members = pickOneMembers(doc, grp);
        for (const leaf of members) {
            const ident = leaf.ref ?? leaf.identifier;
            if (ident != null && !m.has(ident)) m.set(ident, grp);
        }
    }
    return m;
}

/**
 * Enforce pick-one over an enabled map: for every pick-one group, if more
 * than one member (option or linked remote member) is enabled, keep ONE and
 * turn the others off (the heading is never a member, so it is never
 * touched). Markers/
 * ghosts are toggled like anything else (the loadout's enabled map covers
 * every leaf); group structure never changes.
 *
 * `seen` dedupes OPTION identifiers across groups exactly as before; remote
 * identifiers are neither filtered by `seen` nor added to it, so a leaf can
 * be a remote member of one group and an option of another and obey both.
 *
 * `preferred` (optional) names the option(s) that win a collapse regardless
 * of outline order: a string (the identifier the user just switched ON —
 * the panel route and /ops toggle pass it) or a Set of identifiers (the
 * ones a layer above the base explicitly turned on — the loadout
 * inheritance resolver passes it). With a Set, the LAST enabled member
 * (outline order) that is in the Set is kept; when none is in the
 * Set — and for null/no match, i.e. ambiguous imported/compiled state —
 * the last enabled member in outline order is kept.
 *
 * @param {any} doc document (sequences read-only here)
 * @param {Record<string, boolean>} enabled flat identifier -> bool map (every leaf)
 * @param {string[]} [changedOut] if given, identifiers flipped by this call are appended
 * @param {string|Set<string>|null} [preferred] the option(s) that win the collapse
 * @returns {Record<string, boolean>} the same map (mutated in place for convenience)
 */
export function normalize(doc, enabled, changedOut = undefined, preferred = null) {
    const owner = groupOfLeaf(doc);
    const seen = new Set();
    for (const grp of collectGroups(doc)) {
        if (grp.cardinality !== 'pick-one') continue;
        const members = pickOneMembers(doc, grp);
        const optIdents = members
            .slice(0, (grp.options ?? []).length)
            .map((leaf) => leaf.ref ?? leaf.identifier)
            .filter((id) => id != null && !seen.has(id));
        for (const id of optIdents) seen.add(id);
        const remoteIdents = members
            .slice((grp.options ?? []).length)
            .map((leaf) => leaf.ref ?? leaf.identifier)
            .filter((id) => id != null);
        const idents = [...optIdents, ...remoteIdents.filter((id) => !optIdents.includes(id))];
        const on = idents.filter((id) => !!enabled[id]);
        if (on.length > 1) {
            // the option just switched on wins; outline-order last is the
            // fallback for ambiguous bulk state
            const pref = preferred instanceof Set
                ? on.filter((id) => preferred.has(id))
                : preferred != null && on.includes(preferred) ? [preferred] : [];
            const keep = pref.length ? pref[pref.length - 1] : on[on.length - 1];
            for (const id of on) {
                if (id !== keep) {
                    enabled[id] = false;
                    changedOut?.push(id);
                }
            }
        }
    }
    void owner;
    return enabled;
}

/**
 * Ensure every leaf of the document has an entry in the enabled map
 * (default false) — a loadout covers every leaf by construction.
 * @param {any} doc
 * @param {Record<string, boolean>} enabled
 * @returns {Record<string, boolean>}
 */
export function ensureAllLeaves(doc, enabled) {
    for (const leaf of iterLeaves(doc)) {
        const id = leaf.ref ?? leaf.identifier;
        if (id != null && !(id in enabled)) enabled[id] = false;
    }
    return enabled;
}

/**
 * Every leaf row in document order (marker|block|ghost).
 * @param {any} doc
 */
export function iterLeaves(doc) {
    /** @type {any[]} */
    const out = [];
    for (const seq of doc.sequences ?? []) walkLeaves(seq.rows ?? [], out);
    return out;
}

function walkLeaves(rows, out) {
    for (const row of rows) {
        switch (row.kind) {
            case 'marker':
            case 'block':
            case 'ghost':
                out.push(row);
                break;
            case 'section':
                if (row.header) out.push(row.header);
                walkLeaves(row.rows ?? [], out);
                break;
            case 'group':
                if (row.header) out.push(row.header);
                walkLeaves(row.options ?? [], out);
                break;
            default:
                break;
        }
    }
}

/**
 * Complete a per-Model loadout override: for every pick-one group, if a
 * member's override value is `true`, its siblings are forced `false` (the
 * last-in-`enabled`-key-order winner if more than one is on). Members =
 * options + linked (remote) members (see pickOneMembers). Members of
 * non-pick-one groups and plain blocks are left exactly as given. The
 * heading is never a member.
 * @param {any} doc
 * @param {Record<string, boolean>} enabled override map (not mutated)
 * @returns {Record<string, boolean>} a new map
 */
export function completeOverride(doc, enabled) {
    /** @type {Record<string, boolean>} */
    const out = { ...enabled };
    for (const grp of collectGroups(doc)) {
        if (grp.cardinality !== 'pick-one') continue;
        const members = pickOneMembers(doc, grp);
        const idents = members
            .map((leaf) => leaf.ref ?? leaf.identifier)
            .filter((id) => id != null);
        const onKeys = Object.keys(enabled).filter((k) => idents.includes(k) && enabled[k]);
        if (onKeys.length === 0) continue;
        const winner = onKeys[onKeys.length - 1];
        for (const id of idents) {
            if (id !== winner) out[id] = false;
        }
    }
    return out;
}
