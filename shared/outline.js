/**
 * Outline ops — the leaf-rank model, ported from v1 outline.py.
 *
 * v2 leaf kinds: marker | block | ghost (v1: marker|component|ghost).
 * Governing invariant: screen order top to bottom IS compile order; sections
 * and groups never change which leaves compile or in which order.
 *
 * Flat entries: { leaf, rank: option|item|group|section, gmeta, sname }.
 * rebuildSeq derives container keys from heading leaves ("grp:<key>" /
 * "sec:<key>"), so any op sequence restoring the same flat sequence restores
 * identical rows. gmeta rides on group heading AND members (survives
 * promote/demote of any leaf); sname rides on the section heading leaf.
 *
 * Every structural op is flatten -> mutate ranks/order -> rebuildSeq, so the
 * nested `rows` stay the persisted form (schema unchanged) and rank/move ops
 * never touch enabled bits. Markers are only ever items: every op that would
 * make a marker a heading or an option raises OutlineError (ghosts cannot be
 * re-ranked at all — they have no name/content).
 */
import { newKey } from './canonical.js';

export const LEAF_KINDS = ['marker', 'block', 'ghost'];
export const RANKS = ['option', 'item', 'group', 'section'];

export class OutlineError extends Error {}

function gmetaOf(row) {
    return {
        name: row.name ?? '',
        cardinality: row.cardinality ?? 'pick-one-or-more',
        guessed: !!row.guessed,
    };
}

/**
 * Nested rows -> flat rank entries in compile order.
 * @param {any[]} rows
 * @param {string|null} [sname]
 */
export function flattenSeq(rows, sname = null) {
    /** @type {any[]} */
    const out = [];
    walk(rows, sname);
    return out;

    function walk(rs, sn) {
        for (const row of rs) {
            const kind = row?.kind;
            if (LEAF_KINDS.includes(kind)) {
                out.push({ leaf: row, rank: 'item', gmeta: null, sname: sn });
            } else if (kind === 'section') {
                const hdr = row.header;
                if (hdr) out.push({ leaf: hdr, rank: 'section', gmeta: null, sname: row.name ?? null });
                walk(row.rows ?? [], row.name ?? sn);
            } else if (kind === 'group') {
                const gm = gmetaOf(row);
                const hdr = row.header;
                if (hdr) {
                    // markers are only ever items (a group always ends at a marker)
                    if (hdr.kind === 'marker') {
                        out.push({ leaf: hdr, rank: 'item', gmeta: null, sname: sn });
                    } else {
                        out.push({ leaf: hdr, rank: 'group', gmeta: { ...gm }, sname: sn });
                    }
                }
                for (const opt of row.options ?? []) {
                    if (opt.kind === 'marker') {
                        out.push({ leaf: opt, rank: 'item', gmeta: null, sname: sn });
                    } else {
                        out.push({ leaf: opt, rank: 'option', gmeta: { ...gm }, sname: sn });
                    }
                }
            } else {
                // defensive: unknown container shapes ride as items
                out.push({ leaf: row, rank: 'item', gmeta: null, sname: sn });
            }
        }
    }
}

/** Deep-first leaf key of a container's children. */
function firstLeafKey(rows) {
    for (const row of rows) {
        if (LEAF_KINDS.includes(row?.kind)) return row.key ?? null;
        for (const f of ['header', 'rows', 'options']) {
            const child = row[f];
            if (Array.isArray(child)) {
                const k = firstLeafKey(child);
                if (k) return k;
            } else if (child && typeof child === 'object') {
                if (child.key) return child.key;
            }
        }
    }
    return null;
}

const DEFAULT_GMETA = () => ({ name: '', cardinality: 'pick-one-or-more', guessed: false });

/**
 * Flat rank entries -> nested rows (the persisted form). Pure function of
 * the entries. Markers can never be headings or options.
 * @param {any[]} entries
 */
