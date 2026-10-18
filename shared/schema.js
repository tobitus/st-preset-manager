/**
 * Native document + registry validation (PLAN §1.2). `validateDoc` returns a
 * list of problem paths; the REST layer turns a non-empty list into a 400.
 */
import { TUNING_KEYS, CONNECTION_KEYS } from './st-keys.js';
import { nemoTags } from './recognizers.js';
import { usedIdentifiers, headingId, makeHeadingBlock, HEADING_SEMANTICS } from './headings.js';
import { newKey } from './canonical.js';
import { ensureAllLeaves } from './groups.js';

/**
 * Pre-mutation shape guard for a native upload (POST /presets {native}):
 * cheap enough to run before anything walks the document, so a malformed
 * upload never reaches `structuredClone`/`ensureDefaultLoadout`/etc as a
 * TypeError. Full validation stays in `validateDoc`.
 * @param {any} x
 * @returns {string[]} problem messages (empty = OK)
 */
export function nativeShapeErrors(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return ['(root): native document must be a JSON object'];
    /** @type {string[]} */
    const errs = [];
    if (x.format !== 'st-preset-manager/library') errs.push(`format: must be "st-preset-manager/library"`);
    if (x.version !== 1) errs.push('version: must be 1');
    if (!Array.isArray(x.sequences)) {
        errs.push('sequences: must be an array');
    } else {
        x.sequences.forEach((s, i) => {
            if (!s || typeof s !== 'object' || Array.isArray(s) || !Array.isArray(s.rows)) {
                errs.push(`sequences[${i}]: must be an object with a rows array`);
            } else {
                validateRows(s.rows, `sequences[${i}].rows`, errs);
            }
        });
    }
    if (x.loadouts !== undefined && (typeof x.loadouts !== 'object' || x.loadouts === null || Array.isArray(x.loadouts))) {
        errs.push('loadouts: must be an object');
    }
    return errs;
}

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
    else if (doc.source !== null && doc.source !== undefined) {
        if (doc.source.headingSemantics !== undefined && doc.source.headingSemantics !== HEADING_SEMANTICS) {
            fail('source.headingSemantics');
        }
    }
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
            else {
                validateRows(s.rows, `sequences[${i}].rows`, errs);
                validateRemote(s.rows, `sequences[${i}].rows`, errs);
            }
        });
    }
    if (typeof doc.loadouts !== 'object' || doc.loadouts === null || Array.isArray(doc.loadouts)) {
        fail('loadouts');
    } else {
        const leafIds = new Set();
        for (const leaf of iterLeaves(doc)) {
            const id = leaf.ref ?? leaf.identifier;
            if (id != null) leafIds.add(id);
        }
        let anyRoot = false;
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
            if (l?.kind !== 'root' && l?.kind !== 'playstyle') {
                fail(`loadouts.${lid}.kind`);
            } else if (l.kind === 'root') {
                anyRoot = true;
                if (l.parent !== null) fail(`loadouts.${lid}.parent`);
                // a root covers every leaf
                for (const id of leafIds) {
                    if (!(id in (l.enabled ?? {}))) fail(`loadouts.${lid}.enabled.${id} (missing leaf)`);
                }
            } else {
                const parent = typeof l.parent === 'string' ? doc.loadouts[l.parent] : undefined;
                if (!parent) fail(`loadouts.${lid}.parent`);
                else if (parent.kind !== 'root') fail(`loadouts.${lid}.parent (parent must be a root)`);
                for (const k of Object.keys(l.enabled ?? {})) {
                    if (!leafIds.has(k)) fail(`loadouts.${lid}.enabled.${k} (unknown leaf)`);
                }
            }
            for (const [m, ov] of Object.entries(l?.overrides ?? {})) {
                if (typeof ov !== 'object' || ov === null || Array.isArray(ov)) {
                    fail(`loadouts.${lid}.overrides.${m}`);
                    continue;
                }
                const o = /** @type {any} */ (ov);
                if (typeof o.enabled !== 'object' || o.enabled === null) fail(`loadouts.${lid}.overrides.${m}.enabled`);
                for (const [k, v] of Object.entries(o.enabled ?? {})) {
                    if (!leafIds.has(k)) fail(`loadouts.${lid}.overrides.${m}.enabled.${k} (unknown leaf)`);
                    if (typeof v !== 'boolean') fail(`loadouts.${lid}.overrides.${m}.enabled.${k}`);
                }
                if (o.tuning !== null && (typeof o.tuning !== 'string' || !o.tuning)) {
                    fail(`loadouts.${lid}.overrides.${m}.tuning`);
                }
            }
        }
        if (!anyRoot) fail('loadouts (no root loadout)');
    }
    if (doc.activeLoadoutId !== null && (typeof doc.activeLoadoutId !== 'string' || !doc.loadouts?.[doc.activeLoadoutId])) {
        fail('activeLoadoutId');
    }
    if ('tuningOverrides' in doc) fail('tuningOverrides (removed)');
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
            else {
                // a group always ends at a marker: markers are fixed ST
                // slots, never group members (v1 validate_canonical; also
                // what flatten/rebuild enforce on every op — this guards
                // hand-edited and PUT docs)
                row.options.forEach((/** @type {any} */ opt, /** @type {number} */ j) => {
                    if (opt?.kind === 'marker') errs.push(`${path}[${i}].options[${j}] (marker in group options — a group always ends at a marker)`);
                });
                validateRows(row.options, `${p}.options`, errs);
            }
            if ('remote' in row) {
                if (!Array.isArray(row.remote)) errs.push(`${p}.remote`);
                else {
                    row.remote.forEach((/** @type {any} */ k, /** @type {number} */ j) => {
                        if (typeof k !== 'string') errs.push(`${p}.remote[${j}] (not a string)`);
                    });
                }
            }
        } else {
            errs.push(`${p}.kind`);
        }
    });
}

