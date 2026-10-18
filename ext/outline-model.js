/**
 * ext/outline-model.js — the pure view model behind the Presets tab outline
 * (sub-phase 2b): doc -> render tree with switch types and pick-one conflict
 * flags, keyboard mapping, pick-one/none click -> ops, drag -> moveLeaf op,
 * leaf lookup for the editor, and search matches.
 *
 * Pure module: imports only the pure shared/outline.js, shared/groups.js and
 * shared/loadouts.js helpers; no DOM, runs in node and browser.
 */

import { containerName, flattenSeq } from '../shared/outline.js';
import { effectiveEnabled } from '../shared/loadouts.js';
import { isCommentOnly } from '../shared/groups.js';

/**
 * A rendered leaf row.
 *
 * @typedef {Object} LeafNode
 * @property {'leaf'} type
 * @property {string} key
 * @property {string} identifier
 * @property {'block'|'marker'|'ghost'} leafKind
 * @property {string} name
 * @property {boolean} enabled
 * @property {'checkbox'|'radio'|'readonly'} switchType
 * @property {boolean} hasContent true when a block leaf's content is non-blank and not comment-only
 * @property {boolean} commentOnly content is only {{// }} comments and {{trim}}: sends no text; heading rows render no switch
 * @property {number} pos 1-based position of this leaf in flattenSeq order of its own sequence
 * @property {boolean} inherited playstyle row whose bit comes from the root loadout
 * @property {boolean} explicit playstyle row whose bit the playstyle sets itself (resettable)
 * @property {{key: string, name: string, pickOne: boolean}|null} linkedTo the linked group this leaf is a remote member of
 */

/**
 * Per-sequence lookups threaded through the node builders.
 *
 * @typedef {Object} SeqContext
 * @property {Map<string, number>} posMap leaf key -> 1-based flat position
 * @property {Map<string, any>} leaves leaf key -> leaf row
 * @property {Map<string, any>} linkedBy leaf key -> the group row it is a linked member of
 */

/**
 * The per-build bit context threaded through the node builders.
 *
 * @typedef {Object} BitsContext
 * @property {{[id: string]: boolean}} enabled effective enabled map
 * @property {{[id: string]: 'root'|'loadout'|'override'}} source where each bit came from
 * @property {boolean} playstyle true when the loadout is a playstyle
 */

/**
 * A rendered group row. Its header (if any) is an ordinary checkbox leaf and
 * never a pick-one member, whatever its content (round 3): `conflict` =
 * pick-one with 2+ members on (options AND linked members), `noneOn` =
 * pick-one with no member on. A comment-only header renders no switch (the
 * row decides via `header.commentOnly`).
 *
 * @typedef {Object} GroupNode
 * @property {'group'} type
 * @property {string} key
 * @property {LeafNode|null} header
 * @property {string} name the heading block's name when the header is a block with a non-empty name, else the stored name
 * @property {'pick-one'|'pick-one-or-more'} cardinality
 * @property {boolean} guessed
 * @property {boolean} pickOne
 * @property {boolean} conflict
 * @property {boolean} noneOn
 * @property {LeafNode[]} options
 * @property {LeafNode[]} remote linked members: leaves elsewhere in the sequence that belong to this group
 */

/**
 * A rendered section row (recursive: nodes may contain sections).
 *
 * @typedef {Object} SectionNode
 * @property {'section'} type
 * @property {string} key
 * @property {LeafNode|null} header
 * @property {string} name the heading block's name when the header is a block with a non-empty name, else the stored name
 * @property {Array<LeafNode|GroupNode|SectionNode>} nodes
 */

/**
 * Any outline node: a leaf, a group, or a section. Deliberately permissive —
 * every property optional, the three shapes merged — because callers look
 * nodes up by key and read container properties straight off the result
 * without narrowing on `type` first. The precise shapes are LeafNode,
 * GroupNode and SectionNode above; buildOutline always emits exactly those.
 *
 * @typedef {Object} Node
 * @property {'leaf'|'group'|'section'} [type]
 * @property {string} [key]
 * @property {string} [identifier]
 * @property {'block'|'marker'|'ghost'} [leafKind]
 * @property {boolean} [hasContent]
 * @property {boolean} [commentOnly] content is only {{// }} comments and {{trim}}: sends no text; heading rows render no switch
 * @property {number} [pos]
 * @property {string} [name]
 * @property {boolean} [enabled]
 * @property {boolean} [inherited] playstyle row whose bit comes from the root
 * @property {boolean} [explicit] playstyle row whose bit the playstyle sets itself
 * @property {'checkbox'|'radio'|'readonly'} [switchType]
 * @property {LeafNode|null} [header]
 * @property {'pick-one'|'pick-one-or-more'} [cardinality]
 * @property {boolean} [guessed]
 * @property {boolean} [pickOne]
 * @property {boolean} [conflict]
 * @property {boolean} [noneOn]
 * @property {LeafNode[]} [options]
 * @property {LeafNode[]} [remote]
 * @property {{key: string, name: string, pickOne: boolean}|null} [linkedTo]
 * @property {Node[]} [nodes]
 */

