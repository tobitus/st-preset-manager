/**
 * Edit operations on native documents — the v2 port of v1 ops.py's op set.
 * Pure functions: doc in, doc mutated, op-specific result out. The REST layer
 * (POST /presets/:id/ops) runs them inside ONE store-queue transaction per
 * request; tests call them directly.
 *
 * Two address spaces, like v1: outline ops address leaf ROWS by `key`
 * (shared/outline.js); block ops address blocks by `identifier` (the blocks
 * map). Groups are addressed by their derived row key ("grp:<heading key>").
 *
 * Layer rules (roadmap item 15): these ops shape the BLOCKS layer
 * (blocks+markers+sequences+settings). Enabled bits live in loadouts and are
 * only written by `toggle`/`setGroup` (and loadout endpoints); pick-one
 * conflicts are NOT collapsed here — the compile/routing layer normalises
 * (Phase 2 Must-NOT). Notes are library-only and never compiled.
 */
import { CONNECTION_KEYS } from './st-keys.js';
import { normalize } from './groups.js';
import { flattenSeq, rebuildSeq, promote, demote, moveLeaf, OutlineError, containerName, syncHeadingNames, makeSection, unmakeSection } from './outline.js';
import { newId } from './util.js';
import { newKey } from './canonical.js';

/**
 * Op-level failure with an HTTP status (the route forwards it verbatim).
 * Extends OutlineError: structural refusals raised by shared/outline.js are
 * normal op failures — applyDocOp wraps them into an OpError (400).
 */
export class OpError extends OutlineError {
    /**
     * @param {string} message
     * @param {number} [status]
     */
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** connection keys are never stored (roadmap item 19) — shared guard */
export function rejectConnectionKeys(/** @type {Record<string, any>} */ obj) {
    const bad = Object.keys(obj ?? {}).filter((k) => CONNECTION_KEYS.includes(k));
    if (bad.length) throw new OpError(`connection keys are never stored: ${bad.join(', ')}`);
}

/** v1 add_option defaults for a fresh ST prompt's fields */
function defaultFields() {
    return {
        system_prompt: false,
        marker: false,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
        forbid_overrides: false,
    };
}

function activeLoadout(/** @type {any} */ doc) {
    const l = doc.loadouts?.[doc.activeLoadoutId];
    if (!l) throw new OpError('preset has no active loadout', 409);
    return l;
}

/**
 * (parentRows, index, row) for a leaf row by key, or null.
 * @param {any} doc
 * @param {string} key
 */
function locateRow(doc, key) {
    const scan = (/** @type {any[]} */ rows) => {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.key === key && ['marker', 'block', 'ghost'].includes(row.kind)) {
                return [rows, i, row];
            }
            for (const f of ['rows', 'options']) {
                if (Array.isArray(row[f])) {
                    const hit = scan(row[f]);
                    if (hit) return hit;
                }
            }
        }
        return null;
    };
    for (const seq of doc.sequences ?? []) {
        const hit = scan(seq.rows ?? []);
        if (hit) return hit;
    }
    return null;
}

function requireRow(/** @type {any} */ doc, /** @type {string} */ key) {
    const hit = locateRow(doc, key);
    if (!hit) throw new OpError(`no row with key ${JSON.stringify(key)}`, 404);
    return hit;
}

/**
 * Key existence over the FLAT entries — group/section heading leaves are
 * not inside any rows array, but rank/move ops address them by key exactly
 * like any other leaf (v1 `_find_seq` semantics).
 * @param {any} doc
 * @param {string} key
 */
function findRowKey(doc, key) {
    for (const seq of doc.sequences ?? []) {
        for (const e of flattenSeq(seq.rows ?? [])) {
            if (e.leaf.key === key) return;
        }
    }
    throw new OpError(`no row with key ${JSON.stringify(key)}`, 404);
}

/** All group rows in the document. */
function collectGroups(/** @type {any} */ doc) {
    /** @type {any[]} */
    const out = [];
    const walk = (/** @type {any[]} */ rows) => {
        for (const row of rows) {
            if (row.kind === 'group') out.push(row);
            for (const f of ['rows', 'options']) {
                if (Array.isArray(row[f])) walk(row[f]);
            }
        }
    };
    for (const seq of doc.sequences ?? []) walk(seq.rows ?? []);
    return out;
}

function requireGroup(/** @type {any} */ doc, /** @type {string} */ key) {
    const grp = collectGroups(doc).find((g) => g.key === key);
    if (!grp) throw new OpError(`no group ${JSON.stringify(key)}`, 404);
    return grp;
}

/** The leaf's identifier as used in enabled maps and the blocks map. */
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;

// ------------------------------------------------------------------ switches

/**
 * Flip one leaf's switch in the ACTIVE loadout. Enforces pick-one ≤ 1 via
 * normalize (the option just switched on wins; `none` stays legal).
 * @param {any} doc
 * @param {{ identifier?: string, value?: boolean }} a
 */
function opToggle(doc, a) {
    const { identifier, value } = a ?? {};
    if (typeof identifier !== 'string') throw new OpError('toggle needs identifier');
    const loadout = activeLoadout(doc);
    const enabled = loadout.enabled;
    if (!(identifier in enabled)) throw new OpError(`unknown leaf ${identifier}`, 404);
    enabled[identifier] = value !== undefined ? !!value : !enabled[identifier];
    normalize(doc, enabled, undefined, enabled[identifier] ? identifier : null);
    return { identifier, enabled: enabled[identifier] };
}

