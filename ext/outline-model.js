/**
 * ext/outline-model.js — the pure view model behind the Presets tab outline
 * (sub-phase 2b): doc -> render tree with switch types and pick-one conflict
 * flags, keyboard mapping, pick-one/none click -> ops, drag -> moveLeaf op,
 * leaf lookup for the editor, and search matches.
 *
 * Pure module: no imports, no DOM, runs in node and browser.
 */

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
 * @property {boolean} hasContent true when a block leaf's content is non-blank
 */

/**
 * A rendered group row. Its header (if any) is shown without a switch (v1:
 * headings are not choosable). `noneOn` tallies options only; `conflict`
 * still counts an enabled heading, because compile's pick-one normalize
 * (shared/groups.js) treats it as a member and would collapse the pair.
 *
 * @typedef {Object} GroupNode
 * @property {'group'} type
 * @property {string} key
 * @property {LeafNode|null} header
 * @property {string} name
 * @property {'pick-one'|'pick-one-or-more'} cardinality
 * @property {boolean} guessed
 * @property {boolean} pickOne
 * @property {boolean} conflict
 * @property {boolean} noneOn
 * @property {LeafNode[]} options
 */

/**
 * A rendered section row (recursive: nodes may contain sections).
 *
 * @typedef {Object} SectionNode
 * @property {'section'} type
 * @property {string} key
 * @property {LeafNode|null} header
 * @property {string} name
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
 * @property {string} [name]
 * @property {boolean} [enabled]
 * @property {'checkbox'|'radio'|'readonly'} [switchType]
 * @property {LeafNode|null} [header]
 * @property {'pick-one'|'pick-one-or-more'} [cardinality]
 * @property {boolean} [guessed]
 * @property {boolean} [pickOne]
 * @property {boolean} [conflict]
 * @property {boolean} [noneOn]
 * @property {LeafNode[]} [options]
 * @property {Node[]} [nodes]
 */

/**
 * The switch type for a leaf: markers are fixed (readonly); members of a
 * pick-one group (header or option) are radios; everything else is a checkbox.
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
 * @param {Object|undefined} enabled the loadout's enabled map
 * @param {any} leaf
 * @param {boolean} pickOne
 * @returns {LeafNode}
 */
function leafNode(doc, enabled, leaf, pickOne) {
    const identifier = leaf.ref ?? leaf.identifier;
    return {
        type: 'leaf',
        key: leaf.key,
        identifier,
        leafKind: leaf.kind,
        name: leaf.kind === 'block' ? (doc.blocks?.[identifier]?.name || identifier) : identifier,
        enabled: !!enabled?.[identifier],
        switchType: switchType(leaf, pickOne),
        hasContent: leaf.kind === 'block' && String(doc.blocks?.[identifier]?.content ?? '').trim() !== '',
    };
}

/**
 * Render a group row. A marker can sit in a group's options in legacy data:
 * it still renders as a readonly leaf (never a radio).
 *
 * @param {any} doc
 * @param {Object|undefined} enabled
 * @param {any} row
 * @returns {GroupNode}
 */
function groupNode(doc, enabled, row) {
    const pickOne = row.cardinality === 'pick-one';
    const header = row.header ? leafNode(doc, enabled, row.header, pickOne) : null;
    const options = (row.options ?? []).map((/** @type {any} */ o) => leafNode(doc, enabled, o, pickOne));
    const on = options.filter((/** @type {LeafNode} */ m) => m.enabled).length;
    const headerOn = header?.enabled ? 1 : 0;
    return {
        type: 'group',
        key: row.key,
        header,
        name: row.name ?? '',
        cardinality: row.cardinality ?? 'pick-one-or-more',
        guessed: !!row.guessed,
        pickOne,
        conflict: pickOne && on + headerOn >= 2,
        noneOn: pickOne && on === 0,
        options,
    };
}

/**
 * Render a row of any kind (recursing into sections).
 *
 * @param {any} doc
 * @param {Object|undefined} enabled
 * @param {any} row
 * @returns {Node}
 */
function rowNode(doc, enabled, row) {
    if (row.kind === 'group') return groupNode(doc, enabled, row);
    if (row.kind === 'section') {
        return {
            type: 'section',
            key: row.key,
            header: row.header ? leafNode(doc, enabled, row.header, false) : null,
            name: row.name ?? '',
            nodes: (row.rows ?? []).map((/** @type {any} */ r) => rowNode(doc, enabled, r)),
        };
    }
    return leafNode(doc, enabled, row, false);
}

/**
 * Build the outline render tree for one loadout. Never mutates the document.
 *
 * @param {any} doc library document
 * @param {string} [loadoutId] defaults to the doc's active loadout
 * @returns {{ sequences: Array<{ characterId: any, nodes: Node[] }> }}
 */
export function buildOutline(doc, loadoutId = doc.activeLoadoutId) {
    const enabled = doc.loadouts?.[loadoutId]?.enabled;
    return {
        sequences: (doc.sequences ?? []).map((/** @type {any} */ seq) => ({
            characterId: seq.character_id,
            nodes: (seq.rows ?? []).map((/** @type {any} */ row) => rowNode(doc, enabled, row)),
        })),
    };
}

/**
 * Map a keyboard event on the outline to an op, or null when the key is not
 * ours. Any ctrl/meta combination is never ours; Tab must not carry alt;
 * arrow moves need alt and no shift.
 *
 * @param {{ key: string, shiftKey: boolean, altKey: boolean, ctrlKey: boolean, metaKey: boolean }} ev
 * @returns {{ op: 'promote' } | { op: 'demote' } | { op: 'moveLeaf', delta: -1|1 } | null}
 */
export function keyAction(ev) {
    if (ev.ctrlKey || ev.metaKey) return null;
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

/**
 * Ops for a click on a pick-one group member or its "none" radio.
 * A member -> one setGroup; "none" -> toggle off every enabled member
 * (header first, then options in outline order).
 *
 * @param {Node} group a group node from buildOutline
 * @param {string|null} identifier the chosen member, or null for "none"
 * @returns {Array<Object>} op bodies for POST /presets/:id/ops
 */
export function pickOneOps(group, identifier) {
    if (identifier != null) {
        return [{ op: 'setGroup', group: group.key ?? '', identifier }];
    }
    const members = group.header ? [group.header, ...(group.options ?? [])] : (group.options ?? []);
    /** @type {Array<Object>} */
    const ops = [];
    for (const m of members) {
        if (m.enabled) ops.push({ op: 'toggle', identifier: m.identifier, value: false });
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

