/**
 * Working-slot desired state + panel routing (PLAN §1.4 write-back).
 *
 * The tab snapshots `getChatCompletionPreset(oai_settings)` on every
 * SETTINGS_UPDATED while the slot is selected and POSTs it here; this module
 * diffs the snapshot against the last compiled output and routes each
 * difference to its layer:
 *
 *   - prompt_order[].enabled for identifier i -> L.overrides[M].enabled[i] if
 *     that override exists, else L.enabled[i]; a pick-one option turned on
 *     turns its siblings off.
 *   - prompt_order order / prompt content, name, role, fields / prompt added
 *     or deleted -> blocks layer.
 *   - TUNING_KEYS -> D.tuningOverrides[M] if that override exists, else the
 *     Model's global tuning; with no Model resolved -> D.settings + warning.
 *   - anything else -> D.settings.
 */
import { TUNING_KEYS, CONNECTION_KEYS } from '../shared/st-keys.js';
import { diffKeys, stripConnectionKeys, compile } from '../shared/compile.js';
import { normalize } from '../shared/groups.js';

/**
 * Route panel differences to layers. Mutates `doc` (and optionally the
 * registry via the caller — global tunings are returned instead).
 *
 * @param {any} doc native document (mutated)
 * @param {any} compiled the plugin's last compiled output for this slot
 * @param {any} snapshot ST panel snapshot (connection keys already stripped)
 * @param {{ name: string }|null} model resolved Model (or null)
 * @param {string|null} [loadoutId] the loadout the panel is showing
 *   (defaults to doc.activeLoadoutId); enabled bits route there
 * @returns {{ routed: {key: string, layer: string}[], globalTuning: Record<string,any>|null, warnings: string[] }}
 */
export function routePanelDiff(doc, compiled, snapshot, model, loadoutId = undefined) {
    /** @type {{key: string, layer: string}[]} */
    const routed = [];
    /** @type {string[]} */
    const warnings = [];
    let /** @type {Record<string, any>|null} */ globalTuning = null;

    const loadout = doc.loadouts?.[loadoutId ?? doc.activeLoadoutId];
    if (!loadout) return { routed, globalTuning, warnings: ['document has no active loadout'] };
    const overrideModel = model ? loadout.overrides?.[model.name] : undefined;

    // ---- prompt_order: order + enabled bits
    const oldOrder = compiled?.prompt_order?.[0]?.order ?? [];
    const newOrder = snapshot?.prompt_order?.[0]?.order ?? [];
    const oldIdents = oldOrder.map((/** @type {any} */ o) => o.identifier);
    const newIdents = newOrder.map((/** @type {any} */ o) => o.identifier);
    const orderChanged = JSON.stringify(oldIdents) !== JSON.stringify(newIdents);
    if (orderChanged) {
        // blocks layer: reorder the doc's sequences to match the panel order.
        // Any panel identifier we don't know is ignored (ST-side prompt the
        // library never saw; Phase 2's addBlock covers real additions).
        applyOrderToSequences(doc, newIdents);
        routed.push({ key: 'prompt_order.order', layer: 'blocks' });
    }
    for (let i = 0; i < Math.min(oldOrder.length, newOrder.length); i++) {
        const before = oldOrder[i];
        const after = newOrder[i];
        if (before.identifier !== after.identifier) continue; // reorder, handled above
        if (!!before.enabled !== !!after.enabled) {
            const id = after.identifier;
            if (overrideModel && id in (overrideModel.enabled ?? {})) {
                overrideModel.enabled[id] = !!after.enabled;
                routed.push({ key: id, layer: `override:${model?.name}` });
            } else if (overrideModel && model) {
                // the override exists for this model: route there (item 21) and list the identifier
                overrideModel.enabled[id] = !!after.enabled;
                routed.push({ key: id, layer: `override:${model?.name}` });
            } else {
                loadout.enabled[id] = !!after.enabled;
                routed.push({ key: id, layer: 'loadout' });
            }
            // pick-one: the option just switched on turns its siblings off
            const changed = [];
            normalize(doc, loadout.enabled, changed, !!after.enabled ? id : null);
            const norm = changed.filter((x) => x !== id);
            if (norm.length > 0 && !overrideModel) {
                routed.push({ key: norm.join(','), layer: 'group:pick-one' });
            }
        }
    }

    // ---- prompts: content/name/role/fields/added/deleted
    const oldPrompts = new Map((compiled?.prompts ?? []).map((/** @type {any} */ p) => [p.identifier, p]));
    const newPrompts = new Map((snapshot?.prompts ?? []).map((/** @type {any} */ p) => [p.identifier, p]));
    for (const [id, np] of newPrompts) {
        if (doc.blocks?.[id] === undefined) continue; // not a library block (marker or unknown)
        const op = oldPrompts.get(id);
        const block = doc.blocks[id];
        let changed = false;
        if (op && (op.content !== np.content || op.name !== np.name || op.role !== np.role)) changed = true;
        if (!op) changed = true;
        if (changed) {
            block.content = np.content ?? '';
            block.name = np.name ?? block.name;
            block.role = np.role ?? block.role;
            routed.push({ key: id, layer: 'blocks' });
        }
    }
    for (const id of oldPrompts.keys()) {
        if (!newPrompts.has(id) && doc.blocks?.[id] !== undefined) {
            deleteBlockFromDoc(doc, id);
            routed.push({ key: id, layer: 'blocks:deleted' });
        }
    }

    // ---- sampler + settings keys
    for (const key of diffKeys(compiled, snapshot)) {
        if (['prompts', 'prompt_order', 'preset_settings_openai'].includes(key)) continue;
        if (CONNECTION_KEYS.includes(key)) continue; // never stored
        if (TUNING_KEYS.includes(key)) {
            const docOverride = doc.tuningOverrides?.[model?.name ?? ''];
            if (docOverride) {
                docOverride[key] = snapshot[key];
                routed.push({ key, layer: `tuningOverride:${model?.name}` });
            } else if (model) {
                if (!globalTuning) globalTuning = {};
                globalTuning[key] = snapshot[key];
                routed.push({ key, layer: `tuning:${model.name}` });
            } else {
                doc.settings[key] = snapshot[key];
                routed.push({ key, layer: 'settings' });
                warnings.push(`sampler key "${key}" changed with no Model resolved — routed to the document's settings`);
            }
        } else {
            // Ordinary preset setting (names_behavior, send_if_empty,
            // wi_format, assistant_prefill, …): after prompts/prompt_order
            // and connection keys are excluded, everything the panel reports
            // is library state — dropping keys that merely exist in the
            // compiled output made /slot/panel return the old compile and
            // the tab re-apply the old value.
            doc.settings[key] = snapshot[key];
            routed.push({ key, layer: 'settings' });
        }
    }
    // defensive: a doc may already carry connection keys (e.g. routed by an
    // earlier bug or hand-edited); validation refuses them on every save
    for (const k of CONNECTION_KEYS) delete doc.settings[k];
    return { routed, globalTuning, warnings };
}

