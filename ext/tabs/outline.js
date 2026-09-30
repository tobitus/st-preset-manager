/**
 * ext/tabs/outline.js — the Presets tab outline (sub-phase 2b). Renders the
 * `buildOutline` view model into the .pm-outline element as nested lists and
 * wires clicks, switches, keyboard and jQuery UI sortable to ops handed to
 * `handlers.onOps`. Never mutates its own inputs locally: the server doc
 * coming back through re-render is the truth.
 *
 * `render`'s optional `opts` layers three display-only extras on top of that
 * base render, none of which touch the doc: section and group headings
 * always carry a `pm-caret` (▾/▸) that toggles `opts.collapsed` membership
 * through `handlers.onToggleCollapse`, hiding a collapsed section's or
 * group's `ul.pm-list` via CSS — a collapsed section whose subtree holds a
 * current search match is shown anyway; `opts.search` highlights matching
 * rows (`pm-match`, `pm-match-current` on the current key) and, when
 * `search.filter` is set, hides (`pm-filtered-out`) every row whose own key
 * and whole subtree miss every search key; and a section/group heading
 * whose header leaf has non-blank content gets a `pm-sends-text` ⓘ marker.
 */
import { buildOutline, dragOps, keyAction, pickOneOps } from '../outline-model.js';

/** @typedef {import('../outline-model.js').Node} Node */
/** @typedef {import('../outline-model.js').LeafNode} LeafNode */
/** @typedef {import('../outline-model.js').GroupNode} GroupNode */
/** @typedef {import('../outline-model.js').SectionNode} SectionNode */

const CONFLICT_TITLE = 'pick-one has 2+ on — nothing is auto-collapsed; choose one';

/** @returns {any} the global jQuery (undefined under node/tests) */
function jq() {
    return /** @type {any} */ (globalThis).jQuery;
}

let radioSeq = 0;

/** @returns {string} a radio name no other input shares (conflicts render two checked radios) */
function nextRadioName() {
    radioSeq += 1;
    return `pm-r-${radioSeq}`;
}

/** @returns {HTMLSpanElement} the '⋮⋮' drag handle */
function handleSpan() {
    const span = document.createElement('span');
    span.className = 'pm-drag-handle';
    span.textContent = '⋮⋮';
    return span;
}

/**
 * @param {string} text
 * @returns {HTMLSpanElement}
 */
function nameSpan(text) {
    const span = document.createElement('span');
    span.className = 'pm-name';
    span.textContent = text;
    return span;
}

/**
 * The switch input for a leaf/header. Radios get a unique name so two checked
 * radios can coexist in a pick-one conflict; readonly leaves get a disabled
 * checkbox.
 * @param {{ identifier: string, enabled: boolean, switchType: 'checkbox'|'radio'|'readonly' }} sw
 * @returns {HTMLInputElement}
 */
function makeSwitch(sw) {
    const input = document.createElement('input');
    input.className = 'pm-switch';
    input.dataset.identifier = sw.identifier ?? '';
    if (sw.switchType === 'radio') {
        input.type = 'radio';
        input.name = nextRadioName();
        input.checked = !!sw.enabled;
    } else {
        input.type = 'checkbox';
        input.checked = !!sw.enabled;
        if (sw.switchType === 'readonly') input.disabled = true;
    }
    return input;
}

/** @param {GroupNode} node @returns {HTMLButtonElement} '1' or 'N' cardinality badge; click flips cardinality */
function cardSpan(node) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pm-card';
    btn.textContent = node.pickOne ? '1' : 'N';
    btn.dataset.next = node.pickOne ? 'pick-one-or-more' : 'pick-one';
    btn.title = node.pickOne ? 'Pick one — click to allow many' : 'Pick many — click to allow one';
    return btn;
}

/** @returns {HTMLSpanElement} the ⓘ marker for a heading whose leaf sends non-blank content to the model */
function sendsTextSpan() {
    const span = document.createElement('span');
    span.className = 'pm-sends-text';
    span.title = 'this heading sends text to the model';
    span.textContent = 'ⓘ';
    return span;
}

