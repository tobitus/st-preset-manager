/**
 * Model panel (Phase 4, roadmap items 16/21): lets the user pick which
 * registry Model they are editing tuning for, edit that Model's global
 * tuning or a per-preset override, and edit the open loadout's per-Model
 * enabled overrides.
 *
 * State (`registry`, `slotModelId`) is fetched from the plugin on create and
 * refreshed on live updates (SSE `models`/`slot`/`hello` events, or a bridge
 * `s.model`/`s.slot` push), debounced 150 ms. `chosen` — the Model being
 * edited — survives across renders as long as it still exists in the
 * registry; it resets to the slot's resolved Model (or the first one) when
 * it doesn't.
 *
 * DOM contract: a fixed "empty" markup when the registry has no Models, else
 * a fixed "full" markup (head/tuning/override/status) built once and
 * updated in place, so a tuning `<input>` under active typing is never
 * clobbered by a refresh. Every write goes through `bridge.edit`; reads may
 * call `api` directly.
 */
import { api } from '../st.js';
import { iterLeaves } from '../../shared/groups.js';

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
                <label class="pm-tuning-override-label"><input type="checkbox" class="pm-tuning-override"> Override for this preset</label>
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
            tuningOverrideCb: q('.pm-tuning-override'),
            tuningInputs,
            tuningSrc,
            ovTitle: q('.pm-ov-title'),
            ovCreateBtn: q('.pm-ov-create'),
            ovDeleteBtn: q('.pm-ov-delete'),
            ovFilter: q('.pm-ov-filter'),
            ovList: q('.pm-ov-list'),
            statusEl: q('.pm-mp-status'),
        };
        refs.modelSelect.addEventListener('change', () => {
            chosen = refs.modelSelect.value;
            render();
        });
        refs.tuningOverrideCb.addEventListener('change', () => void onOverrideToggle());
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
            const [reg, slot] = await Promise.all([api('GET', '/models'), api('GET', '/slot')]);
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
        const g = registry.models[M]?.tuning ?? {};
        const ov = doc.tuningOverrides?.[M];
        const on = !!ov;
        refs.tuningOverrideCb.checked = on;
        for (const k of KEYS) {
            const input = refs.tuningInputs[k];
            /** @type {string} */
            let value;
            /** @type {string} */
            let placeholder;
            /** @type {string} */
            let src;
            if (on) {
                value = ov[k] ?? '';
                placeholder = String(g[k] ?? doc.settings?.[k] ?? '');
                src = k in ov ? 'override' : (k in g ? 'global' : '');
            } else {
                value = g[k] ?? '';
                placeholder = String(doc.settings?.[k] ?? '');
                src = k in g ? 'global' : '';
            }
            if (document.activeElement !== input) input.value = value === '' ? '' : String(value);
            input.placeholder = placeholder;
            refs.tuningSrc[k].textContent = src;
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
        renderOverrideList(doc);
    }

    function renderOverrideList(/** @type {any} */ doc) {
        const M = chosen;
        const lid = getLoadoutId();
        const lo = doc.loadouts?.[lid];
        const cur = lo?.overrides?.[/** @type {string} */ (M)]?.enabled;
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
            .map(({ id, name }) => buildOverrideRow(id, name, lo, cur));
        refs.ovList.replaceChildren(...rows);
    }

    function buildOverrideRow(/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ lo, /** @type {any} */ cur) {
        const row = document.createElement('div');
        row.className = 'pm-ov-row';
        row.dataset.identifier = id;
        const nameSpan = document.createElement('span');
        nameSpan.className = 'pm-ov-name';
        nameSpan.textContent = name;
        const baseSpan = document.createElement('span');
        baseSpan.className = 'pm-ov-base';
        baseSpan.textContent = `loadout: ${lo?.enabled?.[id] ? 'on' : 'off'}`;
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

    async function onTuningChange(/** @type {string} */ k) {
        const M = chosen;
        if (!M || !registry) return;
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
        const doc = getDoc();
        const ov = doc?.tuningOverrides?.[M];
        try {
            if (ov) {
                const body = { ...ov };
                if (v === undefined) delete body[k]; else body[k] = v;
                await bridge.edit(() => api('PUT', `/presets/${presetId}/tuning-overrides/${encodeURIComponent(M)}`, body));
            } else {
                const g = registry.models[M]?.tuning ?? {};
                const body = { ...g };
                if (v === undefined) delete body[k]; else body[k] = v;
                await bridge.edit(() => api('PUT', `/models/${encodeURIComponent(M)}/tuning`, body));
            }
            await afterWrite();
            setStatus('');
        } catch (err) {
            setStatus(errText(err), true);
        }
        render();
    }

    async function onOverrideToggle() {
        const M = chosen;
        if (!M) return;
        const checked = refs.tuningOverrideCb.checked;
        try {
            if (checked) {
                await bridge.edit(() => api('PUT', `/presets/${presetId}/tuning-overrides/${encodeURIComponent(M)}`, {}));
            } else {
                await bridge.edit(() => api('DELETE', `/presets/${presetId}/tuning-overrides/${encodeURIComponent(M)}`));
            }
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
        if (!M || !lid) return;
        const doc = getDoc();
        const lo = doc?.loadouts?.[lid];
        const cur = lo?.overrides?.[M]?.enabled ?? {};
        const next = { ...cur };
        if (value === 'inherit') delete next[id];
        else next[id] = value === 'on';
        try {
            await bridge.edit(() => api('PUT', `/presets/${presetId}/loadouts/${lid}/overrides/${encodeURIComponent(M)}`, { enabled: next }));
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