/**
 * The switch type for a leaf: markers are fixed (readonly); options of a
 * pick-one group are radios; everything else (headings included) is a checkbox.
 *
 * @param {any} leaf
 * @param {boolean} pickOne true when the leaf sits in a pick-one group
 * @returns {'checkbox'|'radio'|'readonly'}
 */
function switchType(leaf, pickOne) {
    if (leaf.kind === 'marker') return 'readonly';
    return pickOne ? 'radio' : 'checkbox';
}

/**
 * Render one leaf row. `identifier` is `ref ?? identifier` (imported docs use
 * ref for ST-provided entries).
 *
 * @param {any} doc
 * @param {BitsContext} bits
 * @param {any} leaf
 * @param {boolean} pickOne
 * @param {SeqContext} seq
 * @returns {LeafNode}
 */
function leafNode(doc, bits, leaf, pickOne, seq) {
    const identifier = leaf.ref ?? leaf.identifier;
    const content = String(doc.blocks?.[identifier]?.content ?? '');
    const commentOnly = leaf.kind === 'block' && isCommentOnly(content);
    const grp = seq.linkedBy.get(leaf.key);
    const linkedTo = grp
        ? { key: grp.key, name: containerName(doc, grp), pickOne: grp.cardinality === 'pick-one' }
        : null;
    return {
        type: 'leaf',
        key: leaf.key,
        identifier,
        leafKind: leaf.kind,
        name: leaf.kind === 'block' ? (doc.blocks?.[identifier]?.name || identifier) : identifier,
        enabled: !!bits.enabled?.[identifier],
        switchType: switchType(leaf, pickOne || !!linkedTo?.pickOne),
        hasContent: leaf.kind === 'block' && content.trim() !== '' && !commentOnly,
        commentOnly,
        pos: seq.posMap.get(leaf.key) ?? 0,
        inherited: bits.playstyle && bits.source?.[identifier] === 'root',
        explicit: bits.playstyle && bits.source?.[identifier] === 'loadout',
        linkedTo,
    };
}

/**
 * Render a group row. A marker can sit in a group's options in legacy data:
 * it still renders as a readonly leaf (never a radio).
 *
 * @param {any} doc
 * @param {BitsContext} bits
 * @param {any} row
 * @param {SeqContext} seq
 * @returns {GroupNode}
 */
function groupNode(doc, bits, row, seq) {
    const pickOne = row.cardinality === 'pick-one';
    const header = row.header ? leafNode(doc, bits, row.header, false, seq) : null;
    const options = (row.options ?? []).map((/** @type {any} */ o) => leafNode(doc, bits, o, pickOne, seq));
    /** @type {LeafNode[]} */
    const remote = [];
    for (const k of row.remote ?? []) {
        const leaf = seq.leaves.get(k);
        if (leaf) remote.push(leafNode(doc, bits, leaf, pickOne, seq));
    }
    const on = options.filter((/** @type {LeafNode} */ m) => m.enabled).length
        + remote.filter((m) => m.enabled).length;
    return {
        type: 'group',
        key: row.key,
        header,
        name: containerName(doc, row),
        cardinality: row.cardinality ?? 'pick-one-or-more',
        guessed: !!row.guessed,
        pickOne,
        conflict: pickOne && on >= 2,
        noneOn: pickOne && on === 0,
        options,
        remote,
    };
}

/**
 * Render a row of any kind (recursing into sections).
 *
 * @param {any} doc
 * @param {BitsContext} bits
 * @param {any} row
 * @param {SeqContext} seq
 * @returns {Node}
 */