export function rebuildSeq(entries) {
    /** @type {any[]} */
    const out = [];
    let /** @type {any} */ section = null;
    let /** @type {any} */ group = null;

    const gclose = () => {
        if (group === null) return;
        if (group.header === null && group.options.length === 0) {
            group = null;
            return;
        }
        const key = group.header ? group.header.key : group.options[0].key;
        group.key = 'grp:' + key;
        (section ? section.rows : out).push(group);
        group = null;
    };
    const sclose = () => {
        gclose();
        if (section !== null) {
            const key = (section.header ? section.header.key : null) || firstLeafKey(section.rows);
            section.key = 'sec:' + (key || newKey('sec'));
            out.push(section);
            section = null;
        }
    };

    for (const e of entries) {
        const leaf = e.leaf;
        const rank = e.rank;
        if (rank === 'section') {
            if (leaf.kind === 'marker') throw new OutlineError('markers can never be section headings');
            sclose();
            section = { kind: 'section', key: 'pending', name: e.sname ?? null, header: leaf, rows: [] };
        } else if (rank === 'group') {
            if (leaf.kind === 'marker') throw new OutlineError('markers can never be group headings');
            gclose();
            const gm = e.gmeta ?? DEFAULT_GMETA();
            group = {
                kind: 'group',
                key: 'pending',
                name: gm.name ?? '',
                cardinality: gm.cardinality ?? 'pick-one-or-more',
                guessed: !!gm.guessed,
                header: leaf,
                options: [],
            };
        } else if (rank === 'option') {
            if (leaf.kind === 'marker') throw new OutlineError('markers can never be group members');
            if (group === null) {
                const gm = e.gmeta ?? DEFAULT_GMETA();
                group = {
                    kind: 'group',
                    key: 'pending',
                    name: gm.name ?? '',
                    cardinality: gm.cardinality ?? 'pick-one-or-more',
                    guessed: !!gm.guessed,
                    header: null,
                    options: [],
                };
            }
            group.options.push(leaf);
        } else {
            gclose();
            (section ? section.rows : out).push(leaf);
        }
    }
    sclose();
    return out;
}

// ------------------------------------------------------------ structural ops
// (port of v1 outline.py: derive_structure / promote / demote / move_leaf /
// insert_entries; v1 `component` leaves are v2 `block` leaves)

/** Label used for derived group/section names (v1 `_label`). */
function label(doc, leaf) {
    if (leaf.kind === 'ghost') return leaf.identifier ?? '(order-only)';
    const comp = doc.blocks?.[leaf.ref];
    return comp?.name || leaf.ref || '(row)';
}

/**
 * A section's or group's displayed name. When the container HAS a heading
 * block, its name IS that block's name (the stored `name` can be stale in
 * older documents and is only re-synced on the next rename); a headerless
 * group, or one headed by a ghost, shows its stored name ('' when unset).
 * @param {any} doc
 * @param {any} row a `section` or `group` row
 * @returns {string}
 */
export function containerName(doc, row) {
    const hdr = row?.header;
    if (hdr?.kind === 'block') {
        const name = doc?.blocks?.[hdr.ref]?.name;
        if (name) return name;
    }
    return row?.name ?? '';
}

/**
 * Keep every stored section/group `name` equal to the heading block's name
 * after a rename of block `identifier`. A no-op when the block has no name
 * or heads nothing.
 * @param {any} doc
 * @param {string} identifier
 */
export function syncHeadingNames(doc, identifier) {
    const name = doc.blocks?.[identifier]?.name;
    if (!name) return;
    const walk = (/** @type {any[]} */ rows) => {
        for (const row of rows ?? []) {
            if (row?.kind === 'section' || row?.kind === 'group') {
                if (row.header?.kind === 'block' && row.header.ref === identifier) {
                    row.name = name;
                }
                if (row.kind === 'section') walk(row.rows);
            }
        }
    };
    for (const seq of doc.sequences ?? []) walk(seq.rows);
}

/**
 * Re-derive every sequence's structure from its flat leaf sequence (v1
 * `derive_structure`). Run after import: the nested rows become EXACTLY what
 * `rebuildSeq(flattenSeq(rows))` produces, so every rank op is byte-exact
 * invertible from the first application. Leaf order, leaf content and
 * enabled bits are untouched.
 * @param {any} doc
 */
export function deriveStructure(doc) {
    for (const seq of doc.sequences ?? []) {
        seq.rows = rebuildSeq(flattenSeq(seq.rows ?? []));
    }
}

/**
 * (seq, entries, index) for the sequence holding leaf `key`.
 * @param {any} doc
 * @param {string} key
 */
function findSeq(doc, key) {
    for (const seq of doc.sequences ?? []) {
        const entries = flattenSeq(seq.rows ?? []);
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].leaf.key === key) return { seq, entries, i };
        }
    }
    throw new OutlineError(`no row with key ${JSON.stringify(key)}`);
}

/** Markers are fixed ST slots; ghosts have nothing to re-rank. */
function checkRankable(leaf) {
    if (leaf.kind === 'marker') {
        throw new OutlineError('markers are fixed ST slots — they can never be headings or options');
    }
    if (leaf.kind === 'ghost') {
        throw new OutlineError('order-only entries have no name or content and cannot be re-ranked');
    }
}

