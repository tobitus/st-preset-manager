/**
 * Presets tab (sub-phase 2b, extended in Phase 6): a tab strip of open
 * presets plus the active preset's view (loadout bar, rank bar, edit bar,
 * status line, outline/editor split, and a toggleable right-hand shelf panel
 * for cross-preset / shelf block copies).
 *
 * The edit bar (fix round 1) adds: an "Insert ▾" menu (empty section
 * heading / empty block, inserted before the selected row or at the end),
 * Duplicate (copies the selected block directly below itself) and Delete
 * (two-click-armed, like the loadout delete button but keyed to the
 * selected row so switching rows resets the arm) buttons, and a
 * name+content search box (Enter/Shift+Enter cycle matches, an optional
 * "Filter" checkbox hides non-matching rows in the outline). Markers and
 * order-only "ghost" rows can't be duplicated or deleted; the buttons stay
 * enabled but visually disabled and clicking them just toasts why.
 *
 * The outline's per-section/group collapse state persists per preset in
 * localStorage (`pm.collapsed.<id>`); the set of open tabs and the active
 * one persist across reloads in `pm.presets.open`, restored on creation
 * (silently dropping presets that no longer exist). The tab strip also
 * tracks SillyTavern's current working-slot preset (via `GET /slot`, re-read
 * on every slot event) and marks its tab with a "● Active" marker; a view of
 * a preset that is not (fully) active shows a notice with a "Make active"
 * button. On creation it
 * auto-opens that preset and activates it only when no saved active tab
 * remains.
 *
 * Re-render strategy: the view skeleton is built ONCE per activation, so the
 * outline/editor/notes state survives refreshes; afterwards only the loadout
 * picker options, the rank/edit bars' disabled state, the notes textarea
 * (when the user has not typed into it) and the outline/editor renders are
 * updated. Every write goes through `bridge.edit`; reads (GET) may be
 * direct.
 */
import { api, ctx, slotPath, loadSlot } from '../st.js';
import { activeNotice } from '../active.js';
import { createOutline } from './outline.js';
import { createEditor } from './editor.js';
import { createModelPanel } from './model-panel.js';
import { createShelfPanel } from './shelf-panel.js';
import { findLeaf, headingAction, searchMatches } from '../outline-model.js';
import { createEditGuard } from '../dirty.js';

/**
 * @typedef {object} PresetView
 * @property {string} id preset id this view renders
 * @property {HTMLElement} root the `.pm-preset-view` element
 * @property {HTMLElement} outlineEl the `.pm-outline` keyboard target
 * @property {HTMLElement} editorEl the `.pm-editor` element
 * @property {HTMLElement} statusEl the `.pm-status` one-liner
 * @property {HTMLSelectElement} picker loadout picker
 * @property {HTMLInputElement} loadoutName typed loadout name
 * @property {HTMLButtonElement} deleteBtn two-click-armed loadout delete
 * @property {HTMLButtonElement[]} rankButtons promote/demote/move up/down/make section/make group
 * @property {HTMLButtonElement} shelfSaveBtn 'Save to shelf' button
 * @property {HTMLButtonElement} makeSectionBtn 'Make/Unmake section heading' button
 * @property {HTMLButtonElement} makeGroupBtn 'Make/Unmake group heading' button
 * @property {HTMLTextAreaElement} notes preset notes textarea
 * @property {HTMLElement} insertMenu the `.pm-insert-menu` popup
 * @property {HTMLButtonElement} dupBtn 'Duplicate' button
 * @property {HTMLButtonElement} delBtn two-click-armed block delete button
 * @property {HTMLInputElement} searchInput the `.pm-search-input` box
 * @property {HTMLElement} searchCount the `.pm-search-count` match counter
 * @property {HTMLInputElement} searchFilter the `.pm-search-filter` checkbox
 * @property {HTMLElement} notActiveEl the `.pm-not-active` notice
 * @property {HTMLElement} notActiveText its text span
 * @property {HTMLButtonElement} makeActiveBtn the notice's "Make active" button
 * @property {{ query: string, filter: boolean, index: number }} search
 * @property {Set<string>} collapsed section/group node keys collapsed in the outline
 * @property {string|null} delArmedKey key the block delete confirmation is armed for
 * @property {any} delTimer restore-'Delete' timer for delArmedKey
 * @property {AbortController} ac aborts this view's document-level listeners
 * @property {{ render(doc: any, selectedKey: string|null, opts?: any): void, destroy(): void }} outline
 * @property {{ render(): void, destroy(): void }} modelPanel
 * @property {{ show(doc: any, key: string|null): void }} editor
 * @property {import('../dirty.js').EditGuard} notesGuard tracks unsaved edits to the notes textarea
 * @property {boolean} deleteArmed first loadout-delete click happened
 * @property {any} deleteTimer restore-'Delete' timer for the loadout delete
 * @property {string|null} selectNextLid loadout to select after creation
 * @property {HTMLElement} shelfPanelEl the `.pm-shelf-panel` element
 * @property {{ render(): Promise<void>, destroy(): void }} shelfPanel
 */