/**
 * Set a group's choice: turn `identifier` on and (pick-one) its siblings off.
 * The identifier must belong to the group (heading or option).
 * @param {any} doc
 * @param {{ group?: string, identifier?: string }} a
 */
function opSetGroup(doc, a) {
    const { group, identifier } = a ?? {};
    if (typeof group !== 'string' || typeof identifier !== 'string') {
        throw new OpError('setGroup needs {group, identifier}');
    }
    const grp = requireGroup(doc, group);
    const members = [...(grp.header ? [grp.header] : []), ...(grp.options ?? [])];
    if (!members.some((leaf) => identOf(leaf) === identifier)) {
        throw new OpError(`${identifier} is not a member of group ${group}`, 404);
    }
    const loadout = activeLoadout(doc);
    loadout.enabled[identifier] = true;
    normalize(doc, loadout.enabled, undefined, identifier);
    return { group, identifier };
}

// -------------------------------------------------------------- group shapes

/**
 * Rename a group (its drawn name; guessed flips to false — it is now owned).
 * On a HEADED group the group name drives the heading block's name: both
 * end up equal (see syncHeadingNames). A headerless group only has a stored
 * name.
 * @param {any} doc
 * @param {{ key?: string, name?: string }} a
 */
function opRenameGroup(doc, a) {
    const { key, name } = a ?? {};
    if (typeof key !== 'string' || typeof name !== 'string') throw new OpError('renameGroup needs {key, name}');
    const grp = requireGroup(doc, key);
    const trimmed = name.trim();
    if (trimmed) {
        if (grp.header?.kind === 'block' && doc.blocks?.[grp.header.ref]) {
            doc.blocks[grp.header.ref].name = trimmed;
            syncHeadingNames(doc, grp.header.ref);
        } else {
            grp.name = trimmed;
        }
    }
    grp.guessed = false;
    return { key, name: grp.name };
}

/**
 * Identifiers of the group's members (heading + options) that are on in an
 * enabled map.
 * @param {any} grp
 * @param {any} enabled
 * @returns {string[]}
 */
function onMembers(grp, enabled) {
    const members = [...(grp.header ? [grp.header] : []), ...(grp.options ?? [])];
    return members.map((leaf) => identOf(leaf)).filter((id) => id && enabled?.[id]);
}

/**
 * Change a group's kind (pick-one | pick-one-or-more). Never changes enabled
 * bits. Switching to pick-one is refused (409) while any loadout's base map or
 * per-Model override effective map has 2+ of the group's members on (an
 * enabled heading counts), so normalize never silently collapses after a
 * switch.
 * @param {any} doc
 * @param {{ key?: string, cardinality?: string }} a
 */
function opSetCardinality(doc, a) {
    const { key, cardinality } = a ?? {};
    if (cardinality !== 'pick-one' && cardinality !== 'pick-one-or-more') {
        throw new OpError(`bad cardinality ${JSON.stringify(cardinality ?? null)}`);
    }
    if (typeof key !== 'string') throw new OpError('setCardinality needs {key, cardinality}');
    const grp = requireGroup(doc, key);
    if (cardinality === 'pick-one') {
        const headId = grp.header ? identOf(grp.header) : undefined;
        /** @type {any} */
        const active = doc.loadouts?.[doc.activeLoadoutId];
        /** @type {any[]} */
        const loadouts = [...(active ? [active] : []), ...Object.values(doc.loadouts ?? {}).filter((l) => l !== active)];
        const refuse = (/** @type {any} */ enabled, /** @type {string} */ where) => {
            const on = onMembers(grp, enabled);
            if (on.length < 2) return;
            const heading = headId && on.includes(headId) ? ' (the group heading counts)' : '';
            throw new OpError(`more than one option currently selected${where}${heading}`, 409);
        };
        for (const l of loadouts) {
            const label = ` in loadout "${l.name ?? l.id}"`;
            refuse(l.enabled ?? {}, l === active ? '' : label);
            for (const [modelName, ov] of Object.entries(l.overrides ?? {})) {
                /** @type {any} */
                const eff = { ...l.enabled };
                for (const [id, on] of Object.entries(/** @type {any} */ (ov)?.enabled ?? {})) {
                    if (typeof on === 'boolean') eff[id] = on;
                }
                refuse(eff, `${label} for Model "${modelName}"`);
            }
        }
    }
    grp.cardinality = cardinality;
    grp.guessed = false;
    return { key, cardinality };
}

/**
 * Create a group from existing leaves: `keys` (leaf keys) become its options,
 * `headerKey` (optional, non-marker) becomes the heading. The group lands at
 * the position of the first member (or before the `before` leaf key when
 * given). Markers refuse membership (a group always ends at a marker). When
 * `headerKey` names a block with a non-empty name, the stored group name is
 * that block's name (given `name` is ignored); otherwise it's `name` (or
 * blank). Enabled bits are untouched.
 * @param {any} doc
 * @param {{ keys?: string[], headerKey?: string|null, name?: string, cardinality?: string, before?: string|null }} a
 */