/**
 * Move a row one step UP the ladder: option -> item -> group -> section.
 *
 * Exactly invertible: state the inverse op cannot re-derive (a swallowed
 * group's metadata, a section's exact name) is stashed ON the leaf row
 * (`_gmeta` / `_sname`) and popped by the inverse op. A completed
 * promote∘demote round-trip leaves the doc byte-identical — a stash is
 * written only when its inverse needs it and popped when consumed.
 * @param {any} doc
 * @param {string} key
 * @returns {any} the moved leaf row
 */
export function promote(doc, key) {
    const { seq, entries, i } = findSeq(doc, key);
    const e = entries[i];
    const leaf = e.leaf;
    checkRankable(leaf);
    const r = e.rank;
    if (r === 'option') {
        e.rank = 'item';
        leaf._gmeta = e.gmeta; // demote(item) restores the group exactly
    } else if (r === 'item') {
        e.rank = 'group';
        if (leaf._gmeta != null) { // it used to be an option: reuse its group
            e.gmeta = leaf._gmeta;
            delete leaf._gmeta;
        } else {
            e.gmeta = { name: label(doc, leaf), cardinality: 'pick-one-or-more', guessed: false };
        }
        if (e.sname != null && e.sname !== label(doc, leaf)) {
            leaf._sname = e.sname; // demote(group) restores the section name
        }
    } else if (r === 'group') {
        e.rank = 'section';
        const gm = e.gmeta;
        const stash = leaf._sname ?? null;
        if (stash !== undefined && leaf._sname !== undefined) delete leaf._sname;
        e.sname = stash ?? (gm?.name ? gm.name : label(doc, leaf));
        // stash the group identity only when demote cannot re-derive it
        if (gm && JSON.stringify(gm) !== JSON.stringify({ name: label(doc, leaf), cardinality: 'pick-one-or-more', guessed: false })) {
            leaf._gmeta = gm;
        }
    } else {
        throw new OutlineError('row is already a section heading (top of the ladder)');
    }
    seq.rows = rebuildSeq(entries);
    return leaf;
}

/**
 * Move a row one step DOWN the ladder: section -> group -> item -> option.
 * Exact inverse of promote: pops the stashes promote left (see there).
 * @param {any} doc
 * @param {string} key
 * @returns {any} the moved leaf row
 */
export function demote(doc, key) {
    const { seq, entries, i } = findSeq(doc, key);
    const e = entries[i];
    const leaf = e.leaf;
    checkRankable(leaf);
    const r = e.rank;
    if (r === 'section') {
        e.rank = 'group';
        e.gmeta = leaf._gmeta !== undefined ? leaf._gmeta : null;
        if (leaf._gmeta !== undefined) delete leaf._gmeta;
        if (e.gmeta === null) {
            e.gmeta = { name: label(doc, leaf), cardinality: 'pick-one-or-more', guessed: false };
        }
        // stash the section name only when promote(group) could not re-derive it
        const gm = e.gmeta;
        if (e.sname != null && e.sname !== (gm?.name ? gm.name : label(doc, leaf))) {
            leaf._sname = e.sname;
        }
    } else if (r === 'group') {
        e.rank = 'item';
        const stash = leaf._sname;
        if (stash !== undefined) {
            delete leaf._sname;
            e.sname = stash;
        } else {
            const sname = e.gmeta?.name ?? null;
            if (e.sname === null && sname && sname !== label(doc, leaf)) {
                e.sname = sname; // the section continues under the (former) group name
            }
        }
    } else if (r === 'item') {
        e.rank = 'option';
        if (leaf._gmeta !== undefined) {
            e.gmeta = leaf._gmeta;
            delete leaf._gmeta;
        } else {
            e.gmeta = e.gmeta ?? null;
        }
    } else {
        throw new OutlineError('row is already an option (bottom of the ladder)');
    }
    seq.rows = rebuildSeq(entries);
    return leaf;
}

/**
 * A plain item becomes a section heading directly, named after its block:
 * the rows below it up to the next section heading become its children.
 * One atomic op, the exact inverse of unmakeSection — a completed
 * makeSection∘unmakeSection round trip leaves the doc byte-identical.
 * Options, group headings, section headings, markers and ghosts are
 * refused. The block's content, name and enabled bit are untouched (an
 * empty heading is suppressed from the compiled slot as before).
 * @param {any} doc
 * @param {string} key
 * @returns {any} the row's leaf
 */
