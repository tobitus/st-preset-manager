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
 * The leaves that count toward a pick-one group's "at most one on" rule: the
 * heading (if any) followed by all options. A comment-only heading (Nemo's
 * `{{// … }}{{trim}}` headings) sends no text, so it is no pick-one member.
 * @param {any} doc
 * @param {any} grp
 * @returns {any[]}
 */
export function pickOneMembers(doc, grp) {
    /** @type {any[]} */
    const members = [];
    const h = grp.header;
    if (h) {
        const id = h.ref ?? h.identifier;
        const silent = h.kind === 'block' && isCommentOnly(doc.blocks?.[id]?.content);
        if (!silent) members.push(h);
    }
    for (const opt of grp.options ?? []) members.push(opt);
    return members;
}

/**
 * Leaf identifier -> the owning group row (first group that lists the leaf
 * as a member). Headings count as members for cardinality, except
 * comment-only headings: a pick-one group whose heading is enabled pins the
 * heading choice.
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
 * than one member is enabled, keep ONE and turn the others off. Markers/
 * ghosts are toggled like anything else (the loadout's enabled map covers
 * every leaf); group structure never changes.
 *
 * `preferred` (optional) is the identifier the user just switched ON: it
 * wins over its siblings regardless of outline order (the panel route and
 * /ops toggle pass it; ambiguous imported/compiled state falls back to the
 * last enabled member in outline order).
 *
 * @param {any} doc document (sequences read-only here)
 * @param {Record<string, boolean>} enabled flat identifier -> bool map (every leaf)
 * @param {string[]} [changedOut] if given, identifiers flipped by this call are appended
 * @param {string|null} [preferred] the option just enabled (wins the collapse)
 * @returns {Record<string, boolean>} the same map (mutated in place for convenience)
 */
export function normalize(doc, enabled, changedOut = undefined, preferred = null) {
    const owner = groupOfLeaf(doc);
    const seen = new Set();
    for (const grp of collectGroups(doc)) {
        if (grp.cardinality !== 'pick-one') continue;
        const members = pickOneMembers(doc, grp);
        const idents = members
            .map((leaf) => leaf.ref ?? leaf.identifier)
            .filter((id) => id != null && !seen.has(id));
        for (const id of idents) seen.add(id);
        const on = idents.filter((id) => !!enabled[id]);
        if (on.length > 1) {
            // the option just switched on wins; outline-order last is the
            // fallback for ambiguous bulk state
            const keep = preferred != null && on.includes(preferred) ? preferred : on[on.length - 1];
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
 * last-in-`enabled`-key-order winner if more than one is on). Members of
 * non-pick-one groups and plain blocks are left exactly as given. A
 * comment-only heading is no member (see pickOneMembers).
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
