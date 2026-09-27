/**
 * Minimal floating window (Phase 1): one Library tab. Full tabbed window
 * arrives in Phase 2. Uses plain DOM + a little CSS from style.css; jQuery UI
 * draggable is available globally in ST and used for the title bar.
 */
import { api, SLOT_NAME } from './st.js';

/**
 * @param {{ title: string, content: string }} opts
 * @returns {{ root: HTMLElement, body: HTMLElement, close: () => void }}
 */
export function openWindow({ title, content }) {
    document.getElementById('pm-window')?.remove();
    const root = document.createElement('div');
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
    root.querySelector('.pm-close')?.addEventListener('click', () => root.remove());
    return { root, body: /** @type {HTMLElement} */ (root.querySelector('.pm-body')), close: () => root.remove() };
}

/**
 * Render the Library tab.
 * @param {HTMLElement} root .pm-root element
 * @param {import('./bridge.js').Bridge} _bridge
 * @param {{ items?: any[], desired?: any }} [state]
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
            void refresh(root, _bridge);
        })));
    };
    filter.addEventListener('input', render);
    render();
}

function libraryRow(/** @type {any} */ item, /** @type {string|null} */ desiredId, /** @type {() => void} */ onChange) {
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
            <button class="menu_button pm-load" title="Load into working slot">Load</button>
        </span>`;
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

async function refresh(/** @type {HTMLElement} */ root, /** @type {import('./bridge.js').Bridge} */ bridge) {
    try {
        const [items, slot] = await Promise.all([
            api('GET', '/library'),
            api('GET', '/slot'),
        ]);
        renderLibrary(root, bridge, { items, desired: slot.desired });
    } catch { /* window may be closed */ }
}

function escapeHtml(/** @type {string} */ s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[/** @type {any} */ (c)]);
}
