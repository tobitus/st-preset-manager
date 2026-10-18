/**
 * Presets tab (sub-phase 2b, extended in Phase 6): a tab strip of open
 * presets plus the active preset's view (loadout bar, rank bar, edit bar,
 * status line, outline/editor split, and a toggleable right-hand shelf panel
 * for cross-preset / shelf block copies).
 *
 * The edit bar (fix round 1) adds: an "Insert ▾" menu (empty section
 * heading / empty block / empty group heading, inserted below the selected row or at the end),
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
import { createEditor, findGroupRow } from './editor.js';
import { createModelPanel } from './model-panel.js';
import { createShelfPanel } from './shelf-panel.js';
import { flattenSeq } from '../../shared/outline.js';
import { findLeaf, headingAction, searchMatches, leadingRun, linkSelectionOp } from '../outline-model.js';
import { rootOf } from '../../shared/loadouts.js';
import { createEditGuard } from '../dirty.js';

const MAKE_GROUP_SEL_TITLE = 'Make one group from the selected rows (Ctrl/Shift-click to select); rows that are not adjacent become linked members';
const LINK_SEL_TITLE = 'Link the selected rows to the selected group (Ctrl-click one group row and the rows to link)';

/**
 * @typedef {object} PresetView
 * @property {string} id preset id this view renders
 * @property {HTMLElement} root the `.pm-preset-view` element
 * @property {HTMLElement} outlineEl the `.pm-outline` keyboard target
 * @property {HTMLElement} editorEl the `.pm-editor` element
 * @property {HTMLElement} statusEl the `.pm-status` one-liner
 * @property {HTMLSelectElement} picker loadout picker
 * @property {HTMLInputElement} loadoutName typed loadout name
 * @property {HTMLSelectElement} parentSelect root a playstyle inherits from
 * @property {HTMLSelectElement} kindSelect kind of the loadout 'New' creates
 * @property {HTMLButtonElement} resetAllBtn 'Reset all to inherit' (playstyles only)
 * @property {HTMLButtonElement} deleteBtn two-click-armed loadout delete
 * @property {HTMLButtonElement[]} rankButtons promote/demote/move up/down/make section/make group
 * @property {HTMLButtonElement} shelfSaveBtn 'Save to shelf' button
 * @property {HTMLButtonElement} makeSectionBtn 'Make/Unmake section heading' button
 * @property {HTMLButtonElement} makeGroupBtn 'Make/Unmake group heading' button
 * @property {HTMLButtonElement} makeGroupSelBtn 'Make group from selection' button
 * @property {HTMLButtonElement} linkSelBtn 'Link to group' button
 * @property {HTMLTextAreaElement} notes preset notes textarea
 * @property {HTMLElement} insertMenu the `.pm-insert-menu` popup
 * @property {HTMLButtonElement} dupBtn 'Duplicate' button
 * @property {HTMLButtonElement} undoBtn 'Undo' button
 * @property {HTMLButtonElement} redoBtn 'Redo' button
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
    /** the whole multi-selection per preset (primary key included); mirrors `selected` */
    const /** @type {Map<string, Set<string>>} */ multi = new Map();
    /** undo/redo depths per preset, valid for the doc rev they were read at */
    const /** @type {Map<string, {rev: number, undo: number, redo: number}>} */ history = new Map();
    /** Select exactly one key (or nothing) for a preset. */
    function setSelection(/** @type {string} */ id, /** @type {string|null} */ key) {
        selected.set(id, key);
        multi.set(id, key ? new Set([key]) : new Set());
    }
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

    /** Enable undo/redo buttons from the cached depths. */
    function applyHistoryButtons(/** @type {PresetView} */ v) {
        const h = history.get(v.id);
        v.undoBtn.disabled = !h || h.undo === 0;
        v.redoBtn.disabled = !h || h.redo === 0;
    }

    /** Fetch undo/redo depths for a preset unless cached for its current rev. */
    async function refreshHistory(/** @type {string} */ id) {
        const doc = docs.get(id);
        if (!doc) return;
        const cached = history.get(id);
        if (cached && cached.rev === doc.rev) {
            if (view?.id === id) applyHistoryButtons(view);
            return;
        }
        try {
            const res = await api('GET', `/presets/${id}/history`);
            if (docs.get(id)?.rev !== doc.rev) return; // stale answer
            history.set(id, { rev: doc.rev, ...res });
            if (view?.id === id) applyHistoryButtons(view);
        } catch { /* keep the buttons as they are */ }
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
        setSelection(presetId, null);
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
        multi.delete(id);
        history.delete(id);
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
            <div class="pm-loadout-box">
                <div class="pm-loadout-box-title">Loadout</div>
                <div class="pm-loadout-bar">
                    <select class="pm-loadout-picker text_pole" title="loadout"></select>
                    <select class="pm-loadout-parent text_pole" title="Root this playstyle inherits from" hidden></select>
                    <button class="pm-loadout-activate menu_button" title="Make the selected loadout the active one">Activate</button>
                    <button class="pm-loadout-reset-all menu_button" title="Drop every explicit setting of this playstyle: it inherits everything from its root" hidden>Reset all to inherit</button>
                    <input class="pm-loadout-name text_pole" type="text" placeholder="name…">
                    <select class="pm-loadout-kind text_pole" title="Kind of the new loadout"><option value="root">root</option><option value="playstyle">playstyle</option></select>
                    <button class="pm-loadout-new menu_button" title="Create a loadout: a root copies the selected loadout's root; a playstyle inherits from it">New</button>
                    <button class="pm-loadout-rename menu_button" title="Rename the selected loadout to the typed name">Rename</button>
                    <button class="pm-loadout-delete menu_button" title="Delete the selected loadout">Delete loadout</button>
                </div>
            </div>
            <div class="pm-rank-bar">
                <button class="pm-rank-promote menu_button" title="Promote the selected row (Tab)">Promote</button>
                <button class="pm-rank-demote menu_button" title="Demote the selected row (Shift+Tab)">Demote</button>
                <button class="pm-move-up menu_button" title="Move the selected row up (Alt+↑)">↑</button>
                <button class="pm-move-down menu_button" title="Move the selected row down (Alt+↓)">↓</button>
                <button class="pm-rank-make-section menu_button" title="Turn the selected plain row into a section heading (Alt+S) — the rows below it become its children">Make section heading</button>
                <button class="pm-rank-make-group menu_button" title="Turn the selected plain row into a group heading (Alt+G)">Make group heading</button>
                <button class="pm-rank-make-group-sel menu_button" title="Make one group from the selected rows (Ctrl/Shift-click to select); rows that are not adjacent become linked members">Make group from selection</button>
                <button class="pm-rank-link-sel menu_button" title="Link the selected rows to the selected group (Ctrl-click one group row and the rows to link)">Link to group</button>
                <button class="pm-shelf-save menu_button" title="Save the selected block to the shelf">Save to shelf</button>
                <button class="pm-shelf-toggle menu_button" title="Show the shelf list (drag blocks into this preset)">Shelf ▸</button>
            </div>
            <div class="pm-edit-bar">
                <button class="pm-undo menu_button" title="Undo the last change to this preset (Ctrl+Z)">Undo</button><button class="pm-redo menu_button" title="Redo (Ctrl+Shift+Z)">Redo</button>
                <span class="pm-insert">
                    <button class="pm-insert-toggle menu_button" title="Insert below the selected row (or at the end)">Insert ▾</button>
                    <span class="pm-insert-menu" hidden>
                        <button class="pm-insert-section menu_button" title="An empty section heading: the rows below it, up to the next section heading, belong to it">Section heading</button>
                        <button class="pm-insert-block menu_button" title="An empty block">Block</button>
                        <button class="pm-insert-group menu_button" title="An empty group heading (Pick one or Pick many): Insert → Block with it selected adds its options">Group heading</button>
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
            parentSelect: q('.pm-loadout-parent'),
            kindSelect: q('.pm-loadout-kind'),
            resetAllBtn: q('.pm-loadout-reset-all'),
            deleteBtn: q('.pm-loadout-delete'),
            rankButtons: [q('.pm-rank-promote'), q('.pm-rank-demote'), q('.pm-move-up'), q('.pm-move-down'), q('.pm-rank-make-section'), q('.pm-rank-make-group')],
            shelfSaveBtn: q('.pm-shelf-save'),
            makeSectionBtn: q('.pm-rank-make-section'),
            makeGroupBtn: q('.pm-rank-make-group'),
            makeGroupSelBtn: q('.pm-rank-make-group-sel'),
            linkSelBtn: q('.pm-rank-link-sel'),
            notes: q('.pm-preset-notes'),
            insertMenu: q('.pm-insert-menu'),
            dupBtn: q('.pm-block-duplicate'),
            undoBtn: q('.pm-undo'),
            redoBtn: q('.pm-redo'),
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
                onSelect: (/** @type {string[]} */ keys) => {
                    selected.set(id, keys.at(-1) ?? null);
                    multi.set(id, new Set(keys));
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
                onHistory: (/** @type {'undo'|'redo'} */ dir) => void historyOp(id, dir),
                onCardinality: (/** @type {string} */ key, /** @type {'pick-one'|'pick-one-or-more'} */ c) => cardinalityOp(id, key, c),
            }),
            editor: createEditor(editorEl, {
                onOps: (/** @type {any[]} */ ops) => runOps(id, ops),
                onCardinality: (/** @type {string} */ key, /** @type {'pick-one'|'pick-one-or-more'} */ c) => cardinalityOp(id, key, c),
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
        nextView.picker.addEventListener('change', () => refreshView());
        nextView.parentSelect.addEventListener('change', () => void reparentLoadout(nextView));
        nextView.resetAllBtn.addEventListener('click', () => {
            void runOps(id, [{ op: 'resetAllInherit', loadoutId: nextView.picker.value }]).catch(() => {});
        });
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
        q('.pm-rank-make-group-sel').addEventListener('click', () => {
            const reason = makeGroupSelRefusal(id);
            if (reason) {
                toast('warning', reason);
                return;
            }
            void makeGroupFromSelection(nextView);
        });
        q('.pm-rank-link-sel').addEventListener('click', () => {
            const a = linkSelectionOp(docs.get(id), multi.get(id) ?? new Set());
            if (a.refuse) {
                toast('warning', a.refuse);
                return;
            }
            void runOps(id, [a.op]).then(() => {
                setSelection(id, null);
                refreshView();
            }).catch((/** @type {any} */ err) => {
                const msg = document.createElement('p');
                msg.textContent = err?.body?.error ?? errText(err);
                void ctx().callGenericPopup(msg, ctx().POPUP_TYPE.TEXT);
            });
        });
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
        q('.pm-insert-group').addEventListener('click', () => void insertGroup(nextView));
        nextView.dupBtn.addEventListener('click', () => void duplicateBlock(nextView));
        nextView.undoBtn.addEventListener('click', () => void historyOp(id, 'undo'));
        nextView.redoBtn.addEventListener('click', () => void historyOp(id, 'redo'));
        nextView.delBtn.addEventListener('click', () => void deleteSelectedBlock(nextView));
        nextView.undoBtn.disabled = true;
        nextView.redoBtn.disabled = true;
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
            setSelection(id, matches[nextView.search.index]);
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
        const keys = multi.get(id);
        if (op !== 'moveLeaf' && keys && keys.size >= 2) {
            void runOps(id, [{ op, keys: [...keys] }]).catch(() => {});
            return;
        }
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
        if (a.op) void runOps(id, [a.op]).then(() => { if (a.note) setStatus(a.note); }).catch(() => {});
    }

    /** Why "Make group from selection" is unavailable now, or '' when it is available. */
    function makeGroupSelRefusal(/** @type {string} */ id) {
        const keys = multi.get(id);
        if (!keys || keys.size < 2) return 'Select at least two rows (Ctrl/Shift-click) to make a group from them';
        if ([...keys].some((k) => k.startsWith('grp:'))) return 'A group row cannot be part of a new group';
        return '';
    }

    /** Ask for heading + cardinality, then send one `createGroup` op for the multi-selection. */
    async function makeGroupFromSelection(/** @type {PresetView} */ v) {
        const doc = docs.get(v.id);
        const keys = multi.get(v.id);
        if (!doc || !keys || keys.size < 2) return;
        /** @type {any[]} */
        const selectedEntries = [];
        /** @type {Map<string, number>} */
        const positions = new Map();
        for (const seq of doc.sequences ?? []) {
            flattenSeq(seq.rows ?? []).forEach((e, i) => {
                positions.set(e.leaf.key, i + 1);
                if (keys.has(e.leaf.key)) selectedEntries.push(e);
            });
        }
        const { leading, later } = leadingRun(doc, keys);
        const candidates = selectedEntries.filter((e) => e.rank === 'item' && e.leaf.kind === 'block' && leading.includes(e.leaf.key));

        const form = document.createElement('div');
        form.className = 'pm-mkgrp-form';
        const title = document.createElement('div');
        title.textContent = later.length
            ? `${selectedEntries.length} rows are not adjacent: the first run becomes the group, the rest are linked members`
            : `Make group from ${selectedEntries.length} rows`;
        const headLabel = document.createElement('label');
        headLabel.append('Heading ');
        const select = document.createElement('select');
        select.className = 'pm-mkgrp-heading text_pole';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'No heading';
        select.append(none);
        for (const e of candidates) {
            const opt = document.createElement('option');
            opt.value = e.leaf.key;
            opt.textContent = `#${positions.get(e.leaf.key)} ${doc.blocks?.[e.leaf.ref ?? e.leaf.identifier]?.name ?? ''}`;
            select.append(opt);
        }
        const first = selectedEntries[0];
        select.value = first && candidates.includes(first) ? first.leaf.key : '';
        headLabel.append(select);
        const radioLabel = (/** @type {string} */ value, /** @type {string} */ text, /** @type {boolean} */ checked) => {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'pm-mkgrp-card';
            input.value = value;
            input.checked = checked;
            label.append(input, ` ${text}`);
            return label;
        };
        form.append(
            title,
            headLabel,
            radioLabel('pick-one', 'Pick one (1)', true),
            radioLabel('pick-one-or-more', 'Pick many (N)', false),
        );

        const res = await ctx().callGenericPopup(form, ctx().POPUP_TYPE.CONFIRM, '', { okButton: 'Make group', cancelButton: 'Cancel' });
        if (res !== ctx().POPUP_RESULT.AFFIRMATIVE) return;
        const headerKey = select.value || null;
        const checked = /** @type {HTMLInputElement|null} */ (form.querySelector('input[name="pm-mkgrp-card"]:checked'));
        const cardinality = checked?.value === 'pick-one-or-more' ? 'pick-one-or-more' : 'pick-one';
        const optKeys = selectedEntries.map((e) => e.leaf.key).filter((k) => k !== headerKey);
        try {
            await runOps(v.id, [{ op: 'createGroup', keys: optKeys, headerKey, cardinality, ...(later.length ? { linked: true } : {}) }]);
        } catch (/** @type {any} */ err) {
            const msg = document.createElement('p');
            msg.textContent = err?.body?.error ?? errText(err);
            void ctx().callGenericPopup(msg, ctx().POPUP_TYPE.TEXT);
            return;
        }
        setSelection(v.id, null);
        refreshView();
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

    /** Undo/redo the whole-document snapshot stack of a preset (server side). */
    async function historyOp(/** @type {string} */ id, /** @type {'undo'|'redo'} */ dir) {
        const hadFocus = !!view && view.id === id && document.activeElement === view.outlineEl;
        if (view?.id === id) { view.undoBtn.disabled = true; view.redoBtn.disabled = true; }
        try {
            const res = await bridge.edit(() => api('POST', `/presets/${id}/${dir}`));
            setDoc(id, res?.doc);
            if (res?.history && res?.doc) history.set(id, { rev: res.doc.rev, ...res.history });
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
            await regetDoc(id);
        }
        refreshView();
        if (hadFocus && view && view.id === id) view.outlineEl.focus({ preventScroll: true });
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

    /** The leaf key an Insert lands below: the selected row's key; a headerless group row (`grp:` key) resolves to its last option, so the insert lands after the whole group / joins it last; nothing selected -> null (end). */
    function insertAnchor(/** @type {string} */ id) {
        const key = selected.get(id) ?? null;
        if (!key?.startsWith('grp:')) return key;
        const doc = docs.get(id);
        const row = doc ? findGroupRow(doc, key) : null;
        return row?.options?.at(-1)?.key ?? null;
    }

    /** Add an empty section heading below the selected row (or at the end). */
    async function insertSection(/** @type {PresetView} */ v) {
        v.insertMenu.hidden = true;
        const raw = await ctx().callGenericPopup('Section heading name', ctx().POPUP_TYPE.INPUT, 'New section');
        if (typeof raw !== 'string' || !raw.trim()) return;
        const trimmed = raw.trim();
        const name = trimmed.startsWith('=') ? trimmed : `== ${trimmed} ==`;
        await runInsertOp(v, { op: 'addSection', name, after: insertAnchor(v.id) });
    }

    /** Add an empty block below the selected row (or at the end). */
    async function insertBlock(/** @type {PresetView} */ v) {
        v.insertMenu.hidden = true;
        await runInsertOp(v, { op: 'addBlock', name: 'New block', after: insertAnchor(v.id) });
    }

    /** Add an empty headed group below the selected row (or at the end), asking for name + cardinality. */
    async function insertGroup(/** @type {PresetView} */ v) {
        v.insertMenu.hidden = true;
        const form = document.createElement('div');
        form.className = 'pm-addgrp-form';
        const title = document.createElement('div');
        title.textContent = 'Group heading';
        const nameLabel = document.createElement('label');
        nameLabel.append('Name ');
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'pm-addgrp-name text_pole';
        nameInput.value = 'New group';
        nameLabel.append(nameInput);
        const radioLabel = (/** @type {string} */ value, /** @type {string} */ text, /** @type {boolean} */ checked) => {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'pm-addgrp-card';
            input.value = value;
            input.checked = checked;
            label.append(input, ` ${text}`);
            return label;
        };
        form.append(
            title,
            nameLabel,
            radioLabel('pick-one', 'Pick one (1)', true),
            radioLabel('pick-one-or-more', 'Pick many (N)', false),
        );
        const res = await ctx().callGenericPopup(form, ctx().POPUP_TYPE.CONFIRM, '', { okButton: 'Add group', cancelButton: 'Cancel' });
        if (res !== ctx().POPUP_RESULT.AFFIRMATIVE) return;
        const name = nameInput.value.trim();
        if (!name) return;
        const checked = /** @type {HTMLInputElement|null} */ (form.querySelector('input[name="pm-addgrp-card"]:checked'));
        const cardinality = checked?.value === 'pick-one-or-more' ? 'pick-one-or-more' : 'pick-one';
        await runInsertOp(v, { op: 'addGroup', name, cardinality, after: insertAnchor(v.id) });
    }

    /** Shared addSection/addBlock/addGroup runner: select + scroll to the new row. */
    async function runInsertOp(/** @type {PresetView} */ v, /** @type {any} */ op) {
        const id = v.id;
        try {
            const res = await bridge.edit(() => api('POST', `/presets/${id}/ops`, op));
            setDoc(id, res.doc);
            setSelection(id, res.result?.key ?? null);
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
            setSelection(id, newKey);
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
            setSelection(id, null);
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
                btn.title = a.note ?? (a.label.startsWith('Unmake') ? unmakeTitle : normalTitle);
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
            const label = l.kind === 'playstyle'
                ? `${l.name} ↳ ${doc.loadouts[l.parent]?.name ?? l.parent}`
                : `${l.name} (root)`;
            opt.textContent = label + (l.id === doc.activeLoadoutId ? ' (active)' : '');
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
        const sel = doc.loadouts?.[view.picker.value];
        const isPlay = sel?.kind === 'playstyle';
        view.parentSelect.hidden = !isPlay;
        if (isPlay) {
            view.parentSelect.replaceChildren(...loadouts.filter((/** @type {any} */ l) => l.kind !== 'playstyle').map((/** @type {any} */ l) => {
                const opt = document.createElement('option');
                opt.value = l.id;
                opt.textContent = l.name;
                return opt;
            }));
            view.parentSelect.value = sel.parent;
        }
        view.resetAllBtn.hidden = !isPlay;
        view.resetAllBtn.disabled = isPlay && Object.keys(sel.enabled ?? {}).length === 0;
    }

    /** Targeted refresh: picker, rank/edit bars, notes (if not dirty), outline+editor. */
    function refreshView() {
        if (!view) return;
        const doc = docs.get(view.id);
        if (!doc) return;
        refreshLoadoutBar(doc);
        let key = selected.get(view.id) ?? null;
        if (key?.startsWith('grp:') && !findGroupRow(doc, key)) {
            // the group row is gone (e.g. dissolved): clear the selection
            setSelection(view.id, null);
            key = null;
        }
        const onGroup = !!key?.startsWith('grp:');
        for (const b of view.rankButtons) b.disabled = !key || onGroup;
        updateHeadingButtons(view, doc, key);
        {
            const reason = makeGroupSelRefusal(view.id);
            view.makeGroupSelBtn.classList.toggle('pm-disabled', !!reason);
            view.makeGroupSelBtn.setAttribute('aria-disabled', reason ? 'true' : 'false');
            view.makeGroupSelBtn.title = reason || MAKE_GROUP_SEL_TITLE;
            const linkDoc = docs.get(view.id);
            const linkReason = linkDoc ? (linkSelectionOp(linkDoc, multi.get(view.id) ?? new Set()).refuse ?? '') : '';
            view.linkSelBtn.classList.toggle('pm-disabled', !!linkReason);
            view.linkSelBtn.setAttribute('aria-disabled', linkReason ? 'true' : 'false');
            view.linkSelBtn.title = linkReason || LINK_SEL_TITLE;
        }
        view.makeSectionBtn.disabled = onGroup;
        view.makeGroupBtn.disabled = onGroup;
        view.shelfSaveBtn.disabled = !key || onGroup;
        if (view.delArmedKey && view.delArmedKey !== key) disarmDelete();
        updateBlockActionButtons(view, doc, key);
        if (onGroup) {
            view.dupBtn.disabled = true;
            view.delBtn.disabled = true;
        }
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
            selectedKeys: multi.get(view.id),
            search: q ? { keys: new Set(matches), current: view.search.index >= 0 ? matches[view.search.index] : null, filter: view.search.filter } : undefined,
            loadoutId: view.picker.value,
        });
        view.editor.show(doc, key);
        applyHistoryButtons(view);
        void refreshHistory(view.id);
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
        const kind = v.kindSelect.value;
        const rootId = rootOf(docs.get(id), v.picker.value).id;
        const oldLids = new Set(Object.values(docs.get(id)?.loadouts ?? {}).map((/** @type {any} */ l) => l.id));
        try {
            const body = kind === 'playstyle' ? { name, kind, parent: rootId } : { name, kind, from: rootId };
            const res = await bridge.edit(() => api('POST', `/presets/${id}/loadouts`, body));
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

    /** Re-parent the selected playstyle onto the root chosen in the parent select. */
    async function reparentLoadout(/** @type {PresetView} */ v) {
        const id = v.id;
        const lid = v.picker.value;
        if (!lid) return;
        try {
            const res = await bridge.edit(() => api('PATCH', `/presets/${id}/loadouts/${lid}`, { parent: v.parentSelect.value }));
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
                v.deleteBtn.textContent = 'Delete loadout';
            }, 4000);
            return;
        }
        clearTimeout(v.deleteTimer);
        v.deleteArmed = false;
        v.deleteBtn.textContent = 'Delete loadout';
        try {
            const res = await bridge.edit(() => api('DELETE', `/presets/${id}/loadouts/${lid}`));
            setDoc(id, res.doc);
            setStatus('');
        } catch (/** @type {any} */ err) {
            setStatus(errText(err), true);
            const msg = document.createElement('p');
            msg.textContent = err?.body?.error ?? errText(err);
            void ctx().callGenericPopup(msg, ctx().POPUP_TYPE.TEXT);
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
            if (res.remoteSkipped?.length) {
                toast('warning', `Linked members not copied: ${res.remoteSkipped.join(', ')}`, 'Linked group');
                text += ` — ${res.remoteSkipped.length} linked member(s) not copied`;
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