/**
 * @param {HTMLElement} pane .pm-pane[data-pane="presets"]
 * @param {import('../bridge.js').Bridge} bridge
 * @returns {{ open(presetId: string): Promise<void>, destroy(): void, openIds(): string[] }}
 */
export function createPresetsTab(pane, bridge) {
    // Contract state `open`: preset ids in tab order.
    const /** @type {string[]} */ openIds = [];
    let /** @type {string|null} */ active = null;
    const /** @type {Map<string, any>} */ docs = new Map();
    const /** @type {Map<string, string|null>} */ selected = new Map();
    let /** @type {PresetView|null} */ view = null;
    let /** @type {any} */ refreshTimer = undefined;
    let shelfOpen = false;
    /** true while restore() replays the saved tab set (saveOpenState waits for its end) */
    let restoring = false;
    /** set by destroy(): async work that resumes afterwards (restore, open) must not build a view */
    let destroyed = false;
    let shelfSource = 'shelf';
    let /** @type {string|null} */ slotPresetId = null;
    let /** @type {string|null} */ slotLoadoutId = null;

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

    /** Persist the open tab set + active tab across reloads. */
    function saveOpenState() {
        if (restoring) return; // restore() saves once at its end: never a half-restored set
        try {
            localStorage.setItem('pm.presets.open', JSON.stringify({ ids: openIds, active }));
        } catch { /* storage unavailable/full — best effort */ }
    }

    function renderTabs() {
        tabsEl.replaceChildren(...openIds.map((id) => {
            const tab = document.createElement('div');
            tab.className = 'pm-preset-tab'
                + (id === active ? ' pm-active' : '')
                + (id === slotPresetId ? ' pm-slot' : '');
            tab.dataset.presetId = id;
            const name = document.createElement('span');
            name.className = 'pm-preset-tab-name';
            name.textContent = docs.get(id)?.name ?? id;
            tab.append(name);
            if (id === slotPresetId) {
                const marker = document.createElement('span');
                marker.className = 'pm-active-marker';
                marker.title = 'SillyTavern is running this preset';
                marker.textContent = '● Active';
                tab.append(marker);
            }
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
            tab.append(close);
            return tab;
        }));
        emptyEl.hidden = openIds.length > 0;
    }

    function activate(/** @type {string} */ presetId) {
        active = presetId;
        saveOpenState();
        renderTabs();
        buildView();
    }

    /**
     * GET the doc and push a tab for `presetId` if it isn't open yet.
     * `silent` drops a failed GET (e.g. a 404 for a preset deleted since
     * the tab set was saved) without status text or a console error.
     * @param {string} presetId
     * @param {{ silent?: boolean }} [opts]
     * @returns {Promise<boolean>} whether the preset ended up open
     */
    async function addTab(presetId, { silent = false } = {}) {
        if (openIds.includes(presetId)) return true;
        let doc;
        try {
            doc = await api('GET', `/presets/${presetId}`);
        } catch (err) {
            if (!silent) {
                console.error('[preset-manager] open preset failed', err);
                setStatus(errText(err), true);
            }
            return false;
        }
        if (openIds.includes(presetId)) return true; // opened while we awaited
        docs.set(presetId, doc);
        selected.set(presetId, null);
        openIds.push(presetId);
        saveOpenState();
        return true;
    }

    /** Contract `open(id)`: GET the doc if not open, add a tab, activate, render. */
    async function openPreset(/** @type {string} */ presetId) {
        const ok = await addTab(presetId);
        if (!ok || destroyed) return;
        if (active !== presetId) activate(presetId);
        else { renderTabs(); refreshView(); if (view && shelfOpen) void view.shelfPanel.render(); }
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
            if (next) activate(next); // activate() saves the open state
            else { saveOpenState(); renderTabs(); }
        } else {
            saveOpenState();
            renderTabs();
            if (view && shelfOpen) void view.shelfPanel.render();
        }
    }

    function destroyView() {
        if (!view) return;
        if (view.deleteTimer) clearTimeout(view.deleteTimer);
        if (view.delTimer) clearTimeout(view.delTimer);
        view.ac.abort();
        view.outline.destroy();
        view.modelPanel.destroy();
        view.shelfPanel.destroy();
        view.root.remove();
        view = null;
    }

    /** Build the view skeleton ONCE per activation (DOM contract selectors). */
    function buildView() {
        if (destroyed) return; // a late async activation after the window closed/was replaced
        const id = /** @type {string} */ (active);
        destroyView();
        const root = document.createElement('div');
        root.className = 'pm-preset-view';
        root.dataset.presetId = id;
        root.innerHTML = `
            <div class="pm-not-active" hidden><span class="pm-not-active-text"></span><button class="pm-make-active menu_button" title="Load this preset with its active loadout into SillyTavern (same as Library → Load)">Make active</button></div>
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
                <button class="pm-rank-make-section menu_button" title="Turn the selected plain row into a section heading (the rows below it become its children)">Make section heading (Alt+S)</button>
                <button class="pm-rank-make-group menu_button" title="Turn the selected plain row into a group heading">Make group heading (Alt+G)</button>
                <button class="pm-shelf-save menu_button" title="Save the selected block to the shelf">Save to shelf</button>
                <button class="pm-shelf-toggle menu_button" title="Show the shelf list (drag blocks into this preset)">Shelf ▸</button>
            </div>
            <div class="pm-edit-bar">
                <span class="pm-insert">
                    <button class="pm-insert-toggle menu_button" title="Insert at the selected row (or at the end)">Insert ▾</button>
                    <span class="pm-insert-menu" hidden>
                        <button class="pm-insert-section menu_button" title="An empty section heading: the rows below it, up to the next section heading, belong to it">Section heading</button>
                        <button class="pm-insert-block menu_button" title="An empty block">Block</button>
                    </span>
                </span>
                <button class="pm-block-duplicate menu_button" title="Copy the selected block directly below it">Duplicate</button>
                <button class="pm-block-delete menu_button" title="Delete the selected block">Delete</button>
                <span class="pm-search">
                    <input class="pm-search-input text_pole" type="search" placeholder="Search names + content…">
                    <span class="pm-search-count"></span>
                    <label class="pm-search-filter-label" title="Show only matching rows (and their headings)"><input type="checkbox" class="pm-search-filter">Filter</label>
                </span>
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
                <div class="pm-shelf-panel" hidden></div>
            </div>`;
        const q = (/** @type {string} */ sel) => /** @type {any} */ (root.querySelector(sel));
        const outlineEl = /** @type {HTMLElement} */ (q('.pm-outline'));
        const editorEl = /** @type {HTMLElement} */ (q('.pm-editor'));
        let /** @type {Set<string>} */ collapsed;
        try {
            const raw = JSON.parse(localStorage.getItem('pm.collapsed.' + id) ?? '[]');
            collapsed = new Set(Array.isArray(raw) ? raw.filter((/** @type {any} */ x) => typeof x === 'string') : []);
        } catch { collapsed = new Set(); }
        /** @type {PresetView} */
        const nextView = {
            id,
            root,
            outlineEl,
            editorEl,
            statusEl: q('.pm-status'),
            notActiveEl: q('.pm-not-active'),
            notActiveText: q('.pm-not-active-text'),
            makeActiveBtn: q('.pm-make-active'),
            picker: q('.pm-loadout-picker'),
            loadoutName: q('.pm-loadout-name'),
            deleteBtn: q('.pm-loadout-delete'),
            rankButtons: [q('.pm-rank-promote'), q('.pm-rank-demote'), q('.pm-move-up'), q('.pm-move-down'), q('.pm-rank-make-section'), q('.pm-rank-make-group')],
            shelfSaveBtn: q('.pm-shelf-save'),
            makeSectionBtn: q('.pm-rank-make-section'),
            makeGroupBtn: q('.pm-rank-make-group'),
            notes: q('.pm-preset-notes'),
            insertMenu: q('.pm-insert-menu'),
            dupBtn: q('.pm-block-duplicate'),
            delBtn: q('.pm-block-delete'),
            searchInput: q('.pm-search-input'),
            searchCount: q('.pm-search-count'),
            searchFilter: q('.pm-search-filter'),
            search: { query: '', filter: false, index: -1 },
            collapsed,
            delArmedKey: null,
            delTimer: null,
            ac: new AbortController(),
            outline: createOutline(outlineEl, {
                onSelect: (/** @type {string|null} */ key) => {
                    selected.set(id, key);
                    refreshView();
                },
                onOps: (/** @type {any[]} */ ops) => runOps(id, ops),
                onToggleCollapse: (/** @type {string} */ nodeKey) => {
                    if (nextView.collapsed.has(nodeKey)) nextView.collapsed.delete(nodeKey);
                    else nextView.collapsed.add(nodeKey);
                    try {
                        localStorage.setItem('pm.collapsed.' + id, JSON.stringify([...nextView.collapsed]));
                    } catch { /* storage unavailable/full — best effort */ }
                    refreshView();
                },
                onHeading: (/** @type {'section'|'group'} */ kind) => headingOp(id, kind),
                onCardinality: (/** @type {string} */ key, /** @type {'pick-one'|'pick-one-or-more'} */ c) => cardinalityOp(id, key, c),
            }),
            editor: createEditor(editorEl, {
                onOps: (/** @type {any[]} */ ops) => runOps(id, ops),
            }),
            notesGuard: createEditGuard(),
            deleteArmed: false,
            deleteTimer: null,
            selectNextLid: null,
            modelPanel: /** @type {any} */ (null),
            shelfPanelEl: q('.pm-shelf-panel'),
            shelfPanel: /** @type {any} */ (null),
        };
        nextView.modelPanel = createModelPanel(q('.pm-model-panel-host'), {
            bridge,
            presetId: id,
            getDoc: () => docs.get(id),
            setDoc: (/** @type {any} */ d) => setDoc(id, d),
            getLoadoutId: () => nextView.picker.value,
        });
        nextView.shelfPanel = createShelfPanel(nextView.shelfPanelEl, {
            bridge,
            sources: () => openIds.filter((x) => x !== id).map((x) => ({ id: x, name: docs.get(x)?.name ?? x })),
            getDoc: (/** @type {string} */ x) => docs.get(x),
            getSource: () => shelfSource,
            setSource: (/** @type {string} */ s) => { shelfSource = s; },
            onCopy: (/** @type {any} */ src, /** @type {{ before: string|null, outsideGroup: boolean }} */ anchor) => copyInto(id, src, anchor),
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
        q('.pm-rank-make-section').addEventListener('click', () => headingOp(id, 'section'));
        q('.pm-rank-make-group').addEventListener('click', () => headingOp(id, 'group'));
        q('.pm-shelf-save').addEventListener('click', () => void saveToShelf(nextView));
        q('.pm-shelf-toggle').addEventListener('click', () => {
            shelfOpen = !shelfOpen;
            applyShelfOpen(nextView);
        });
        q('.pm-insert-toggle').addEventListener('click', () => {
            nextView.insertMenu.hidden = !nextView.insertMenu.hidden;
        });
        document.addEventListener('click', (ev) => {
            if (!nextView.insertMenu.hidden && !(/** @type {Element} */ (ev.target))?.closest?.('.pm-insert')) {
                nextView.insertMenu.hidden = true;
            }
        }, { signal: nextView.ac.signal });
        q('.pm-insert-section').addEventListener('click', () => void insertSection(nextView));
        q('.pm-insert-block').addEventListener('click', () => void insertBlock(nextView));
        nextView.dupBtn.addEventListener('click', () => void duplicateBlock(nextView));
        nextView.delBtn.addEventListener('click', () => void deleteSelectedBlock(nextView));
        nextView.searchInput.addEventListener('input', () => {
            nextView.search.query = nextView.searchInput.value;
            nextView.search.index = -1;
            refreshView();
        });
        nextView.searchInput.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter') return;
            ev.preventDefault();
            const doc = docs.get(id);
            if (!doc) return;
            const matches = searchMatches(doc, nextView.search.query);
            if (!matches.length) return;
            const n = matches.length;
            nextView.search.index = ev.shiftKey
                ? (nextView.search.index <= 0 ? n - 1 : nextView.search.index - 1)
                : (nextView.search.index + 1) % n;
            selected.set(id, matches[nextView.search.index]);
            refreshView();
            scrollToKey(matches[nextView.search.index]);
        });
        nextView.searchFilter.addEventListener('change', () => {
            nextView.search.filter = nextView.searchFilter.checked;
            refreshView();
        });
        nextView.notes.addEventListener('input', () => { nextView.notesGuard.edited(); });
        q('.pm-preset-notes-save').addEventListener('click', () => void saveNotes(nextView));
        nextView.makeActiveBtn.addEventListener('click', async () => {
            const doc = docs.get(id);
            nextView.makeActiveBtn.disabled = true;
            try {
                await loadSlot(bridge, id, doc?.activeLoadoutId);
                setStatus('');
            } catch (err) {
                setStatus(errText(err), true);
            } finally {
                nextView.makeActiveBtn.disabled = false;
            }
            await refreshSlot();
        });
        host.replaceChildren(root);
        view = nextView;
        applyShelfOpen(nextView);
        refreshView();
    }

    /** Show/hide the shelf panel; toggle button label/state; render when opened. */
    function applyShelfOpen(/** @type {PresetView} */ v) {
        v.shelfPanelEl.hidden = !shelfOpen;
        const btn = /** @type {HTMLElement} */ (v.root.querySelector('.pm-shelf-toggle'));
        if (btn) {
            btn.classList.toggle('pm-active', shelfOpen);
            btn.textContent = shelfOpen ? 'Shelf ◂' : 'Shelf ▸';
        }
        if (shelfOpen) void v.shelfPanel.render();
    }

    /** @param {'promote'|'demote'|'moveLeaf'} op @param {number} [delta] */
    function rankOp(/** @type {string} */ id, op, delta = 0) {
        const key = selected.get(id);
        if (!key) return;
        void runOps(id, [op === 'moveLeaf' ? { op, key, delta } : { op, key }]).catch(() => {});
    }

    /** @param {'section'|'group'} kind */
    function headingOp(/** @type {string} */ id, kind) {
        const key = selected.get(id);
        const doc = docs.get(id);
        if (!key || !doc) return;
        const a = headingAction(doc, key, kind);
        if (a.refuse) {
            toast('warning', a.refuse);
            setStatus(a.refuse, true);
            return;
        }
        if (a.op) void runOps(id, [a.op]).catch(() => {});
    }

    /**
     * Flip a group's cardinality from its 1/N badge. The outline never mutates
     * locally: runOps re-renders from the server doc either way. Any failure
     * (e.g. the 409 "more than one option currently selected" refusal) pops up
     * the server's message.
     */
    function cardinalityOp(/** @type {string} */ id, /** @type {string} */ key, /** @type {'pick-one'|'pick-one-or-more'} */ cardinality) {
        void runOps(id, [{ op: 'setCardinality', key, cardinality }]).catch((/** @type {any} */ err) => {
            const msg = document.createElement('p');
            msg.textContent = err?.body?.error ?? errText(err);
            void ctx().callGenericPopup(msg, ctx().POPUP_TYPE.TEXT);
        });
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

    /** Scroll the outline row for `key` (in the active view) into view. */
    function scrollToKey(/** @type {string} */ key) {
        if (!view) return;
        view.outlineEl.querySelector(`li.pm-node[data-key="${CSS.escape(key)}"] > .pm-row`)?.scrollIntoView({ block: 'nearest' });
    }

    /**
     * Guard shared by Duplicate and Delete: no selection -> null; a marker
     * or order-only ghost row -> toast why and null; otherwise the leaf.
     * @returns {{ key: string, found: any } | null}
     */
    function guardEditableSelection(/** @type {string} */ id, /** @type {any} */ doc) {
        const key = selected.get(id);
        if (!key) return null;
        const found = findLeaf(doc, key);
        if (!found) return null;
        if (found.marker || found.leaf.kind === 'ghost') {
            toast('warning', found.marker
                ? "Markers are fixed SillyTavern slots: they can't be deleted or duplicated"
                : "Order-only entries have no block: they can't be deleted or duplicated");
            return null;
        }
        return { key, found };
    }

    /** Add an empty section heading before the selected row (or at the end). */
    async function insertSection(/** @type {PresetView} */ v) {
        v.insertMenu.hidden = true;
        const raw = await ctx().callGenericPopup('Section heading name', ctx().POPUP_TYPE.INPUT, 'New section');
        if (typeof raw !== 'string' || !raw.trim()) return;
        const trimmed = raw.trim();
        const name = trimmed.startsWith('=') ? trimmed : `== ${trimmed} ==`;
        await runInsertOp(v, { op: 'addSection', name, before: selected.get(v.id) ?? null });
    }

    /** Add an empty block before the selected row (or at the end). */
    async function insertBlock(/** @type {PresetView} */ v) {
        v.insertMenu.hidden = true;
        await runInsertOp(v, { op: 'addBlock', name: 'New block', before: selected.get(v.id) ?? null });
    }

    /** Shared addSection/addBlock runner: select + scroll to the new row. */
    async function runInsertOp(/** @type {PresetView} */ v, /** @type {any} */ op) {
        const id = v.id;
        try {
            const res = await bridge.edit(() => api('POST', `/presets/${id}/ops`, op));
            setDoc(id, res.doc);
            selected.set(id, res.result?.key ?? null);
            setStatus('');
            refreshView();
            if (res.result?.key) scrollToKey(res.result.key);
        } catch (err) {
            setStatus(errText(err), true);
            await regetDoc(id);
            refreshView();
        }
    }

    /** Copy the selected block directly below itself. */
    async function duplicateBlock(/** @type {PresetView} */ v) {
        const id = v.id;
        const doc = docs.get(id);
        if (!doc) return;
        const g = guardEditableSelection(id, doc);
        if (!g) return;
        try {
            const res = await bridge.edit(() => api('POST', `/presets/${id}/ops`, {
                op: 'copyBlock', fromPresetId: id, identifier: g.found.identifier, after: g.key,
            }));
            setDoc(id, res.doc);
            const newKey = res.keys?.[0] ?? null;
            selected.set(id, newKey);
            const name = g.found.block?.name || g.found.identifier;
            setStatus(`Duplicated "${name}"`);
            refreshView();
            if (newKey) scrollToKey(newKey);
        } catch (err) {
            const message = /** @type {any} */ (err).body?.error ?? /** @type {any} */ (err).message;
            toast('error', message);
            setStatus(message, true);
            await regetDoc(id);
            refreshView();
        }
    }

    /** Disarm the block-delete confirmation (selecting another row, a timeout, or a successful delete). */
    function disarmDelete() {
        if (!view) return;
        clearTimeout(view.delTimer);
        view.delTimer = null;
        view.delArmedKey = null;
        view.delBtn.textContent = 'Delete';
    }

    /** First click on a row arms (4 s timer); a second click on the SAME row deletes it. */
    async function deleteSelectedBlock(/** @type {PresetView} */ v) {
        const id = v.id;
        const doc = docs.get(id);
        if (!doc) return;
        const g = guardEditableSelection(id, doc);
        if (!g) return;
        if (v.delArmedKey !== g.key) {
            v.delArmedKey = g.key;
            v.delBtn.textContent = 'Confirm delete';
            clearTimeout(v.delTimer);
            v.delTimer = setTimeout(() => disarmDelete(), 4000);
            return;
        }
        const name = g.found.block?.name || g.found.identifier;
        disarmDelete(); // before the await: a third click cannot send a second op
        try {
            const res = await bridge.edit(() => api('POST', `/presets/${id}/ops`, { op: 'deleteBlock', identifier: g.found.identifier }));
            setDoc(id, res.doc);
            selected.set(id, null);
            setStatus(`Deleted "${name}"`);
            refreshView();
        } catch (err) {
            setStatus(errText(err), true);
            await regetDoc(id);
            refreshView();
        }
    }

    /**
     * Duplicate/Delete button state: no selection -> disabled; a marker or
     * ghost selection -> visually disabled (but still clickable, so the
     * click handler's toast explains why); otherwise fully enabled.
     */
    function updateBlockActionButtons(/** @type {PresetView} */ v, /** @type {any} */ doc, /** @type {string|null} */ key) {
        const found = key ? findLeaf(doc, key) : null;
        const fixed = !!found && (found.marker || found.leaf.kind === 'ghost');
        const fixedTitle = "Markers are fixed SillyTavern slots: they can't be deleted or duplicated";
        for (const [btn, normalTitle] of /** @type {[HTMLButtonElement, string][]} */ ([
            [v.dupBtn, 'Copy the selected block directly below it'],
            [v.delBtn, 'Delete the selected block'],
        ])) {
            if (!key) {
                btn.disabled = true;
                btn.classList.remove('pm-disabled');
                btn.removeAttribute('aria-disabled');
                btn.title = normalTitle;
            } else if (fixed) {
                btn.disabled = false;
                btn.classList.add('pm-disabled');
                btn.setAttribute('aria-disabled', 'true');
                btn.title = fixedTitle;
            } else {
                btn.disabled = false;
                btn.classList.remove('pm-disabled');
                btn.setAttribute('aria-disabled', 'false');
                btn.title = normalTitle;
            }
        }
    }

    /**
     * Make/Unmake section/group heading button label + refuse-disabled
     * state (still clickable when refused, so the click handler's toast
     * explains why — same pattern as `updateBlockActionButtons`).
     */
    function updateHeadingButtons(/** @type {PresetView} */ v, /** @type {any} */ doc, /** @type {string|null} */ key) {
        for (const [btn, kind, shortcut, normalTitle, unmakeTitle] of /** @type {[HTMLButtonElement, 'section'|'group', string, string, string][]} */ ([
            [v.makeSectionBtn, 'section', 'Alt+S', 'Turn the selected plain row into a section heading (the rows below it become its children)', 'Turn the selected section heading back into a plain row'],
            [v.makeGroupBtn, 'group', 'Alt+G', 'Turn the selected plain row into a group heading', 'Turn the selected group heading back into a plain row'],
        ])) {
            const a = headingAction(doc, key, kind);
            btn.textContent = `${a.label} (${shortcut})`;
            if (a.refuse) {
                btn.classList.add('pm-disabled');
                btn.setAttribute('aria-disabled', 'true');
                btn.title = a.refuse;
            } else {
                btn.classList.remove('pm-disabled');
                btn.setAttribute('aria-disabled', 'false');
                btn.title = a.label.startsWith('Unmake') ? unmakeTitle : normalTitle;
            }
        }
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

    /** Targeted refresh: picker, rank/edit bars, notes (if not dirty), outline+editor. */
    function refreshView() {
        if (!view) return;
        const doc = docs.get(view.id);
        if (!doc) return;
        refreshLoadoutBar(doc);
        const key = selected.get(view.id) ?? null;
        for (const b of view.rankButtons) b.disabled = !key;
        updateHeadingButtons(view, doc, key);
        view.shelfSaveBtn.disabled = !key;
        if (view.delArmedKey && view.delArmedKey !== key) disarmDelete();
        updateBlockActionButtons(view, doc, key);
        if (!view.notesGuard.dirty) view.notes.value = doc.notes ?? '';
        const q = view.search.query.trim();
        const matches = q ? searchMatches(doc, q) : [];
        if (view.search.index > matches.length - 1) view.search.index = matches.length - 1;
        view.searchCount.textContent = !q
            ? ''
            : (matches.length === 0
                ? '0 matches'
                : (view.search.index < 0
                    ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
                    : `${view.search.index + 1}/${matches.length}`));
        view.outline.render(doc, key, {
            collapsed: view.collapsed,
            search: q ? { keys: new Set(matches), current: view.search.index >= 0 ? matches[view.search.index] : null, filter: view.search.filter } : undefined,
        });
        view.editor.show(doc, key);
        view.modelPanel.render();
        updateNotice();
    }

    /** Show/hide the "not active in SillyTavern" notice of the open view. */
    function updateNotice() {
        if (!view) return;
        const text = activeNotice(view.id, docs.get(view.id), { presetId: slotPresetId, loadoutId: slotLoadoutId });
        view.notActiveEl.hidden = text === null;
        view.notActiveText.textContent = text ?? '';
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
        const tok = v.notesGuard.token();
        try {
            const res = await bridge.edit(() => api('PATCH', `/presets/${id}/meta`, { notes }));
            setDoc(id, res.doc);
            v.notesGuard.saved(tok);
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
            await regetDoc(id);
        }
        refreshView();
    }

    /** Save the selected outline row (leaf) as a new shelf entry. */
    async function saveToShelf(/** @type {PresetView} */ v) {
        const id = v.id;
        const key = selected.get(id);
        if (!key) return;
        const doc = docs.get(id);
        if (!doc) return;
        const found = findLeaf(doc, key);
        if (!found) return;
        try {
            const entry = await bridge.edit(() => api('POST', '/shelf', { fromPresetId: id, identifier: found.identifier }));
            setStatus(`Saved "${entry.name}" to the shelf`);
            toast('success', `Saved "${entry.name}" to the shelf`);
        } catch (err) {
            const message = /** @type {any} */ (err).body?.error ?? /** @type {any} */ (err).message;
            setStatus(message, true);
            toast('error', message);
        }
    }

    /**
     * Copy a shelf entry or a source preset's block/group into `targetId`,
     * before the given leaf key (or at the end when `anchor.before` is
     * null), optionally outside its enclosing group.
     * @param {string} targetId
     * @param {{ shelfId: string } | { fromPresetId: string, identifier: string } | { fromPresetId: string, group: string }} src
     * @param {{ before: string|null, outsideGroup: boolean }} anchor
     */
    async function copyInto(targetId, src, anchor) {
        try {
            const res = await bridge.edit(() => api('POST', `/presets/${targetId}/ops`, { op: 'copyBlock', ...src, before: anchor.before, outsideGroup: anchor.outsideGroup }));
            setDoc(targetId, res.doc);
            let text = `Copied ${res.identifiers.length} block(s)`;
            if (res.warnings?.length) {
                toast('warning', res.warnings.join('\n'), 'Macro warning');
                text += ` — ${res.warnings.length} macro warning(s)`;
            }
            if (view?.id === targetId) setStatus(text);
        } catch (err) {
            const message = /** @type {any} */ (err).body?.error ?? /** @type {any} */ (err).message;
            toast('error', message, 'Copy refused');
            if (view?.id === targetId) setStatus(message, true);
            await regetDoc(targetId);
        }
        if (view?.id === targetId) refreshView();
    }

    /** @param {'success'|'error'|'warning'|'info'} kind @param {string} text @param {string} [title] */
    function toast(kind, text, title = 'Preset Manager') {
        const t = /** @type {any} */ (globalThis).toastr;
        if (!t) return;
        const html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/\n/g, '<br>');
        // escaped above; ST turns toastr's escapeHtml on globally, which
        // would escape it twice and show the <br> literally
        t[kind](html, title, { timeOut: kind === 'error' ? 8000 : 10000, extendedTimeOut: 4000, escapeHtml: false });
    }

    /** Re-GET SillyTavern's current working-slot preset id and re-render the tab strip. */
    async function refreshSlot() {
        try {
            const slot = await api('GET', slotPath());
            slotPresetId = slot?.desired?.presetId ?? null;
            slotLoadoutId = slot?.desired?.loadoutId ?? null;
        } catch { /* transient — keep the last known value */ }
        if (pane.isConnected) { renderTabs(); updateNotice(); }
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
        await refreshSlot();
        for (const id of [...openIds]) {
            let fresh;
            try {
                fresh = await api('GET', `/presets/${id}`);
            } catch (err) {
                if (/** @type {any} */ (err)?.status === 404) { closeTab(id); continue; }
                /* transient — keep the current doc */
            }
            if (!fresh || !openIds.includes(id)) continue;
            if (JSON.stringify(docs.get(id)) !== JSON.stringify(fresh)) {
                docs.set(id, fresh);
                if (id === active) refreshView();
                else if (view && shelfOpen) void view.shelfPanel.render();
                renderTabs();
            }
        }
    }

    /**
     * Restore the open tab set + active tab from `pm.presets.open`, then
     * make sure the current working-slot preset is open too (without
     * switching to it unless nothing else claims the active slot).
     */
    async function restore() {
        restoring = true;
        try {
            await restoreTabs();
        } finally {
            restoring = false;
        }
        if (!destroyed) saveOpenState();
    }

    async function restoreTabs() {
        let /** @type {string[]} */ ids = [];
        let /** @type {string|null} */ savedActive = null;
        try {
            const raw = JSON.parse(localStorage.getItem('pm.presets.open') ?? '{}');
            ids = Array.isArray(raw?.ids) ? raw.ids.filter((/** @type {any} */ x) => typeof x === 'string') : [];
            savedActive = typeof raw?.active === 'string' ? raw.active : null;
        } catch { /* ignore */ }
        for (const pid of ids) {
            if (destroyed) return;
            await addTab(pid, { silent: true });
        }
        if (destroyed) return;
        await refreshSlot();
        if (destroyed) return;
        if (slotPresetId && !openIds.includes(slotPresetId)) {
            await addTab(slotPresetId, { silent: true });
        }
        if (destroyed) return;
        if (active === null) {
            if (savedActive && openIds.includes(savedActive)) activate(savedActive);
            else if (slotPresetId && openIds.includes(slotPresetId)) activate(slotPresetId);
            else if (openIds.length) activate(openIds[0]);
            else renderTabs();
        }
    }

    renderTabs();
    void restore();
    return {
        open: openPreset,
        openIds: () => [...openIds],
        destroy() {
            destroyed = true;
            unsubscribe();
            clearTimeout(refreshTimer);
            destroyView();
        },
    };
}