function opCreateGroup(doc, a) {
    if (!Array.isArray(a?.keys) || !a.keys.every((/** @type {any} */ k) => typeof k === 'string')) {
        throw new OpError('createGroup keys must be an array of strings');
    }
    if (a.headerKey !== undefined && a.headerKey !== null && typeof a.headerKey !== 'string') {
        throw new OpError('createGroup headerKey must be a string');
    }
    const keys = new Set(/** @type {string[]} */ (a.keys));
    if (a?.headerKey) keys.add(a.headerKey);
    if (keys.size === 0) throw new OpError('createGroup needs keys (and optionally headerKey)');
    if (a?.cardinality !== undefined && a.cardinality !== 'pick-one' && a.cardinality !== 'pick-one-or-more') {
        throw new OpError(`bad cardinality ${JSON.stringify(a.cardinality)}`);
    }
    // all members must live in one sequence, and every key (incl. headerKey)
    // must exist in it: any throw below happens BEFORE the doc is mutated
    /** @type {{ seq: any, flat: any[] }|null} */
    let host = null;
    /** @type {Set<string>|null} */
    let found = null;
    for (const seq of doc.sequences ?? []) {
        const flat = flattenSeq(seq.rows ?? []);
        const present = flat.filter((/** @type {any} */ e) => keys.has(e.leaf.key)).map((/** @type {any} */ e) => e.leaf.key);
        if (present.length) {
            if (host) throw new OpError('createGroup keys span multiple sequences');
            host = { seq, flat };
            found = new Set(present);
        }
    }
    if (!host) throw new OpError('no row with any of the given keys', 404);
    const missing = [...keys].filter((/** @type {string} */ k) => !found.has(k));
    if (missing.length) throw new OpError(`no row with key ${JSON.stringify(missing[0])}`, 404);

    const members = host.flat.filter((e) => keys.has(e.leaf.key));
    for (const e of members) {
        if (e.leaf.kind === 'marker') {
            throw new OutlineError('markers are fixed ST slots — they can never be headings or options');
        }
    }
    const headerEntry = a?.headerKey ? host.flat.find((e) => e.leaf.key === a.headerKey) : null;
    if (a?.headerKey && !headerEntry) throw new OpError(`no row with key ${JSON.stringify(a.headerKey)}`, 404);

    const hdrName = headerEntry?.leaf.kind === 'block' ? (doc.blocks?.[headerEntry.leaf.ref]?.name || '') : '';
    const gmeta = { name: hdrName || (a?.name ?? ''), cardinality: a?.cardinality ?? 'pick-one-or-more', guessed: false };
    /** @type {any[]} */
    const groupEntries = [];
    if (headerEntry) {
        groupEntries.push({ leaf: headerEntry.leaf, rank: 'group', gmeta: { ...gmeta }, sname: headerEntry.sname });
    }
    for (const e of members) {
        if (e === headerEntry) continue;
        groupEntries.push({ leaf: e.leaf, rank: 'option', gmeta: { ...gmeta }, sname: e.sname });
    }
    // rebuild the sequence without the members, then splice the group in at
    // the first member's position (or before the `before` anchor)
    const firstIdx = host.flat.indexOf(members[0]);
    const kept = host.flat.filter((e) => !keys.has(e.leaf.key));
    let at = firstIdx;
    if (a?.before) {
        const bIdx = kept.findIndex((e) => e.leaf.key === a.before);
        if (bIdx === -1) throw new OpError(`no row with key ${JSON.stringify(a.before)}`, 404);
        at = bIdx;
    }
    kept.splice(at, 0, ...groupEntries);
    host.seq.rows = rebuildSeq(kept);
    const grp = collectGroups(doc).find((g) => g.header === (headerEntry?.leaf ?? null)
        && (g.options ?? []).some((o) => members.some((m) => m.leaf === o)));
    return { groupKey: grp?.key ?? null, options: (grp?.options ?? []).length };
}

// ------------------------------------------------------------------- options

/**
 * New option = cloned last sibling (fields), fresh identifier, appended after
 * the group's last option, disabled in every loadout. Markers refuse.
 * @param {any} doc
 * @param {{ group?: string, name?: string, content?: string, role?: string, fields?: any }} a
 */
function opAddOption(doc, a) {
    const { group } = a ?? {};
    if (typeof group !== 'string') throw new OpError('addOption needs {group, name}');
    const grp = requireGroup(doc, group);
    const identifier = newId();
    if (doc.blocks?.[identifier]) throw new OpError('identifier collision — retry');
    const template = (grp.options ?? []).at(-1);
    const templateBlock = template?.kind === 'block' ? doc.blocks?.[template.ref] : null;
    doc.blocks ??= {};
    doc.blocks[identifier] = {
        identifier,
        name: a?.name || 'New option',
        content: a?.content ?? '',
        role: a?.role ?? templateBlock?.role ?? 'system',
        fields: a?.fields ? { ...a.fields } : templateBlock
            ? { ...structuredClone(templateBlock.fields ?? {}), marker: false }
            : defaultFields(),
        notes: '',
    };
    const row = { kind: 'block', ref: identifier, key: newKey('row') };
    grp.options.push(row); // list end = after the last sibling (v1)
    grp.guessed = false;
    for (const loadout of Object.values(doc.loadouts ?? {})) {
        loadout.enabled[identifier] = false;
    }
    return { identifier, key: row.key, group };
}

/**
 * Remove one option row from its group. The block stays in the blocks map as
 * an orphan (compiled as a disabled prompt; v1 parity) — `deleteBlock`
 * removes it for good.
 * @param {any} doc
 * @param {{ key?: string }} a
 */
function opRemoveOption(doc, a) {
    const { key } = a ?? {};
    if (typeof key !== 'string') throw new OpError('removeOption needs {key}');
    const [rows, idx, row] = requireRow(doc, key);
    if (row.kind !== 'block') throw new OpError('removeOption removes a block option');
    // must sit in a group's options
    const owner = collectGroups(doc).find((g) => (g.options ?? []).some((o) => o.key === key));
    if (!owner) throw new OpError(`row ${JSON.stringify(key)} is not a group option`);
    rows.splice(idx, 1);
    return { key, identifier: row.ref };
}

