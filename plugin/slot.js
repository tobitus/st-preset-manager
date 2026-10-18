/**
 * Working-slot desired state + panel routing (PLAN §1.4 write-back).
 *
 * The tab snapshots `getChatCompletionPreset(oai_settings)` on every
 * SETTINGS_UPDATED while the slot is selected and POSTs {base, snapshot}
 * here; panelDelta computes the SEMANTIC delta (base -> snapshot) and
 * routePanelDiff routes each user change to its layer:
 *
 *   - prompt_order[].enabled for identifier i -> L.overrides[M].enabled[i]
 *     when that override already controls i (i is a key in it), else the
 *     desired loadout's OWN layer: a root's L.enabled[i] (a pick-one option
 *     turned on turns its siblings off) or a playstyle's sparse L.enabled
 *     (ON writes last + completeOverride, OFF an explicit false; never the
 *     parent root). Override-routed pick-one groups are filled in and
 *     normalised by completeOverride. Bits the delta omits are untouched.
 *   - prompt_order SEQUENCE change -> blocks layer: the minimal set of
 *     moved leaves (outside the heaviest in-order chain over ST's order) is
 *     spliced onto the doc's current structure; a document unchanged by the
 *     order routes nothing (`applyOrderToSequences` returns `false`).
 *   - prompt content/name/role/field changes, keyed by identifier+field ->
 *     blocks layer; identifiers absent from the delta are untouched, so a
 *     concurrent API edit to another block's content survives.
 *   - TUNING_KEYS with a Model -> `tuningWrite` for the named tuning in
 *     effect (the loadout's override binding, else the Model's default),
 *     which the caller applies to the registry; with no Model resolved ->
 *     D.settings + warning.
 *   - anything else -> D.settings.
 */
import { TUNING_KEYS, CONNECTION_KEYS } from '../shared/st-keys.js';
import { stripConnectionKeys, compile } from '../shared/compile.js';
import { normalize, completeOverride } from '../shared/groups.js';
import { tuningNameInEffect } from '../shared/loadouts.js';
import { flattenSeq, rebuildSeq, syncHeadingNames } from '../shared/outline.js';
import { reorderEntries } from '../shared/reorder.js';

/**
 * Route panel differences to layers. Mutates `doc` (and optionally the
 * registry via the caller — global tunings are returned instead).
 *
 * @param {any} doc native document (mutated)
 * @param {any} compiled the plugin's last compiled output for this slot
 *   (kept for signature stability and future no-op detection; the semantic
 *   delta already names exactly what the user changed)
 * @param {any} delta SEMANTIC delta from panelDelta(base, snapshot): what
 *   the user changed, keyed per identifier/field/key — never a wholesale
 *   array replacement
 * @param {{ name: string, defaultTuning?: string }|null} model resolved Model (or null)
 * @param {string|null} [loadoutId] the loadout the panel is showing
 *   (defaults to doc.activeLoadoutId); enabled bits route there
 * @returns {{ routed: {key: string, layer: string}[], tuningWrite: {name: string, values: Record<string,any>}|null, warnings: string[] }}
 *   tuningWrite = the sampler values the CALLER must merge into the Model's
 *   named tuning `name` in the registry (null when none)
 */

/**
 * Panel delta = what the user changed in ST's UI (base -> snapshot), as a
 * SEMANTIC delta — per key, per identifier, per field — never a wholesale
 * array replacement:
 *
 *   - top-level scalar keys: absent when equal (or when the base never
 *     carried them); never `undefined` (a deletion cannot shadow a value a
 *     concurrent API write just stored);
 *   - `prompt_order`: `{changed: bool, order: [{identifier, enabled?}]}` —
 *     `changed` is true only when the identifier SEQUENCE differs; entries
 *     then carry the new sequence (in full), and an entry's `enabled` is
 *     present only when that bit changed vs the base (an untouched bit is
 *     absent, so a concurrent enabled write to another block survives);
 *     with `changed: false` the section still lists toggled bits only;
 *   - `prompts`: only CHANGED prompts, keyed by identifier, and per prompt
 *     only the fields that differ from the base (content, name, role,
 *     injection_* etc. — enabled too, though it routes with the order
 *     section); an added prompt carries all its fields; a deleted prompt
 *     is `{ identifier, deleted: true }`;
 *   - `preset_settings_openai` (the slot's own name) is never a user edit.
 *
 * @param {any} base panel projection the tab based its edit on
 * @param {any} snapshot current panel projection
 * @returns {any|null} semantic delta object, or null when the structure
 *   cannot be diffed (missing prompt_order/prompts on either side)
 */
