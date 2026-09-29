/**
 * Floating window shell (2b/4/5/6): one window, six tabs plus a connection
 * toolbar. Library = preset list (load into slot, open in the Presets tab);
 * Presets = per-preset editor tabs (ext/tabs/*); Diff = 2x2 preset/revision/
 * block comparison (ext/tabs/diff.js); Import/Export = file import/export
 * (ext/tabs/io.js); Shelf = saved blocks (rename/notes/delete), dropped back
 * into a preset from that tab's own shelf list (ext/tabs/shelf.js);
 * Settings = Model registry + connection profile tidy (ext/tabs/settings.js).
 * The toolbar above the tabs holds a Model picker that switches ST's live
 * connection to a Model's profile. Uses plain DOM + CSS from style.css;
 * jQuery UI draggable/resizable are available globally in ST and used for
 * the window. The window also swallows file drag/drop events anywhere
 * inside it so ST's body-level importer never sees them (see below). The
 * main window remembers its size and position across reloads (localStorage
 * key `pm.window.rect`, clamped back on screen via ext/layout.js), and the
 * Library tab marks the preset in ST's working slot with a live badge that
 * follows slot changes without a manual refresh.
 */
import { api, SLOT_NAME, currentRaw, connectionProfiles, slotPath } from './st.js';
import { switchToModel, unlinkProfilePreset } from './connection.js';
import { createPresetsTab } from './tabs/presets.js';
import { createDiffTab } from './tabs/diff.js';
import { createIoTab } from './tabs/io.js';
import { createShelfTab } from './tabs/shelf.js';
import { createSettingsTab } from './tabs/settings.js';
import { clampRect } from './layout.js';

/**
 * @param {{ title: string, content: string, onClose?: () => void, persistKey?: string }} opts
 * @returns {{ root: HTMLElement, body: HTMLElement, close: () => void }}
 */
