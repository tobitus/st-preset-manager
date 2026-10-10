/**
 * Model registry helpers (roadmap items 21, 22; PLAN §1.2 models.json):
 * resolve a raw (source, model[, profileId]) connection id to a named
 * Model, seed new Models from ST connection profiles, suggest merges by
 * normalized tail, and merge Models under an owner-picked name.
 */

/**
 * Lower-case a raw model id and drop everything up to and including its
 * last `/` (provider/sub-account prefixes).
 * @param {any} modelId
 * @returns {string}
 */
export function normalizeTail(modelId) {
    return String(modelId).toLowerCase().replace(/^.*\//, '');
}

/**
 * Connection profile `api` -> chat_completion_source (ST's CONNECT_API_MAP
 * aliases; most apis pass through unchanged).
 * @param {string|null|undefined} api
 * @returns {string}
 */
export function sourceOfApi(api) {
    if (api == null) return '';
    if (api === 'oai') return 'openai';
    if (api === 'google') return 'makersuite';
    return api;
}

/**
 * @param {any} registry { version, models } — name -> Model
 * @param {{ source?: string, model?: string, profileId?: string|null }} raw
 * @returns {any|null} the registry entry (has .name, .tunings, …), or null
 */
export function resolveModel(registry, raw) {
    if (!registry?.models || !raw) return null;
    const source = raw.source ?? '';
    const modelId = raw.model ?? '';
    for (const m of Object.values(registry.models)) {
        for (const match of m.matches ?? []) {
            if (match.source === source && match.model === modelId) return m;
        }
    }
    if (raw.profileId) {
        for (const m of Object.values(registry.models)) {
            if ((m.profiles ?? []).includes(raw.profileId)) return m;
        }
    }
    return null;
}

function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * New Models seeded from ST connection profiles: one per distinct (source,
 * model) pair not already exactly matched by the registry, named by the
 * raw model id (disambiguated on collision). Nothing is merged — matching
 * ids are only reported in `mergeSuggestions` for the owner to confirm.
 * @param {{ id?: string, name?: string, mode?: string, api?: string, model?: string, exclude?: string[] }[]} profiles
 * @param {any} [registry] { version, models } — existing Models to seed against
 * @returns {{ models: Record<string, any>, mergeSuggestions: string[][] }}
 */
export function seedFromProfiles(profiles, registry = { version: 1, models: {} }) {
    const existingModels = registry?.models ?? {};
    /** @type {Map<string, { source: string, model: string, profiles: string[], rawProfiles: any[] }>} */
    const byKey = new Map();
    const keyOrder = [];
    for (const p of profiles ?? []) {
        if (p?.mode !== 'cc') continue;
        if (typeof p.model !== 'string' || !p.model) continue;
        const source = sourceOfApi(p.api);
        const model = p.model;
        if (resolveModel({ version: 1, models: existingModels }, { source, model })) continue;
        const key = `${source}\u0000${model}`;
        if (!byKey.has(key)) {
            byKey.set(key, { source, model, profiles: [], rawProfiles: [] });
            keyOrder.push(key);
        }
        const entry = byKey.get(key);
        if (p.id) entry.profiles.push(p.id);
        entry.rawProfiles.push(p);
    }

    const takenNames = new Set(Object.keys(existingModels));
    const takenIds = new Set(Object.values(existingModels).map((m) => m.id));

    /** @type {Record<string, any>} */
    const models = {};
    for (const key of keyOrder) {
        const { source, model, profiles: pids, rawProfiles } = byKey.get(key);
        let name = model;
        if (takenNames.has(name)) name = `${model} (${source})`;
        if (takenNames.has(name)) {
            let n = 2;
            while (takenNames.has(`${name} #${n}`)) n += 1;
            name = `${name} #${n}`;
        }
        takenNames.add(name);

        let id = `m_${slug(name)}`;
        if (takenIds.has(id)) {
            let n = 2;
            while (takenIds.has(`${id}-${n}`)) n += 1;
            id = `${id}-${n}`;
        }
        takenIds.add(id);

        let preferredProfile = null;
        for (const p of rawProfiles) {
            if ((p.exclude ?? []).includes('preset')) { preferredProfile = p.id ?? null; break; }
        }
        if (preferredProfile == null) preferredProfile = pids[0] ?? null;

        models[name] = {
            id,
            name,
            matches: [{ source, model }],
            profiles: pids,
            preferredProfile,
            tunings: { default: {} },
            defaultTuning: 'default',
        };
    }

    /** @type {Map<string, string[]>} tail -> raw ids (first-appearance order) */
    const byTail = new Map();
    const seenIds = new Set();
    const addId = (rawId) => {
        if (seenIds.has(rawId)) return;
        seenIds.add(rawId);
        const tail = normalizeTail(rawId);
        if (!byTail.has(tail)) byTail.set(tail, []);
        byTail.get(tail).push(rawId);
    };
    for (const m of Object.values(existingModels)) {
        for (const match of m.matches ?? []) addId(match.model);
    }
    for (const m of Object.values(models)) {
        for (const match of m.matches ?? []) addId(match.model);
    }
    const mergeSuggestions = [...byTail.values()].filter((ids) => ids.length > 1);

    return { models, mergeSuggestions };
}

/**
 * Merge suggestions over an existing registry: group Model NAMES that
 * share a normalized tail on any of their matches (a Model with two
 * different tails can appear in two groups). Nothing is merged; the owner
 * picks.
 * @param {any} registry { version, models }
 * @returns {string[][]}
 */
export function suggestMerges(registry) {
    if (!registry?.models) return [];
    /** @type {Map<string, string[]>} tail -> names, first-appearance order */
    const byTail = new Map();
    for (const [name, m] of Object.entries(registry.models)) {
        const tailsForThisModel = new Set();
        for (const match of m.matches ?? []) {
            const tail = normalizeTail(match.model);
            if (tailsForThisModel.has(tail)) continue;
            tailsForThisModel.add(tail);
            if (!byTail.has(tail)) byTail.set(tail, []);
            byTail.get(tail).push(name);
        }
    }
    /** @type {string[][]} */
    const groups = [];
    const seenGroups = new Set();
    for (const names of byTail.values()) {
        if (names.length < 2) continue;
        const key = names.join('\u0000');
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        groups.push(names);
    }
    return groups;
}

/**
 * Merge two or more Models under one name (owner action). Matches and
 * profiles concatenate (deduped); `preferredProfile` and `defaultTuning`
 * come from the first listed Model; `tunings` union by tuning name, the
 * first listed Model that has a name supplying that whole tuning record.
 * Does not mutate `registry`.
 * @param {any} registry { version, models }
 * @param {string[]} names Model names to merge, in precedence order
 * @param {string} newName the merged Model's name (may reuse one of `names`)
 * @returns {any} a new registry
 */
export function mergeModels(registry, names, newName) {
    if (!Array.isArray(names) || names.length < 2) {
        throw new Error('mergeModels needs at least two names');
    }
    for (const n of names) {
        if (!registry?.models?.[n]) throw new Error(`unknown Model: ${n}`);
    }
    const trimmed = String(newName).trim();
    if (!trimmed) throw new Error('mergeModels needs a non-empty name');
    if (registry.models[trimmed] && !names.includes(trimmed)) {
        throw new Error(`name "${trimmed}" is already used by another Model`);
    }

    const src = names.map((n) => registry.models[n]);

    /** @type {{source: string, model: string}[]} */
    const matches = [];
    const seenMatch = new Set();
    for (const m of src) {
        for (const match of m.matches ?? []) {
            const key = `${match.source}\u0000${match.model}`;
            if (seenMatch.has(key)) continue;
            seenMatch.add(key);
            matches.push({ source: match.source, model: match.model });
        }
    }

    /** @type {string[]} */
    const profiles = [];
    const seenProfile = new Set();
    for (const m of src) {
        for (const pid of m.profiles ?? []) {
            if (seenProfile.has(pid)) continue;
            seenProfile.add(pid);
            profiles.push(pid);
        }
    }

    let preferredProfile = null;
    for (const m of src) {
        if (m.preferredProfile != null) { preferredProfile = m.preferredProfile; break; }
    }

    /** @type {Record<string, any>} */
    const tunings = {};
    for (const m of src) {
        for (const [tname, values] of Object.entries(m.tunings ?? {})) {
            if (!(tname in tunings)) tunings[tname] = structuredClone(values);
        }
    }

    const merged = {
        id: src[0].id,
        name: trimmed,
        matches,
        profiles,
        preferredProfile,
        tunings,
        defaultTuning: src[0].defaultTuning,
    };

    const out = structuredClone(registry);
    const nameSet = new Set(names);
    /** @type {Record<string, any>} */
    const models = {};
    let placed = false;
    for (const key of Object.keys(out.models)) {
        if (key === names[0]) {
            models[trimmed] = merged;
            placed = true;
            continue;
        }
        if (nameSet.has(key)) continue;
        models[key] = out.models[key];
    }
    if (!placed) models[trimmed] = merged;
    out.models = models;
    return out;
}