/**
 * Cross-row checks of group `remote` links, one sequence at a time: each
 * string key must name a block-capable member leaf of THIS sequence (not a
 * marker, ghost or heading), not the group's own header/option, and not be
 * linked by an earlier group or earlier in the same list.
 * @param {any[]} rows
 * @param {string} path
 * @param {string[]} errs
 */
function validateRemote(rows, path, errs) {
    /** @type {Map<string, {leaf: any, role: 'item'|'option'|'heading'}>} */
    const index = new Map();
    /** @type {{grp: any, gpath: string}[]} */
    const groups = [];
    const add = (/** @type {any} */ leaf, /** @type {'item'|'option'|'heading'} */ role) => {
        if (leaf && typeof leaf === 'object' && typeof leaf.key === 'string') index.set(leaf.key, { leaf, role });
    };
    const scan = (/** @type {any[]} */ list, /** @type {string} */ base, /** @type {boolean} */ top) => {
        list.forEach((row, i) => {
            if (!row || typeof row !== 'object') return;
            const p = `${base}[${i}]`;
            if (['marker', 'block', 'ghost'].includes(row.kind)) add(row, 'item');
            else if (row.kind === 'section') {
                add(row.header, 'heading');
                if (top && Array.isArray(row.rows)) scan(row.rows, `${p}.rows`, false);
            } else if (row.kind === 'group') {
                add(row.header, 'heading');
                if (Array.isArray(row.options)) for (const o of row.options) add(o, 'option');
                groups.push({ grp: row, gpath: p });
            }
        });
    };
    scan(rows, path, true);
    const claimed = new Set();
    for (const { grp, gpath } of groups) {
        if (!Array.isArray(grp.remote)) continue;
        const own = new Set();
        if (grp.header && typeof grp.header.key === 'string') own.add(grp.header.key);
        if (Array.isArray(grp.options)) for (const o of grp.options) if (o && typeof o.key === 'string') own.add(o.key);
        grp.remote.forEach((/** @type {any} */ key, /** @type {number} */ j) => {
            if (typeof key !== 'string') return;
            const hit = index.get(key);
            /** @type {string|null} */
            let reason = null;
            if (!hit) reason = 'unknown';
            else if (own.has(key)) reason = 'own member';
            else if (hit.leaf.kind === 'marker') reason = 'marker';
            else if (hit.leaf.kind === 'ghost') reason = 'ghost';
            else if (hit.role === 'heading') reason = 'heading';
            else if (claimed.has(key)) reason = 'duplicate';
            if (reason) errs.push(`${gpath}.remote[${j}] (${reason})`);
            else claimed.add(key);
        });
    }
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
        if (typeof m !== 'object' || m === null || Array.isArray(m)) {
            errs.push(`models.${name}`);
            continue;
        }
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
        if ('tuning' in model) errs.push(`models.${name}.tuning (removed)`);
        const tunings = model?.tunings;
        if (typeof tunings !== 'object' || tunings === null || Array.isArray(tunings) || Object.keys(tunings).length < 1) {
            errs.push(`models.${name}.tunings`);
        } else {
            for (const [t, values] of Object.entries(tunings)) {
                if (typeof values !== 'object' || values === null) {
                    errs.push(`models.${name}.tunings.${t}`);
                    continue;
                }
                for (const k of Object.keys(values)) {
                    if (!TUNING_KEYS.includes(k)) errs.push(`models.${name}.tunings.${t}.${k}`);
                }
            }
            if (typeof model?.defaultTuning !== 'string' || !Object.hasOwn(tunings, model.defaultTuning)) {
                errs.push(`models.${name}.defaultTuning`);
            }
        }
    }
    return errs;
}

