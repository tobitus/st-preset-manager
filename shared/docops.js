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
import { flattenSeq, rebuildSeq, promote, demote, moveLeaf, OutlineError } from './outline.js';
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
 * @param {any} doc
 * @param {{ key?: string, name?: string }} a
 */
function opRenameGroup(doc, a) {
    const { key, name } = a ?? {};
    if (typeof key !== 'string' || typeof name !== 'string') throw new OpError('renameGroup needs {key, name}');
    const grp = requireGroup(doc, key);
    const trimmed = name.trim();
    if (trimmed) grp.name = trimmed;
    grp.guessed = false;
    return { key, name: grp.name };
}

/**
 * Change a group's kind (pick-one | pick-one-or-more). Does NOT collapse the
 * enabled bits — the compile/routing layer normalises pick-one conflicts.
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
    grp.cardinality = cardinality;
    grp.guessed = false;
    return { key, cardinality };
}

/**
 * Create a group from existing leaves: `keys` (leaf keys) become its options,
 * `headerKey` (optional, non-marker) becomes the heading. The group lands at
 * the position of the first member (or before the `before` leaf key when
 * given). Markers refuse membership (a group always ends at a marker).
 * Enabled bits are untouched.
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

    const gmeta = { name: a?.name ?? '', cardinality: a?.cardinality ?? 'pick-one-or-more', guessed: false };
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
    if (name.trim()) block.name = name.trim();
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
    if (a?.name !== undefined) { if (!String(a.name).trim()) throw new OpError('name cannot be empty'); block.name = String(a.name).trim(); }
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
        case 'deleteBlock': return opDeleteBlock(doc, a);
        case 'setNotes': return opSetNotes(doc, a);
        default: throw new OpError(`unknown op '${op}'`);
    }
}