export function panelDelta(base, snapshot) {
    if (!base?.prompt_order || !base?.prompts || !snapshot?.prompt_order || !snapshot?.prompts) return null;
    const delta = {};
    for (const key of Object.keys(snapshot)) {
        if (key === 'prompts' || key === 'prompt_order' || key === 'preset_settings_openai') continue;
        if (!(key in base) || !canonicalEqual(base[key], snapshot[key])) delta[key] = snapshot[key];
    }

    // ---- prompt_order: sequence + per-identifier enabled bits
    const baseOrder = (base.prompt_order ?? []).at(-1)?.order ?? [];
    const snapOrder = (snapshot.prompt_order ?? []).at(-1)?.order ?? [];
    const baseSeq = baseOrder.map((/** @type {any} */ o) => o?.identifier);
    const snapSeq = snapOrder.map((/** @type {any} */ o) => o?.identifier);
    const baseEnabled = new Map(baseOrder.map((/** @type {any} */ o) => [o?.identifier, o?.enabled]));
    const seqChanged = snapSeq.length !== baseSeq.length || snapSeq.some((id, i) => id !== baseSeq[i]);
    /** @type {any[]} */
    const orderEntries = [];
    if (seqChanged) {
        // the new sequence; an entry's enabled rides only when it differs
        // from the base (untouched bits stay absent -> concurrent toggles
        // to other blocks survive the routing below)
        for (const o of snapOrder) {
            const entry = { identifier: o?.identifier };
            if (baseEnabled.get(o?.identifier) !== o?.enabled) entry.enabled = o?.enabled;
            orderEntries.push(entry);
        }
    } else {
        // same sequence: still report bits the user toggled
        for (let i = 0; i < snapOrder.length; i++) {
            const o = snapOrder[i];
            if (baseEnabled.get(o?.identifier) !== o?.enabled) {
                orderEntries.push({ identifier: o?.identifier, enabled: o?.enabled });
            }
        }
    }
    delta.prompt_order = { changed: seqChanged, order: orderEntries };

    // ---- prompts: only changed prompts, only changed fields
    // (delta.prompts is [] when nothing changed; deletion rides as
    // {identifier, deleted: true} when the snapshot lost a prompt the base
    // carried)
    const basePrompts = new Map((base.prompts ?? []).map((/** @type {any} */ p) => [p?.identifier, p]));
    const snapPrompts = new Map((snapshot.prompts ?? []).map((/** @type {any} */ p) => [p?.identifier, p]));
    /** @type {any[]} */
    const promptsDelta = [];
    for (const [id, sp] of snapPrompts) {
        if (sp && typeof sp !== 'object') continue;
        const bp = basePrompts.get(id);
        if (!bp) {
            promptsDelta.push({ ...sp }); // added: full fields
            continue;
        }
        /** @type {Record<string, any>} */
        const fields = {};
        let changed = false;
        for (const k of Object.keys(sp)) {
            if (k === 'identifier' || !canonFieldEqual(bp[k], sp[k])) {
                if (k !== 'identifier') { fields[k] = sp[k]; changed = true; }
            }
        }
        if (changed) promptsDelta.push({ identifier: id, ...fields });
    }
    for (const id of basePrompts.keys()) {
        if (!snapPrompts.has(id)) promptsDelta.push({ identifier: id, deleted: true });
    }
    delta.prompts = promptsDelta;
    return delta;
}