export function openWindow({ title, content, onClose, persistKey }) {
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
    if (persistKey) {
        /** @type {any} */
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(persistKey) ?? 'null');
        } catch {
            saved = null;
        }
        const clamped = clampRect(saved, { width: window.innerWidth, height: window.innerHeight });
        if (clamped) {
            root.style.left = `${clamped.left}px`;
            root.style.top = `${clamped.top}px`;
            root.style.width = `${clamped.width}px`;
            root.style.height = `${clamped.height}px`;
            root.style.right = 'auto';
        }
    }
    const save = () => {
        if (!persistKey) return;
        const r = root.getBoundingClientRect();
        try {
            localStorage.setItem(persistKey, JSON.stringify({
                left: Math.round(r.left),
                top: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
            }));
        } catch {
            // storage unavailable/full: skip persisting
        }
    };
    const jq = /** @type {any} */ (globalThis).jQuery;
    if (jq?.ui) {
        jq(root).draggable({ handle: '.pm-titlebar', stop: save });
        jq(root).resizable?.({ minWidth: 360, minHeight: 220, stop: save });
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
 * Open the main window: tab strip + Library/Presets/Diff/Import-Export/
 * Shelf/Settings panes, wired to the bridge. Library "Open" switches to the
 * Presets tab and opens the preset. The connection toolbar above the tabs
 * switches ST's live connection to a Model's profile.
 * @param {import('./bridge.js').Bridge} bridge
 * @returns {{ root: HTMLElement, body: HTMLElement, close: () => void, presets: { open(presetId: string): Promise<void>, destroy(): void, openIds(): string[] } }}
 */
export function openMainWindow(bridge) {
    /** @type {any} */
    let presets;
    /** @type {any} */
    let diff;
    /** @type {any} */
    let io;
    /** @type {any} */
    let shelf;
    /** @type {any} */
    let settings;
    /** @type {(() => void)|null} */
    let unwireModelPicker = null;
    /** @type {(() => void)|null} */
    let unsubscribeSlot = null;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let slotDebounce;
    const win = openWindow({
        title: 'Preset Manager',
        persistKey: 'pm.window.rect',
        onClose: () => {
            presets?.destroy(); diff?.destroy(); io?.destroy(); shelf?.destroy(); settings?.destroy(); unwireModelPicker?.();
            unsubscribeSlot?.();
            clearTimeout(slotDebounce);
        },
        content: `
            <div class="pm-toolbar">
                <label class="pm-model-label">Model</label>
                <select class="pm-model-picker text_pole" title="Switch SillyTavern's connection to this Model's profile"></select>
                <span class="pm-model-status"></span>
            </div>
            <div class="pm-tabs">
                <button type="button" class="pm-tab menu_button pm-active" data-tab="library">Library</button>
                <button type="button" class="pm-tab menu_button" data-tab="presets">Presets</button>
                <button type="button" class="pm-tab menu_button" data-tab="diff">Diff</button>
                <button type="button" class="pm-tab menu_button" data-tab="io">Import/Export</button>
                <button type="button" class="pm-tab menu_button" data-tab="shelf">Shelf</button>
                <button type="button" class="pm-tab menu_button" data-tab="settings">Settings</button>
            </div>
            <div class="pm-pane" data-pane="library">
                <div class="pm-root"></div>
            </div>
            <div class="pm-pane" data-pane="presets" hidden></div>
            <div class="pm-pane" data-pane="diff" hidden></div>
            <div class="pm-pane" data-pane="io" hidden></div>
            <div class="pm-pane" data-pane="shelf" hidden></div>
            <div class="pm-pane" data-pane="settings" hidden></div>`,
    });
    const root = win.root;

    // ST binds its own drag-and-drop character importer on document.body
    // (public/scripts/dragdrop.js). Any file dropped inside our window that
    // isn't caught by the dedicated Import/Export drop zone would otherwise
    // bubble up and trigger ST's "Could not import character" toast, so we
    // swallow file drags anywhere in the window here.
    for (const type of ['dragenter', 'dragover', 'drop']) {
        root.addEventListener(type, (/** @type {DragEvent} */ ev) => {
            if (ev.dataTransfer && Array.from(ev.dataTransfer.types ?? []).includes('Files')) {
                ev.preventDefault();
                ev.stopPropagation();
            }
        });
    }

    const showTab = (/** @type {string} */ name) => {
        for (const tab of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('.pm-tab')))) {
            tab.classList.toggle('pm-active', tab.dataset.tab === name);
        }
        for (const pane of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('.pm-pane')))) {
            pane.hidden = pane.dataset.pane !== name;
        }
        if (name === 'diff') void diff.refresh();
        if (name === 'io') void io.refresh();
        if (name === 'shelf') void shelf.refresh();
        if (name === 'settings') void settings.refresh();
    };
    for (const tab of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('.pm-tab')))) {
        tab.addEventListener('click', () => showTab(/** @type {string} */ (tab.dataset.tab)));
    }

    presets = createPresetsTab(
        /** @type {HTMLElement} */ (root.querySelector('.pm-pane[data-pane="presets"]')),
        bridge,
    );

    diff = createDiffTab(
        /** @type {HTMLElement} */ (root.querySelector('.pm-pane[data-pane="diff"]')),
        bridge,
        { openIds: () => presets.openIds() },
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

    shelf = createShelfTab(
        /** @type {HTMLElement} */ (root.querySelector('.pm-pane[data-pane="shelf"]')),
        bridge,
    );

    settings = createSettingsTab(
        /** @type {HTMLElement} */ (root.querySelector('.pm-pane[data-pane="settings"]')),
        bridge,
    );

    unwireModelPicker = wireModelPicker(root, bridge);

    renderLibrary(libRoot, bridge, { onOpen });
    void refresh(libRoot, bridge, { onOpen });

    unsubscribeSlot = /** @type {() => void} */ (bridge.onUpdate((/** @type {any} */ s) => {
        if (!root.isConnected) return;
        if (!(s?.slot || s?.event?.kind === 'slot')) return;
        clearTimeout(slotDebounce);
        slotDebounce = setTimeout(() => {
            void refresh(libRoot, bridge, { onOpen });
        }, 150);
    }));

    return { root: win.root, body: win.body, close: win.close, presets };
}

/**
 * Wire the toolbar's Model picker: lists Models from the registry, shows the
 * currently-resolved one (or "— no Model —" when unresolved), and switches
 * ST's live connection to a Model's profile on selection. Refreshes on
 * window open and on bridge updates that can move the resolved Model
 * (`s.model`, `s.slot`, or an SSE `models`/`slot`/`hello` event); never
 * re-renders the options while the select has focus during an in-flight
 * switch, so the user's own pick is never yanked out from under them.
 * @param {HTMLElement} root the window root
 * @param {import('./bridge.js').Bridge} bridge
 * @returns {() => void} unsubscribe
 */