/** @returns {HTMLSpanElement} the collapse/expand caret for a section or group row (display-only; toggled by handlers.onToggleCollapse) */
function caretSpan() {
    const span = document.createElement('span');
    span.className = 'pm-caret';
    span.title = 'Collapse / expand';
    return span;
}

/** @returns {HTMLSpanElement} the '⚠' conflict badge */
function conflictSpan() {
    const span = document.createElement('span');
    span.className = 'pm-conflict';
    span.textContent = '⚠';
    span.title = CONFLICT_TITLE;
    return span;
}

/** @param {GroupNode} node @returns {HTMLLabelElement} the pick-one 'none' radio */
function noneLabel(node) {
    const label = document.createElement('label');
    label.className = 'pm-none-label';
    const input = document.createElement('input');
    input.className = 'pm-none';
    input.type = 'radio';
    input.name = nextRadioName();
    input.checked = !!node.noneOn;
    label.append(input, document.createTextNode(' none'));
    return label;
}

/** @param {string|null} selectedKey @returns {string} row class suffix for the selected key */
function selectedSuffix(key, selectedKey) {
    return key && key === selectedKey ? ' pm-selected' : '';
}

/**
 * The per-render context threaded through renderNode/sectionLi/groupLi/
 * leafLi: `collapsed`/`search` come straight from `render`'s `opts`
 * (defaulted); `searchActive` = `search.keys.size > 0`; `matches` maps every
 * model Node to whether its own key or any descendant's key is in
 * `search.keys` (computed once per render by `computeMatch`, never rescanned
 * per row).
 * @typedef {Object} RenderCtx
 * @property {Set<string>} collapsed
 * @property {{ keys: Set<string>, current: string|null, filter: boolean }|undefined} search
 * @property {boolean} searchActive
 * @property {WeakMap<Node, boolean>} matches
 */

/**
 * Adds `pm-match`/`pm-match-current` to `row` when `key` (a li's own,
 * possibly empty, data-key) is among the active search keys.
 * @param {HTMLElement} row
 * @param {string} key
 * @param {RenderCtx} ctx
 */
function applySearchMatch(row, key, ctx) {
    if (!key || !ctx.search?.keys.has(key)) return;
    row.classList.add('pm-match');
    if (key === ctx.search.current) row.classList.add('pm-match-current');
}

/**
 * Recursively marks, in `memo`, whether `node`'s own key (leaf key / header
 * key) or any descendant's key is in `keys`. A single post-order pass over
 * the whole model per render — never rerun per row.
 * @param {Node} node
 * @param {Set<string>} keys
 * @param {WeakMap<Node, boolean>} memo
 * @returns {boolean}
 */
function computeMatch(node, keys, memo) {
    let own = false;
    if (node.type === 'group') {
        if (node.header && keys.has(node.header.key)) own = true;
        for (const opt of node.options ?? []) {
            if (computeMatch(opt, keys, memo)) own = true;
        }
    } else if (node.type === 'section') {
        if (node.header && keys.has(node.header.key)) own = true;
        for (const child of node.nodes ?? []) {
            if (computeMatch(child, keys, memo)) own = true;
        }
    } else {
        own = keys.has(/** @type {string} */ (node.key));
    }
    memo.set(node, own);
    return own;
}

/**
 * @param {LeafNode} node
 * @param {string|null} selectedKey
 * @param {RenderCtx} ctx
 * @returns {HTMLLIElement}
 */
function leafLi(node, selectedKey, ctx) {
    const li = document.createElement('li');
    li.className = 'pm-node'
        + (node.leafKind === 'marker' ? ' pm-marker' : '')
        + (node.leafKind === 'ghost' ? ' pm-ghost' : '');
    li.dataset.kind = 'leaf';
    li.dataset.key = node.key;
    li.dataset.identifier = node.identifier ?? '';
    li.dataset.nodeKey = node.key;
    const row = document.createElement('div');
    row.className = 'pm-row' + selectedSuffix(node.key, selectedKey);
    row.append(handleSpan(), makeSwitch(node), nameSpan(node.name));
    applySearchMatch(row, node.key, ctx);
    li.append(row);
    if (ctx.search?.filter && !ctx.matches.get(node)) li.classList.add('pm-filtered-out');
    return li;
}