/** @param {any} a @param {any} b */
function canonFieldEqual(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** @param {any} a @param {any} b */
function canonicalEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function routePanelDiff(doc, compiled, delta, model, loadoutId = undefined) {
    /** @type {{key: string, layer: string}[]} */
    const routed = [];
    /** @type {string[]} */
    const warnings = [];
    /** @type {{name: string, values: Record<string, any>}|null} */
    let tuningWrite = null;

    const loadout = doc.loadouts?.[loadoutId ?? doc.activeLoadoutId];
    if (!loadout) return { routed, tuningWrite, warnings: ['document has no active loadout'] };
    const overrideModel = model ? loadout.overrides?.[model.name] : undefined;

    // ---- prompt_order: order change + per-identifier enabled bits
    // The delta carries semantic sections only: `order` exists only when the
    // identifier SEQUENCE changed, and its entries' enabled bits are present
    // only where the user toggled. Absent == untouched: a concurrent API
    // reorder or toggle in the CURRENT doc is never overwritten.
    const orderDelta = delta?.prompt_order ?? {};
    if (orderDelta.changed && Array.isArray(orderDelta.order)) {
        // blocks layer: reorder the doc's sequence to match the panel order,
        // preserving structure (reorderEntries). Any panel identifier we
        // don't know is ignored (ST-side prompt the library never saw;
        // Phase 2's addBlock covers real additions). A document the reorder
        // leaves unchanged (e.g. the panel's order is already a fixed
        // point the library converged to) routes nothing, so no revision
        // is saved.
        const changed = applyOrderToSequences(doc, orderDelta.order.map((/** @type {any} */ o) => o.identifier));
        if (changed) routed.push({ key: 'prompt_order.order', layer: 'blocks' });
    }
    for (const entry of orderDelta.order ?? (Array.isArray(orderDelta) ? orderDelta : [])) {
        const id = entry?.identifier;
        if (entry?.enabled === undefined) continue; // untouched bit (or pure-order entry)
        const on = !!entry.enabled;
        const overrideControls = !!(overrideModel && overrideModel.enabled && id in overrideModel.enabled);
        if (overrideControls) {
            if (on) {
                const next = { ...overrideModel.enabled };
                delete next[id];
                next[id] = true; // last key: wins the override's own pick-one collapse
                overrideModel.enabled = completeOverride(doc, next);
            } else {
                overrideModel.enabled[id] = false;
            }
            routed.push({ key: id, layer: `override:${model?.name}` });
        } else if (loadout.kind === 'playstyle') {
            // a playstyle owns a sparse layer: ON writes last (wins its own
            // pick-one collapse), OFF is an explicit false; never the parent
            if (on) {
                const next = { ...loadout.enabled };
                delete next[id];
                next[id] = true;
                loadout.enabled = completeOverride(doc, next);
            } else {
                loadout.enabled[id] = false;
            }
            routed.push({ key: id, layer: 'loadout' });
        } else {
            loadout.enabled[id] = on;
            routed.push({ key: id, layer: 'loadout' });
            // pick-one: the option just switched on turns its siblings off
            const changed = [];
            normalize(doc, loadout.enabled, changed, on ? id : null);
            const norm = changed.filter((x) => x !== id);
            if (norm.length > 0) {
                routed.push({ key: norm.join(','), layer: 'group:pick-one' });
            }
        }
    }

    // ---- prompts: only the delta's changed prompts, only their fields
    // The delta lists prompts the USER changed (per identifier+field); a
    // concurrent API edit to another block's content survives untouched.
    // Deletions: only when the delta says so. A snapshot missing a prompt
    // the doc has is NOT evidence of deletion (ST hides unplaced prompts,
    // so the panel list legitimately omits them) — deletions come from the
    // prompt list itself (panel removal) and never from absence alone.
    const changedPrompts = Array.isArray(delta?.prompts) ? delta.prompts : [];
    for (const cp of changedPrompts) {
        const id = cp?.identifier;
        if (id === undefined) continue;
        if (cp.deleted) {
            if (doc.blocks?.[id] !== undefined) {
                deleteBlockFromDoc(doc, id);
                routed.push({ key: id, layer: 'blocks:deleted' });
            }
            continue;
        }
        if (doc.blocks?.[id] === undefined) continue; // marker or unknown: nothing to route
        const block = doc.blocks[id];
        let changed = false;
        if (cp.content !== undefined) { block.content = cp.content; changed = true; }
        if (cp.name !== undefined) { block.name = cp.name; syncHeadingNames(doc, id); changed = true; }
        if (cp.role !== undefined) { block.role = cp.role; changed = true; }
        for (const [k, v] of Object.entries(cp)) {
            if (k === 'identifier' || k === 'content' || k === 'name' || k === 'role' || k === 'deleted') continue;
            block.fields ??= {};
            block.fields[k] = v;
            changed = true;
        }
        if (changed) routed.push({ key: id, layer: 'blocks' });
    }

    // ---- sampler + settings keys
    // The delta's top-level keys are exactly what the user changed; the
    // compiled check only skips no-op writes. Absent keys are untouched, so
    // a concurrent API write to an untouched key survives.
    for (const key of Object.keys(delta ?? {})) {
        if (key === 'prompts' || key === 'prompt_order') continue;
        if (CONNECTION_KEYS.includes(key)) continue; // never stored
        if (TUNING_KEYS.includes(key)) {
            if (model) {
                // the named tuning in effect for the desired loadout: its
                // override's binding, else the Model's default
                tuningWrite ??= { name: tuningNameInEffect(loadout, /** @type {any} */ (model)), values: {} };
                tuningWrite.values[key] = delta[key];
                routed.push({ key, layer: `tuning:${model.name}/${tuningWrite.name}` });
            } else {
                doc.settings ??= {};
                if (delta[key] !== undefined) doc.settings[key] = delta[key];
                routed.push({ key, layer: 'settings' });
                warnings.push(`sampler key "${key}" changed with no Model resolved — routed to the document's settings`);
            }
        } else {
            doc.settings ??= {};
            // A delta never carries undefined (panelDelta), but guard anyway:
            // an explicit undefined must not shadow a concurrent API write.
            if (delta[key] !== undefined) doc.settings[key] = delta[key];
            routed.push({ key, layer: 'settings' });
        }
    }
    // defensive: a doc may already carry connection keys (e.g. routed by an
    // earlier bug or hand-edited); validation refuses them on every save
    for (const k of CONNECTION_KEYS) delete doc.settings[k];
    return { routed, tuningWrite, warnings };
}

/**
 * Reorder the document's first sequence so it reflects ST's panel `order`,
 * preserving structure: identifiers `order` lacks (e.g. a suppressed empty
 * section/group heading) never move; a moved row lands above such an
 * absent run over its new following neighbour, unless it already belonged
 * to that heading's section/group (PLAN §1.4). Among the present
 * leaves, only the MINIMAL set that moved — the complement of the
 * heaviest in-order chain, weighting a section/group heading 3 and every
 * other row 2 so a heading only counts as moved when keeping it would move
 * two or more rows — is spliced onto the structure: each moved row lands
 * directly above its new following neighbour with v2's drop rules (a
 * single item/option re-derives its rank from what it lands next to; a
 * group or section heading moved alone takes its whole group/section with
 * it). Any step that would change the rank, group or section of a row that
 * did NOT move is rejected, so the next apply of the library's own order
 * is a no-op. Unknown identifiers in `order` are ignored, and each
 * identifier is placed once.
 * @param {any} doc
 * @param {string[]} newIdents
 * @returns {boolean} true when the document changed
 */
export function applyOrderToSequences(doc, newIdents) {
    const seq = doc.sequences?.[0];
    if (!seq) return false;
    const next = reorderEntries(flattenSeq(seq.rows ?? []), newIdents);
    if (!next) return false;
    seq.rows = rebuildSeq(next);
    return true;
}

/**
 * Remove a block from the doc: blocks map + every sequence position.
 * @param {any} doc
 * @param {string} id
 */
export function deleteBlockFromDoc(doc, id) {
    /** @type {Set<string>} */
    const gone = new Set();
    const collect = (/** @type {any[]} */ rows) => {
        const take = (/** @type {any} */ leaf) => { if (leaf && (leaf.ref ?? leaf.identifier) === id) gone.add(leaf.key); };
        for (const row of rows) {
            if (row.kind === 'section') { take(row.header); collect(row.rows ?? []); }
            else if (row.kind === 'group') { take(row.header); for (const o of row.options ?? []) take(o); }
            else take(row);
        }
    };
    for (const seq of doc.sequences ?? []) collect(seq.rows ?? []);
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
    const prune = (/** @type {any[]} */ rows) => {
        for (const row of rows) {
            if (row.kind === 'section') prune(row.rows ?? []);
            else if (row.kind === 'group' && row.remote) {
                row.remote = row.remote.filter((/** @type {string} */ k) => !gone.has(k));
                if (row.remote.length === 0) delete row.remote;
            }
        }
    };
    for (const seq of doc.sequences ?? []) prune(seq.rows ?? []);
}

export { compile, stripConnectionKeys };