/**
 * Reorder the document's sequences so the flat leaf order matches
 * `newIdents`. Leaves the enabled bits as the panel reports (applied by the
 * caller). Unknown identifiers ride at the end, preserving relative order.
 * @param {any} doc
 * @param {string[]} newIdents
 */
export function applyOrderToSequences(doc, newIdents) {
    const seq = doc.sequences?.[0];
    if (!seq) return;
    /** @type {any[]} */
    const flat = [];
    const collect = (/** @type {any[]} */ rows) => {
        for (const row of rows) {
            if (['marker', 'block', 'ghost'].includes(row.kind)) flat.push(row);
            else if (row.kind === 'section') {
                if (row.header) flat.push(row.header);
                collect(row.rows ?? []);
            } else if (row.kind === 'group') {
                if (row.header) flat.push(row.header);
                collect(row.options ?? []);
            }
        }
    };
    collect(seq.rows ?? []);
    const byIdent = new Map(flat.map((leaf) => [leaf.ref ?? leaf.identifier, leaf]));
    /** @type {any[]} */
    const next = [];
    const used = new Set();
    for (const id of newIdents) {
        const leaf = byIdent.get(id);
        if (leaf) {
            next.push(leaf);
            used.add(id);
        }
    }
    for (const leaf of flat) {
        const id = leaf.ref ?? leaf.identifier;
        if (!used.has(id)) {
            next.push(leaf);
            used.add(id);
        }
    }
    seq.rows = next.map((leaf) => ({ ...leaf }));
}

/**
 * Remove a block from the doc: blocks map + every sequence position.
 * @param {any} doc
 * @param {string} id
 */
export function deleteBlockFromDoc(doc, id) {
    delete doc.blocks?.[id];
    const filter = (/** @type {any[]} */ rows) => rows.filter((row) => {
        if (['marker', 'block', 'ghost'].includes(row.kind)) return (row.ref ?? row.identifier) !== id;
        if (row.kind === 'section') {
            if (row.header && (row.header.ref ?? row.header.identifier) === id) return false;
            row.rows = filter(row.rows ?? []);
            return true;
        }
        if (row.kind === 'group') {
            if (row.header && (row.header.ref ?? row.header.identifier) === id) {
                // promote options to the parent position (rare via panel)
                rows.push(...(row.options ?? []));
                return false;
            }
            row.options = filter(row.options ?? []);
            return true;
        }
        return true;
    });
    for (const seq of doc.sequences ?? []) seq.rows = filter(seq.rows ?? []);
}

export { compile, stripConnectionKeys };