// -------------------------------------------------------------------- blocks

/**
 * Update a block's content (v1 set_content). Markers are not blocks; ghosts
 * have no content.
 * @param {any} doc
 * @param {{ identifier?: string, content?: string }} a
 */
function opSetContent(doc, a) {
    const { identifier, content } = a ?? {};
    if (typeof identifier !== 'string' || typeof content !== 'string') {
        throw new OpError('setContent needs {identifier, content}');
    }
    const block = doc.blocks?.[identifier];
    if (!block) throw new OpError(`no block ${JSON.stringify(identifier)}`, 404);
    block.content = content;
    return { identifier };
}

function opSetBlockNotes(doc, a) {
    const { identifier, notes } = a ?? {};
    if (typeof identifier !== 'string' || typeof notes !== 'string') {
        throw new OpError('setBlockNotes needs {identifier, notes}');
    }
    const block = doc.blocks?.[identifier];
    if (!block) throw new OpError(`no block ${JSON.stringify(identifier)}`, 404);
    block.notes = notes;
    return { identifier };
}

function opRenameBlock(doc, a) {
    const { identifier, name } = a ?? {};
    if (typeof identifier !== 'string' || typeof name !== 'string') {
        throw new OpError('renameBlock needs {identifier, name}');
    }
    const block = doc.blocks?.[identifier];
    if (!block) throw new OpError(`no block ${JSON.stringify(identifier)}`, 404);
    if (name.trim()) { block.name = name.trim(); syncHeadingNames(doc, identifier); }
    return { identifier, name: block.name };
}

/**
 * Update several block fields at once (name/content/role/fields merge).
 * @param {any} doc
 * @param {{ identifier?: string, name?: string, content?: string, role?: string, fields?: any }} a
 */
function opEditBlock(doc, a) {
    const { identifier } = a ?? {};
    if (typeof identifier !== 'string') throw new OpError('editBlock needs {identifier, ...}');
    const block = doc.blocks?.[identifier];
    if (!block) throw new OpError(`no block ${JSON.stringify(identifier)}`, 404);
    if (a?.name !== undefined) { if (!String(a.name).trim()) throw new OpError('name cannot be empty'); block.name = String(a.name).trim(); syncHeadingNames(doc, identifier); }
    if (a?.content !== undefined) block.content = String(a.content);
    if (a?.role !== undefined) block.role = String(a.role);
    if (a?.fields !== undefined) {
        if (typeof a.fields !== 'object' || a.fields === null) throw new OpError('fields must be an object');
        block.fields = { ...(block.fields ?? {}), ...a.fields };
    }
    return { identifier };
}

/**
 * Add a new block with a leaf row at a drop position: appended to the first
 * sequence's end (`before` null/absent) or inserted right before the anchor
 * leaf key (keeping the anchor's section). Disabled in every loadout.
 * @param {any} doc
 * @param {{ identifier?: string, name?: string, content?: string, role?: string, fields?: any, before?: string|null }} a
 */
function opAddBlock(doc, a) {
    if (typeof a?.name !== 'string' || !a.name.trim()) throw new OpError('addBlock needs {name}');
    if (a.before != null && typeof a.before !== 'string') {
        throw new OpError('addBlock before must be a leaf key');
    }
    const identifier = typeof a.identifier === 'string' && a.identifier ? a.identifier : newId();
    if (doc.blocks?.[identifier]) throw new OpError(`block ${identifier} already exists`, 409);
    const row = { kind: 'block', ref: identifier, key: newKey('row') };
    const entry = { leaf: row, rank: 'item', gmeta: null, sname: null };
    // anchor lookup BEFORE any mutation: a 404 must leave the doc untouched.
    // The flat scan also finds group/section heading leaves, which live in no
    // rows array (that is why the nested requireRow lookup failed on them).
    /** @type {{ seq: any, flat: any[], idx: number }|null} */
    let anchor = null;
    if (a.before != null) {
        for (const seq of doc.sequences ?? []) {
            const flat = flattenSeq(seq.rows ?? []);
            const idx = flat.findIndex((/** @type {any} */ e) => e.leaf.key === a.before);
            if (idx !== -1) {
                anchor = { seq, flat, idx };
                break;
            }
        }
        if (!anchor) throw new OpError(`no row with key ${JSON.stringify(a.before)}`, 404);
        // keep the anchor's section (same sname) so the row lands beside it;
        // above a SECTION heading the item lands OUTSIDE the section, so it
        // takes the sname of the entry before the heading instead
        entry.sname = anchor.flat[anchor.idx].rank === 'section'
            ? (anchor.flat[anchor.idx - 1]?.sname ?? null)
            : (anchor.flat[anchor.idx].sname ?? null);
    }
    doc.blocks ??= {};
    doc.blocks[identifier] = {
        identifier,
        name: a.name.trim(),
        content: a.content ?? '',
        role: a.role ?? 'system',
        fields: a.fields ? { ...a.fields } : defaultFields(),
        notes: '',
    };
    if (anchor) {
        anchor.flat.splice(anchor.idx, 0, entry);
        anchor.seq.rows = rebuildSeq(anchor.flat);
    } else {
        const seq = (doc.sequences ?? [])[0];
        if (!seq) throw new OpError('document has no sequences', 409);
        seq.rows = rebuildSeq([...flattenSeq(seq.rows ?? []), entry]);
    }
    for (const loadout of Object.values(doc.loadouts ?? {})) {
        loadout.enabled[identifier] = false;
    }
    return { identifier, key: row.key };
}

