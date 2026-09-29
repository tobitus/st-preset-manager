/**
 * Working-slot compile (PLAN §1.3). Pure: no fs, no ST.
 *
 * Input: document D, Model M (registry entry or null), base B = ST's own
 * `OpenAI Settings/Default.json` read at compile time (so missing keys track
 * the running ST version).
 *
 * 1. out = pick(B, non-connection keys of settingsToUpdate) ⊕ D.settings
 * 2. out ⊕= models[M].tuning ⊕ D.tuningOverrides[M.name]
 * 3. enabled = L.enabled ⊕ L.overrides[M].enabled, then groups.normalize
 * 4. out.prompts = markers (verbatim) + blocks as ST prompts;
 *    out.prompt_order = one entry per sequence, flattened leaf order
 * 5. strip every CONNECTION_KEYS key; return { out, hash }
 */
import { TUNING_KEYS, CONNECTION_KEYS, PRESET_SETTING_KEYS, MODELED_PROMPT_KEYS } from './st-keys.js';
import { normalize, iterLeaves } from './groups.js';
import { flattenSeq } from './outline.js';
import { canonicalHash } from './util.js';

/**
 * Compile a document into an ST preset for the working slot.
 * @param {any} doc native library document
 * @param {{ name: string, tuning?: Record<string, any> }|null} model Model registry entry or null
 * @param {any} base ST Default.json content (or {} in tests)
 * @param {string|null} [loadoutId] compile THIS loadout (defaults to the
 *   document's activeLoadoutId); lets /slot/load serve a non-active loadout
 * @param {{ suppressEmptyHeadings?: boolean }} [opts] a section/group heading
 *   block with empty or whitespace-only content is omitted from the slot's
 *   prompts and prompt_order (headings are informational; ST cannot toggle
 *   it — its loadout bit is library-only); the ST export keeps it. Set
 *   `suppressEmptyHeadings: false` to disable (used by exportSt).
 * @returns {{ compiled: any, hash: string, enabled: Record<string, boolean> }}
 */
