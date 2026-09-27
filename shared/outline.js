/**
 * Outline flatten/rebuild — the leaf-rank model, ported from v1 outline.py
 * (roadmap: Phase 1 ports flatten/rebuild only; promote/demote/moveLeaf are
 * Phase 2 and reuse exactly these two functions).
 *
 * v2 leaf kinds: marker | block | ghost (v1: marker|component|ghost).
 * Governing invariant: screen order top to bottom IS compile order; sections
 * and groups never change which leaves compile or in which order.
 *
 * Flat entries: { leaf, rank: option|item|group|section, gmeta, sname }.
 * rebuild_seq derives container keys from heading leaves ("grp:<key>" /
 * "sec:<key>"), so any op sequence restoring the same flat sequence restores
 * identical rows. gmeta rides on group heading AND members (survives
 * promote/demote of any leaf); sname rides on the section heading leaf.
 */
import { newKey } from './util.js';

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
