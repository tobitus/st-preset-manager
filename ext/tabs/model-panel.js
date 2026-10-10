/**
 * Model panel (Phase 4, roadmap items 16/21): lets the user pick which
 * registry Model they are editing, edit that Model's named tunings (select,
 * create, rename, delete, set the default, edit values), pick a named tuning for
 * the open loadout's per-Model override, and edit that override's enabled
 * bits.
 *
 * State (`registry`, `slotModelId`) is fetched from the plugin on create and
 * refreshed on live updates (SSE `models`/`slot`/`hello` events, or a bridge
 * `s.model`/`s.slot` push), debounced 150 ms. `chosen` — the Model being
 * edited — survives across renders as long as it still exists in the
 * registry; it resets to the slot's resolved Model (or the first one) when
 * it doesn't. `tuningSel` — the named tuning being edited — resets to the
 * loadout's tuning in effect (else the Model's default) when it is unset or
 * no longer exists.
 *
 * DOM contract: a fixed "empty" markup when the registry has no Models, else
 * a fixed "full" markup (head/tuning/override/status) built once and
 * updated in place, so a tuning `<input>` under active typing is never
 * clobbered by a refresh. Every write goes through `bridge.edit`; reads may
 * call `api` directly.
 */
import { api, slotPath } from '../st.js';
import { iterLeaves } from '../../shared/groups.js';
import { effectiveEnabled, inheritResetKeys, tuningNameInEffect } from '../../shared/loadouts.js';

/** Tuning keys shown in this panel (a curated subset of shared/st-keys.js TUNING_KEYS). */
const KEYS = [
    'temperature',
    'top_p',
    'top_k',
    'min_p',
    'frequency_penalty',
    'presence_penalty',
    'repetition_penalty',
    'openai_max_tokens',
    'openai_max_context',
];

/**
 * @param {HTMLElement} el host element (the panel owns everything under it)
 * @param {{
 *   bridge: import('../bridge.js').Bridge,
 *   presetId: string,
 *   getDoc: () => any,
 *   setDoc: (doc: any) => void,
 *   getLoadoutId: () => string,
 * }} opts
 * @returns {{ render(): void, destroy(): void }}
 */