/**
 * Insert an empty FF-style section heading block: a fresh block (empty
 * content) becomes a new section-heading leaf. Rows below it up to the next
 * section heading (or the end) become its children; an anchor on a group
 * option snaps above the whole group so it never splits it. ON only in the
 * active loadout, off everywhere else.
 * @param {any} doc
 * @param {{ name?: string, before?: string|null }} a
 */
function opAddSection(doc, a) {
    if (typeof a?.name !== 'string' || !a.name.trim()) throw new OpError('addSection needs {name}');
    if (a.before != null && typeof a.before !== 'string') {
        throw new OpError('addSection before must be a leaf key');
    }
    activeLoadout(doc); // preset has no active loadout -> 409 before any mutation
    const name = a.name.trim();
    // anchor lookup BEFORE any mutation: a 404 must leave the doc untouched
    /** @type {{ seq: any, flat: any[], idx: number }|null} */
    let anchor = null;
    if (a.before != null) {
        for (const seq of doc.sequences ?? []) {
            const flat = flattenSeq(seq.rows ?? []);
            const idx = flat.findIndex((/** @type {any} */ e) => e.leaf.key === a.before);
            if (idx !== -1) {
                anchor = { seq, flat, idx };
                break;
            }
        }
        if (!anchor) throw new OpError(`no row with key ${JSON.stringify(a.before)}`, 404);
    }
    const identifier = mintIdentifiers(doc, 1)[0];
    const key = newKey('row');
    const entry = { leaf: { kind: 'block', ref: identifier, key }, rank: 'section', gmeta: null, sname: name };
    /** @type {any} */
    let seq;
    /** @type {any[]} */
    let entries;
    if (anchor) {
        seq = anchor.seq;
        entries = anchor.flat;
        const at = entries[anchor.idx].rank === 'option' ? snapAboveGroup(entries, anchor.idx) : anchor.idx;
        entries.splice(at, 0, entry);
    } else {
        seq = (doc.sequences ?? [])[0];
        if (!seq) throw new OpError('document has no sequences', 409);
        entries = [...flattenSeq(seq.rows ?? []), entry];
    }
    // rebuild first (it can still refuse): a throw leaves `doc` untouched
    let rows;
    try {
        rows = rebuildSeq(entries);
    } catch (err) {
        if (err instanceof OutlineError) throw new OpError(err.message);
        throw err;
    }
    seq.rows = rows;
    doc.blocks ??= {};
    doc.blocks[identifier] = { identifier, name, content: '', role: 'system', fields: defaultFields(), notes: '' };
    for (const loadout of Object.values(doc.loadouts ?? {})) {
        loadout.enabled[identifier] = false;
    }
    activeLoadout(doc).enabled[identifier] = true;
    return { identifier, key };
}

/**
 * Remove a block everywhere: the blocks map entry, every sequence position,
 * and its bit in every loadout/override. Markers are not blocks.
 * @param {any} doc
 * @param {{ identifier?: string }} a
 */
function opDeleteBlock(doc, a) {
    const { identifier } = a ?? {};
    if (typeof identifier !== 'string') throw new OpError('deleteBlock needs {identifier}');
    if (doc.blocks?.[identifier] === undefined) throw new OpError(`no block ${JSON.stringify(identifier)}`, 404);
    delete doc.blocks[identifier];
    // flatten -> drop the identifier -> rebuild, per sequence: dropping a
    // group/section heading must NOT destroy its children, and the orphaned
    // option run must not merge into a neighbouring group (rebuildSeq always
    // joins consecutive options onto the currently open group)
    for (const seq of doc.sequences ?? []) {
        const entries = flattenSeq(seq.rows ?? []);
        let touched = false;
        /** @type {any[]} */
        const out = [];
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (identOf(e.leaf) !== identifier) {
                out.push(e);
                continue;
            }
            touched = true;
            // e is removed. Options that followed it would re-join the group
            // above (or the previous group across the section) on rebuild —
            // demote the contiguous option run to plain items.
            if (e.rank === 'group'
                || (e.rank === 'section'
                    && (out.at(-1)?.rank === 'option' || out.at(-1)?.rank === 'group')
                    && entries[i + 1]?.rank === 'option'))
            {
                for (let j = i + 1; j < entries.length && entries[j].rank === 'option'; j++) {
                    entries[j] = { ...entries[j], rank: 'item', gmeta: null };
                }
            }
        }
        if (touched) seq.rows = rebuildSeq(out);
    }
    for (const loadout of Object.values(doc.loadouts ?? {})) {
        delete loadout.enabled[identifier];
        for (const ov of Object.values(loadout.overrides ?? {})) delete ov.enabled?.[identifier];
    }
    return { identifier };
}

// --------------------------------------------------------------------- notes

function opSetNotes(doc, a) {
    if (typeof a?.notes !== 'string') throw new OpError('setNotes needs {notes}');
    doc.notes = a.notes;
    return {};
}

// ------ copy (Phase 6)
// Cross-preset copy (v1 ops.py copy_component / copy_group): build a
// detached payload from one document or a shelf item (copyPayloadFromDoc)
// and land it in another (copyIntoDoc); macroWarnings ports v1
// token_warnings (pmcore/ops.py ~570-596).

/**
 * @typedef {{kind: 'block', block: any}
 *   | {kind: 'group', name: string, cardinality: string, header: any|null, options: any[]}} CopyPayload
 */

