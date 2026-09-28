/**
 * ST access layer. The only module that touches SillyTavern internals;
 * everything else in the extension goes through this (PLAN §1.1).
 *
 * `../../../../openai.js` is ST's own public/scripts/openai.js: this file is
 * served at public/scripts/extensions/third-party/st-preset-manager/ext/st.js
 * (regular user extensions get the same /scripts/extensions/third-party/<name>
 * URL, src/endpoints/extensions.js:1219), so four levels up land on
 * public/scripts/. This is how third-party extensions import ST modules.
 * The plugin mount (plugins/st-preset-manager) never loads browser code.
 */
import { getPresetApplicationPromise, getChatCompletionPreset } from '../../../../openai.js';

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
 * @param {{ signal?: AbortSignal }} [opts] caller abort signal, merged with
 *   the deadline below (whichever fires first aborts the request)
 */
export async function api(method, path, body = undefined, opts = undefined) {
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
    // LIVENESS BOUND (15 s): every plugin request is bounded, so a request
    // that never settles (dead socket, plugin wedged) cannot hold a bridge
    // op open — reconcileOp holds the full-screen apply overlay across
    // flush -> GET -> apply, and an unbounded fetch would keep input blocked
    // indefinitely. With the deadline the op rejects, reconcileOp's finally
    // unmounts the overlay and the queue stays alive for a retry.
    const deadline = AbortSignal.timeout(15000);
    init.signal = opts?.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
    const res = await fetch(`${PLUGIN_BASE}${path}`, init);
    if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch { detail = res.statusText; }
        const err = /** @type {Error & {status?: number}} */ (new Error(`${method} ${path} -> ${res.status}: ${detail}`));
        // structured status: the bridge branches on 409 (stale panel base)
        err.status = res.status;
        throw err;
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
    // LIVENESS BOUND (15 s): savePreset() returns a promise ST resolves via
    // its own save/list-refresh chain — in a wedged tab it never settles,
    // and reconcileOp holds the apply overlay (input blocked) until this
    // function settles. The deadline turns a hung save into a rejection:
    // the op rejects, reconcileOp's finally unmounts the overlay, the queue
    // stays alive and the next reconcile retries the apply.
    await Promise.race([
        pm.savePreset(SLOT_NAME, compiled),
        new Promise((/** @type {(v: never) => void} */ resolve, reject) => {
            const t = setTimeout(() => reject(new Error('applyCompiledToSlot: pm.savePreset did not settle within 15s — the overlay must not be held open past this')), 15000);
            t.unref?.();
        }),
    ]);
    // savePreset POSTs /api/presets/save and updateList() selects it;
    // onSettingsPresetChange runs via the select's change event. ST exports
    // getPresetApplicationPromise from openai.js:5015 covering the listener
    // aftermath — but its chain ends in PRESET_CHANGED listeners we do not
    // control, and in some environments it never settles, wedging any caller
    // that awaits it. So it is only a bounded optimisation here (a path
    // where it settles fast skips the poll); correctness comes from
    // OBSERVING ST's state below.
    await Promise.race([
        getPresetApplicationPromise().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 200)),
    ]);
    // Poll until ST's own state shows the FULL compiled projection — the
    // complete panel projection: prompts (all fields), prompt_order (order
    // and enabled bits) and every sampler / other preset setting — not just
    // the slot name and the prompt structure. A content-only or sampler-only
    // apply left the old partial predicate true while ST still exposed the
    // old values, so the bridge recorded a half-applied baseline and could
    // later mistake the real apply for a panel edit. Must not silently
    // proceed: callers rely on apply meaning "the panel now shows the
    // compiled preset"; a false success would make the next panel op diff
    // user edits against the wrong baseline. The bounded ST-promise await
    // above is only a fast path; this observation is the correctness check.
    const deadline = performance.now() + 5000;
    for (;;) {
        const shown = await snapshotPanel();
        if (shown && showsCompiled(shown, compiled)) break;
        if (performance.now() > deadline) {
            const name = currentPresetName();
            const mismatches = shown
                ? Object.keys(compiled).filter((key) => !canonEq(shown[key], compiled[key])).slice(0, 5)
                : ['(snapshotPanel returned null)'];
            throw new Error(`applyCompiledToSlot: ST did not show ${JSON.stringify(SLOT_NAME)} with the full compiled projection within 5s${name !== SLOT_NAME ? ` (preset is ${JSON.stringify(name)}, not the slot)` : ''}; mismatched keys: ${mismatches.join(', ')}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // ST sanitizes the name for the filesystem; use what it reports back.
    return ctx().chatCompletionSettings.preset_settings_openai ?? SLOT_NAME;
}

/** @param {any} a @param {any} b deep structural equality via canonical JSON */
function canonEq(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Does the panel projection ST currently shows match `compiled`? Compares
 * the complete projection — prompts (all fields), prompt_order (order +
 * enabled bits) and every other preset setting (samplers etc.) — because a
 * partial predicate (name + identifier list + order) accepted an apply half
 * way through and mis-baselined the bridge.
 *
 * Key-set note: the compiled body carries exactly the keys ST presets carry
 * (all of getChatCompletionPreset's settingsToUpdate keys minus connection
 * keys — shared/compile.js strips CONNECTION_KEYS and preset_settings_openai,
 * and preset_settings_openai is not a settingsToUpdate key, so it never
 * appears in a compiled body). A snapshot from snapshotPanel() therefore has
 * no extra non-connection keys to compare; the loop below observes every
 * compiled key on the live panel.
 * @param {any} shown snapshotPanel() output
 * @param {any} compiled full compiled ST preset body
 * @returns {boolean}
 */
function showsCompiled(shown, compiled) {
    if (!shown) return false;
    // The slot NAME must match first: ST's rename/apply is not atomic, and
    // the name is what makes the panel "the working slot" at all.
    if (currentPresetName() !== SLOT_NAME) return false;
    // Every compiled key ST echoes must match its live state. Keys the panel
    // projection never carries (getChatCompletionPreset skips e.g. the
    // *_group_models / *_sort_models connection-flagged keys) cannot be
    // observed and are skipped; they would otherwise make every apply time out.
    for (const key of Object.keys(compiled)) {
        if (!(key in shown)) continue;
        if (!canonEq(shown[key], compiled[key])) return false;
    }
    return true;
}

/**
 * Snapshot the current ST panel state (minus connection keys — the plugin
 * strips again, but avoid shipping secrets).
 * @returns {Promise<any>}
 */
export async function snapshotPanel() {
    // openai.js's getChatCompletionPreset(settingsToUpdate view) is NOT on
    // getContext() in ST 1.19.0 — import it from the module instead.
    const full = getChatCompletionPreset?.(ctx().chatCompletionSettings) ?? null;
    if (!full) return null;
    // DEEP copy: prompts/prompt_order are top-level ARRAY fields whose
    // values alias oai_settings' live arrays; a shallow spread made every
    // "base" share identity with every later "snapshot", so the plugin's
    // base->snapshot delta saw no structural change and toggle write-backs
    // routed nothing.
    const out = JSON.parse(JSON.stringify(full));
    delete out.proxy_password;
    delete out.reverse_proxy;
    delete out.custom_url;
    return out;
}

/** @returns {string} current preset name selected in ST */
export function currentPresetName() {
    return ctx().chatCompletionSettings.preset_settings_openai ?? '';
}
