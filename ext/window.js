/**
 * Floating window shell (2b): one window, three tabs. Library = preset list
 * (load into slot, open in the Presets tab); Presets = per-preset editor
 * tabs (ext/tabs/*); Import/Export = file import/export (ext/tabs/io.js).
 * Uses plain DOM + CSS from style.css; jQuery UI draggable/resizable are
 * available globally in ST and used for the window.
 */
import { api, SLOT_NAME } from './st.js';
import { createPresetsTab } from './tabs/presets.js';
import { createIoTab } from './tabs/io.js';

/**
 * @param {{ title: string, content: string, onClose?: () => void }} opts
 * @returns {{ root: HTMLElement, body: HTMLElement, close: () => void }}
 */
export function openWindow({ title, content, onClose }) {
    const existing = /** @type {any} */ (document.getElementById('pm-window'));
    existing?.__pmCleanup?.();
    existing?.remove();
    const root = /** @type {any} */ (document.createElement('div'));
    root.id = 'pm-window';
    root.innerHTML = `
        <div class="pm-titlebar">
            <span class="pm-title">${title}</span>
            <span class="pm-titlebar-buttons">
                <span class="pm-close menu_button interactable" title="Close"><i class="fa-solid fa-xmark"></i></span>
            </span>
        </div>
        <div class="pm-body">${content}</div>`;
    document.body.appendChild(root);
    const jq = /** @type {any} */ (globalThis).jQuery;
    if (jq?.ui) {
        jq(root).draggable({ handle: '.pm-titlebar' });
        jq(root).resizable?.({ minWidth: 360, minHeight: 220 });
    }
    const close = () => {
        onClose?.();
        root.__pmCleanup = null;
        root.remove();
    };
    root.querySelector('.pm-close')?.addEventListener('click', close);
    root.__pmCleanup = onClose;
    return { root, body: /** @type {HTMLElement} */ (root.querySelector('.pm-body')), close };
}

/**
 * Open the main window: tab strip + Library and Presets panes, wired to the
 * bridge. Library "Open" switches to the Presets tab and opens the preset.
 * @param {import('./bridge.js').Bridge} bridge
 * @returns {{ root: HTMLElement, body: HTMLElement, close: () => void, presets: { open(presetId: string): Promise<void>, destroy(): void } }}
 */
export function openMainWindow(bridge) {
    /** @type {any} */
    let presets;
    /** @type {any} */
    let io;
    const win = openWindow({
        title: 'Preset Manager',
        onClose: () => { presets?.destroy(); io?.destroy(); },
        content: `
            <div class="pm-tabs">
                <button type="button" class="pm-tab menu_button pm-active" data-tab="library">Library</button>
                <button type="button" class="pm-tab menu_button" data-tab="presets">Presets</button>
                <button type="button" class="pm-tab menu_button" data-tab="io">Import/Export</button>
            </div>
            <div class="pm-pane" data-pane="library">
                <div class="pm-root"></div>
            </div>
            <div class="pm-pane" data-pane="presets" hidden></div>
            <div class="pm-pane" data-pane="io" hidden></div>`,
    });
    const root = win.root;

    const showTab = (/** @type {string} */ name) => {
        for (const tab of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('.pm-tab')))) {
            tab.classList.toggle('pm-active', tab.dataset.tab === name);
        }
        for (const pane of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('.pm-pane')))) {
            pane.hidden = pane.dataset.pane !== name;
        }
        if (name === 'io') void io.refresh();
    };
    for (const tab of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('.pm-tab')))) {
        tab.addEventListener('click', () => showTab(/** @type {string} */ (tab.dataset.tab)));
    }

    presets = createPresetsTab(
        /** @type {HTMLElement} */ (root.querySelector('.pm-pane[data-pane="presets"]')),
        bridge,
    );

    const onOpen = (/** @type {string} */ presetId) => {
        showTab('presets');
        void presets.open(presetId);
    };
    const libRoot = /** @type {HTMLElement} */ (root.querySelector('.pm-root'));

    io = createIoTab(
        /** @type {HTMLElement} */ (root.querySelector('.pm-pane[data-pane="io"]')),
        bridge,
        { onOpen, onLibraryChanged: () => void refresh(libRoot, bridge, { onOpen }) },
    );

    renderLibrary(libRoot, bridge, { onOpen });
    void refresh(libRoot, bridge, { onOpen });

    return { root: win.root, body: win.body, close: win.close, presets };
}