/**
 * Detach one block's copyable fields from its source doc (name/content/
 * role/fields/notes only) so the payload shares no references with `src`.
 * @param {any} b
 */
function pickBlock(b) {
    return {
        name: b.name,
        content: b.content ?? '',
        role: b.role ?? 'system',
        fields: structuredClone(b.fields ?? {}),
        notes: b.notes ?? '',
    };
}

/**
 * Build a copy payload from `src`: one block (`{identifier}`) or a whole
 * group (`{group}`, a "grp:<key>" row key) — exactly one of the two.
 * Markers never transfer (fixed ST slots); a group's marker/ghost members
 * are silently skipped — only its block header/options travel. Every block
 * in the payload is deep-detached from `src` (pickBlock).
 * @param {any} src
 * @param {{identifier?: string, group?: string}} a
 * @returns {CopyPayload}
 */
export function copyPayloadFromDoc(src, a) {
    const hasId = typeof a?.identifier === 'string';
    const hasGroup = typeof a?.group === 'string';
    if (hasId === hasGroup) throw new OpError('copyBlock needs {identifier} or {group}', 400);
    if (hasId) {
        const identifier = /** @type {string} */ (a.identifier);
        if ((src.markers ?? []).some((/** @type {any} */ m) => m.identifier === identifier)) {
            throw new OpError('markers never transfer (fixed ST slots)', 400);
        }
        const block = src.blocks?.[identifier];
        if (!block) throw new OpError(`no block ${JSON.stringify(identifier)}`, 404);
        return { kind: 'block', block: pickBlock(block) };
    }
    const group = /** @type {string} */ (a.group);
    const grp = requireGroup(src, group);
    const header = grp.header?.kind === 'block' && src.blocks?.[grp.header.ref]
        ? pickBlock(src.blocks[grp.header.ref])
        : null;
    const options = (grp.options ?? [])
        .filter((/** @type {any} */ o) => o.kind === 'block' && src.blocks?.[o.ref])
        .map((/** @type {any} */ o) => pickBlock(src.blocks[o.ref]));
    if (!header && options.length === 0) throw new OpError('group has nothing to copy', 400);
    return {
        kind: 'group',
        name: containerName(src, grp),
        cardinality: grp.cardinality ?? 'pick-one-or-more',
        header,
        options,
    };
}

/**
 * Fresh identifiers, none colliding with any block, marker, or leaf
 * (including ghosts) anywhere in `doc`, nor with each other.
 * @param {any} doc
 * @param {number} count
 */
function mintIdentifiers(doc, count) {
    const used = new Set(Object.keys(doc.blocks ?? {}));
    for (const m of doc.markers ?? []) used.add(m.identifier);
    for (const seq of doc.sequences ?? []) {
        for (const e of flattenSeq(seq.rows ?? [])) used.add(identOf(e.leaf));
    }
    /** @type {string[]} */
    const ids = [];
    for (let i = 0; i < count; i++) {
        let id = newId();
        while (used.has(id)) id = newId();
        used.add(id);
        ids.push(id);
    }
    return ids;
}

/**
 * The snap index for an entry landing directly above an anchor option's
 * whole group: walk the option run back to its start; a headed group lands
 * right at its heading, a headerless one right at its first option (both
 * `j`), anything else lands right after it (`j + 1`).
 * @param {any[]} entries
 * @param {number} idx the anchor's index (an option)
 */
function snapAboveGroup(entries, idx) {
    let j = idx;
    while (j > 0 && entries[j].rank === 'option') j--;
    return (entries[j].rank === 'group' || entries[j].rank === 'option') ? j : j + 1;
}

/**
 * Land a copy payload in `doc` at `before` (a leaf row key; null/undefined =
 * end of the first sequence) or, for a single block, at `opts.after` (a
 * leaf row key in its own sequence — the copy lands right after its
 * source). Every copied block gets a freshly minted identifier and row key
 * — never the source's — and starts off in every loadout. Landing rules
 * (`before` = the key of the row the drop landed above):
 *   single block  anchor option -> an option of that group at that position
 *                 anything else -> an item at that position
 *   whole group   anchor option -> snaps above the anchor's group (never
 *                                  splits it)
 *                 anything else -> right above the anchor
 * `opts.after` (single block only; mutually exclusive with `before`) lands
 * directly below the named row, in the row's own sequence:
 *   anchor option  -> an option of that group, right after the anchor
 *   anchor group   -> an item right after the group's option run
 *   anchor section
 *   or item        -> an item right after the anchor
 * A group landing is refused (400) when it would merge into a neighbouring
 * group's options. All validation runs before any mutation of `doc`.
 * @param {any} doc
 * @param {CopyPayload} payload
 * @param {string|null|undefined} before
 * @param {{ outsideGroup?: boolean, after?: string }} [opts] `outsideGroup`:
 *   for a BLOCK payload anchored on an option, land as a plain item above
 *   the anchor's whole group instead of joining it — the drop point was
 *   outside the anchor's group (dropAnchor reached the anchor by
 *   descending into a headerless container). No effect on a group payload
 *   or a non-option anchor. `after`: for a BLOCK payload, land directly
 *   below this leaf key instead of at `before`; takes precedence and
 *   cannot be combined with a non-null `before`.
 */
