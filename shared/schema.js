/**
 * Native document + registry validation (PLAN §1.2). `validateDoc` returns a
 * list of problem paths; the REST layer turns a non-empty list into a 400.
 */
import { TUNING_KEYS, CONNECTION_KEYS } from './st-keys.js';

/**
 * @param {any} doc
 * @returns {string[]} paths of bad fields (empty = valid)
 */
export function validateDoc(doc) {
    /** @type {string[]} */
    const errs = [];
    const fail = (p) => errs.push(p);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['(root)'];
    if (doc.format !== 'st-preset-manager/library') fail('format');
    if (doc.version !== 1) fail('version');
    if (typeof doc.id !== 'string' || !doc.id) fail('id');
    if (typeof doc.name !== 'string' || !doc.name) fail('name');
    if (!Array.isArray(doc.tags)) fail('tags');
    if (typeof doc.notes !== 'string') fail('notes');
    if (doc.source !== null && (typeof doc.source !== 'object' || doc.source === undefined)) fail('source');
    if (typeof doc.settings !== 'object' || doc.settings === null || Array.isArray(doc.settings)) {
        fail('settings');
    } else {
        for (const key of Object.keys(doc.settings)) {
            if (CONNECTION_KEYS.includes(key)) fail(`settings.${key} (connection key — never stored)`);
        }
    }
    if (!Array.isArray(doc.markers)) {
        fail('markers');
    } else {
        doc.markers.forEach((m, i) => {
            if (!m || typeof m.identifier !== 'string') fail(`markers[${i}].identifier`);
            if (!m || typeof m.prompt !== 'object' || m.prompt === null) fail(`markers[${i}].prompt`);
        });
    }
    if (typeof doc.blocks !== 'object' || doc.blocks === null || Array.isArray(doc.blocks)) {
        fail('blocks');
    } else {
        for (const [id, block] of Object.entries(doc.blocks)) {
            const b = /** @type {any} */ (block);
            if (b?.identifier !== id) fail(`blocks.${id}.identifier`);
            if (typeof b?.content !== 'string') fail(`blocks.${id}.content`);
            if (typeof b?.role !== 'string') fail(`blocks.${id}.role`);
            if (typeof b?.fields !== 'object' || b.fields === null) fail(`blocks.${id}.fields`);
            if (typeof b?.notes !== 'string') fail(`blocks.${id}.notes`);
        }
    }
    if (!Array.isArray(doc.sequences)) {
        fail('sequences');
    } else {
        doc.sequences.forEach((s, i) => {
            if (typeof s?.character_id !== 'number') fail(`sequences[${i}].character_id`);
            if (!Array.isArray(s?.rows)) fail(`sequences[${i}].rows`);
            else validateRows(s.rows, `sequences[${i}].rows`, errs);
        });
    }
    if (typeof doc.loadouts !== 'object' || doc.loadouts === null || Array.isArray(doc.loadouts)) {
        fail('loadouts');
    } else {
        for (const [lid, lo] of Object.entries(doc.loadouts)) {
            const l = /** @type {any} */ (lo);
            if (l?.id !== lid) fail(`loadouts.${lid}.id`);
            if (typeof l?.name !== 'string') fail(`loadouts.${lid}.name`);
            if (typeof l?.notes !== 'string') fail(`loadouts.${lid}.notes`);
            if (typeof l?.enabled !== 'object' || l?.enabled === null) fail(`loadouts.${lid}.enabled`);
            for (const [k, v] of Object.entries(l?.enabled ?? {})) {
                if (typeof v !== 'boolean') fail(`loadouts.${lid}.enabled.${k}`);
            }
            if (typeof l?.overrides !== 'object' || l?.overrides === null) fail(`loadouts.${lid}.overrides`);
            if (doc.activeLoadoutId === lid) {
                // every leaf must have an entry
                for (const leaf of iterLeaves(doc)) {
                    const id = leaf.ref ?? leaf.identifier;
                    if (id != null && !(id in (l?.enabled ?? {}))) fail(`loadouts.${lid}.enabled.${id} (missing leaf)`);
                }
            }
        }
    }
    if (doc.activeLoadoutId !== null && (typeof doc.activeLoadoutId !== 'string' || !doc.loadouts?.[doc.activeLoadoutId])) {
        fail('activeLoadoutId');
    }
    if (typeof doc.tuningOverrides !== 'object' || doc.tuningOverrides === null || Array.isArray(doc.tuningOverrides)) {
        fail('tuningOverrides');
    } else {
        for (const [mid, t] of Object.entries(doc.tuningOverrides)) {
            for (const k of Object.keys(/** @type {any} */ (t))) {
                if (!TUNING_KEYS.includes(k)) fail(`tuningOverrides.${mid}.${k}`);
            }
        }
    }
    if (typeof doc.createdAt !== 'string') fail('createdAt');
    if (typeof doc.updatedAt !== 'string') fail('updatedAt');
    if (typeof doc.rev !== 'number') fail('rev');
    return errs;
}

