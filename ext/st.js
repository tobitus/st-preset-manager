/**
 * ST access layer. The only module that touches SillyTavern internals;
 * everything else in the extension goes through this (PLAN §1.1).
 */

/** @returns {any} SillyTavern.getContext() */
export function ctx() {
    return /** @type {any} */ (globalThis).SillyTavern.getContext();
}

export const SLOT_NAME = '⟨PM⟩ working';
export const PLUGIN_BASE = '/api/plugins/st-preset-manager';

/** @returns {string} stable per-tab client id (session) */
export function clientId() {
    const win = /** @type {any} */ (window);
    win.__pmClientId = win.__pmClientId ?? `tab-${Math.random().toString(36).slice(2, 10)}`;
    return win.__pmClientId;
}

/** GET /csrf-token once, reuse cookie + token for every non-GET. */
let /** @type {string|null} */ csrfToken = null;

/** @returns {Promise<string>} */
export async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    const res = await fetch('/csrf-token', { credentials: 'include' });
    const data = await res.json();
    csrfToken = data.token;
    return /** @type {string} */ (csrfToken);
}

/**
 * Plugin API call with cookie + CSRF header.
 * @param {string} method
 * @param {string} path
 * @param {any} [body]
 */
export async function api(method, path, body = undefined) {
    /** @type {RequestInit} */
    const init = {
        method,
        credentials: 'include',
        headers: {},
    };
    if (method !== 'GET') {
        init.headers = {
            'Content-Type': 'application/json',
            'x-csrf-token': await getCsrfToken(),
        };
        init.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(`${PLUGIN_BASE}${path}`, init);
    if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch { detail = res.statusText; }
        throw new Error(`${method} ${path} -> ${res.status}: ${detail}`);
    }
    return res.json();
}

/** @returns {Promise<boolean>} plugin reachable? */
export async function pluginHealth() {
    try {
        const res = await fetch(`${PLUGIN_BASE}/health`, { credentials: 'include' });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Apply a compiled preset into ST's working slot through ST's own path.
 * @param {any} compiled full ST preset body
 * @returns {Promise<string>} canonical slot name as ST returned it
 */
export async function applyCompiledToSlot(compiled) {
    const pm = ctx().getPresetManager('openai');
    await pm.savePreset(SLOT_NAME, compiled);
    // savePreset POSTs /api/presets/save and updateList() selects it;
    // onSettingsPresetChange runs via the select's change event. Await the
    // application promise so callers can measure settled state.
    const openai = await /** @type {any} */ (globalThis).import('/scripts/openai.js');
    await openai.getPresetApplicationPromise();
    // ST sanitizes the name for the filesystem; use what it reports back.
    return ctx().chatCompletionSettings.preset_settings_openai ?? SLOT_NAME;
}

/**
 * Snapshot the current ST panel state (minus connection keys — the plugin
 * strips again, but avoid shipping secrets).
 * @returns {any}
 */
export function snapshotPanel() {
    const full = ctx().getChatCompletionPreset
        ? ctx().getChatCompletionPreset(ctx().chatCompletionSettings)
        : null;
    if (!full) return null;
    const out = { ...full };
    delete out.proxy_password;
    delete out.reverse_proxy;
    delete out.custom_url;
    return out;
}

/** @returns {string} current preset name selected in ST */
export function currentPresetName() {
    return ctx().chatCompletionSettings.preset_settings_openai ?? '';
}