/**
 * A group's row IS its header leaf when one exists, but the header never
 * gets a switch (only options do); headerless groups show the group name
 * and no handle. Every group row carries a collapse/expand caret, same as
 * sections.
 * @param {GroupNode} node
 * @param {string|null} selectedKey
 * @param {RenderCtx} ctx
 * @returns {HTMLLIElement}
 */
function groupLi(node, selectedKey, ctx) {
    const key = node.header?.key ?? '';
    const li = document.createElement('li');
    li.className = 'pm-node';
    li.dataset.kind = 'group';
    li.dataset.key = key;
    li.dataset.identifier = node.header?.identifier ?? '';
    li.dataset.nodeKey = node.key;
    const row = document.createElement('div');
    row.className = 'pm-row pm-group-row' + selectedSuffix(key, selectedKey);
    const caret = caretSpan();
    const collapsedDisplay = !!ctx.collapsed?.has(node.key)
        && !(ctx.searchActive && ctx.matches.get(node));
    caret.textContent = collapsedDisplay ? '▸' : '▾';
    row.append(caret);
    if (node.header) {
        row.append(handleSpan(), nameSpan(node.header.name));
        if (node.header.hasContent) row.append(sendsTextSpan());
    } else {
        row.append(nameSpan(node.name || '(options)'));
    }
    row.append(cardSpan(node));
    if (node.conflict) row.append(conflictSpan());
    if (node.pickOne) row.append(noneLabel(node));
    applySearchMatch(row, key, ctx);
    if (collapsedDisplay) li.classList.add('pm-collapsed');
    li.append(row);
    const list = document.createElement('ul');
    list.className = 'pm-list';
    list.dataset.list = 'options';
    for (const opt of node.options ?? []) list.append(leafLi(opt, selectedKey, ctx));
    li.append(list);
    if (ctx.search?.filter && !ctx.matches.get(node)) li.classList.add('pm-filtered-out');
    return li;
}

/**
 * Sections show the section name (or header name when unnamed); handle and
 * switch exist only when a header leaf exists. Every section row carries a
 * collapse/expand caret (display-only, never affects the doc).
 * @param {import('../outline-model.js').SectionNode} node
 * @param {string|null} selectedKey
 * @param {RenderCtx} ctx
 * @returns {HTMLLIElement}
 */
function sectionLi(node, selectedKey, ctx) {
    const key = node.header?.key ?? '';
    const li = document.createElement('li');
    li.className = 'pm-node';
    li.dataset.kind = 'section';
    li.dataset.key = key;
    li.dataset.identifier = node.header?.identifier ?? '';
    li.dataset.nodeKey = node.key;
    const row = document.createElement('div');
    row.className = 'pm-row pm-section-row' + selectedSuffix(key, selectedKey);
    const caret = caretSpan();
    const collapsedDisplay = !!ctx.collapsed?.has(node.key)
        && !(ctx.searchActive && ctx.matches.get(node));
    caret.textContent = collapsedDisplay ? '▸' : '▾';
    row.append(caret);
    if (node.header) {
        row.append(handleSpan(), makeSwitch(node.header));
    }
    row.append(nameSpan(node.name || node.header?.name || '(section)'));
    if (node.header?.hasContent) row.append(sendsTextSpan());
    applySearchMatch(row, key, ctx);
    if (collapsedDisplay) li.classList.add('pm-collapsed');
    li.append(row);
    const list = document.createElement('ul');
    list.className = 'pm-list';
    list.dataset.list = 'rows';
    for (const child of node.nodes ?? []) list.append(renderNode(child, selectedKey, ctx));
    li.append(list);
    if (ctx.search?.filter && !ctx.matches.get(node)) li.classList.add('pm-filtered-out');
    return li;
}