export function createModelPanel(el, opts) {
    const { bridge, presetId, getDoc, setDoc, getLoadoutId } = opts;

    /** @type {any} GET /models response, or null before the first fetch. */
    let registry = null;
    /** @type {string|null} the plugin-resolved Model name active in ST, or null. */
    let slotModelId = null;
    /** @type {string|null} the Model currently being edited. */
    let chosen = null;
    /** @type {string|null} the named tuning of `chosen` being edited; null = resolve on next render. */
    let tuningSel = null;
    let filterText = '';
    /** @type {any} */
    let fetchTimer = undefined;

    el.innerHTML = '<div class="pm-model-panel"></div>';
    const root = /** @type {HTMLElement} */ (el.querySelector('.pm-model-panel'));

    /** @type {'empty'|'full'|null} which skeleton is currently mounted */
    let mounted = null;
    /** @type {any} cached element refs for the 'full' skeleton, or null */
    let refs = null;

    /** @param {unknown} err @returns {string} */
    function errText(err) {
        return err instanceof Error ? err.message : String(err);
    }

    function setStatus(/** @type {string} */ text, /** @type {boolean} */ isError = false) {
        if (!refs) return;
        refs.statusEl.textContent = text;
        refs.statusEl.classList.toggle('pm-error', isError);
    }

    function mountEmpty() {
        if (mounted === 'empty') return;
        root.innerHTML = '<div class="pm-mp-empty">No Models yet: seed them in the Settings tab.</div>';
        mounted = 'empty';
        refs = null;
    }

    function mountFull() {
        if (mounted === 'full') return;
        root.innerHTML = `
            <div class="pm-mp-head">
                <label>Model</label>
                <select class="pm-mp-model text_pole" title="Model"></select>
                <span class="pm-mp-active"></span>
            </div>
            <div class="pm-tuning">
                <h5>Tuning</h5>
                <div class="pm-tuning-bar">
                    <select class="pm-tuning-name text_pole" title="Named tuning of this Model"></select>
                    <button class="pm-tuning-default menu_button" title="Use this tuning wherever no loadout override picks one">Set as default</button>
                    <button class="pm-tuning-delete menu_button" title="Delete this tuning">Delete tuning</button>
                    <input class="pm-tuning-new-name text_pole" type="text" placeholder="tuning name…">
                    <button class="pm-tuning-new menu_button" title="Create a tuning copied from the selected one">New tuning</button>
                    <button class="pm-tuning-rename menu_button" title="Rename the selected tuning to the name typed (loadout overrides that use it follow)">Rename tuning</button>
                </div>
                ${KEYS.map((k) => `
                <div class="pm-tuning-row" data-key="${k}">
                    <label>${k}</label>
                    <input type="number" step="any" class="pm-tuning-input text_pole" data-key="${k}">
                    <span class="pm-tuning-src"></span>
                </div>`).join('')}
            </div>
            <div class="pm-ov">
                <h5>Loadout override</h5>
                <span class="pm-ov-title"></span>
                <label class="pm-ov-tuning-label">Tuning <select class="pm-ov-tuning text_pole"></select></label>
                <button class="pm-ov-create menu_button">Create override</button>
                <button class="pm-ov-delete menu_button">Delete override</button>
                <input class="pm-ov-filter text_pole" placeholder="filter…">
                <div class="pm-ov-list"></div>
            </div>
            <div class="pm-mp-status"></div>`;
        const q = (/** @type {string} */ sel) => /** @type {any} */ (root.querySelector(sel));
        /** @type {{[k: string]: HTMLInputElement}} */
        const tuningInputs = {};
        /** @type {{[k: string]: HTMLElement}} */
        const tuningSrc = {};
        for (const k of KEYS) {
            const row = q(`.pm-tuning-row[data-key="${k}"]`);
            tuningInputs[k] = row.querySelector('.pm-tuning-input');
            tuningSrc[k] = row.querySelector('.pm-tuning-src');
        }
        refs = {
            modelSelect: q('.pm-mp-model'),
            activeSpan: q('.pm-mp-active'),
            tuningNameSelect: q('.pm-tuning-name'),
            tuningDefaultBtn: q('.pm-tuning-default'),
            tuningDeleteBtn: q('.pm-tuning-delete'),
            tuningNewName: q('.pm-tuning-new-name'),
            tuningNewBtn: q('.pm-tuning-new'),
            tuningRenameBtn: q('.pm-tuning-rename'),
            tuningInputs,
            tuningSrc,
            ovTitle: q('.pm-ov-title'),
            ovTuningSelect: q('.pm-ov-tuning'),
            ovCreateBtn: q('.pm-ov-create'),
            ovDeleteBtn: q('.pm-ov-delete'),
            ovFilter: q('.pm-ov-filter'),
            ovList: q('.pm-ov-list'),
            statusEl: q('.pm-mp-status'),
        };
        refs.modelSelect.addEventListener('change', () => {
            chosen = refs.modelSelect.value;
            tuningSel = null;
            render();
        });
        refs.tuningNameSelect.addEventListener('change', () => {
            tuningSel = refs.tuningNameSelect.value;
            render();
        });
        refs.tuningDefaultBtn.addEventListener('click', () => void onTuningDefault());
        refs.tuningDeleteBtn.addEventListener('click', () => void onTuningDelete());
        refs.tuningNewBtn.addEventListener('click', () => void onTuningNew());
        refs.tuningRenameBtn.addEventListener('click', () => void onTuningRename());
        refs.ovTuningSelect.addEventListener('change', () => void onOvTuningChange(refs.ovTuningSelect.value));
        for (const k of KEYS) {
            refs.tuningInputs[k].addEventListener('change', () => void onTuningChange(k));
        }
        refs.ovCreateBtn.addEventListener('click', () => void onOvCreate());
        refs.ovDeleteBtn.addEventListener('click', () => void onOvDelete());
        refs.ovFilter.addEventListener('input', () => {
            filterText = refs.ovFilter.value;
            const doc = getDoc();
            if (doc) renderOverrideList(doc);
        });
        mounted = 'full';
    }

    /** GET /models + GET /slot into `registry`/`slotModelId`. */
    async function fetchState() {
        try {
            const [reg, slot] = await Promise.all([api('GET', '/models'), api('GET', slotPath())]);
            registry = reg;
            slotModelId = slot?.desired?.modelId ?? null;
        } catch (err) {
            setStatus(errText(err), true);
        }
    }

    /** Re-GET the doc + registry/slot after a successful write. */
    async function afterWrite() {
        try {
            setDoc(await api('GET', `/presets/${presetId}`));
        } catch { /* keep the last known doc */ }
        await fetchState();
    }

    function render() {
        const modelNames = registry ? Object.keys(registry.models ?? {}) : [];
        if (modelNames.length === 0) {
            mountEmpty();
            return;
        }
        mountFull();
        if (!chosen || !modelNames.includes(chosen)) {
            chosen = (slotModelId && modelNames.includes(slotModelId)) ? slotModelId : modelNames[0];
        }
        renderHead(modelNames);
        const doc = getDoc();
        if (doc) {
            renderTuning(doc);
            renderOverride(doc);
        }
    }

    function renderHead(/** @type {string[]} */ modelNames) {
        refs.modelSelect.replaceChildren(...modelNames.map((name) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            return opt;
        }));
        refs.modelSelect.value = chosen;
        refs.activeSpan.textContent = chosen === slotModelId ? 'active in ST' : 'not active';
    }

    function renderTuning(/** @type {any} */ doc) {
        const M = /** @type {string} */ (chosen);
        const model = registry.models[M];
        if (tuningSel === null || !Object.prototype.hasOwnProperty.call(model.tunings, tuningSel)) {
            const inEffect = tuningNameInEffect(doc.loadouts?.[getLoadoutId()], model);
            tuningSel = (inEffect !== undefined && Object.prototype.hasOwnProperty.call(model.tunings, inEffect))
                ? inEffect
                : model.defaultTuning;
        }
        const sel = /** @type {string} */ (tuningSel);
        const tuning = model.tunings[sel] ?? {};
        refs.tuningNameSelect.replaceChildren(...Object.keys(model.tunings).map((name) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name === model.defaultTuning ? `${name} (default)` : name;
            return opt;
        }));
        refs.tuningNameSelect.value = sel;
        const isDefault = sel === model.defaultTuning;
        refs.tuningDefaultBtn.disabled = isDefault;
        refs.tuningDeleteBtn.disabled = isDefault;
        for (const k of KEYS) {
            const input = refs.tuningInputs[k];
            const value = tuning[k] ?? '';
            if (document.activeElement !== input) input.value = value === '' ? '' : String(value);
            input.placeholder = String(doc.settings?.[k] ?? '');
            refs.tuningSrc[k].textContent = k in tuning ? sel : '';
        }
    }

    function renderOverride(/** @type {any} */ doc) {
        const M = chosen;
        const lid = getLoadoutId();
        const lo = doc.loadouts?.[lid];
        refs.ovTitle.textContent = `${lo?.name ?? lid ?? ''} × ${M ?? ''}`;
        const exists = !!lo?.overrides?.[/** @type {string} */ (M)];
        refs.ovCreateBtn.hidden = exists;
        refs.ovDeleteBtn.hidden = !exists;
        const model = registry.models[/** @type {string} */ (M)];
        const opts = [{ value: '', text: `inherit (default: ${model.defaultTuning})` }]
            .concat(Object.keys(model.tunings).map((name) => ({ value: name, text: name })));
        refs.ovTuningSelect.replaceChildren(...opts.map(({ value, text }) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            return opt;
        }));
        refs.ovTuningSelect.value = lo?.overrides?.[/** @type {string} */ (M)]?.tuning ?? '';
        renderOverrideList(doc);
    }

    function renderOverrideList(/** @type {any} */ doc) {
        const M = chosen;
        const lid = getLoadoutId();
        const lo = doc.loadouts?.[lid];
        const cur = lo?.overrides?.[/** @type {string} */ (M)]?.enabled;
        const base = lo ? effectiveEnabled(doc, lid, null).enabled : {};
        const filter = filterText.trim().toLowerCase();
        const rows = iterLeaves(doc)
            .map((leaf) => {
                const id = leaf.ref ?? leaf.identifier;
                const name = leaf.kind === 'block' ? (doc.blocks?.[id]?.name || id) : id;
                return { id, name };
            })
            .filter(({ id, name }) => !filter
                || String(name).toLowerCase().includes(filter)
                || String(id).toLowerCase().includes(filter))
            .map(({ id, name }) => buildOverrideRow(id, name, base, cur));
        refs.ovList.replaceChildren(...rows);
    }

    function buildOverrideRow(/** @type {string} */ id, /** @type {string} */ name, /** @type {{[id: string]: boolean}} */ base, /** @type {any} */ cur) {
        const row = document.createElement('div');
        row.className = 'pm-ov-row';
        row.dataset.identifier = id;
        const nameSpan = document.createElement('span');
        nameSpan.className = 'pm-ov-name';
        nameSpan.textContent = name;
        const baseSpan = document.createElement('span');
        baseSpan.className = 'pm-ov-base';
        baseSpan.textContent = `loadout: ${base[id] ? 'on' : 'off'}`;
        const select = /** @type {HTMLSelectElement} */ (document.createElement('select'));
        select.className = 'pm-ov-state';
        for (const value of ['inherit', 'on', 'off']) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = value;
            select.append(opt);
        }
        const has = !!cur && Object.prototype.hasOwnProperty.call(cur, id);
        select.value = has ? (cur[id] ? 'on' : 'off') : 'inherit';
        select.addEventListener('change', () => void onOvStateChange(id, select.value));
        row.append(nameSpan, baseSpan, select);
        return row;
    }

    /** Run one tuning write against the selected Model, then refresh. */
    async function tuningWrite(/** @type {() => Promise<any>} */ write) {
        try {
            await bridge.edit(write);
            await afterWrite();
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
        }
        render();
    }

    async function onTuningChange(/** @type {string} */ k) {
        const M = chosen;
        if (!M || !registry || !tuningSel) return;
        const input = refs.tuningInputs[k];
        const raw = input.value;
        /** @type {number|undefined} */
        let v;
        if (raw === '') {
            v = undefined;
        } else {
            v = Number(raw);
            if (!Number.isFinite(v)) {
                setStatus(`"${k}" must be a number`, true);
                render();
                return;
            }
        }
        const body = v === undefined ? { unset: [k] } : { set: { [k]: v } };
        const name = tuningSel;
        await tuningWrite(() => api('PATCH', `/models/${encodeURIComponent(M)}/tunings/${encodeURIComponent(name)}`, body));
    }

    async function onTuningNew() {
        const M = chosen;
        if (!M || !registry || !tuningSel) return;
        const model = registry.models[M];
        const name = refs.tuningNewName.value.trim();
        if (name === '') {
            setStatus('Tuning name is required', true);
            return;
        }
        if (Object.prototype.hasOwnProperty.call(model.tunings, name)) {
            setStatus(`tuning "${name}" already exists`, true);
            return;
        }
        try {
            await bridge.edit(() => api('PUT', `/models/${encodeURIComponent(M)}/tunings/${encodeURIComponent(name)}`, { ...model.tunings[tuningSel] }));
            refs.tuningNewName.value = '';
            await afterWrite();
            // only now: a render in between (SSE refresh) with the old
            // registry would reset a name it does not list yet
            tuningSel = name;
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
        }
        render();
    }

    async function onTuningRename() {
        const M = chosen;
        const from = tuningSel;
        if (!M || !registry || !from) return;
        const to = refs.tuningNewName.value.trim();
        if (to === '') {
            setStatus('Tuning name is required', true);
            return;
        }
        if (to === from) return;
        if (Object.prototype.hasOwnProperty.call(registry.models[M].tunings, to)) {
            setStatus(`tuning "${to}" already exists`, true);
            return;
        }
        try {
            await bridge.edit(() => api('POST', `/models/${encodeURIComponent(M)}/tunings/rename`, { from, to }));
            refs.tuningNewName.value = '';
            await afterWrite();
            // only now: a render in between (SSE refresh) with the old
            // registry would reset a name it does not list yet
            tuningSel = to;
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
        }
        render();
    }

    async function onTuningDefault() {
        const M = chosen;
        const name = tuningSel;
        if (!M || !name) return;
        await tuningWrite(() => api('PUT', `/models/${encodeURIComponent(M)}/default-tuning`, { name }));
    }

    async function onTuningDelete() {
        const M = chosen;
        const name = tuningSel;
        if (!M || !name) return;
        try {
            await bridge.edit(() => api('DELETE', `/models/${encodeURIComponent(M)}/tunings/${encodeURIComponent(name)}`));
            tuningSel = null;
            await afterWrite();
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
        }
        render();
    }

    async function onOvCreate() {
        const M = chosen;
        const lid = getLoadoutId();
        if (!M || !lid) return;
        try {
            await bridge.edit(() => api('PUT', `/presets/${presetId}/loadouts/${lid}/overrides/${encodeURIComponent(M)}`, { enabled: {} }));
            await afterWrite();
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
        }
        render();
    }

    async function onOvDelete() {
        const M = chosen;
        const lid = getLoadoutId();
        if (!M || !lid) return;
        try {
            await bridge.edit(() => api('DELETE', `/presets/${presetId}/loadouts/${lid}/overrides/${encodeURIComponent(M)}`));
            await afterWrite();
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
        }
        render();
    }

    async function onOvStateChange(/** @type {string} */ id, /** @type {string} */ value) {
        const M = chosen;
        const lid = getLoadoutId();
        const doc = getDoc();
        if (!M || !lid || !doc) return;
        const body = value === 'inherit' ? { unset: inheritResetKeys(doc, id) } : { set: { [id]: value === 'on' } };
        const url = `/presets/${presetId}/loadouts/${lid}/overrides/${encodeURIComponent(M)}`;
        // no override for this loadout x Model yet: the first choice creates
        // it (PUT); an existing one takes a per-identifier PATCH
        const exists = doc.loadouts?.[lid]?.overrides?.[M] !== undefined;
        try {
            if (exists) await bridge.edit(() => api('PATCH', url, body));
            else if (value !== 'inherit') await bridge.edit(() => api('PUT', url, { enabled: { [id]: value === 'on' } }));
            await afterWrite();
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
        }
        render();
    }

    async function onOvTuningChange(/** @type {string} */ value) {
        const M = chosen;
        const lid = getLoadoutId();
        if (!M || !lid) return;
        const tuning = value === '' ? null : value;
        const url = `/presets/${presetId}/loadouts/${lid}/overrides/${encodeURIComponent(M)}`;
        const exists = getDoc()?.loadouts?.[lid]?.overrides?.[M] !== undefined;
        try {
            if (exists) await bridge.edit(() => api('PATCH', url, { tuning }));
            else if (tuning !== null) await bridge.edit(() => api('PUT', url, { enabled: {}, tuning }));
            await afterWrite();
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
        }
        render();
    }

    function scheduleFetch() {
        if (!el.isConnected) return;
        clearTimeout(fetchTimer);
        fetchTimer = setTimeout(() => {
            if (!el.isConnected) return;
            void (async () => {
                await fetchState();
                render();
            })();
        }, 150);
    }

    const unsubscribe = /** @type {() => void} */ (bridge.onUpdate((/** @type {any} */ s) => {
        if (!el.isConnected) return;
        const kind = s?.event?.kind;
        if (s?.model || s?.slot || kind === 'models' || kind === 'slot' || kind === 'hello') {
            scheduleFetch();
        }
    }));

    void (async () => {
        await fetchState();
        render();
    })();

    return {
        render,
        destroy() {
            unsubscribe();
            clearTimeout(fetchTimer);
        },
    };
}
