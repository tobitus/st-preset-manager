/**
 * Presets tab (sub-phase 2b): a tab strip of open presets plus the active
 * preset's view (loadout bar, rank bar, status line, outline/editor split).
 *
 * Re-render strategy: the view skeleton is built ONCE per activation, so the
 * outline/editor/notes state survives refreshes; afterwards only the loadout
 * picker options, the rank bar's disabled state, the notes textarea (when the
 * user has not typed into it) and the outline/editor renders are updated.
 * Every write goes through `bridge.edit`; reads (GET) may be direct.
 */
import { api } from '../st.js';
import { createOutline } from './outline.js';
import { createEditor } from './editor.js';
import { createModelPanel } from './model-panel.js';

/**
 * @typedef {object} PresetView
 * @property {string} id preset id this view renders
 * @property {HTMLElement} root the `.pm-preset-view` element
 * @property {HTMLElement} outlineEl the `.pm-outline` keyboard target
 * @property {HTMLElement} editorEl the `.pm-editor` element
 * @property {HTMLElement} statusEl the `.pm-status` one-liner
 * @property {HTMLSelectElement} picker loadout picker
 * @property {HTMLInputElement} loadoutName typed loadout name
 * @property {HTMLButtonElement} deleteBtn two-click-armed delete
 * @property {HTMLButtonElement[]} rankButtons promote/demote/move up/down
 * @property {HTMLTextAreaElement} notes preset notes textarea
 * @property {{ render(doc: any, selectedKey: string|null): void, destroy(): void }} outline
 * @property {{ render(): void, destroy(): void }} modelPanel
 * @property {{ show(doc: any, key: string|null): void }} editor
 * @property {boolean} notesDirty user typed into the notes textarea
 * @property {number} notesRev bumped each time the user types into notes
 * @property {boolean} deleteArmed first delete click happened
 * @property {any} deleteTimer restore-'Delete' timer
 * @property {string|null} selectNextLid loadout to select after creation
 */

/**
 * @param {HTMLElement} pane .pm-pane[data-pane="presets"]
 * @param {import('../bridge.js').Bridge} bridge
 * @returns {{ open(presetId: string): Promise<void>, destroy(): void }}
 */
