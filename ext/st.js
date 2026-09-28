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
import { getPresetApplicationPromise, getChatCompletionPreset, promptManager } from '../../../../openai.js';
import { CONNECTION_KEYS } from '../shared/st-keys.js';

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

/**
 * GET /csrf-token once, reuse cookie + token for every non-GET.
 * @param {AbortSignal} [signal] deadline covering the acquisition fetch
 * @returns {Promise<string>}
 */
export async function getCsrfToken(signal = undefined) {
    if (csrfToken) return csrfToken;
    const res = await fetch('/csrf-token', { credentials: 'include', signal });
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
        init.body = JSON.stringify(body ?? {});
    }
    // LIVENESS BOUND (15 s): created BEFORE CSRF acquisition so the deadline
    // covers the whole request, not just the plugin fetch — on a tab's first
    // non-GET, getCsrfToken() performs its own unbounded fetch, and a
    // /csrf-token that never settles would otherwise keep this call (and the
    // bridge op holding the apply overlay) open indefinitely. With the
    // deadline the op rejects, reconcileOp's finally unmounts the overlay
    // and the queue stays alive for a retry. Every plugin request is
    // bounded: a request that never settles (dead socket, plugin wedged)
    // cannot hold a bridge op open.
    const deadline = AbortSignal.timeout(15000);
    init.signal = opts?.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
    if (method !== 'GET') {
        init.headers = {
            'Content-Type': 'application/json',
            'x-csrf-token': await getCsrfToken(deadline),
        };
    }
    const res = await fetch(`${PLUGIN_BASE}${path}`, init);
    if (!res.ok) {
        let body;
        let detail = '';
        try { body = await res.json(); detail = JSON.stringify(body); } catch { detail = res.statusText; }
        const err = /** @type {Error & {status?: number, body?: any}} */ (new Error(`${method} ${path} -> ${res.status}: ${detail}`));
        // structured status: the bridge branches on 409 (stale panel base)
        err.status = res.status;
        // structured body: callers show `err.body?.error ?? err.message`
        err.body = body;
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
 * ST's own Chat Completion presets, as the tab currently holds them.
 * @returns {{ name: string, preset: any }[]} sorted by name
 */
export function listStPresets() {
    const { presets, preset_names } = ctx().getPresetManager('openai').getPresetList();
    /** @type {{ name: string, preset: any }[]} */
    const out = [];
    for (const [name, index] of Object.entries(preset_names)) {
        if (name === SLOT_NAME) continue;
        const preset = presets[/** @type {any} */ (index)];
        if (preset === undefined) continue;
        out.push({ name, preset });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

/**
 * Apply a compiled preset into ST's working slot through ST's own path.
 * @param {any} compiled full ST preset body
 * @returns {Promise<string>} canonical slot name as ST returned it
 */
export async function applyCompiledToSlot(compiled) {
    const pm = ctx().getPresetManager('openai');
    // LIVENESS BOUND (15 s): reproduce ST 1.19.0 PresetManager.savePreset()
    // (public/scripts/preset-manager.js:473-505, ~/tools/ST-dev read-only)
    // inline instead of calling it, with an AbortSignal.timeout deadline on
    // the POST. In the 'openai' branch of savePreset (the novel/instruct
    // conversions at :474-480 do not apply — this.apiId is 'openai') the
    // whole method is exactly: POST /api/presets/save with
    // {preset, name, apiId} and getRequestHeaders() (:484-488), throw on
    // !ok (:490-494), take data.name (:496-497), then the synchronous
    // updateList(name, preset) (:504) that selects the option and fires the
    // change event. Calling pm.savePreset() behind a Promise.race could not
    // deliver this: the race rejects at 15 s but the save chain keeps
    // running, so a later-settling save would still run updateList() and
    // select/apply the slot AFTER reconcileOp removed the overlay and moved
    // on — an out-of-queue apply overwriting a user edit. An aborted fetch
    // cannot complete later, so the deadline here is a real cancellation.
    let response;
    try {
        response = await fetch('/api/presets/save', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ preset: compiled, name: SLOT_NAME, apiId: 'openai' }),
            signal: AbortSignal.timeout(15000),
        });
    } catch (err) {
        throw new Error(`applyCompiledToSlot: preset save did not settle within 15s (or failed to start) — ${/** @type {Error} */ (err).message ?? err}`);
    }
    if (!response.ok) {
        let detail = '';
        try { detail = JSON.stringify(await response.json()); } catch { detail = response.statusText; }
        throw new Error(`applyCompiledToSlot: /api/presets/save -> ${response.status}: ${detail}`);
    }
    const data = await response.json();
    // ST 1.19.0 preset-manager.js:497,504 — data.name then updateList.
    pm.updateList(data.name, compiled);
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
    // ST re-renders the prompt manager on OAI_PRESET_CHANGED_AFTER only
    // through its 1 s renderDebounced (PromptManager.js:818-831), so the
    // panel's rows would lag the applied state by a second (acceptance 9 and
    // the v2 window's toggles have a 2 s budget). Render now, without the
    // token-count dry run; the debounced render still follows with counts.
    promptManager?.render(false);
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
 * Snapshot the current ST panel state (minus every CONNECTION_KEYS field —
 * compiled presets never carry them, so they are never a user edit; the
 * plugin strips them again server-side, but this also stops a profile
 * switch's connection-key mutations from producing a spurious panel post).
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
    for (const key of CONNECTION_KEYS) delete out[key];
    return out;
}

/** @returns {string} current preset name selected in ST */
export function currentPresetName() {
    return ctx().chatCompletionSettings.preset_settings_openai ?? '';
}

/**
 * Raw connection id ST currently shows: source, model and the selected
 * connection profile (or null when none is selected).
 * @returns {{source: string, model: string, profileId: string|null}}
 */
export function currentRaw() {
    return {
        source: String(ctx().chatCompletionSettings.chat_completion_source ?? ''),
        model: String(ctx().getChatCompletionModel?.() ?? ''),
        profileId: ctx().extensionSettings?.connectionManager?.selectedProfile ?? null,
    };
}

/**
 * `GET /slot` query string for a given raw connection id — every tab-side
 * GET /slot call goes through this so the plugin always compiles/routes for
 * the tab's OWN connection, not a stale global one.
 * @param {{source: string, model: string, profileId: string|null}} [raw]
 * @returns {string} e.g. `/slot?source=openai&model=gpt-4&profileId=`
 */
export function slotPath(raw = currentRaw()) {
    return '/slot?' + new URLSearchParams({ source: raw.source ?? '', model: raw.model ?? '', profileId: raw.profileId ?? '' });
}

/**
 * The LIVE connection-manager profiles array (not a copy) — callers that
 * mutate it are editing settings.json directly (F-052: the tab owns it).
 * @returns {any[]}
 */
export function connectionProfiles() {
    return ctx().extensionSettings?.connectionManager?.profiles ?? [];
}