/**
 * @param {Node} node
 * @param {string|null} selectedKey
 * @param {RenderCtx} ctx
 * @returns {HTMLLIElement}
 */
function renderNode(node, selectedKey, ctx) {
    if (node.type === 'group') return groupLi(/** @type {GroupNode} */ (node), selectedKey, ctx);
    if (node.type === 'section') return sectionLi(/** @type {SectionNode} */ (node), selectedKey, ctx);
    return leafLi(/** @type {LeafNode} */ (node), selectedKey, ctx);
}

/**
 * @param {Element} ul
 * @returns {(string|null)[]} direct li.pm-node children's data-key ('' -> null)
 */
function listKeys(ul) {
    const keys = [];
    for (const el of ul.children) {
        if (el instanceof Element && el.matches('li.pm-node')) {
            keys.push(/** @type {HTMLElement} */ (el).dataset.key || null);
        }
    }
    return keys;
}

/**
 * @param {any} el
 * @returns {boolean} true for a `li.pm-node`
 */
function isNode(el) {
    return el?.tagName === 'LI' && el.classList.contains('pm-node');
}

/**
 * @param {any} li a `li.pm-node`
 * @returns {{ key: string, outsideGroup: boolean }|null} its own data-key, or
 *   (headerless group/section, whose own data-key is empty) the first
 *   descendant leaf's data-key found by a depth-first search of its `ul`
 *   children's `li.pm-node` items, recursing into nested headerless
 *   containers. `outsideGroup` is true when that key sits in the options of
 *   a headerless GROUP the search descended into.
 */
function firstKey(li) {
    const own = /** @type {string} */ (li.dataset.key);
    if (own) return { key: own, outsideGroup: false };
    for (const child of li.children) {
        if (child.tagName !== 'UL') continue;
        for (const item of child.children) {
            if (!isNode(item)) continue;
            const found = firstKey(item);
            if (!found) continue;
            const outsideGroup = found.outsideGroup || li.dataset.kind === 'group';
            return { key: found.key, outsideGroup };
        }
    }
    return null;
}

/**
 * The `{ before, outsideGroup }` anchor for an element just dropped (by
 * jQuery UI sortable) into one of the outline's `ul.pm-list` lists: `before`
 * = the key of the first row BELOW the drop point, climbing out of nested
 * lists at their end (a drop at the very end of the whole outline anchors on
 * nothing, `before: null`); `outsideGroup` = that row was found by
 * descending into a HEADERLESS group (the drop point sits above the whole
 * group, not inside it — copyIntoDoc lands a plain item there instead of
 * joining the group).
 *
 * @param {any} li the dropped `li.pm-node`
 * @returns {{ before: string|null, outsideGroup: boolean }}
 */
export function dropAnchor(li) {
    /** @type {any} */
    let node = li;
    while (node) {
        for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
            if (isNode(sib)) {
                const found = firstKey(sib);
                if (found) return { before: found.key, outsideGroup: found.outsideGroup };
            }
        }
        /** @type {any} */
        let anc = node.parentElement;
        while (anc && !isNode(anc)) {
            if (anc.classList.contains('pm-outline')) return { before: null, outsideGroup: false };
            anc = anc.parentElement;
        }
        if (!anc) return { before: null, outsideGroup: false };
        node = anc;
    }
    return { before: null, outsideGroup: false };
}

/**
 * @param {HTMLElement} container the .pm-outline element
 * @param {{ onSelect(key: string|null): void, onOps(ops: any[]): Promise<void>, onToggleCollapse?(nodeKey: string): void, onHeading?(kind: 'section'|'group'): void, onCardinality?(nodeKey: string, cardinality: 'pick-one'|'pick-one-or-more'): void }} handlers
 * @returns {{ render(doc: any, selectedKey: string|null, opts?: { collapsed?: Set<string>, search?: { keys: Set<string>, current: string|null, filter: boolean } }): void, destroy(): void }}
 */