export function createPresetsTab(pane, bridge) {
    // Contract state `open`: preset ids in tab order.
    const /** @type {string[]} */ openIds = [];
    let /** @type {string|null} */ active = null;
    const /** @type {Map<string, any>} */ docs = new Map();
    const /** @type {Map<string, string|null>} */ selected = new Map();
    let /** @type {PresetView|null} */ view = null;
    let /** @type {any} */ refreshTimer = undefined;

    pane.innerHTML = `
        <div class="pm-preset-tabs"></div>
        <div class="pm-preset-host"></div>
        <div class="pm-presets-empty">Open a preset from the Library tab.</div>`;
    const host = /** @type {HTMLElement} */ (pane.querySelector('.pm-preset-host'));
    const tabsEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-preset-tabs'));
    const emptyEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-presets-empty'));

    /** @param {unknown} err @returns {string} */
    function errText(err) {
        return err instanceof Error ? err.message : String(err);
    }

    function setStatus(/** @type {string} */ text, /** @type {boolean} */ isError = false) {
        if (!view) return;
        view.statusEl.textContent = text;
        view.statusEl.classList.toggle('pm-error', isError);
    }

    /** Store a fetched doc, dropping it when its tab was closed meanwhile. */
    function setDoc(/** @type {string} */ id, /** @type {any} */ doc) {
        if (openIds.includes(id)) docs.set(id, doc);
    }

    /** Re-GET the doc after a failed write (the op may have partially run). */
    async function regetDoc(/** @type {string} */ id) {
        try {
            setDoc(id, await api('GET', `/presets/${id}`));
        } catch { /* keep the last known doc */ }
    }

    function renderTabs() {
        tabsEl.replaceChildren(...openIds.map((id) => {
            const tab = document.createElement('div');
            tab.className = 'pm-preset-tab' + (id === active ? ' pm-active' : '');
            tab.dataset.presetId = id;
            const name = document.createElement('span');
            name.className = 'pm-preset-tab-name';
            name.textContent = docs.get(id)?.name ?? id;
            const close = document.createElement('span');
            close.className = 'pm-preset-tab-close';
            close.textContent = '×';
            close.title = 'Close';
            close.addEventListener('click', (ev) => {
                ev.stopPropagation();
                closeTab(id);
            });
            tab.addEventListener('click', () => {
                if (active !== id) activate(id);
            });
            tab.append(name, close);
            return tab;
        }));
        emptyEl.hidden = openIds.length > 0;
    }

    function activate(/** @type {string} */ presetId) {
        active = presetId;
        renderTabs();
        buildView();
    }

    /** Contract `open(id)`: GET the doc if not open, add a tab, activate, render. */
    async function openPreset(/** @type {string} */ presetId) {
        if (!openIds.includes(presetId)) {
            let doc;
            try {
                doc = await api('GET', `/presets/${presetId}`);
            } catch (err) {
                console.error('[preset-manager] open preset failed', err);
                setStatus(errText(err), true);
                return;
            }
            docs.set(presetId, doc);
            selected.set(presetId, null);
            openIds.push(presetId);
        }
        if (active !== presetId) activate(presetId);
        else { renderTabs(); refreshView(); }
    }

    /** Remove from state; activate the neighbour or show the empty text. */
    function closeTab(/** @type {string} */ id) {
        const idx = openIds.indexOf(id);
        if (idx === -1) return;
        openIds.splice(idx, 1);
        docs.delete(id);
        selected.delete(id);
        if (active === id) {
            active = null;
            destroyView();
            const next = openIds[idx] ?? openIds[idx - 1] ?? null;
            if (next) activate(next);
            else renderTabs();
        } else {
            renderTabs();
        }
    }

    function destroyView() {
        if (!view) return;
        if (view.deleteTimer) clearTimeout(view.deleteTimer);
        view.outline.destroy();
        view.modelPanel.destroy();
        view.root.remove();
        view = null;
    }

    /** Build the view skeleton ONCE per activation (DOM contract selectors). */
    function buildView() {
        const id = /** @type {string} */ (active);
        destroyView();
        const root = document.createElement('div');
        root.className = 'pm-preset-view';
        root.dataset.presetId = id;
        root.innerHTML = `
            <div class="pm-loadout-bar">
                <label class="pm-loadout-label">Loadout</label>
                <select class="pm-loadout-picker text_pole" title="loadout"></select>
                <input class="pm-loadout-name text_pole" type="text" placeholder="name…">
                <button class="pm-loadout-new menu_button" title="Create a loadout from the selected one">New from selected</button>
                <button class="pm-loadout-rename menu_button" title="Rename the selected loadout to the typed name">Rename</button>
                <button class="pm-loadout-delete menu_button" title="Delete the selected loadout">Delete</button>
                <button class="pm-loadout-activate menu_button" title="Make the selected loadout the active one">Activate</button>
            </div>
            <div class="pm-rank-bar">
                <button class="pm-rank-promote menu_button" title="Promote the selected row">Promote (Tab)</button>
                <button class="pm-rank-demote menu_button" title="Demote the selected row">Demote (Shift+Tab)</button>
                <button class="pm-move-up menu_button" title="Move the selected row up">↑ (Alt+↑)</button>
                <button class="pm-move-down menu_button" title="Move the selected row down">↓ (Alt+↓)</button>
            </div>
            <div class="pm-status"></div>
            <div class="pm-split">
                <div class="pm-outline" tabindex="0"></div>
                <div class="pm-side">
                    <div class="pm-editor"></div>
                    <div class="pm-meta">
                        <label class="pm-preset-notes-label">Preset notes (library only)</label>
                        <textarea class="pm-preset-notes text_pole" rows="4"></textarea>
                        <button class="pm-preset-notes-save menu_button" title="Save the preset notes to the library">Save preset notes</button>
                    </div>
                    <div class="pm-model-panel-host"></div>
                </div>
            </div>`;
        const q = (/** @type {string} */ sel) => /** @type {any} */ (root.querySelector(sel));
        const outlineEl = /** @type {HTMLElement} */ (q('.pm-outline'));
        const editorEl = /** @type {HTMLElement} */ (q('.pm-editor'));
        /** @type {PresetView} */
        const nextView = {
            id,
            root,
            outlineEl,
            editorEl,
            statusEl: q('.pm-status'),
            picker: q('.pm-loadout-picker'),
            loadoutName: q('.pm-loadout-name'),
            deleteBtn: q('.pm-loadout-delete'),
            rankButtons: [q('.pm-rank-promote'), q('.pm-rank-demote'), q('.pm-move-up'), q('.pm-move-down')],
            notes: q('.pm-preset-notes'),
            outline: createOutline(outlineEl, {
                onSelect: (/** @type {string|null} */ key) => {
                    selected.set(id, key);
                    refreshView();
                },
                onOps: (/** @type {any[]} */ ops) => runOps(id, ops),
            }),
            editor: createEditor(editorEl, {
                onOps: (/** @type {any[]} */ ops) => runOps(id, ops),
            }),
            notesDirty: false,
            notesRev: 0,
            deleteArmed: false,
            deleteTimer: null,
            selectNextLid: null,
            modelPanel: /** @type {any} */ (null),
        };
        nextView.modelPanel = createModelPanel(q('.pm-model-panel-host'), {
            bridge,
            presetId: id,
            getDoc: () => docs.get(id),
            setDoc: (/** @type {any} */ d) => setDoc(id, d),
            getLoadoutId: () => nextView.picker.value,
        });
        nextView.picker.addEventListener('change', () => nextView.modelPanel.render());
        q('.pm-loadout-new').addEventListener('click', () => void newLoadout(nextView));
        q('.pm-loadout-rename').addEventListener('click', () => void renameLoadout(nextView));
        q('.pm-loadout-delete').addEventListener('click', () => void deleteLoadout(nextView));
        q('.pm-loadout-activate').addEventListener('click', () => void activateLoadout(nextView));
        q('.pm-rank-promote').addEventListener('click', () => rankOp(id, 'promote'));
        q('.pm-rank-demote').addEventListener('click', () => rankOp(id, 'demote'));
        q('.pm-move-up').addEventListener('click', () => rankOp(id, 'moveLeaf', -1));
        q('.pm-move-down').addEventListener('click', () => rankOp(id, 'moveLeaf', 1));
        nextView.notes.addEventListener('input', () => { nextView.notesDirty = true; nextView.notesRev++; });
        q('.pm-preset-notes-save').addEventListener('click', () => void saveNotes(nextView));
        host.replaceChildren(root);
        view = nextView;
        refreshView();
    }

    /** @param {'promote'|'demote'|'moveLeaf'} op @param {number} [delta] */
    function rankOp(/** @type {string} */ id, op, delta = 0) {
        const key = selected.get(id);
        if (!key) return;
        void runOps(id, [op === 'moveLeaf' ? { op, key, delta } : { op, key }]).catch(() => {});
    }

    /**
     * Contract `runOps(ops)`: sequentially through bridge.edit, update the
     * doc, re-GET + status error on failure, always re-render at the end.
     * @returns {Promise<void>}
     */
    async function runOps(/** @type {string} */ id, /** @type {any[]} */ ops) {
        const hadFocus = !!view && view.id === id && document.activeElement === view.outlineEl;
        let /** @type {unknown} */ failedErr = null;
        for (const op of ops) {
            try {
                const res = await bridge.edit(() => api('POST', `/presets/${id}/ops`, op));
                setDoc(id, res?.doc);
            } catch (err) {
                setStatus(errText(err), true);
                await regetDoc(id);
                failedErr = err;
                break;
            }
        }
        if (!failedErr) setStatus('');
        refreshView();
        if (hadFocus && view && view.id === id) view.outlineEl.focus({ preventScroll: true });
        // the editor relies on the rejection to keep its dirty flag (a failed
        // save's text would otherwise be lost on the next refresh)
        if (failedErr) throw failedErr;
    }

    /**
     * Rebuild the picker options, keeping the user's selection when that
     * loadout still exists (else the active one); honour a just-created id.
     */
    function refreshLoadoutBar(/** @type {any} */ doc) {
        if (!view) return;
        const loadouts = Object.values(doc.loadouts ?? {});
        const prev = view.picker.value;
        view.picker.replaceChildren(...loadouts.map((/** @type {any} */ l) => {
            const opt = document.createElement('option');
            opt.value = l.id;
            opt.textContent = l.name + (l.id === doc.activeLoadoutId ? ' (active)' : '');
            return opt;
        }));
        const has = (/** @type {string} */ lid) => loadouts.some((/** @type {any} */ l) => l.id === lid);
        const wanted = view.selectNextLid && has(view.selectNextLid)
            ? view.selectNextLid
            : (prev && has(prev)
                ? prev
                : (doc.activeLoadoutId && has(doc.activeLoadoutId) ? doc.activeLoadoutId : (loadouts[0]?.id ?? '')));
        view.selectNextLid = null;
        view.picker.value = wanted ?? '';
    }

    /** Targeted refresh: picker, rank bar, notes (if not dirty), outline+editor. */
    function refreshView() {
        if (!view) return;
        const doc = docs.get(view.id);
        if (!doc) return;
        refreshLoadoutBar(doc);
        const key = selected.get(view.id) ?? null;
        for (const b of view.rankButtons) b.disabled = !key;
        if (!view.notesDirty) view.notes.value = doc.notes ?? '';
        view.outline.render(doc, key);
        view.editor.show(doc, key);
        view.modelPanel.render();
    }

    async function newLoadout(/** @type {PresetView} */ v) {
        const id = v.id;
        const name = v.loadoutName.value.trim();
        if (!name) { setStatus('Loadout name is required', true); return; }
        const oldLids = new Set(Object.values(docs.get(id)?.loadouts ?? {}).map((/** @type {any} */ l) => l.id));
        try {
            const res = await bridge.edit(() => api('POST', `/presets/${id}/loadouts`, { name, from: v.picker.value }));
            setDoc(id, res.doc);
            const fresh = Object.values(res.doc?.loadouts ?? {});
            const byName = fresh.find((/** @type {any} */ l) => l.name === name && !oldLids.has(l.id));
            v.selectNextLid = byName?.id
                ?? fresh.map((/** @type {any} */ l) => l.id).find((/** @type {string} */ lid) => !oldLids.has(lid))
                ?? null;
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
            await regetDoc(id);
        }
        refreshView();
    }

    async function renameLoadout(/** @type {PresetView} */ v) {
        const id = v.id;
        const name = v.loadoutName.value.trim();
        if (!name) { setStatus('Loadout name is required', true); return; }
        const lid = v.picker.value;
        if (!lid) return;
        try {
            const res = await bridge.edit(() => api('PATCH', `/presets/${id}/loadouts/${lid}`, { name }));
            setDoc(id, res.doc);
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
            await regetDoc(id);
        }
        refreshView();
    }

    /** First click arms (4 s timer); second click within the window deletes. */
    async function deleteLoadout(/** @type {PresetView} */ v) {
        const id = v.id;
        const lid = v.picker.value;
        if (!lid) return;
        if (!v.deleteArmed) {
            v.deleteArmed = true;
            v.deleteBtn.textContent = 'Confirm delete';
            v.deleteTimer = setTimeout(() => {
                v.deleteArmed = false;
                v.deleteBtn.textContent = 'Delete';
            }, 4000);
            return;
        }
        if (v.deleteTimer) clearTimeout(v.deleteTimer);
        v.deleteArmed = false;
        v.deleteBtn.textContent = 'Delete';
        try {
            const res = await bridge.edit(() => api('DELETE', `/presets/${id}/loadouts/${lid}`));
            setDoc(id, res.doc);
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
            await regetDoc(id);
        }
        refreshView();
    }

    /** Activate returns the slot view (no doc) — GET the doc inside the edit. */
    async function activateLoadout(/** @type {PresetView} */ v) {
        const id = v.id;
        const lid = v.picker.value;
        if (!lid) return;
        try {
            const fresh = await bridge.edit(async () => {
                await api('POST', `/presets/${id}/loadouts/${lid}/activate`, {});
                return api('GET', `/presets/${id}`);
            });
            setDoc(id, fresh);
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
            await regetDoc(id);
        }
        refreshView();
    }

    async function saveNotes(/** @type {PresetView} */ v) {
        const id = v.id;
        const notes = v.notes.value;
        const rev = v.notesRev;
        try {
            const res = await bridge.edit(() => api('PATCH', `/presets/${id}/meta`, { notes }));
            setDoc(id, res.doc);
            if (view === v && v.notesRev === rev) v.notesDirty = false;
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
            await regetDoc(id);
        }
        refreshView();
    }

    /**
     * Live refresh: SSE preset events for open docs, slot events and
     * reconciles debounce into one re-GET pass over the open docs.
     */
    const unsubscribe = /** @type {() => void} */ (bridge.onUpdate((/** @type {any} */ s) => {
        if (!pane.isConnected) return;
        const ev = s?.event;
        const hit = !!s?.slot
            || (ev && (ev.kind === 'slot' || (typeof ev.presetId === 'string' && openIds.includes(ev.presetId))));
        if (!hit) return;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { void refreshOpenDocs(); }, 150);
    }));

    async function refreshOpenDocs() {
        if (!pane.isConnected) return;
        for (const id of [...openIds]) {
            let fresh;
            try {
                fresh = await api('GET', `/presets/${id}`);
            } catch { /* transient — keep the current doc */ }
            if (!fresh || !openIds.includes(id)) continue;
            if (JSON.stringify(docs.get(id)) !== JSON.stringify(fresh)) {
                docs.set(id, fresh);
                if (id === active) refreshView();
                renderTabs();
            }
        }
    }

    renderTabs();
    return {
        open: openPreset,
        destroy() {
            unsubscribe();
            clearTimeout(refreshTimer);
            destroyView();
        },
    };
}
