/**
 * Model registry helpers: resolve a raw (source, model[, profileId]) id to a
 * named Model. Exact (source, model) match first, then connection-profile id.
 */

/**
 * @param {any} registry { version, models } — name -> Model
 * @param {{ source?: string, model?: string, profileId?: string|null }} raw
 * @returns {{ name: string, model: any }|null}
 */
export function resolveModel(registry, raw) {
    if (!registry?.models || !raw) return null;
    const source = raw.source ?? '';
    const modelId = raw.model ?? '';
    for (const [name, m] of Object.entries(registry.models)) {
        for (const match of m.matches ?? []) {
            if (match.source === source && match.model === modelId) {
                return { name, model: m };
            }
        }
    }
    if (raw.profileId) {
        for (const [name, m] of Object.entries(registry.models)) {
            if ((m.profiles ?? []).includes(raw.profileId)) return { name, model: m };
        }
    }
    return null;
}

/**
 * Merge suggestions: one Model per distinct raw id; ids whose normalized tail
 * matches (lower-case, provider prefix up to the last `/` dropped) are
 * suggested for merging. Nothing merges without the owner (item 22).
 * @param {{ id?: string, name?: string, mode?: string, "api-url"?: string, model?: string, exclude?: string[] }[]} profiles
 * @returns {{ models: Record<string, any>, mergeSuggestions: string[][] }}
 */
export function seedFromProfiles(profiles) {
    /** @type {Map<string, Set<string>>} id -> profile ids */
    const byId = new Map();
    for (const p of profiles ?? []) {
        if (p?.mode !== 'cc') continue;
        const model = p.model;
        if (!model) continue;
        if (!byId.has(model)) byId.set(model, new Set());
        const pid = p.id ?? p.name;
        if (pid) byId.get(model)?.add(pid);
    }
    /** @type {Record<string, any>} */
    const models = {};
    /** @type {Map<string, string[]>} normalized tail -> [modelIds] */
    const byTail = new Map();
    let n = 0;
    for (const [id, pids] of byId) {
        n += 1;
        const name = `Model ${n}`;
        models[name] = {
            id: `m_${name.toLowerCase().replace(/\s+/g, '-')}`,
            name,
            matches: [{ source: 'custom', model: id }],
            profiles: [...pids],
            preferredProfile: null,
            tuning: {},
        };
        const tail = id.toLowerCase().split('/').pop() ?? id;
        if (!byTail.has(tail)) byTail.set(tail, []);
        byTail.get(tail)?.push(id);
    }
    const mergeSuggestions = [...byTail.values()].filter((ids) => ids.length > 1);
    return { models, mergeSuggestions };
}