export function makeSection(doc, key) {
    const { seq, entries, i } = findSeq(doc, key);
    const e = entries[i];
    const leaf = e.leaf;
    checkRankable(leaf);
    if (e.rank === 'section') {
        throw new OutlineError('row is already a section heading');
    }
    if (e.rank !== 'item') {
        throw new OutlineError(`Make section heading works on a plain row — make it a plain row first (this row is ${e.rank === 'option' ? 'a group option' : 'a group heading'})`);
    }
    e.rank = 'section';
    e.sname = label(doc, leaf);
    seq.rows = rebuildSeq(entries);
    return leaf;
}

/**
 * A section heading becomes a plain item directly: its rows rejoin the
 * section above (or the top level). One atomic op, the exact inverse of
 * makeSection. The block's content, name and enabled bit are untouched.
 * @param {any} doc
 * @param {string} key
 * @returns {any} the row's leaf
 */
export function unmakeSection(doc, key) {
    const { seq, entries, i } = findSeq(doc, key);
    const e = entries[i];
    const leaf = e.leaf;
    if (e.rank !== 'section') {
        throw new OutlineError('row is not a section heading');
    }
    e.rank = 'item';
    seq.rows = rebuildSeq(entries);
    return leaf;
}

/**
 * Maximal structural block [start, end) containing index i.
 * - option -> the single option (moves within its group only)
 * - group heading -> heading + its whole option run
 * - section heading -> the whole section (until the next section heading)
 * - item -> the single row
 * @param {any[]} entries
 * @param {number} i
 */
function blockAt(entries, i) {
    const r = entries[i].rank;
    const n = entries.length;
    if (r === 'option') return [i, i + 1];
    if (r === 'group') {
        let e = i + 1;
        while (e < n && entries[e].rank === 'option') e++;
        return [i, e];
    }
    if (r === 'section') {
        let e = i + 1;
        while (e < n && entries[e].rank !== 'section') e++;
        return [i, e];
    }
    return [i, i + 1]; // item
}

/**
 * The block STARTING at position j (j must be a block start in the tiling:
 * a heading, an item, or the first option of a headerless run).
 * @param {any[]} entries
 * @param {number} j
 */
function blockStart(entries, j) {
    const r = entries[j].rank;
    const n = entries.length;
    if (r === 'group') {
        let e = j + 1;
        while (e < n && entries[e].rank === 'option') e++;
        return [j, e];
    }
    if (r === 'section') {
        let e = j + 1;
        while (e < n && entries[e].rank !== 'section') e++;
        return [j, e];
    }
    if (r === 'option' && (j === 0 || entries[j - 1].rank !== 'option')
            && (j === 0 || entries[j - 1].rank !== 'group')) {
        let e = j + 1;
        while (e < n && entries[e].rank === 'option') e++;
        return [j, e]; // a headerless option run is one block (one group)
    }
    return [j, j + 1]; // item, or a single option of a headed group
}

/**
 * The block ENDING at position b0 (the tiling neighbor above).
 * - the row above is an option -> its option run plus the group heading
 *   that owns it (if any)
 * - the row above is a section heading -> that single heading (an item or
 *   group mover swaps with the heading entry only)
 * - otherwise (item) -> that single row
 * @param {any[]} entries
 * @param {number} b0
 */
function blockBefore(entries, b0) {
    let j = b0 - 1;
    const r = entries[j].rank;
    if (r === 'option') {
        while (j > 0 && entries[j - 1].rank === 'option') j--;
        if (j > 0 && entries[j - 1].rank === 'group') j--; // the heading owning this run
    }
    return [j, b0];
}

/**
 * Swap the row (or its whole block, for headings) with the adjacent sibling
 * block at the same level. Never changes enabled bits.
 *
 * An item or group crosses a section heading one row per step: one step
 * swaps its block with THAT HEADING ENTRY ONLY (up: it leaves the section
 * and becomes the last row of the previous section or leading run; down: it
 * becomes the section's first row(s)). This is exactly one-step invertible.
 * Moving a group down into a section that starts with a headerless option
 * run is refused (the run would merge into the group on rebuild). Options
 * stay inside their group. Section headings swap whole sibling blocks
 * (items, groups, whole sections).
 *
 * Note (v1 parity): a section moving up across the document's leading run
 * takes the run with it (sections cannot sit above their own rows); its
 * single-step inverse is therefore two presses, not one, when a run rode
 * along. Only section headings are affected.
 * @param {any} doc
 * @param {string} key
 * @param {number} delta -1 = up one sibling block, +1 = down one, 0 = no-op
 */