export function compile(doc, model, base = {}, loadoutId = undefined, opts = {}) {
    const out = {};

    // 1. Base: ST's Default.json, non-connection preset keys only.
    for (const [key, value] of Object.entries(base ?? {})) {
        if (!CONNECTION_KEYS.includes(key)) out[key] = value;
    }
    // Document settings passthrough (already excludes tuning/connection keys
    // at import time, but be strict here too).
    for (const [key, value] of Object.entries(doc.settings ?? {})) {
        if (!CONNECTION_KEYS.includes(key)) out[key] = value;
    }

    // 2. Tunings: global per Model, then the preset's override.
    const modelTuning = model?.tuning ?? {};
    for (const key of TUNING_KEYS) {
        if (modelTuning[key] !== undefined) out[key] = modelTuning[key];
    }
    const override = model ? doc.tuningOverrides?.[model.name] : undefined;
    for (const key of TUNING_KEYS) {
        if (override && override[key] !== undefined) out[key] = override[key];
    }

    // 3. Enabled: loadout ⊕ per-model loadout override, then pick-one ≤ 1.
    const lid = loadoutId ?? doc.activeLoadoutId;
    const loadout = lid ? doc.loadouts?.[lid] : null;
    if (!loadout) throw new CompileError(`document has no loadout ${lid ?? '(none)'}`);
    /** @type {Record<string, boolean>} */
    const enabled = { ...loadout.enabled };
    const modelOverride = model ? loadout.overrides?.[model.name] : undefined;
    if (modelOverride?.enabled) {
        for (const [id, on] of Object.entries(modelOverride.enabled)) {
            if (typeof on === 'boolean') enabled[id] = on;
        }
    }
    normalize(doc, enabled);

    // 4. prompts + prompt_order. A section/group heading block with empty
    // or whitespace-only content is omitted from the slot's prompts and
    // prompt_order (headings are informational; ST cannot toggle it — its
    // loadout bit is library-only); the ST export keeps it.
    /** @type {any[]} */
    const prompts = [];
    const placed = new Set();
    for (const m of doc.markers ?? []) {
        prompts.push({ ...m.prompt });
        placed.add(m.identifier);
    }
    const byIdent = new Map(Object.entries(doc.blocks ?? {}));
    const suppressEmptyHeadings = opts?.suppressEmptyHeadings !== false;
    /** @type {Set<string>} */
    const suppressed = new Set();
    /** @type {any[]} */
    const orderEntries = [];
    for (const seq of doc.sequences ?? []) {
        const flat = flattenSeq(seq.rows ?? []);
        /** @type {{ identifier: string, enabled: boolean }[]} */
        const order = [];
        for (const e of flat) {
            const leaf = e.leaf;
            const id = leaf.ref ?? leaf.identifier;
            if (
                suppressEmptyHeadings &&
                (e.rank === 'section' || e.rank === 'group') &&
                leaf.kind === 'block'
            ) {
                const block = byIdent.get(id);
                if (block && String(block.content ?? '').trim() === '') {
                    suppressed.add(id);
                    continue;
                }
            }
            order.push({ identifier: id, enabled: !!enabled[id] });
            if (leaf.kind === 'block' && !placed.has(id)) {
                const block = byIdent.get(id);
                if (!block) continue; // defensive: order entry without a block rides in order only
                /** @type {any} */
                const prompt = {};
                for (const [k, v] of Object.entries(block.fields ?? {})) {
                    if (!MODELED_PROMPT_KEYS.includes(k)) prompt[k] = v;
                }
                prompt.identifier = block.identifier;
                prompt.name = block.name ?? null;
                prompt.content = block.content ?? '';
                prompt.role = block.role ?? 'system';
                prompt.enabled = !!enabled[id];
                prompt.marker = false;
                prompt.system_prompt = false;
                prompts.push(prompt);
                placed.add(id);
            }
        }
        orderEntries.push({ character_id: seq.character_id, order });
    }
    // Blocks present in `blocks` but placed in no sequence keep existing as
    // disabled prompts (the DEM orphan case; v1 parity). Suppressed empty
    // headings must never come back as a disabled orphan prompt.
    for (const [id, block] of byIdent) {
        if (!placed.has(id) && !suppressed.has(id)) {
            /** @type {any} */
            const prompt = {};
            for (const [k, v] of Object.entries(block.fields ?? {})) {
                if (!MODELED_PROMPT_KEYS.includes(k)) prompt[k] = v;
            }
            prompt.identifier = block.identifier;
            prompt.name = block.name ?? null;
            prompt.content = block.content ?? '';
            prompt.role = block.role ?? 'system';
            prompt.enabled = false;
            prompt.marker = false;
            prompt.system_prompt = false;
            prompts.push(prompt);
        }
    }
    out.prompts = prompts;
    out.prompt_order = orderEntries;

    // 5. Strip every connection key; never leak library-only fields.
    for (const key of CONNECTION_KEYS) delete out[key];
    delete out.preset_settings_openai;

    return { compiled: out, hash: canonicalHash(out), enabled };
}

/**
 * ST-format export (PLAN §1.6): the document's own settings and its active
 * loadout, with no Model tuning and no per-Model override — Model is null so
 * step 2/3 of `compile` never apply a tuning or an override, and base is `{}`
 * so the export carries exactly the document's own settings, not ST's
 * running Default.json. Unlike the working-slot compile, a section/group
 * heading block with empty or whitespace-only content is NOT omitted here:
 * the ST export keeps every block exactly as authored.
 * @param {any} doc native library document
 * @returns {any} plain ST preset object
 */
export function exportSt(doc) {
    return compile(doc, null, {}, doc.activeLoadoutId, { suppressEmptyHeadings: false }).compiled;
}

/**
 * Drop connection keys from a snapshot taken via getChatCompletionPreset.
 * @param {any} snapshot
 */
export function stripConnectionKeys(snapshot) {
    const out = { ...snapshot };
    for (const key of CONNECTION_KEYS) delete out[key];
    return out;
}

export class CompileError extends Error {}

/**
 * Difference keys between two compiled presets (top level only). Used by the
 * plugin's panel-diff routing.
 * @param {any} a
 * @param {any} b
 * @returns {string[]}
 */
export function diffKeys(a, b) {
    /** @type {Set<string>} */
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    /** @type {string[]} */
    const out = [];
    for (const k of keys) {
        if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out.push(k);
    }
    return out;
}

export { PRESET_SETTING_KEYS };