function rowNode(doc, bits, row, seq) {
    if (row.kind === 'group') return groupNode(doc, bits, row, seq);
    if (row.kind === 'section') {
        return {
            type: 'section',
            key: row.key,
            header: row.header ? leafNode(doc, bits, row.header, false, seq) : null,
            name: containerName(doc, row),
            nodes: (row.rows ?? []).map((/** @type {any} */ r) => rowNode(doc, bits, r, seq)),
        };
    }
    return leafNode(doc, bits, row, false, seq);
}

/**
 * Collect every group row of a sequence (top level and inside sections).
 *
 * @param {any[]} rows
 * @param {any[]} [out]
 * @returns {any[]}
 */
function groupRows(rows, out = []) {
    for (const r of rows) {
        if (r.kind === 'group') out.push(r);
        else if (r.kind === 'section') groupRows(r.rows ?? [], out);
    }
    return out;
}

/**
 * Build the outline render tree for one loadout. Never mutates the document.
 * Bits are the loadout's layered bits (a playstyle inherits its root's) WITHOUT
 * pick-one normalization, so a stored conflict shows. An unknown loadout id
 * renders every switch off (structure-only callers such as sourceItems pass
 * documents without loadouts).
 *
 * @param {any} doc library document
 * @param {string} [loadoutId] defaults to the doc's active loadout
 * @param {string|null} [modelName] apply this Model's overrides, or none
 * @returns {{ sequences: Array<{ characterId: any, nodes: Node[] }> }}
 */
export function buildOutline(doc, loadoutId = doc.activeLoadoutId, modelName = null) {
    const known = !!doc.loadouts?.[loadoutId];
    const { enabled, source } = known
        ? effectiveEnabled(doc, loadoutId, modelName, { raw: true })
        : { enabled: {}, source: {} };
    const playstyle = known && doc.loadouts[loadoutId].kind === 'playstyle';
    const bits = { enabled, source, playstyle };
    return {
        sequences: (doc.sequences ?? []).map((/** @type {any} */ s) => {
            const flat = flattenSeq(s.rows ?? []);
            /** @type {SeqContext} */
            const seq = {
                posMap: new Map(flat.map((e, i) => [e.leaf.key, i + 1])),
                leaves: new Map(flat.map((e) => [e.leaf.key, e.leaf])),
                linkedBy: new Map(),
            };
            for (const g of groupRows(s.rows ?? [])) {
                for (const k of g.remote ?? []) seq.linkedBy.set(k, g);
            }
            return {
                characterId: s.character_id,
                nodes: (s.rows ?? []).map((/** @type {any} */ row) => rowNode(doc, bits, row, seq)),
            };
        }),
    };
}

/**
 * Map a keyboard event on the outline to an op, or null when the key is not
 * ours except Ctrl/Cmd+Z (undo) and Ctrl/Cmd+Shift+Z (redo, no alt); Tab must not carry alt;
 * arrow moves need alt and no shift. Alt+S toggles the section heading and
 * Alt+G the group heading on the selected row (by physical key, so macOS
 * Option+S producing 'ß' still works).
 *
 * @param {{ key: string, code?: string, shiftKey: boolean, altKey: boolean, ctrlKey: boolean, metaKey: boolean }} ev
 * @returns {{ op: 'promote' } | { op: 'demote' } | { op: 'moveLeaf', delta: -1|1 } | { op: 'heading', kind: 'section'|'group' } | { op: 'undo' } | { op: 'redo' } | null}
 */
export function keyAction(ev) {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'z') return ev.shiftKey ? { op: 'redo' } : { op: 'undo' };
    if (ev.ctrlKey || ev.metaKey) return null;
    if (ev.altKey && !ev.shiftKey && (ev.code === 'KeyS' || ev.code === 'KeyG')) return { op: 'heading', kind: ev.code === 'KeyS' ? 'section' : 'group' };
    if (ev.key === 'Tab') {
        if (ev.altKey) return null;
        return ev.shiftKey ? { op: 'demote' } : { op: 'promote' };
    }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        if (!ev.altKey || ev.shiftKey) return null;
        return { op: 'moveLeaf', delta: ev.key === 'ArrowUp' ? -1 : 1 };
    }
    return null;
}

/** Hint shown after "Make group heading" runs on a section heading. */
export const MAKE_GROUP_ON_SECTION = 'Turn the section heading into a group heading; its rows stay below it as plain rows — select them and Demote to make them options';

