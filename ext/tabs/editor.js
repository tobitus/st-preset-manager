/**
 * Right-hand editor pane (contract §Editor): renders the row selected in the
 * outline into the `.pm-editor` container.
 *
 * - nothing selected / unknown key → `.pm-editor-empty` message
 * - marker / ghost leaf → `.pm-editor-readonly` message (fixed ST slot resp.
 *   order-only entry)
 * - block leaf → the block's name, role, content and never-sent notes, each
 *   with its own save button (`editBlock` / `setBlockNotes` ops).
 *
 * Refresh policy: `show` with a NEW key re-renders from scratch; with the
 * SAME key (the usual SSE-driven path) it only refreshes the parts the user
 * has not typed into since the last render/save (`dirtyContent` guards
 * name/role/content, `dirtyNotes` guards notes), so a re-render never eats
 * typing. A dirty flag is cleared on a fresh render, and after a save that
 * saw no newer typing while it was in flight (revision counters); a rejected
 * save keeps it set. All user text goes through
 * `.value` / `textContent` — never innerHTML.
 */
import { findLeaf } from '../outline-model.js';

/**
 * @param {HTMLElement} container the `.pm-editor` element
 * @param {{ onOps(ops: any[]): Promise<void> }} handlers
 * @returns {{ show(doc: any, key: string|null): void }}
 */
export function createEditor(container, handlers) {
    /** @type {string|null|undefined} */
    let shownKey;
    let rendered = false;
    /** @type {'empty'|'readonly'|'block'} */
    let mode = 'empty';
    let dirtyContent = false;
    let dirtyNotes = false;
    let contentRev = 0;
    let notesRev = 0;
    let renderSeq = 0;
    /** @type {{ identifier: string, name: any, role: any, content: any, notes: any }|null} */
    let blockView = null;

    /**
     * Small DOM helper: everything user-controlled is set via textContent.
     * @param {string} tag
     * @param {string} cls
     * @param {string} [text]
     * @returns {any} the element (typed `any` so narrow DOM props typecheck)
     */
    function el(tag, cls, text) {
        const node = /** @type {any} */ (document.createElement(tag));
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function markContentDirty() {
        dirtyContent = true;
        contentRev++;
    }

    function markNotesDirty() {
        dirtyNotes = true;
        notesRev++;
    }

    function renderEmpty() {
        renderSeq++;
        mode = 'empty';
        blockView = null;
        dirtyContent = false;
        dirtyNotes = false;
        container.replaceChildren(el('div', 'pm-editor-empty', 'Select a row to edit its content and notes.'));
    }

    function renderReadonly(text) {
        renderSeq++;
        mode = 'readonly';
        blockView = null;
        dirtyContent = false;
        dirtyNotes = false;
        container.replaceChildren(el('div', 'pm-editor-readonly', text));
    }

    /** @param {string} identifier */
    function markerText(identifier) {
        return `ST marker — fixed slot, content comes from ST (${identifier})`;
    }

    /**
     * @param {string} identifier
     * @param {any} block may be null when the doc has no record yet
     */
    function renderBlock(identifier, block) {
        renderSeq++;
        const header = el('div', 'pm-block-identifier pm-muted', identifier);

        const name = el('input', 'pm-block-name text_pole');
        name.type = 'text';
        name.value = block?.name ?? '';

        const role = el('select', 'pm-block-role text_pole');
        for (const r of ['system', 'user', 'assistant']) {
            const opt = el('option', '', r);
            opt.value = r;
            opt.selected = r === (block?.role ?? 'system');
            role.append(opt);
        }

        const contentLabel = el('label', 'pm-field-label', 'Content');
        const content = el('textarea', 'pm-block-content text_pole');
        content.rows = 14;
        content.value = block?.content ?? '';

        const saveBtn = el('button', 'pm-block-save menu_button', 'Save block');

        const notesLabel = el('label', 'pm-field-label', 'Notes (never sent to the model)');
        const notes = el('textarea', 'pm-block-notes text_pole');
        notes.rows = 4;
        notes.value = block?.notes ?? '';

        const notesBtn = el('button', 'pm-block-notes-save menu_button', 'Save notes');

        for (const node of [name, role, content]) {
            node.addEventListener('input', markContentDirty);
            node.addEventListener('change', markContentDirty);
        }
        notes.addEventListener('input', markNotesDirty);
        notes.addEventListener('change', markNotesDirty);

        saveBtn.addEventListener('click', () => {
            saveBtn.disabled = true;
            const seq = renderSeq, rev = contentRev;
            void (async () => {
                await handlers.onOps([{ op: 'editBlock', identifier, name: name.value, role: role.value, content: content.value }]);
                if (renderSeq === seq && contentRev === rev) dirtyContent = false;
            })().catch(() => {
                // rejected save keeps dirtyContent: a refresh must not eat the user's text
            }).finally(() => {
                saveBtn.disabled = false;
            });
        });

        notesBtn.addEventListener('click', () => {
            notesBtn.disabled = true;
            const seq = renderSeq, rev = notesRev;
            void (async () => {
                await handlers.onOps([{ op: 'setBlockNotes', identifier, notes: notes.value }]);
                if (renderSeq === seq && notesRev === rev) dirtyNotes = false;
            })().catch(() => {
                // rejected save keeps dirtyNotes
            }).finally(() => {
                notesBtn.disabled = false;
            });
        });

        mode = 'block';
        blockView = { identifier, name, role, content, notes };
        dirtyContent = false;
        dirtyNotes = false;
        container.replaceChildren(header, name, role, contentLabel, content, saveBtn, notesLabel, notes, notesBtn);
    }

    /**
     * @param {any} doc
     * @param {string|null} key
     */
    function show(doc, key) {
        const found = key === null ? null : findLeaf(doc, key);
        if (!rendered || key !== shownKey) {
            shownKey = key;
            rendered = true;
            if (!found) {
                renderEmpty();
                return;
            }
            const kind = found.leaf?.kind;
            if (kind === 'marker') {
                renderReadonly(markerText(found.identifier));
            } else if (kind === 'ghost') {
                renderReadonly('order-only entry — no content');
            } else {
                renderBlock(found.identifier, found.block);
            }
            return;
        }
        // same key: refresh in place, never clobbering a dirty part
        if (!found) {
            renderEmpty();
            return;
        }
        const kind = found.leaf?.kind;
        if (kind === 'marker' || kind === 'ghost') {
            if (mode !== 'readonly') {
                renderReadonly(kind === 'marker' ? markerText(found.identifier) : 'order-only entry — no content');
            }
            return;
        }
        const block = found.block;
        if (mode !== 'block' || blockView?.identifier !== found.identifier) {
            renderBlock(found.identifier, block);
            return;
        }
        if (!dirtyContent) {
            blockView.name.value = block?.name ?? '';
            blockView.role.value = block?.role ?? 'system';
            blockView.content.value = block?.content ?? '';
        }
        if (!dirtyNotes) {
            blockView.notes.value = block?.notes ?? '';
        }
    }

    return { show };
}