export function copyIntoDoc(doc, payload, before, opts = {}) {
    if (opts.outsideGroup !== undefined && typeof opts.outsideGroup !== 'boolean') {
        throw new OpError('copyBlock outsideGroup must be a boolean');
    }
    if (before !== null && before !== undefined && typeof before !== 'string') {
        throw new OpError('copyBlock before must be a leaf key');
    }
    if (opts.after !== undefined && typeof opts.after !== 'string') {
        throw new OpError('copyBlock after must be a leaf key');
    }
    if (opts.after !== undefined && before !== null && before !== undefined) {
        throw new OpError('copyBlock takes before or after, not both');
    }
    if (payload?.kind !== 'block' && payload?.kind !== 'group') {
        throw new OpError('copyBlock needs a block or group payload');
    }
    if (opts.after !== undefined && payload.kind !== 'block') {
        throw new OpError('copyBlock after is for a single block');
    }

    /** @type {{ seq: any, idx: number }|null} */
    let anchor = null;
    /** @type {any} */
    let host;
    /** @type {any[]} */
    let entries;
    if (opts.after !== undefined) {
        for (const seq of doc.sequences ?? []) {
            const flat = flattenSeq(seq.rows ?? []);
            const idx = flat.findIndex((/** @type {any} */ e) => e.leaf.key === opts.after);
            if (idx !== -1) { anchor = { seq, idx }; host = seq; entries = flat; break; }
        }
        if (!anchor) throw new OpError(`no row with key ${JSON.stringify(opts.after)}`, 404);
    } else if (before != null) {
        for (const seq of doc.sequences ?? []) {
            const flat = flattenSeq(seq.rows ?? []);
            const idx = flat.findIndex((/** @type {any} */ e) => e.leaf.key === before);
            if (idx !== -1) { anchor = { seq, idx }; host = seq; entries = flat; break; }
        }
        if (!anchor) throw new OpError(`no row with key ${JSON.stringify(before)}`, 404);
    } else {
        host = (doc.sequences ?? [])[0];
        if (!host) throw new OpError('document has no sequences', 409);
        entries = flattenSeq(host.rows ?? []);
    }

    const blocksToMint = payload.kind === 'block'
        ? [payload.block]
        : [...(payload.header ? [payload.header] : []), ...(payload.options ?? [])];
    const ids = mintIdentifiers(doc, blocksToMint.length);
    const keys = blocksToMint.map(() => newKey('row'));

    /** @type {any[]} */
    let newEntries;
    if (payload.kind === 'block' && opts.after !== undefined) {
        const i = anchor.idx;
        const A = entries[i];
        let at;
        let rank;
        let gmeta;
        if (A.rank === 'option') {
            at = i + 1;
            rank = 'option';
            gmeta = { ...A.gmeta };
        } else if (A.rank === 'group') {
            let j = i + 1;
            while (j < entries.length && entries[j].rank === 'option') j++;
            at = j;
            rank = 'item';
            gmeta = null;
        } else {
            at = i + 1;
            rank = 'item';
            gmeta = null;
        }
        newEntries = [{ leaf: { kind: 'block', ref: ids[0], key: keys[0] }, rank, gmeta, sname: null }];
        entries.splice(at, 0, ...newEntries);
    } else if (payload.kind === 'block') {
        const A = anchor ? entries[anchor.idx] : null;
        let at = anchor ? anchor.idx : entries.length;
        let rank = A?.rank === 'option' ? 'option' : 'item';
        let gmeta = A?.rank === 'option' ? { ...A.gmeta } : null;
        if (opts.outsideGroup && anchor && A?.rank === 'option') {
            at = snapAboveGroup(entries, anchor.idx);
            rank = 'item';
            gmeta = null;
        }
        newEntries = [{ leaf: { kind: 'block', ref: ids[0], key: keys[0] }, rank, gmeta, sname: null }];
        entries.splice(at, 0, ...newEntries);
    } else {
        const A = anchor ? entries[anchor.idx] : null;
        let at;
        if (anchor && A?.rank === 'option') {
            at = snapAboveGroup(entries, anchor.idx);
        } else {
            at = anchor ? anchor.idx : entries.length;
        }
        if (entries[at]?.rank === 'option') {
            throw new OpError('a group cannot land directly above the options of a group without a heading', 400);
        }
        if (!payload.header && at > 0 && (entries[at - 1].rank === 'option' || entries[at - 1].rank === 'group')) {
            throw new OpError('a group without a heading cannot land directly below another group', 400);
        }
        const gmeta = { name: payload.name, cardinality: payload.cardinality, guessed: false };
        newEntries = [];
        let k = 0;
        if (payload.header) {
            newEntries.push({ leaf: { kind: 'block', ref: ids[k], key: keys[k] }, rank: 'group', gmeta: { ...gmeta }, sname: null });
            k++;
        }
        for (const _opt of payload.options ?? []) {
            newEntries.push({ leaf: { kind: 'block', ref: ids[k], key: keys[k] }, rank: 'option', gmeta: { ...gmeta }, sname: null });
            k++;
        }
        entries.splice(at, 0, ...newEntries);
    }

    // rebuild first (it can still refuse): a throw leaves `doc` untouched
    let rows;
    try {
        rows = rebuildSeq(entries);
    } catch (err) {
        if (err instanceof OutlineError) throw new OpError(err.message);
        throw err;
    }
    doc.blocks ??= {};
    blocksToMint.forEach((b, i) => {
        doc.blocks[ids[i]] = {
            identifier: ids[i],
            name: b.name,
            content: b.content,
            role: b.role,
            fields: { ...structuredClone(b.fields ?? {}), marker: false },
            notes: b.notes ?? '',
        };
    });
    host.rows = rows;
    for (const loadout of Object.values(doc.loadouts ?? {})) {
        for (const id of ids) loadout.enabled[id] = false;
    }
    const group = payload.kind === 'group' ? 'grp:' + keys[0] : null;
    const warnings = macroWarnings(doc, ids);
    return { identifiers: ids, keys, group, warnings };
}