/**
 * Loadout override tuning bindings the registry cannot satisfy: a
 * non-null string `tuning` whose Model the registry has but whose
 * `tunings` lacks that name (own key) — exactly the bindings compile()
 * throws on. An override for a Model the registry lacks is inert (compile
 * only reads the resolved Model's override) and is not reported.
 * Non-object loadouts/overrides are skipped (validateDoc reports them).
 * Order: loadouts in key order, overrides in key order.
 * @param {any} doc
 * @param {any} registry
 * @returns {{ loadoutId: string, loadoutName: string, model: string, tuning: string }[]}
 */
export function deadTuningBindings(doc, registry) {
    const has = (/** @type {any} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);
    const isObj = (/** @type {any} */ v) => typeof v === 'object' && v !== null;
    const models = registry?.models;
    /** @type {{ loadoutId: string, loadoutName: string, model: string, tuning: string }[]} */
    const out = [];
    for (const [loadoutId, loadout] of Object.entries(doc?.loadouts ?? {})) {
        if (!isObj(loadout)) continue;
        const l = /** @type {any} */ (loadout);
        if (!isObj(l.overrides)) continue;
        for (const [model, override] of Object.entries(l.overrides)) {
            if (!isObj(override)) continue;
            const tuning = override.tuning;
            if (typeof tuning !== 'string') continue;
            if (!isObj(models) || !has(models, model)) continue;
            const tunings = isObj(models[model]) ? models[model].tunings : undefined;
            if (isObj(tunings) && has(tunings, tuning)) continue;
            out.push({ loadoutId, loadoutName: typeof l.name === 'string' ? l.name : loadoutId, model, tuning });
        }
    }
    return out;
}

/**
 * Walk every group row of every sequence (defensively), calling `fn(group)`.
 * @param {any[]} sequences
 * @param {(grp: any) => void} fn
 */
function walkGroups(sequences, fn) {
    /** @param {any} rows */
    const walk = (rows) => {
        if (!Array.isArray(rows)) return;
        for (const row of rows) {
            if (typeof row !== 'object' || row === null) continue;
            if (row.kind === 'group') fn(row);
            walk(row.rows);
            walk(row.options);
        }
    };
    for (const seq of sequences) if (typeof seq === 'object' && seq !== null) walk(seq.rows);
}

/**
 * Nemo upgrade step of `upgradeDoc` (see there). Runs only on documents
 * WITHOUT the round-3 `source.headingSemantics` marker: the marker is set by
 * this very upgrade and by every import/creation under round-3 code, so a
 * legitimate tagged heading created afterwards (dissolve a Nemo group, then
 * "Make group from selection" with its tagged first block as the heading) is
 * never rewritten back into options[0].
 * @param {any} doc
 */
