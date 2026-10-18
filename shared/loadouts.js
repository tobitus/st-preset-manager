/**
 * Loadout inheritance (root -> playstyle -> per-Model override). Pure and
 * browser-safe: imports only ./groups.js.
 *
 * A root loadout carries a COMPLETE enabled map; a playstyle names a root as
 * `parent` (no chaining) and carries a SPARSE map (absent = inherit from the
 * root). Either may hold per-Model overrides, which apply on top of the
 * loadout's OWN layer only — a playstyle never sees its parent's overrides.
 * Code that only reads `kind` treats `kind !== 'playstyle'` as a root.
 */
import { normalize, collectGroups, pickOneMembers } from './groups.js';

export class LoadoutError extends Error {
    /**
     * @param {string} message
     * @param {number} [status]
     */
    constructor(message, status = 400) {
        super(message);
        this.name = 'LoadoutError';
        this.status = status;
    }
}

/**
 * The root loadout for `loadoutId` (the loadout itself when it is not a
 * playstyle).
 * @param {any} doc
 * @param {string} loadoutId
 * @returns {any}
 */
export function rootOf(doc, loadoutId) {
    const loadout = doc.loadouts?.[loadoutId];
    if (!loadout) throw new LoadoutError(`document has no loadout ${loadoutId}`, 404);
    if (loadout.kind !== 'playstyle') return loadout;
    const parent = doc.loadouts?.[loadout.parent];
    if (!parent || parent.kind === 'playstyle') {
        throw new LoadoutError(`loadout ${loadoutId} has no root parent ${loadout.parent}`, 409);
    }
    return parent;
}

/**
 * Resolve the enabled map of a loadout: root ⊕ playstyle ⊕ the loadout's own
 * per-Model override, then pick-one normalization preferring every id a layer
 * above the root turned on. `opts.raw` skips the normalization: the outline
 * shows the layered bits as stored so a pick-one conflict stays visible.
 * After the collapse, an id it switched off is labelled with the source of
 * the member its group kept. Group members include linked (remote) members
 * (via pickOneMembers).
 * @param {any} doc
 * @param {string} loadoutId
 * @param {string|null} [modelName]
 * @param {{ raw?: boolean }} [opts]
 * @returns {{ enabled: Record<string, boolean>, source: Record<string, 'root'|'loadout'|'override'> }}
 */
export function effectiveEnabled(doc, loadoutId, modelName = null, opts = {}) {
    const loadout = doc.loadouts?.[loadoutId];
    if (!loadout) throw new LoadoutError(`document has no loadout ${loadoutId}`, 404);
    const root = rootOf(doc, loadoutId);
    /** @type {Record<string, boolean>} */
    const enabled = { ...root.enabled };
    /** @type {Record<string, 'root'|'loadout'|'override'>} */
    const source = {};
    for (const id of Object.keys(enabled)) source[id] = 'root';
    if (loadout.kind === 'playstyle') {
        for (const [id, on] of Object.entries(loadout.enabled ?? {})) {
            enabled[id] = on;
            source[id] = 'loadout';
        }
    }
    const override = modelName ? loadout.overrides?.[modelName]?.enabled : undefined;
    if (override) {
        for (const [id, on] of Object.entries(override)) {
            if (typeof on !== 'boolean') continue;
            enabled[id] = on;
            source[id] = 'override';
        }
    }
    if (opts.raw) return { enabled, source };
    const preferred = new Set();
    for (const id of Object.keys(enabled)) {
        if (source[id] !== 'root' && enabled[id] === true) preferred.add(id);
    }
    /** @type {string[]} */
    const changed = [];
    normalize(doc, enabled, changed, preferred);
    if (changed.length) {
        const flipped = new Set(changed);
        for (const grp of collectGroups(doc)) {
            if (grp.cardinality !== 'pick-one') continue;
            const ids = pickOneMembers(doc, grp)
                .map((leaf) => leaf.ref ?? leaf.identifier)
                .filter((id) => id != null);
            const hit = ids.filter((id) => flipped.has(id));
            if (!hit.length) continue;
            const kept = ids.find((id) => enabled[id] === true);
            if (kept === undefined) continue;
            for (const id of hit) source[id] = source[kept];
        }
    }
    return { enabled, source };
}

/**
 * The ids a "reset to inherited" must clear for `identifier`: every member
 * (options plus linked remote members, via pickOneMembers; the heading is
 * never a member) of the pick-one group containing it (their
 * sparse bits are interdependent), else just the identifier.
 * @param {any} doc
 * @param {string} identifier
 * @returns {string[]}
 */
export function inheritResetKeys(doc, identifier) {
    for (const grp of collectGroups(doc)) {
        if (grp.cardinality !== 'pick-one') continue;
        const ids = pickOneMembers(doc, grp)
            .map((leaf) => leaf.ref ?? leaf.identifier)
            .filter((id) => id != null);
        if (ids.includes(identifier)) return ids;
    }
    return [identifier];
}

/**
 * Playstyle loadouts whose parent is `rootId`.
 * @param {any} doc
 * @param {string} rootId
 * @returns {any[]}
 */
export function childrenOf(doc, rootId) {
    return Object.values(doc.loadouts ?? {}).filter(
        (/** @type {any} */ l) => l?.kind === 'playstyle' && l.parent === rootId,
    );
}

/**
 * The tuning name `model` uses under `loadout`: its override's tuning, else
 * the Model's default.
 * @param {any} loadout
 * @param {{ name: string, defaultTuning?: string }} model
 * @returns {string|undefined}
 */
export function tuningNameInEffect(loadout, model) {
    return loadout?.overrides?.[model.name]?.tuning ?? model.defaultTuning;
}