const MACRO_RE = /\{\{[^}]*\}\}|\{[a-zA-Z][^}]*\}/g;
const UNIVERSAL_MACROS = new Set(['{{char}}', '{{user}}']);

/**
 * v1 token_warnings port (pmcore/ops.py ~570-596): for each copied block's
 * macro tokens, warn when the token appears nowhere in the rest of the doc
 * (content + name of every OTHER block). Comments ({{//...}}) and the
 * universal {{char}}/{{user}} macros never warn. Sorted, de-duplicated.
 * @param {any} doc
 * @param {string[]} copiedIdentifiers
 */
export function macroWarnings(doc, copiedIdentifiers) {
    const copied = new Set(copiedIdentifiers);
    const targetBlob = Object.entries(doc.blocks ?? {})
        .filter(([id]) => !copied.has(id))
        .map(([, b]) => `${(/** @type {any} */ (b).content) || ''} ${(/** @type {any} */ (b).name) || ''}`)
        .join(' ');
    /** @type {string[]} */
    const warnings = [];
    for (const id of copiedIdentifiers) {
        const block = doc.blocks?.[id];
        if (!block) continue;
        const tokens = new Set((block.content || '').match(MACRO_RE) ?? []);
        for (const raw of tokens) {
            const tok = raw.trim();
            if (tok.toLowerCase().startsWith('{{//')) continue;
            if (UNIVERSAL_MACROS.has(tok.toLowerCase())) continue;
            if (tok && !targetBlob.includes(tok)) {
                warnings.push(`'${block.name}' references ${tok} — absent in target preset`);
            }
        }
    }
    return [...new Set(warnings)].sort();
}

// ------------------------------------------------------------------ dispatch

/**
 * Apply one op to a document. `a` is the request body (op-specific fields).
 * Throws OpError (bad args / unknown entities) or OutlineError (illegal
 * structure, e.g. marker re-rank); both carry an HTTP status.
 * @param {any} doc
 * @param {string} op
 * @param {Record<string, any>} a
 */
export function applyDocOp(doc, op, a = {}) {
    try {
        return dispatchOp(doc, op, a);
    } catch (err) {
        if (err instanceof OutlineError && !(err instanceof OpError)) {
            throw new OpError(err.message);
        }
        throw err;
    }
}

/** @param {any} doc @param {string} op @param {Record<string, any>} a */
function dispatchOp(doc, op, a) {
    switch (op) {
        case 'toggle': return opToggle(doc, a);
        case 'setGroup': return opSetGroup(doc, a);
        case 'setSettings': {
            const settings = a?.settings;
            if (typeof settings !== 'object' || settings === null) throw new OpError('setSettings needs {settings}');
            rejectConnectionKeys(settings);
            doc.settings ??= {};
            Object.assign(doc.settings, settings);
            return { keys: Object.keys(settings) };
        }
        case 'promote': {
            if (typeof a?.key !== 'string') throw new OpError('promote needs {key}');
            findRowKey(doc, a.key); // unknown key -> 404 before the structural op
            promote(doc, a.key);
            return { key: a.key };
        }
        case 'demote': {
            if (typeof a?.key !== 'string') throw new OpError('demote needs {key}');
            findRowKey(doc, a.key);
            demote(doc, a.key);
            return { key: a.key };
        }
        case 'makeSection': {
            if (typeof a?.key !== 'string') throw new OpError('makeSection needs {key}');
            findRowKey(doc, a.key);
            makeSection(doc, a.key);
            return { key: a.key };
        }
        case 'unmakeSection': {
            if (typeof a?.key !== 'string') throw new OpError('unmakeSection needs {key}');
            findRowKey(doc, a.key);
            unmakeSection(doc, a.key);
            return { key: a.key };
        }
        case 'moveLeaf': {
            if (typeof a?.key !== 'string' || !Number.isInteger(a?.delta)) throw new OpError('moveLeaf needs {key, delta}');
            findRowKey(doc, a.key);
            // |delta| sibling steps, all-or-nothing: an illegal step (top/bottom,
            // section/group limit) restores the sequences and fails the whole op
            const saved = structuredClone(doc.sequences);
            try {
                for (let i = 0; i < Math.abs(a.delta); i++) moveLeaf(doc, a.key, Math.sign(a.delta));
            } catch (err) {
                doc.sequences = saved;
                throw err;
            }
            return { key: a.key, delta: a.delta };
        }
        case 'createGroup': return opCreateGroup(doc, a);
        case 'renameGroup': return opRenameGroup(doc, a);
        case 'setCardinality': return opSetCardinality(doc, a);
        case 'addOption': return opAddOption(doc, a);
        case 'removeOption': return opRemoveOption(doc, a);
        case 'setContent': return opSetContent(doc, a);
        case 'setBlockNotes': return opSetBlockNotes(doc, a);
        case 'renameBlock': return opRenameBlock(doc, a);
        case 'editBlock': return opEditBlock(doc, a);
        case 'addBlock': return opAddBlock(doc, a);
        case 'addSection': return opAddSection(doc, a);
        case 'deleteBlock': return opDeleteBlock(doc, a);
        case 'setNotes': return opSetNotes(doc, a);
        default: throw new OpError(`unknown op '${op}'`);
    }
}
