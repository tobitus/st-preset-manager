/**
 * ext/tabs/shelf-panel.js — the Presets tab's right-hand shelf panel
 * (Phase 6). Its source is either the shelf (blocks saved with "Save to
 * shelf") or another open preset; each source row drags (jQuery UI
 * sortable, connected to the active outline's `ul.pm-list` lists) into the
 * outline, where the drop becomes one `copyBlock` op anchored at
 * `dropAnchor(li)`.
 */
import { api } from '../st.js';
import { sourceItems } from '../outline-model.js';
import { dropAnchor } from './outline.js';

/** @returns {any} the global jQuery (undefined under node/tests) */
function jq() {
    return /** @type {any} */ (globalThis).jQuery;
}

/**
 * @param {HTMLElement} li a `.pm-src-item` row
 * @returns {{shelfId: string} | {fromPresetId: string, identifier: string} | {fromPresetId: string, group: string} | null}
 */
function sourceOf(li) {
    if (li.dataset.shelfId) return { shelfId: li.dataset.shelfId };
    const fromPresetId = li.dataset.sourcePreset;
    if (!fromPresetId) return null;
    if (li.dataset.groupKey) return { fromPresetId, group: li.dataset.groupKey };
    if (li.dataset.identifier != null) return { fromPresetId, identifier: li.dataset.identifier };
    return null;
}

/**
 * @param {any} item a shelf entry from GET /shelf
 * @returns {HTMLLIElement}
 */
function shelfLi(item) {
    const li = document.createElement('li');
    li.className = 'pm-src-item';
    li.dataset.shelfId = item.id;
    li.title = item.notes || String(item.content ?? '').slice(0, 300);
    const row = document.createElement('div');
    row.className = 'pm-row';
    const handle = document.createElement('span');
    handle.className = 'pm-drag-handle';
    handle.textContent = '⋮⋮';
    const name = document.createElement('span');
    name.className = 'pm-name';
    name.textContent = item.name;
    row.append(handle, name);
    li.append(row);
    return li;
}

/**
 * @param {any} item one entry from sourceItems(doc)
 * @param {string} presetId
 * @returns {HTMLLIElement}
 */
function presetLi(item, presetId) {
    const li = document.createElement('li');
    li.className = 'pm-src-item' + (item.kind === 'group' ? ' pm-src-group' : '')
        + (item.leafKind === 'marker' ? ' pm-marker' : '')
        + (item.heading === 'section' ? ' pm-src-heading' : '');
    li.dataset.sourcePreset = presetId;
    li.style.paddingLeft = item.depth * 14 + 'px';
    if (item.kind === 'group') {
        li.dataset.groupKey = item.groupKey;
    } else {
        li.dataset.identifier = item.identifier;
        if (item.leafKind === 'marker') li.title = 'Markers are fixed ST slots and never copy';
    }
    const row = document.createElement('div');
    row.className = 'pm-row';
    const handle = document.createElement('span');
    handle.className = 'pm-drag-handle';
    handle.textContent = '⋮⋮';
    const name = document.createElement('span');
    name.className = 'pm-name';
    name.textContent = item.kind === 'group'
        ? `▣ ${item.name} (${item.count}, ${item.cardinality})`
        : item.name;
    row.append(handle, name);
    li.append(row);
    return li;
}

/**
 * @param {HTMLElement} el the `.pm-shelf-panel` element (the panel fills it)
 * @param {{
 *   bridge: import('../bridge.js').Bridge,
 *   sources(): { id: string, name: string }[],
 *   getDoc(id: string): any,
 *   getSource(): string,
 *   setSource(s: string): void,
 *   onCopy(src: { shelfId: string } | { fromPresetId: string, identifier: string } | { fromPresetId: string, group: string }, before: string|null): Promise<void>,
 * }} opts
 * @returns {{ render(): Promise<void>, destroy(): void }}
 */
export function createShelfPanel(el, opts) {
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'pm-shelf-panel-head';
    const select = /** @type {HTMLSelectElement} */ (document.createElement('select'));
    select.className = 'pm-shelf-source text_pole';
    head.append(select);
    const hint = document.createElement('div');
    hint.className = 'pm-shelf-hint';
    hint.textContent = 'Drag a row into the outline to copy it there.';
    const list = document.createElement('ul');
    list.className = 'pm-shelf-list';
    const empty = document.createElement('div');
    empty.className = 'pm-shelf-empty';
    empty.hidden = true;
    el.append(head, hint, list, empty);

    let generation = 0;
    /** @type {any} */
    let sortable = null;

    function destroySortable() {
        const JQ = jq();
        if (sortable && JQ?.fn?.sortable) {
            try { JQ(list).sortable('destroy'); } catch { /* not initialized */ }
        }
        sortable = null;
    }

    function initSortable() {
        const JQ = jq();
        if (!JQ?.fn?.sortable) return;
        JQ(list).sortable({
            connectWith: '#pm-window .pm-preset-view .pm-outline ul.pm-list',
            items: '> li.pm-src-item',
            handle: '> .pm-row > .pm-drag-handle',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 100000,
            placeholder: 'pm-sort-placeholder',
            forcePlaceholderSize: true,
            tolerance: 'pointer',
            distance: 4,
            stop(/** @type {any} */ _ev, /** @type {any} */ ui) {
                const li = /** @type {HTMLElement} */ (ui.item[0]);
                let src = null;
                let before = null;
                if (li.parentElement !== list && li.closest('.pm-outline')) {
                    before = dropAnchor(li);
                    src = sourceOf(li);
                }
                // the row goes back; the server response re-renders the outline
                JQ(list).sortable('cancel');
                if (src) void opts.onCopy(src, before).catch(() => {});
            },
        });
        sortable = true;
    }

    function rebuildSelect() {
        const srcs = opts.sources();
        let current = opts.getSource();
        if (current !== 'shelf' && !srcs.some((s) => s.id === current)) {
            opts.setSource('shelf');
            current = 'shelf';
        }
        select.innerHTML = '';
        const shelfOpt = document.createElement('option');
        shelfOpt.value = 'shelf';
        shelfOpt.textContent = 'Shelf';
        select.append(shelfOpt);
        for (const s of srcs) {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            select.append(opt);
        }
        select.value = current;
        return current;
    }

    select.addEventListener('change', () => {
        opts.setSource(select.value);
        void render();
    });

    async function render() {
        const gen = ++generation;
        const current = rebuildSelect();
        destroySortable();
        list.innerHTML = '';
        empty.hidden = true;

        if (current === 'shelf') {
            /** @type {any[]} */
            let items;
            try {
                items = await api('GET', '/shelf');
            } catch (/** @type {any} */ err) {
                if (gen !== generation) return;
                empty.hidden = false;
                empty.textContent = err.body?.error ?? err.message;
                return;
            }
            if (gen !== generation) return;
            for (const item of items) list.append(shelfLi(item));
            empty.hidden = items.length !== 0;
            empty.textContent = 'The shelf is empty. Select a block in a preset and press "Save to shelf".';
        } else {
            const doc = opts.getDoc(current);
            const items = sourceItems(doc);
            for (const item of items) list.append(presetLi(item, current));
            empty.hidden = items.length !== 0;
            empty.textContent = 'Nothing to copy.';
        }
        initSortable();
    }

    const unsubscribe = opts.bridge.onUpdate((/** @type {any} */ s) => {
        if (s?.event?.kind === 'shelf' && opts.getSource() === 'shelf') void render();
    });

    return {
        render,
        destroy() {
            unsubscribe();
            destroySortable();
            el.innerHTML = '';
        },
    };
}