function wireModelPicker(root, bridge) {
    const select = /** @type {HTMLSelectElement} */ (root.querySelector('.pm-model-picker'));
    const status = /** @type {HTMLElement} */ (root.querySelector('.pm-model-status'));
    /** @type {any} */
    let registry = { version: 1, models: {} };
    /** @type {string|null} */
    let modelId = null;
    let switching = false;

    function renderOptions() {
        const names = Object.keys(registry.models ?? {});
        const known = modelId !== null && !!registry.models?.[modelId];
        select.replaceChildren();
        if (!known) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '— no Model —';
            opt.selected = true;
            select.append(opt);
        }
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (known && name === modelId) opt.selected = true;
            select.append(opt);
        }
    }

    async function refreshToolbar() {
        try {
            const [reg, slot] = await Promise.all([api('GET', '/models'), api('GET', slotPath())]);
            registry = reg;
            modelId = slot?.desired?.modelId ?? null;
            if (document.activeElement === select && switching) return;
            renderOptions();
        } catch { /* leave stale state on a transient failure */ }
    }

    /**
     * @param {string} name Model name to switch to
     * @param {(() => void)} [beforeSwitch] run inside the same bridge.edit op before switchToModel, e.g. to unlink a preset
     */
    async function trySwitch(name, beforeSwitch) {
        switching = true;
        status.classList.remove('pm-error');
        status.textContent = 'switching…';
        try {
            const model = registry.models[name];
            await bridge.edit(async () => {
                if (beforeSwitch) beforeSwitch();
                return switchToModel(model);
            });
            modelId = name;
            const raw = currentRaw();
            const profile = raw.profileId ? connectionProfiles().find((/** @type {any} */ p) => p.id === raw.profileId) : null;
            status.textContent = `on ${profile ? profile.name : (raw.profileId ?? 'connection')}`;
            renderOptions();
        } catch (err) {
            status.classList.add('pm-error');
            const e = /** @type {any} */ (err);
            if (e?.code === 'linked') {
                status.innerHTML = `${escapeHtml(e.message)} <button type="button" class="pm-model-unlink-switch menu_button">Unlink preset from “${escapeHtml(e.profile.name)}” and switch</button>`;
                status.querySelector('.pm-model-unlink-switch')?.addEventListener('click', () => {
                    void trySwitch(name, () => unlinkProfilePreset(e.profile));
                });
            } else {
                status.textContent = err instanceof Error ? err.message : String(err);
            }
            renderOptions();
        } finally {
            switching = false;
        }
    }

    select.addEventListener('change', () => {
        const name = select.value;
        if (!name) return;
        void trySwitch(name);
    });

    const unsubscribe = bridge.onUpdate((/** @type {any} */ s) => {
        if (s.model) {
            modelId = s.model.modelId;
            if (document.activeElement === select && switching) return;
            renderOptions();
            return;
        }
        if (s.slot || (s.event && ['models', 'slot', 'hello'].includes(s.event.kind))) {
            void refreshToolbar();
        }
    });

    void refreshToolbar();

    return unsubscribe;
}

/**
 * Render the Library tab.
 * @param {HTMLElement} root .pm-root element
 * @param {import('./bridge.js').Bridge} _bridge
 * @param {{ items?: any[], desired?: any, onOpen?: (presetId: string) => void, filter?: string }} [state]
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
    filter.value = state.filter ?? '';

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
    const badge = item.id === desiredId ? ` <span class="pm-slot-badge" title="In SillyTavern's working slot">slot</span>` : '';
    const tags = item.tags?.length
        ? ` <span class="pm-tags">${item.tags.map((/** @type {string} */ t) => `<span class="pm-tag">${escapeHtml(t)}</span>`).join('')}</span>`
        : '';
    const loadouts = item.loadouts?.length
        ? `<select class="pm-loadout-select" title="loadout">${item.loadouts
              .map((/** @type {any} */ l) => `<option value="${escapeHtml(l.id)}"${l.id === item.activeLoadoutId ? ' selected' : ''}>${escapeHtml(l.name)}</option>`)
              .join('')}</select>`
        : '';
    row.innerHTML = `
        <span class="pm-name">${escapeHtml(item.name)}</span>${badge}${tags}
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
 * every re-render, and the tag filter text across re-renders. On failure
 * the error stays visible in the library list.
 * @param {HTMLElement} root .pm-root element
 * @param {import('./bridge.js').Bridge} bridge
 * @param {{ onOpen?: (presetId: string) => void }} [state]
 */
async function refresh(root, bridge, state = {}) {
    const filter = /** @type {HTMLInputElement|null} */ (root.querySelector('.pm-tag-filter'))?.value;
    try {
        const [items, slot] = await Promise.all([
            api('GET', '/library'),
            api('GET', slotPath()),
        ]);
        renderLibrary(root, bridge, { onOpen: state.onOpen, items, desired: slot.desired, filter });
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