/**
 * Render the Library tab.
 * @param {HTMLElement} root .pm-root element
 * @param {import('./bridge.js').Bridge} _bridge
 * @param {{ items?: any[], desired?: any, onOpen?: (presetId: string) => void }} [state]
 */
export function renderLibrary(root, _bridge, state = {}) {
    root.innerHTML = `
        <div class="pm-library">
            <div class="pm-library-toolbar">
                <input class="pm-tag-filter text_input" type="text" placeholder="filter by tag…">
                <span class="pm-slot-state"></span>
            </div>
            <div class="pm-library-list"></div>
        </div>`;
    const list = /** @type {HTMLElement} */ (root.querySelector('.pm-library-list'));
    const slotState = /** @type {HTMLElement} */ (root.querySelector('.pm-slot-state'));
    const filter = /** @type {HTMLInputElement} */ (root.querySelector('.pm-tag-filter'));

    const render = () => {
        const items = state.items ?? [];
        const tag = filter.value.trim();
        const filtered = tag ? items.filter((i) => i.tags.includes(tag)) : items;
        slotState.textContent = state.desired?.presetId ? `slot: ${SLOT_NAME}` : 'slot: empty';
        list.replaceChildren(...filtered.map((item) => libraryRow(item, state.desired?.presetId, () => {
            void refresh(root, _bridge, state);
        }, state.onOpen)));
    };
    filter.addEventListener('input', render);
    render();
}

function libraryRow(/** @type {any} */ item, /** @type {string|null} */ desiredId, /** @type {() => void} */ onChange, /** @type {((presetId: string) => void)|undefined} */ onOpen) {
    const row = document.createElement('div');
    row.className = 'pm-library-row' + (item.id === desiredId ? ' pm-in-slot' : '');
    row.dataset.presetId = item.id;
    const tags = item.tags?.length
        ? ` <span class="pm-tags">${item.tags.map((/** @type {string} */ t) => `<span class="pm-tag">${escapeHtml(t)}</span>`).join('')}</span>`
        : '';
    const loadouts = item.loadouts?.length
        ? `<select class="pm-loadout-select" title="loadout">${item.loadouts
              .map((/** @type {any} */ l) => `<option value="${escapeHtml(l.id)}"${l.id === item.activeLoadoutId ? ' selected' : ''}>${escapeHtml(l.name)}</option>`)
              .join('')}</select>`
        : '';
    row.innerHTML = `
        <span class="pm-name">${escapeHtml(item.name)}</span>${tags}
        <span class="pm-row-actions">${loadouts}
            <button class="menu_button pm-open" title="Open in the Presets tab">Open</button>
            <button class="menu_button pm-load" title="Load into working slot">Load</button>
        </span>`;
    row.querySelector('.pm-open')?.addEventListener('click', () => onOpen?.(item.id));
    row.querySelector('.pm-load')?.addEventListener('click', async () => {
        const lid = /** @type {HTMLSelectElement|null} */ (row.querySelector('.pm-loadout-select'))?.value ?? undefined;
        await api('POST', '/slot/load', { presetId: item.id, ...(lid ? { loadoutId: lid } : {}) });
        onChange();
    });
    /** @type {HTMLSelectElement|null} */ (row.querySelector('.pm-loadout-select'))?.addEventListener('change', (ev) => {
        const lid = /** @type {HTMLSelectElement} */ (ev.target).value;
        void api('POST', `/slot/load`, { presetId: item.id, loadoutId: lid }).then(onChange);
    });
    return row;
}

/**
 * Re-fetch items + slot and re-render, keeping state (onOpen) wired through
 * every re-render. On failure the error stays visible in the library list.
 * @param {HTMLElement} root .pm-root element
 * @param {import('./bridge.js').Bridge} bridge
 * @param {{ onOpen?: (presetId: string) => void }} [state]
 */
async function refresh(root, bridge, state = {}) {
    try {
        const [items, slot] = await Promise.all([
            api('GET', '/library'),
            api('GET', '/slot'),
        ]);
        renderLibrary(root, bridge, { onOpen: state.onOpen, items, desired: slot.desired });
    } catch (err) {
        // error display moved here from index.js refreshLibrary
        const list = /** @type {HTMLElement|null} */ (root.querySelector('.pm-library-list'));
        if (!list) return; /* window closed */
        const div = document.createElement('div');
        div.className = 'pm-error';
        div.textContent = `Preset Manager: ${/** @type {Error} */ (err).message}`;
        list.replaceChildren(div);
    }
}

function escapeHtml(/** @type {string} */ s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[/** @type {any} */ (c)]);
}
