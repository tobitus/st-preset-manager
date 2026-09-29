/**
 * ext/tabs/outline.js — the Presets tab outline (sub-phase 2b). Renders the
 * `buildOutline` view model into the .pm-outline element as nested lists and
 * wires clicks, switches, keyboard and jQuery UI sortable to ops handed to
 * `handlers.onOps`. Never mutates its own inputs locally: the server doc
 * coming back through re-render is the truth.
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

/** @param {GroupNode} node @returns {HTMLSpanElement} '1' or 'N' cardinality badge */
function cardSpan(node) {
    const span = document.createElement('span');
    span.className = 'pm-card';
    span.textContent = node.pickOne ? '1' : 'N';
    span.title = node.cardinality;
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
 * @param {LeafNode} node
 * @param {string|null} selectedKey
 * @returns {HTMLLIElement}
 */
function leafLi(node, selectedKey) {
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
    li.append(row);
    return li;
}

/**
 * A group's row IS its header leaf when one exists, but the header never
 * gets a switch (only options do); headerless groups show the group name
 * and no handle.
 * @param {GroupNode} node
 * @param {string|null} selectedKey
 * @returns {HTMLLIElement}
 */
function groupLi(node, selectedKey) {
    const key = node.header?.key ?? '';
    const li = document.createElement('li');
    li.className = 'pm-node';
    li.dataset.kind = 'group';
    li.dataset.key = key;
    li.dataset.identifier = node.header?.identifier ?? '';
    li.dataset.nodeKey = node.key;
    const row = document.createElement('div');
    row.className = 'pm-row pm-group-row' + selectedSuffix(key, selectedKey);
    if (node.header) {
        row.append(handleSpan(), nameSpan(node.header.name));
    } else {
        row.append(nameSpan(node.name || '(options)'));
    }
    row.append(cardSpan(node));
    if (node.conflict) row.append(conflictSpan());
    if (node.pickOne) row.append(noneLabel(node));
    li.append(row);
    const list = document.createElement('ul');
    list.className = 'pm-list';
    list.dataset.list = 'options';
    for (const opt of node.options ?? []) list.append(leafLi(opt, selectedKey));
    li.append(list);
    return li;
}

/**
 * Sections show the section name (or header name when unnamed); handle and
 * switch exist only when a header leaf exists.
 * @param {import('../outline-model.js').SectionNode} node
 * @param {string|null} selectedKey
 * @returns {HTMLLIElement}
 */
function sectionLi(node, selectedKey) {
    const key = node.header?.key ?? '';
    const li = document.createElement('li');
    li.className = 'pm-node';
    li.dataset.kind = 'section';
    li.dataset.key = key;
    li.dataset.identifier = node.header?.identifier ?? '';
    li.dataset.nodeKey = node.key;
    const row = document.createElement('div');
    row.className = 'pm-row pm-section-row' + selectedSuffix(key, selectedKey);
    row.append(nameSpan(node.name || node.header?.name || '(section)'));
    if (node.header) {
        row.prepend(makeSwitch(node.header));
        row.prepend(handleSpan());
    }
    li.append(row);
    const list = document.createElement('ul');
    list.className = 'pm-list';
    list.dataset.list = 'rows';
    for (const child of node.nodes ?? []) list.append(renderNode(child, selectedKey));
    li.append(list);
    return li;
}

/**
 * @param {Node} node
 * @param {string|null} selectedKey
 * @returns {HTMLLIElement}
 */
function renderNode(node, selectedKey) {
    if (node.type === 'group') return groupLi(/** @type {GroupNode} */ (node), selectedKey);
    if (node.type === 'section') return sectionLi(/** @type {SectionNode} */ (node), selectedKey);
    return leafLi(/** @type {LeafNode} */ (node), selectedKey);
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
 * @param {Element} li a `li.pm-node`
 * @returns {string|null} its own data-key, or (headerless group/section, whose
 *   own data-key is empty) its first descendant leaf's data-key
 */
function firstKey(li) {
    const own = /** @type {HTMLElement} */ (li).dataset.key;
    if (own) return own;
    const desc = li.querySelector('li.pm-node[data-key]:not([data-key=""])');
    return desc ? /** @type {HTMLElement} */ (desc).dataset.key ?? null : null;
}

/**
 * The `before` anchor for an element just dropped (by jQuery UI sortable)
 * into one of the outline's `ul.pm-list` lists: the key of the first row
 * BELOW the drop point, climbing out of nested lists at their end (a drop at
 * the very end of the whole outline anchors on nothing, `null`).
 *
 * @param {Element} li the dropped `li.pm-node`
 * @returns {string|null}
 */
export function dropAnchor(li) {
    /** @type {Element|null} */
    let node = li;
    while (node) {
        for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
            if (sib.matches('li.pm-node')) {
                const k = firstKey(sib);
                if (k) return k;
            }
        }
        const parentLi = node.parentElement?.closest('li.pm-node') ?? null;
        if (!parentLi || !parentLi.closest('.pm-outline')) return null;
        node = parentLi;
    }
    return null;
}

/**
 * @param {HTMLElement} container the .pm-outline element
 * @param {{ onSelect(key: string|null): void, onOps(ops: any[]): Promise<void> }} handlers
 * @returns {{ render(doc: any, selectedKey: string|null): void, destroy(): void }}
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
        if (!a || !key) return;
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

    const render = (/** @type {any} */ doc, /** @type {string|null} */ sel) => {
        selectedKey = sel;
        const top = container.scrollTop;
        destroySortables();
        groupByKey.clear();
        const model = buildOutline(doc);
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
            for (const node of seq.nodes ?? []) list.append(renderNode(node, selectedKey));
            frag.append(list);
        });
        for (const seq of model.sequences) collectGroups(seq.nodes);
        container.replaceChildren(frag);
        container.scrollTop = top;
        initSortables();
    };

    const destroy = () => {
        ac.abort(); // removes the delegated container listeners
        destroySortables();
    };

    return { render, destroy };
}