/**
 * The label, op and refusal for the "Make/Unmake section/group heading"
 * button on the selected row. A plain item becomes a heading directly
 * (makeSection/promote) and a heading reverts to a plain item directly
 * (unmakeSection/demote); a section heading also becomes a group heading
 * directly (demote, with a `note` hint); an option or a group heading asked
 * to become a section heading must first become a plain row.
 *
 * @param {any} doc
 * @param {string|null} key selected leaf key
 * @param {'section'|'group'} kind
 * @returns {{ label: string, op: { op: string, key: string }|null, refuse: string|null, note?: string }}
 */
export function headingAction(doc, key, kind) {
    const label = `Make ${kind} heading`;
    const found = key ? findLeaf(doc, key) : null;
    if (!found) return { label, op: null, refuse: null };
    if (found.marker) return { label, op: null, refuse: "Markers are fixed SillyTavern slots: they can't be headings" };
    if (found.leaf.kind === 'ghost') return { label, op: null, refuse: "Order-only entries have no block: they can't be headings" };
    if (kind === 'section') {
        if (found.rank === 'item') return { label: 'Make section heading', op: { op: 'makeSection', key }, refuse: null };
        if (found.rank === 'section') return { label: 'Unmake section heading', op: { op: 'unmakeSection', key }, refuse: null };
        return { label: 'Make section heading', op: null, refuse: 'Make section heading works on a plain row — make it a plain row first' };
    }
    if (found.rank === 'section') return { label: 'Make group heading', op: { op: 'demote', key }, refuse: null, note: MAKE_GROUP_ON_SECTION };
    if (found.rank === 'item') return { label: 'Make group heading', op: { op: 'promote', key }, refuse: null };
    if (found.rank === 'group') return { label: 'Unmake group heading', op: { op: 'demote', key }, refuse: null };
    return { label: 'Make group heading', op: null, refuse: 'Make group heading works on a plain row — make it a plain row first' };
}

/**
 * Ops for a click on a pick-one group option or its "none" radio.
 * An option -> one setGroup; "none" -> toggle off every enabled option in
 * outline order (the heading is never touched). When `loadoutId` is a
 * string every op carries it as its last key; otherwise the ops have no
 * loadoutId key (they target the active loadout).
 *
 * @param {Node} group a group node from buildOutline
 * @param {string|null} identifier the chosen member, or null for "none"
 * @param {string} [loadoutId] the loadout the ops edit
 * @returns {Array<Object>} op bodies for POST /presets/:id/ops
 */
export function pickOneOps(group, identifier, loadoutId) {
    /** @type {Array<Object>} */
    const ops = [];
    if (identifier != null) {
        ops.push({ op: 'setGroup', group: group.key ?? '', identifier });
    } else {
        for (const m of [...(group.options ?? []), ...(group.remote ?? [])]) {
            if (m.enabled) ops.push({ op: 'toggle', identifier: m.identifier, value: false });
        }
    }
    if (typeof loadoutId === 'string') {
        for (const op of ops) /** @type {any} */ (op).loadoutId = loadoutId;
    }
    return ops;
}

/**
 * Diff the sibling key order before/after a drag into one atomic moveLeaf op.
 * Headerless containers sit in the lists as null placeholders and count as one
 * sibling each (a null movedKey is never draggable).
 *
 * @param {Array<string|null>} keysBefore
 * @param {Array<string|null>} keysAfter
 * @param {string|null} movedKey
 * @returns {Array<{ op: 'moveLeaf', key: string, delta: number }>}
 */
export function dragOps(keysBefore, keysAfter, movedKey) {
    if (movedKey == null) throw new Error('dragOps: no moved key');
    const before = keysBefore.indexOf(movedKey);
    const after = keysAfter.indexOf(movedKey);
    if (before === -1 || after === -1) throw new Error(`dragOps: moved key not in both lists: ${movedKey}`);
    const delta = after - before;
    return delta === 0 ? [] : [{ op: 'moveLeaf', key: movedKey, delta }];
}

/**
 * Look up a leaf anywhere in the doc (all sequences, headers included) by key.
 * `rank` says where it sits: 'item' (top level or in a section), 'option'
 * (group option), 'group' (group header), 'section' (section header). Markers
 * are only ever items, so a marker found as an option still ranks 'item'.
 *
 * @param {any} doc
 * @param {string} key
 * @returns {{ leaf: any, identifier: string, rank: 'item'|'option'|'group'|'section', block: any|null, marker: boolean } | null}
 */
