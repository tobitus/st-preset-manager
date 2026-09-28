/**
 * Import/Export tab (Phase 3): import ST presets or native library documents
 * by file picker, drag-drop, or straight from ST's own preset list; export
 * a library preset as ST JSON (compiled, lossless of nothing but the
 * library-only fields) or as a native library document.
 */
import { api, listStPresets } from '../st.js';
import { importBodyFromFile, exportFileName } from '../../shared/io.js';

/** Count `kind==='group'` rows anywhere in a doc's sequences, recursing into sections. */
function countGroups(/** @type {any} */ doc) {
    let n = 0;
    const walk = (/** @type {any[]} */ rows) => {
        for (const row of rows ?? []) {
            if (row.kind === 'group') n++;
            else if (row.kind === 'section') walk(row.rows);
        }
    };
    for (const seq of doc?.sequences ?? []) walk(seq.rows);
    return n;
}

/**
 * @param {HTMLElement} pane .pm-pane[data-pane="io"]
 * @param {import('../bridge.js').Bridge} bridge
 * @param {{ onOpen: (presetId: string) => void, onLibraryChanged: () => void }} callbacks
 * @returns {{ refresh(): Promise<void>, destroy(): void }}
 */
export function createIoTab(pane, bridge, { onOpen, onLibraryChanged }) {
    pane.innerHTML = `
        <div class="pm-io">
            <div class="pm-io-import">
                <h4>Import</h4>
                <div class="pm-io-drop">
                    <button type="button" class="pm-io-pick menu_button">Choose files…</button>
                    <div>Drop ST preset or library .json files here</div>
                </div>
                <input type="file" class="pm-io-file" accept=".json,application/json" multiple hidden>
                <label class="pm-io-replace-label"><input type="checkbox" class="pm-io-replace"> Replace a preset with the same name</label>
                <div class="pm-io-st-row">
                    <select class="pm-io-st-list"></select>
                    <button type="button" class="pm-io-st-import menu_button">Import from ST</button>
                </div>
                <div class="pm-io-log"></div>
            </div>
            <div class="pm-io-export">
                <h4>Export</h4>
                <div class="pm-io-export-row">
                    <select class="pm-io-export-preset"></select>
                    <select class="pm-io-format">
                        <option value="st">ST preset JSON (groups/notes stripped)</option>
                        <option value="native">Library document (lossless)</option>
                    </select>
                    <button type="button" class="pm-io-export-go menu_button">Export</button>
                </div>
                <span class="pm-io-export-status"></span>
            </div>
        </div>`;

    const pickBtn = /** @type {HTMLButtonElement} */ (pane.querySelector('.pm-io-pick'));

    const fileInput = /** @type {HTMLInputElement} */ (pane.querySelector('.pm-io-file'));
    const dropZone = /** @type {HTMLElement} */ (pane.querySelector('.pm-io-drop'));
    const replaceBox = /** @type {HTMLInputElement} */ (pane.querySelector('.pm-io-replace'));
    const stList = /** @type {HTMLSelectElement} */ (pane.querySelector('.pm-io-st-list'));
    const stImportBtn = /** @type {HTMLButtonElement} */ (pane.querySelector('.pm-io-st-import'));
    const log = /** @type {HTMLElement} */ (pane.querySelector('.pm-io-log'));
    const exportPreset = /** @type {HTMLSelectElement} */ (pane.querySelector('.pm-io-export-preset'));
    const formatSelect = /** @type {HTMLSelectElement} */ (pane.querySelector('.pm-io-format'));
    const exportBtn = /** @type {HTMLButtonElement} */ (pane.querySelector('.pm-io-export-go'));
    const exportStatus = /** @type {HTMLElement} */ (pane.querySelector('.pm-io-export-status'));

    /** @param {unknown} err @returns {string} */
    function errText(err) {
        return /** @type {any} */ (err)?.body?.error ?? (err instanceof Error ? err.message : String(err));
    }

    /**
     * Prepend one result row to the log.
     * @param {{ ok: boolean, name: string, text: string, presetId?: string, httpStatus?: number }} result
     */
    function logResult({ ok, name, text, presetId, httpStatus }) {
        const row = document.createElement('div');
        row.className = 'pm-io-result' + (ok ? '' : ' pm-error');
        row.dataset.status = ok ? 'ok' : 'error';
        row.dataset.name = name;
        if (httpStatus !== undefined) row.dataset.httpStatus = String(httpStatus);
        const span = document.createElement('span');
        span.textContent = text;
        row.append(span);
        if (ok) {
            row.dataset.presetId = presetId;
            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.className = 'pm-io-open menu_button';
            openBtn.textContent = 'Open';
            openBtn.addEventListener('click', () => onOpen(presetId));
            row.append(openBtn);
        }
        log.insertBefore(row, log.firstChild);
    }

    /** POST a preset body, log the outcome, return whether it succeeded. */
    async function postPreset(/** @type {any} */ body, /** @type {string} */ fallbackName) {
        const name = body.st ? body.name : (body.native?.name ?? fallbackName);
        try {
            const doc = await api('POST', '/presets', body);
            logResult({
                ok: true,
                name,
                presetId: doc.id,
                text: `Imported "${doc.name}" — recognizer ${doc.source?.recognizer?.kind ?? 'native'}, ${countGroups(doc)} groups`,
            });
            return true;
        } catch (err) {
            logResult({ ok: false, name, text: errText(err), httpStatus: /** @type {any} */ (err)?.status });
            return false;
        }
    }

    async function importFiles(/** @type {FileList|File[]} */ files) {
        const replace = replaceBox.checked;
        let any = false;
        for (const file of Array.from(files)) {
            const text = await file.text();
            const { body, error } = importBodyFromFile(file.name, text, { replace });
            if (error) {
                logResult({ ok: false, name: file.name.replace(/\.[^/.]+$/, ''), text: error });
                continue;
            }
            if (await postPreset(body, file.name.replace(/\.[^/.]+$/, ''))) any = true;
        }
        if (any) {
            onLibraryChanged();
            await refreshExportList();
        }
    }

    fileInput.addEventListener('change', () => {
        if (fileInput.files?.length) void importFiles(fileInput.files);
        fileInput.value = '';
    });
    pickBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fileInput.click();
    });
    dropZone.addEventListener('click', () => fileInput.click());

    // stopPropagation: ST binds its own drag-and-drop import on document.body
    // (public/scripts/dragdrop.js) and would also try the dropped preset as a
    // character ("Could not import character" toast)
    for (const ev of ['dragenter', 'dragover']) {
        dropZone.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('pm-drag-over');
        });
    }
    for (const ev of ['dragleave', 'drop']) {
        dropZone.addEventListener(ev, () => dropZone.classList.remove('pm-drag-over'));
    }
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const files = e.dataTransfer?.files;
        if (files?.length) void importFiles(files);
    });

    stImportBtn.addEventListener('click', () => {
        const name = stList.value;
        if (!name) return;
        const entry = listStPresets().find((p) => p.name === name);
        if (!entry) return;
        const replace = replaceBox.checked;
        const body = { st: structuredClone(entry.preset), name, sourceRef: `st:${name}`, ...(replace ? { replace: true } : {}) };
        void (async () => {
            if (await postPreset(body, name)) {
                onLibraryChanged();
                await refreshExportList();
            }
        })();
    });

    function refreshStList() {
        const current = stList.value;
        stList.replaceChildren(...listStPresets().map(({ name }) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            return opt;
        }));
        if (Array.from(stList.options).some((o) => o.value === current)) stList.value = current;
    }

    async function refreshExportList() {
        const current = exportPreset.value;
        const [items, slot] = await Promise.all([
            api('GET', '/library'),
            api('GET', '/slot'),
        ]);
        exportPreset.replaceChildren(...items.map((/** @type {any} */ item) => {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.name;
            return opt;
        }));
        const options = Array.from(exportPreset.options);
        if (options.some((o) => o.value === current)) {
            exportPreset.value = current;
        } else if (slot.desired?.presetId && options.some((o) => o.value === slot.desired.presetId)) {
            exportPreset.value = slot.desired.presetId;
        } else if (options[0]) {
            exportPreset.value = options[0].value;
        }
    }

    exportBtn.addEventListener('click', () => {
        void (async () => {
            const id = exportPreset.value;
            const fmt = /** @type {'st'|'native'} */ (formatSelect.value);
            if (!id) return;
            try {
                const data = await api('GET', `/presets/${id}/export?format=${fmt}`);
                const text = JSON.stringify(data, null, 4);
                const selected = exportPreset.selectedOptions[0];
                const fileName = exportFileName(selected?.textContent ?? id, fmt);
                const blob = new Blob([text], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 0);
                exportStatus.classList.remove('pm-error');
                exportStatus.textContent = `Exported ${fileName} (${text.length} chars)`;
                exportStatus.dataset.file = fileName;
            } catch (err) {
                exportStatus.classList.add('pm-error');
                exportStatus.textContent = errText(err);
                delete exportStatus.dataset.file;
            }
        })();
    });

    async function refresh() {
        try {
            refreshStList();
            await refreshExportList();
        } catch (err) {
            logResult({ ok: false, name: '', text: errText(err) });
        }
    }

    return {
        refresh,
        destroy() { /* no listeners outside pane */ },
    };
}