export function moveLeaf(doc, key, delta) {
    if (delta === 0) return;
    const { seq, entries, i } = findSeq(doc, key);
    const r = entries[i].rank;
    const [b0, b1] = blockAt(entries, i);
    /** @type {[number, number]} */
    let p;
    if (delta < 0) {
        if (b0 === 0) throw new OutlineError('already at the top');
        if (r === 'option') {
            if (entries[b0 - 1].rank !== 'option') {
                throw new OutlineError('cannot move above the group heading (promote it out first)');
            }
            p = [b0 - 1, b0]; // the sibling option directly above
        } else if (r === 'section') {
            // the sibling above is the previous section block, or — before
            // the first section — the last block of the leading run
            let k = b0 - 1;
            while (k > 0 && entries[k].rank !== 'section') k--;
            p = (k > 0 || entries[0].rank === 'section') ? [k, b0] : [0, b0]; // the whole leading run
        } else {
            const [q0, q1] = blockBefore(entries, b0);
            p = [q0, q1];
        }
        entries.splice(p[0], b1 - p[0], ...entries.slice(b0, b1), ...entries.slice(p[0], p[1]));
    } else {
        if (b1 >= entries.length) throw new OutlineError('already at the bottom');
        if (r === 'option') {
            if (entries[b1].rank !== 'option') {
                throw new OutlineError('cannot move below the group (promote it out first)');
            }
            p = [b1, b1 + 1]; // the sibling option directly below
        } else {
            const [q0, q1] = blockStart(entries, b1);
            p = [q0, q1];
            if (entries[b1].rank === 'section' && r !== 'section') {
                if (r === 'group' && entries[b1 + 1]?.rank === 'option') {
                    throw new OutlineError('cannot move the group into the section: its first rows are a headerless group');
                }
                p = [b1, b1 + 1]; // the heading entry only
            }
        }
        entries.splice(b0, p[1] - b0, ...entries.slice(p[0], p[1]), ...entries.slice(b0, b0 + (p[0] - b0)));
    }
    seq.rows = rebuildSeq(entries);
}

/**
 * Splice flat rank entries into a sequence at a drop position (v1
 * `insert_entries`). `beforeKey` null appends to the end of the first
 * sequence. An anchor row adjusts the landing: dropping onto a group heading
 * inserts INTO the group (as its first option); a group/section payload
 * snaps to a clean sibling position instead of splitting the anchor's
 * container.
 * @param {any} doc
 * @param {string|null} beforeKey
 * @param {any[]} newEntries
 */
export function insertEntries(doc, beforeKey, newEntries) {
    if (!newEntries.length) return;
    if (beforeKey === null) {
        const seq = doc.sequences[0];
        if (!seq) throw new OutlineError('document has no sequences');
        seq.rows = rebuildSeq([...flattenSeq(seq.rows ?? []), ...newEntries]);
        return;
    }
    const { seq, entries, i } = findSeq(doc, beforeKey);
    let anchor = entries[i];
    const kind0 = newEntries[0].rank;
    if (kind0 === 'group' || kind0 === 'section') {
        // containers never land INSIDE a group: snap above the anchor's group
        let at = i;
        if (anchor.rank === 'option') {
            let j = i;
            while (j > 0 && entries[j].rank === 'option') j--;
            if (j > 0 && entries[j].rank === 'group') at = j;
        } else if (anchor.rank === 'group') {
            // land right above that group
        } else if (anchor.rank === 'section') {
            at = i + 1; // just inside the section, above its first row
        }
        // kind0 == "section" landing inside a section would nest — snap above it
        if (kind0 === 'section') {
            let j = at;
            while (j > 0 && entries[j].rank !== 'section') j--;
            if (entries[j].rank === 'section' && j < at) at = j;
        }
        entries.splice(at, 0, ...newEntries);
    } else {
        let at = i;
        if (anchor.rank === 'group') {
            // dropped ON a group heading: become its first option
            newEntries = newEntries.map((e) => ({ ...e, rank: 'option', gmeta: { ...(anchor.gmeta ?? {}) } }));
            at = i + 1;
        } else if (anchor.rank === 'section') {
            newEntries = newEntries.map((e) => ({ ...e, rank: 'item' }));
            at = i + 1;
        } else {
            newEntries = newEntries.map((e) => ({
                ...e,
                rank: anchor.rank,
                gmeta: anchor.gmeta ? { ...anchor.gmeta } : null,
                sname: anchor.sname,
            }));
        }
        entries.splice(at, 0, ...newEntries);
    }
    seq.rows = rebuildSeq(entries);
}