export function findLeaf(doc, key) {
    const hit = (/** @type {any} */ leaf, /** @type {'item'|'option'|'group'|'section'} */ rank) => {
        const identifier = leaf.ref ?? leaf.identifier;
        return {
            leaf,
            identifier,
            rank: leaf.kind === 'marker' ? 'item' : rank,
            block: leaf.kind === 'block' ? (doc.blocks?.[identifier] ?? null) : null,
            marker: leaf.kind === 'marker',
        };
    };
    const visit = (/** @type {any} */ row) => {
        if (row.kind === 'group') {
            if (row.header && row.header.key === key) return hit(row.header, 'group');
            for (const o of row.options ?? []) {
                if (o.key === key) return hit(o, 'option');
            }
            return null;
        }
        if (row.kind === 'section') {
            if (row.header && row.header.key === key) return hit(row.header, 'section');
            for (const r of row.rows ?? []) {
                const found = visit(r);
                if (found) return found;
            }
            return null;
        }
        return row.key === key ? hit(row, 'item') : null;
    };
    for (const seq of doc.sequences ?? []) {
        for (const row of seq.rows ?? []) {
            const found = visit(row);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Split a selection into its first adjacent run and the rest. The sequence
 * holding the first selected key decides: its selected keys, ordered by flat
 * position, form `leading` up to the first gap in flat indices; `later` is the
 * remainder of that sequence followed by selected keys from other sequences
 * (in given order).
 *
 * @param {any} doc
 * @param {string[]|Set<string>} keys leaf keys
 * @returns {{ leading: string[], later: string[] }}
 */
export function leadingRun(doc, keys) {
    const list = [...keys];
    if (!list.length) return { leading: [], later: [] };
    for (const seq of doc.sequences ?? []) {
        const flat = flattenSeq(seq.rows ?? []);
        const index = new Map(flat.map((e, i) => [e.leaf.key, i]));
        if (!index.has(list[0])) continue;
        const inSeq = list.filter((k) => index.has(k)).sort((a, b) => /** @type {number} */ (index.get(a)) - /** @type {number} */ (index.get(b)));
        let n = 1;
        while (n < inSeq.length && /** @type {number} */ (index.get(inSeq[n])) === /** @type {number} */ (index.get(inSeq[n - 1])) + 1) n++;
        return {
            leading: inSeq.slice(0, n),
            later: [...inSeq.slice(n), ...list.filter((k) => !index.has(k))],
        };
    }
    return { leading: [], later: list };
}

const LINK_REFUSE = 'Select one group row and the rows to link to it (Ctrl-click)';

/**
 * The linkToGroup op for a selection of one group row plus the rows to link to
 * it, or the reason the selection is refused. The server validates the rest.
 *
 * @param {any} doc
 * @param {string[]|Set<string>} keys selected row keys
 * @returns {{ op: { op: 'linkToGroup', key: string, keys: string[] }, refuse: null } | { op: null, refuse: string }}
 */
export function linkSelectionOp(doc, keys) {
    const refused = { op: null, refuse: LINK_REFUSE };
    /** @type {any[]} */
    const groups = [];
    for (const seq of doc.sequences ?? []) groupRows(seq.rows ?? [], groups);
    /** @type {Set<string>} */
    const groupKeys = new Set();
    /** @type {string[]} */
    const others = [];
    for (const k of keys) {
        if (k.startsWith('grp:')) {
            groupKeys.add(k);
        } else if (findLeaf(doc, k)?.rank === 'group') {
            const g = groups.find((r) => r.header?.key === k);
            if (!g) return refused;
            groupKeys.add(g.key);
        } else {
            others.push(k);
        }
    }
    if (groupKeys.size !== 1 || !others.length) return refused;
    /** @type {Map<string, number>} */
    const order = new Map();
    for (const seq of doc.sequences ?? []) {
        for (const e of flattenSeq(seq.rows ?? [])) order.set(e.leaf.key, order.size);
    }
    const rank = (/** @type {string} */ k) => order.get(k) ?? Infinity;
    others.sort((a, b) => rank(a) - rank(b));
    return { op: { op: 'linkToGroup', key: [...groupKeys][0], keys: others }, refuse: null };
}

/**
 * Flatten one loadout's outline into the shelf panel's cross-preset copy
 * rows: a leaf per row (ghosts skipped — nothing to copy), a group's header
 * and options collapsed into one draggable row (the whole group copies as a
 * unit) followed by its block options as their own rows, and a section's
 * header (when set) followed by its children one level deeper.
 *
 * @param {any} doc library document
 * @returns {Array<
 *   { kind: 'leaf', identifier: string, leafKind: 'block'|'marker'|'ghost', name: string, depth: number, heading: 'section'|null } |
 *   { kind: 'group', groupKey: string, name: string, cardinality: 'pick-one'|'pick-one-or-more', count: number, depth: number }
 * >}
 */
export function sourceItems(doc) {
    /** @type {any[]} */
    const items = [];
    const visit = (/** @type {any} */ node, /** @type {number} */ depth) => {
        if (node.type === 'leaf') {
            if (node.leafKind === 'ghost') return;
            items.push({ kind: 'leaf', identifier: node.identifier, leafKind: node.leafKind, name: node.name, depth, heading: null });
            return;
        }
        if (node.type === 'group') {
            const count = (node.header && node.header.leafKind === 'block' ? 1 : 0)
                + node.options.filter((/** @type {any} */ o) => o.leafKind === 'block').length;
            items.push({
                kind: 'group',
                groupKey: node.key,
                name: node.header?.name || node.name || '(options)',
                cardinality: node.cardinality,
                count,
                depth,
            });
            for (const o of node.options) {
                if (o.leafKind === 'ghost') continue;
                items.push({ kind: 'leaf', identifier: o.identifier, leafKind: o.leafKind, name: o.name, depth: depth + 1, heading: null });
            }
            return;
        }
        // section
        if (node.header && node.header.leafKind !== 'ghost') {
            items.push({ kind: 'leaf', identifier: node.header.identifier, leafKind: node.header.leafKind, name: node.name || node.header.name, depth, heading: 'section' });
            for (const child of node.nodes) visit(child, depth + 1);
            return;
        }
        for (const child of node.nodes) visit(child, depth);
    };
    for (const seq of buildOutline(doc).sequences) {
        for (const node of seq.nodes) visit(node, 0);
    }
    return items;
}

/**
 * Flatten one loadout's outline into per-sequence lists of leaves in outline
 * order, each tagged with the rank findLeaf would give it. Section/group
 * headers precede their body; a marker is always ranked 'item' regardless of
 * where it sits (findLeaf's rule).
 *
 * @param {any} doc
 * @returns {Array<Array<{ leaf: any, rank: 'item'|'option'|'group'|'section' }>>}
 */
function flatLeaves(doc) {
    /** @type {(leaf: any, rank: 'item'|'option'|'group'|'section') => { leaf: any, rank: 'item'|'option'|'group'|'section' }} */
    const entry = (leaf, rank) => ({ leaf, rank: leaf.kind === 'marker' ? 'item' : rank });
    const visit = (/** @type {any} */ row, /** @type {Array<{ leaf: any, rank: 'item'|'option'|'group'|'section' }>} */ list) => {
        if (row.kind === 'group') {
            if (row.header) list.push(entry(row.header, 'group'));
            for (const o of row.options ?? []) list.push(entry(o, 'option'));
            return;
        }
        if (row.kind === 'section') {
            if (row.header) list.push(entry(row.header, 'section'));
            for (const r of row.rows ?? []) visit(r, list);
            return;
        }
        list.push(entry(row, 'item'));
    };
    return (doc.sequences ?? []).map((/** @type {any} */ seq) => {
        /** @type {Array<{ leaf: any, rank: 'item'|'option'|'group'|'section' }>} */
        const list = [];
        for (const row of seq.rows ?? []) visit(row, list);
        return list;
    });
}

/**
 * Leaf keys whose shown name or content contains `query`, case-insensitively,
 * in outline order across all sequences (headers included). A block's shown
 * name is its `blocks[id].name` (falling back to the id) and its content is
 * `blocks[id].content`; a marker or ghost has no content and is matched by
 * its identifier alone. A blank query matches nothing.
 *
 * @param {any} doc
 * @param {string} query
 * @returns {string[]}
 */
export function searchMatches(doc, query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (q === '') return [];
    /** @type {string[]} */
    const matches = [];
    for (const list of flatLeaves(doc)) {
        for (const { leaf } of list) {
            const identifier = leaf.ref ?? leaf.identifier;
            const name = leaf.kind === 'block' ? (doc.blocks?.[identifier]?.name || identifier) : identifier;
            const content = leaf.kind === 'block' ? String(doc.blocks?.[identifier]?.content ?? '') : '';
            if (String(name).toLowerCase().includes(q) || content.toLowerCase().includes(q)) matches.push(leaf.key);
        }
    }
    return matches;
}