function validateRows(rows, path, errs) {
    rows.forEach((row, i) => {
        const p = `${path}[${i}]`;
        if (!row || typeof row !== 'object') {
            errs.push(p);
            return;
        }
        if (['marker', 'block'].includes(row.kind)) {
            if (typeof row.ref !== 'string') errs.push(`${p}.ref`);
        } else if (row.kind === 'ghost') {
            if (typeof row.identifier !== 'string') errs.push(`${p}.identifier`);
        } else if (row.kind === 'section') {
            if (!Array.isArray(row.rows)) errs.push(`${p}.rows`);
            else validateRows(row.rows, `${p}.rows`, errs);
        } else if (row.kind === 'group') {
            if (!['pick-one', 'pick-one-or-more'].includes(row.cardinality)) errs.push(`${p}.cardinality`);
            if (typeof row.guessed !== 'boolean') errs.push(`${p}.guessed`);
            if (!Array.isArray(row.options)) errs.push(`${p}.options`);
            else validateRows(row.options, `${p}.options`, errs);
        } else {
            errs.push(`${p}.kind`);
        }
    });
}

function iterLeaves(doc) {
    /** @type {any[]} */
    const out = [];
    const walk = (rows) => {
        for (const row of rows) {
            if (['marker', 'block', 'ghost'].includes(row.kind)) out.push(row);
            else if (row.kind === 'section') {
                if (row.header) out.push(row.header);
                walk(row.rows ?? []);
            } else if (row.kind === 'group') {
                if (row.header) out.push(row.header);
                walk(row.options ?? []);
            }
        }
    };
    for (const s of doc.sequences ?? []) walk(s.rows ?? []);
    return out;
}

/**
 * Validate the Model registry (models.json body).
 * @param {any} reg
 * @returns {string[]}
 */
export function validateRegistry(reg) {
    /** @type {string[]} */
    const errs = [];
    if (!reg || typeof reg !== 'object') return ['(root)'];
    if (reg.version !== 1) errs.push('version');
    if (typeof reg.models !== 'object' || reg.models === null || Array.isArray(reg.models)) {
        errs.push('models');
        return errs;
    }
    for (const [name, m] of Object.entries(reg.models)) {
        const model = /** @type {any} */ (m);
        if (typeof model?.id !== 'string' || !model.id) errs.push(`models.${name}.id`);
        if (model?.name !== name) errs.push(`models.${name}.name`);
        if (!Array.isArray(model?.matches)) errs.push(`models.${name}.matches`);
        else {
            model.matches.forEach((mm, i) => {
                if (typeof mm?.source !== 'string') errs.push(`models.${name}.matches[${i}].source`);
                if (typeof mm?.model !== 'string') errs.push(`models.${name}.matches[${i}].model`);
            });
        }
        if (!Array.isArray(model?.profiles)) errs.push(`models.${name}.profiles`);
        if (model?.preferredProfile !== null && typeof model?.preferredProfile !== 'string') {
            errs.push(`models.${name}.preferredProfile`);
        }
        if (typeof model?.tuning !== 'object' || model?.tuning === null) errs.push(`models.${name}.tuning`);
        else {
            for (const k of Object.keys(model.tuning)) {
                if (!TUNING_KEYS.includes(k)) errs.push(`models.${name}.tuning.${k}`);
            }
        }
    }
    return errs;
}

/**
 * Normalize an incoming ST snapshot into `settings` + tuning split for
 * setSettings-style writes: tuning keys -> tuning, connection keys rejected,
 * prompt keys rejected, the rest -> settings.
 * @param {any} snapshot
 * @returns {{ settings: Record<string, any>, tuning: Record<string, any>, rejected: string[] }}
 */
export function splitSnapshot(snapshot) {
    /** @type {Record<string, any>} */
    const settings = {};
    /** @type {Record<string, any>} */
    const tuning = {};
    /** @type {string[]} */
    const rejected = [];
    for (const [k, v] of Object.entries(snapshot ?? {})) {
        if (['prompts', 'prompt_order'].includes(k)) continue;
        if (CONNECTION_KEYS.includes(k)) {
            rejected.push(k);
            continue;
        }
        if (TUNING_KEYS.includes(k)) tuning[k] = v;
        else settings[k] = v;
    }
    return { settings, tuning, rejected };
}