export function createOutline(container, handlers) {
    /** group key -> GroupNode from the last buildOutline (radio clicks need it) */
    const /** @type {Map<string, GroupNode>} */ groupByKey = new Map();
    /** the selected key as of the last render/click (drives keyboard ops) */
    let selectedKey = null;

    const ac = new AbortController();

    /**
     * The GroupNode owning a radio: the group li itself (header switch) or the
     * group li enclosing the options list (member switch).
     * @param {HTMLInputElement} input
     * @returns {GroupNode|null}
     */
    function groupForInput(input) {
        const li = /** @type {HTMLElement|null} */ (input.closest('li.pm-node'));
        if (!li) return null;
        const groupLi = li.dataset.kind === 'group'
            ? li
            : /** @type {HTMLElement|null} */ (li.parentElement?.closest('li.pm-node[data-kind="group"]'));
        if (!groupLi) return null;
        return groupByKey.get(groupLi.dataset.nodeKey ?? '') ?? null;
    }

    /**
     * Radios act on click (an already-checked radio still re-sends its op);
     * checkboxes act on change below.
     * @param {HTMLInputElement} input
     */
    function inputClick(input) {
        if (input.classList.contains('pm-none')) {
            const group = groupForInput(input);
            if (!group) return;
            const ops = pickOneOps(group, null);
            if (ops.length) void handlers.onOps(ops).catch(() => {}); // nothing enabled: no-op
            return;
        }
        if (input.classList.contains('pm-switch') && input.type === 'radio') {
            const group = groupForInput(input);
            if (!group) return;
            void handlers.onOps(pickOneOps(group, input.dataset.identifier || null)).catch(() => {});
        }
    }

    const onClick = (/** @type {MouseEvent} */ ev) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const input = /** @type {HTMLInputElement|null} */ (t.closest('input'));
        if (input) {
            ev.stopPropagation(); // switches never select the row they sit on
            inputClick(input);
            return;
        }
        if (t.closest('.pm-caret')) {
            const li = /** @type {HTMLElement|null} */ (t.closest('li.pm-node'));
            handlers.onToggleCollapse?.(li?.dataset.nodeKey ?? '');
            return;
        }
        const card = /** @type {HTMLElement|null} */ (t.closest('.pm-card'));
        if (card) {
            const li = /** @type {HTMLElement|null} */ (card.closest('li.pm-node'));
            const next = card.dataset.next;
            if (li?.dataset.nodeKey && (next === 'pick-one' || next === 'pick-one-or-more')) handlers.onCardinality?.(li.dataset.nodeKey, next);
            return;
        }
        if (t.closest('.pm-drag-handle') || t.closest('label.pm-none-label')) return;
        const row = t.closest('.pm-row');
        if (!row) return;
        const li = /** @type {HTMLElement|null} */ (row.closest('li.pm-node'));
        const key = li?.dataset.key || '';
        if (!key) return; // headerless containers are not selectable
        selectedKey = key;
        handlers.onSelect(key);
    };

    const onChange = (/** @type {Event} */ ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLInputElement)) return;
        if (t.type !== 'checkbox' || !t.classList.contains('pm-switch') || t.disabled) return;
        const identifier = t.dataset.identifier || '';
        if (!identifier) return;
        void handlers.onOps([{ op: 'toggle', identifier, value: t.checked }]).catch(() => {});
    };

    const onKeydown = (/** @type {KeyboardEvent} */ ev) => {
        const a = keyAction(ev);
        const key = selectedKey;
        if (!a) return;
        if (a.op === 'heading') {
            if (!key) return;
            ev.preventDefault();
            handlers.onHeading?.(a.kind);
            return;
        }
        if (!key) return;
        ev.preventDefault(); // Tab must not move focus when it acts
        void handlers.onOps([{ ...a, key }]).catch(() => {});
    };

    container.addEventListener('click', onClick, { signal: ac.signal });
    container.addEventListener('change', onChange, { signal: ac.signal });
    container.addEventListener('keydown', onKeydown, { signal: ac.signal });

    /** Tear down every sortable currently under the container (idempotent). */
    function destroySortables() {
        const JQ = jq();
        if (!JQ?.fn?.sortable) return;
        for (const ul of container.querySelectorAll('ul.pm-list')) {
            if (JQ(ul).sortable('instance')) JQ(ul).sortable('destroy');
        }
    }

    /** Wire jQuery UI sortable on EVERY ul.pm-list (skipped when jQuery UI is absent). */
    function initSortables() {
        const JQ = jq();
        if (!JQ?.fn?.sortable) return;
        for (const ul of container.querySelectorAll('ul.pm-list')) {
            /** @type {(string|null)[]} */
            let keysBefore = [];
            // Outline lists only RECEIVE cross-list drops (the shelf panel's
            // sortable connects to them; see shelf-panel.js) and never send
            // them — no connectWith here.
            JQ(ul).sortable({
                handle: '> .pm-row > .pm-drag-handle',
                items: '> li.pm-node',
                axis: 'y',
                tolerance: 'pointer',
                distance: 4,
                placeholder: 'pm-sort-placeholder',
                forcePlaceholderSize: true,
                start() {
                    keysBefore = listKeys(ul);
                },
                stop(_ev, ui) {
                    // 'stop' (not 'update') is where sortable('cancel') is safe.
                    let ops = [];
                    try {
                        const keysAfter = listKeys(ul);
                        const movedKey = JQ(ui.item).attr('data-key') || null;
                        ops = dragOps(keysBefore, keysAfter, movedKey);
                    } catch { // a malformed drag is an empty op, never a crash
                        ops = [];
                    }
                    // DOM goes back; the server response re-renders.
                    JQ(ul).sortable('cancel');
                    if (ops.length) void handlers.onOps(ops).catch(() => {});
                },
            });
        }
    }

    const /** @type {(nodes: Node[]|undefined) => void} */ collectGroups = (nodes) => {
        for (const node of nodes ?? []) {
            if (node.type === 'group') groupByKey.set(node.key, /** @type {GroupNode} */ (node));
            else if (node.type === 'section') collectGroups(/** @type {SectionNode} */ (node).nodes);
        }
    };

    const render = (/** @type {any} */ doc, /** @type {string|null} */ sel, /** @type {{ collapsed?: Set<string>, search?: { keys: Set<string>, current: string|null, filter: boolean } }} */ opts = {}) => {
        selectedKey = sel;
        const top = container.scrollTop;
        destroySortables();
        groupByKey.clear();
        const model = buildOutline(doc);
        const searchKeys = opts.search?.keys ?? new Set();
        const searchActive = searchKeys.size > 0;
        const matches = /** @type {WeakMap<Node, boolean>} */ (new WeakMap());
        if (searchActive || opts.search?.filter) {
            for (const seq of model.sequences) {
                for (const node of seq.nodes ?? []) computeMatch(node, searchKeys, matches);
            }
        }
        const ctx = /** @type {RenderCtx} */ ({
            collapsed: opts.collapsed ?? new Set(),
            search: opts.search,
            searchActive,
            matches,
        });
        const frag = document.createDocumentFragment();
        const many = model.sequences.length > 1;
        model.sequences.forEach((/** @type {{ characterId: any, nodes: Node[] }} */ seq, /** @type {number} */ i) => {
            if (many) {
                const label = document.createElement('div');
                label.className = 'pm-seq-label';
                label.textContent = `character ${seq.characterId}`;
                frag.append(label);
            }
            const list = document.createElement('ul');
            list.className = 'pm-list';
            list.dataset.list = 'seq';
            list.dataset.seqIndex = String(i);
            for (const node of seq.nodes ?? []) list.append(renderNode(node, selectedKey, ctx));
            frag.append(list);
        });
        for (const seq of model.sequences) collectGroups(seq.nodes);
        container.replaceChildren(frag);
        container.scrollTop = top;
        const filtering = !!opts.search?.filter;
        container.classList.toggle('pm-filtering', filtering);
        if (!filtering) initSortables(); // no drag while filtering: matches are scattered
    };

    const destroy = () => {
        ac.abort(); // removes the delegated container listeners
        destroySortables();
    };

    return { render, destroy };
}
