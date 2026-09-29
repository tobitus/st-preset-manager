/**
 * Shelf tab (Phase 6, roadmap item 10/13): a flat list of saved blocks —
 * rename, edit notes, delete. Blocks are saved to the shelf from the
 * Presets tab (select a block, "Save to shelf") and dropped back into any
 * open preset from that tab's right-hand shelf list (ext/tabs/shelf-panel.js).
 * This tab is just the shelf's own management view; it never mutates a
 * preset document.
 */
import { api } from '../st.js';
import { createEditGuard } from '../dirty.js';

/** @param {unknown} err @returns {string} */
function errText(err) {
    return /** @type {any} */ (err)?.body?.error ?? (err instanceof Error ? err.message : String(err));
}

/**
 * @param {HTMLElement} pane .pm-pane[data-pane="shelf"]
 * @param {import('../bridge.js').Bridge} bridge
 * @returns {{ refresh(): Promise<void>, destroy(): void }}
 */
export function createShelfTab(pane, bridge) {
    pane.innerHTML = `
        <div class="pm-shelf-tab">
            <div class="pm-shelf-status"></div>
            <div class="pm-shelf-tab-empty">The shelf is empty. In the Presets tab, select a block and press "Save to shelf".</div>
            <div class="pm-shelf-split">
                <ul class="pm-shelf-items"></ul>
                <div class="pm-shelf-detail">
                    <div class="pm-shelf-rename-row"><input class="pm-shelf-name text_pole" type="text"><button class="pm-shelf-rename menu_button">Rename</button></div>
                    <label>Notes (library only)</label>
                    <textarea class="pm-shelf-notes text_pole" rows="4"></textarea>
                    <button class="pm-shelf-notes-save menu_button">Save notes</button>
                    <div class="pm-shelf-meta"></div>
                    <pre class="pm-shelf-content"></pre>
                    <button class="pm-shelf-delete menu_button">Delete</button>
                </div>
            </div>
        </div>`;

    const statusEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-shelf-status'));
    const emptyEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-shelf-tab-empty'));
    const splitEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-shelf-split'));
    const itemsEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-shelf-items'));
    const nameInput = /** @type {HTMLInputElement} */ (pane.querySelector('.pm-shelf-name'));
    const renameBtn = /** @type {HTMLButtonElement} */ (pane.querySelector('.pm-shelf-rename'));
    const notesEl = /** @type {HTMLTextAreaElement} */ (pane.querySelector('.pm-shelf-notes'));
    const notesSaveBtn = /** @type {HTMLButtonElement} */ (pane.querySelector('.pm-shelf-notes-save'));
    const metaEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-shelf-meta'));
    const contentEl = /** @type {HTMLElement} */ (pane.querySelector('.pm-shelf-content'));
    const deleteBtn = /** @type {HTMLButtonElement} */ (pane.querySelector('.pm-shelf-delete'));

    /** @type {any[]} */
    let items = [];
    /** @type {string|null} */
    let selectedId = null;
    /** @type {Map<string, string>} */
    let names = new Map();
    const notesGuard = createEditGuard();
    /** @type {string|null} id of the shelf item the delete confirmation belongs to */
    let armedId = null;
    /** @type {any} */
    let deleteTimer = null;
    let refreshTimer = /** @type {any} */ (null);
    let gen = 0;

    function setStatus(/** @type {string} */ text, /** @type {boolean} */ isError = false) {
        statusEl.textContent = text;
        statusEl.classList.toggle('pm-error', isError);
    }

    function fromName(/** @type {any} */ item) {
        const pid = item?.savedFrom?.presetId;
        if (!pid) return 'saved directly';
        return `from ${names.get(pid) ?? pid}`;
    }

    function disarm() {
        clearTimeout(deleteTimer);
        deleteTimer = null;
        armedId = null;
        deleteBtn.textContent = 'Delete';
    }

    function render() {
        const hasItems = items.length > 0;
        emptyEl.hidden = hasItems;
        splitEl.hidden = !hasItems;
        itemsEl.innerHTML = '';
        for (const item of items) {
            const li = document.createElement('li');
            li.className = 'pm-shelf-item';
            li.dataset.shelfId = item.id;
            if (item.id === selectedId) li.classList.add('pm-selected');
            const nameSpan = document.createElement('span');
            nameSpan.className = 'pm-shelf-item-name';
            nameSpan.textContent = item.name;
            const fromSpan = document.createElement('span');
            fromSpan.className = 'pm-shelf-item-from';
            fromSpan.textContent = fromName(item);
            li.append(nameSpan, fromSpan);
            li.addEventListener('click', () => {
                selectedId = item.id;
                notesGuard.reset();
                disarm();
                render();
            });
            itemsEl.appendChild(li);
        }

        const selected = items.find((it) => it.id === selectedId) ?? null;
        if (selected) {
            nameInput.value = selected.name;
            if (!notesGuard.dirty) notesEl.value = selected.notes ?? '';
            metaEl.textContent = `${selected.role} · saved ${new Date(selected.savedAt).toLocaleString()} · ${fromName(selected)}`;
            contentEl.textContent = selected.content;
        } else {
            nameInput.value = '';
            if (!notesGuard.dirty) notesEl.value = '';
            metaEl.textContent = '';
            contentEl.textContent = '';
        }
    }

    async function refresh() {
        const myGen = ++gen;
        let shelf;
        let library = [];
        try {
            [shelf, library] = await Promise.all([
                api('GET', '/shelf'),
                api('GET', '/library').catch(() => []),
            ]);
        } catch (err) {
            if (myGen !== gen) return;
            setStatus(errText(err), true);
            return;
        }
        if (myGen !== gen) return;
        items = shelf;
        names = new Map(library.map((/** @type {any} */ p) => [p.id, p.name]));
        if (selectedId && !items.some((it) => it.id === selectedId)) selectedId = null;
        if (!selectedId && items.length) selectedId = items[0].id;
        setStatus('');
        render();
    }

    renameBtn.addEventListener('click', () => {
        void (async () => {
            if (!selectedId) return;
            const id = selectedId;
            const name = nameInput.value.trim();
            if (!name) { setStatus('Name is required', true); return; }
            try {
                await bridge.edit(() => api('PATCH', `/shelf/${id}`, { name }));
                setStatus('');
            } catch (err) {
                setStatus(errText(err), true);
            }
            await refresh();
        })();
    });

    notesEl.addEventListener('input', () => { notesGuard.edited(); });

    notesSaveBtn.addEventListener('click', () => {
        void (async () => {
            if (!selectedId) return;
            const id = selectedId;
            const notes = notesEl.value;
            const tok = notesGuard.token();
            try {
                await bridge.edit(() => api('PATCH', `/shelf/${id}`, { notes }));
                notesGuard.saved(tok);
                setStatus('');
            } catch (err) {
                setStatus(errText(err), true);
            }
            await refresh();
        })();
    });

    deleteBtn.addEventListener('click', () => {
        void (async () => {
            if (!selectedId) return;
            if (armedId === null || armedId !== selectedId) {
                armedId = selectedId;
                deleteBtn.textContent = 'Confirm delete';
                clearTimeout(deleteTimer);
                deleteTimer = setTimeout(() => { disarm(); }, 4000);
                return;
            }
            const id = armedId;
            disarm(); // before the await: a third click cannot send a second DELETE
            try {
                await bridge.edit(() => api('DELETE', `/shelf/${id}`));
                if (selectedId === id) selectedId = null;
                setStatus('');
            } catch (err) {
                setStatus(errText(err), true);
            }
            await refresh();
        })();
    });

    const unsubscribe = /** @type {() => void} */ (bridge.onUpdate((/** @type {any} */ s) => {
        if (s?.event?.kind !== 'shelf' || !pane.isConnected) return;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { void refresh(); }, 150);
    }));

    render();

    return {
        refresh,
        destroy() {
            unsubscribe();
            clearTimeout(refreshTimer);
            disarm();
        },
    };
}