function upgradeNemoHeadings(doc) {
    if (doc?.source?.recognizer?.kind !== 'nemo') return;
    if (doc.source.headingSemantics === HEADING_SEMANTICS) return;
    if (typeof doc.blocks !== 'object' || doc.blocks === null || !Array.isArray(doc.sequences)) return;
    /** @type {Set<string> | null} */
    let used = null;
    walkGroups(doc.sequences, (grp) => {
        const header = grp.header;
        if (grp.cardinality !== 'pick-one' || typeof header !== 'object' || header === null) return;
        if (header.kind !== 'block' || typeof header.ref !== 'string' || !Array.isArray(grp.options)) return;
        const tags = nemoTags(doc.blocks[header.ref]?.content);
        if (tags.get('section-header') === 'true' || (tags.get('mutual-exclusive-group') ?? '') === '') return;
        used ??= usedIdentifiers(doc);
        const id = headingId(used);
        const name = grp.name || tags.get('mutual-exclusive-group');
        doc.blocks[id] = makeHeadingBlock(id, name);
        const leaf = { kind: 'block', ref: id, key: newKey('row') };
        grp.options.unshift(header);
        grp.header = leaf;
        grp.key = 'grp:' + leaf.key;
        if (typeof doc.loadouts === 'object' && doc.loadouts !== null) {
            for (const l of Object.values(/** @type {Record<string, any>} */ (doc.loadouts))) {
                if (l?.kind === 'root' && typeof l.enabled === 'object' && l.enabled !== null) l.enabled[id] = true;
            }
        }
        const rec = doc.source.recognizer;
        if (!Array.isArray(rec.notes)) rec.notes = [];
        rec.notes.push(
            `upgrade: group '${name}' got a default heading; its former heading ` +
                `'${doc.blocks[header.ref]?.name || header.ref}' is now an option`,
        );
    });
}

/**
 * Bring a pre-inheritance document up to the current shape, in place:
 * a loadout without `kind` becomes a complete root; an override without
 * `tuning` gets `tuning: null`; `tuningOverrides` is dropped. Idempotent;
 * a loadout that already has a `kind` is left alone. A non-object loadout or
 * override is skipped and left for validateDoc to report. A Nemo document
 * whose pick-one group is headed by a former first-member option gets a
 * synthesized comment-only default heading; the old heading becomes an option.
 * The additive group `remote` field needs no conversion and is never
 * stripped; the version stays 1.
 * @param {any} doc
 * @returns {any} the same doc
 */
export function upgradeDoc(doc) {
    const loadouts = doc?.loadouts;
    if (typeof loadouts === 'object' && loadouts !== null) {
        for (const loadout of Object.values(loadouts)) {
            if (typeof loadout !== 'object' || loadout === null) continue;
            const l = /** @type {any} */ (loadout);
            if (l.kind === undefined) {
                l.kind = 'root';
                l.parent = null;
                if (typeof l.enabled === 'object' && l.enabled !== null) ensureAllLeaves(doc, l.enabled);
            }
            if (typeof l.overrides !== 'object' || l.overrides === null) continue;
            for (const override of Object.values(l.overrides)) {
                if (typeof override !== 'object' || override === null) continue;
                const o = /** @type {any} */ (override);
                if (o.tuning === undefined) o.tuning = null;
            }
        }
    }
    upgradeNemoHeadings(doc);
    // every document processed under this code lives by round-3 heading
    // rules from now on — converted or not, Nemo or not: the legacy
    // first-member-heading conversion must never run on it again, even if
    // it had no eligible heading at upgrade time and a genuine tagged
    // heading appears later (copyIntoDoc of a headed group, dissolve ->
    // make group, promote). Null-safe: a native doc may carry `source: null`
    // (validateDoc allows it), and every marker writer must tolerate that.
    if (doc !== null && typeof doc === 'object') {
        if (doc.source === null || typeof doc.source !== 'object') doc.source = {};
        doc.source.headingSemantics = HEADING_SEMANTICS;
    }
    delete doc.tuningOverrides;
    return doc;
}

/**
 * Bring a pre-named-tunings Model registry up to the current shape, in
 * place: `tuning` -> `tunings: {default: tuning}` + `defaultTuning:
 * 'default'`; a Model with neither gets one empty `default` tuning.
 * Idempotent.
 * @param {any} reg
 * @returns {any} the same registry
 */
export function upgradeRegistry(reg) {
    if (typeof reg?.models !== 'object' || reg.models === null) return reg;
    for (const model of Object.values(reg.models)) {
        if (typeof model !== 'object' || model === null || Array.isArray(model)) continue;
        const m = /** @type {any} */ (model);
        if (m.tunings === undefined) {
            m.tunings = { default: m.tuning ?? {} };
            m.defaultTuning = 'default';
        }
        delete m.tuning;
    }
    return reg;
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
