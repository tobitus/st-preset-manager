/**
 * REST routes (PLAN §1.6). Mounted at /api/plugins/st-preset-manager.
 * Phase 1 subset: /health, /library, /presets (import + get/put/delete),
 * /slot/*, /events, /rescan, /revisions, /models GET, /profiles GET, /shelf.
 * The rest of the table lands with its phase.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { compile, stripConnectionKeys } from '../shared/compile.js';
import { routePanelDiff } from './slot.js';
import { resolveModel } from '../shared/models.js';
import { canonicalHash } from '../shared/util.js';
import { TUNING_KEYS } from '../shared/st-keys.js';

/**
 * Base = ST's own OpenAI Settings/Default.json from the user dir, read at
 * compile time (PLAN §1.3: missing keys track the running ST version).
 * @param {any} req
 */
function readBase(req) {
    try {
        const dir = req.user?.directories?.openAI_Settings;
        if (!dir) return {};
        const file = path.join(dir, 'Default.json');
        if (!fs.existsSync(file)) return {};
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

/** @param {any} store */
function rawOf(store) {
    return store.state.raw ?? { source: null, model: null, profileId: null };
}

/**
 * Current slot view: {rev, desired, compiled, hash}.
 * @param {any} req
 */
function slotView(req) {
    const { store } = req.pm;
    const doc = store.state.presetId ? store.getPreset(store.state.presetId) : null;
    const model = doc ? resolveModel(store.models, rawOf(store)) : null;
    if (!doc) {
        return {
            rev: store.rev,
            desired: { presetId: store.state.presetId, loadoutId: store.state.loadoutId, modelId: store.state.modelId },
            compiled: null,
            hash: null,
        };
    }
    const { compiled, hash } = compile(doc, model, readBase(req));
    return {
        rev: store.rev,
        desired: { presetId: store.state.presetId, loadoutId: store.state.loadoutId, modelId: store.state.modelId },
        compiled,
        hash,
    };
}

/** @returns {Router} */
export function makeRouter() {
    const router = Router();

    // -------------------------------------------------------------- health

    router.get('/health', (req, res) => {
        res.json({
            version: '2.0.0-phase1',
            rev: req.pm.store.rev,
            libraryRoot: req.pm.store.root,
            clients: req.pm.hub.clientCount,
        });
    });

    // ------------------------------------------------------------- library

    router.get('/library', (req, res) => {
        res.json(req.pm.store.listLibrary(/** @type {any} */ (req.query).tag));
    });

    router.post('/rescan', async (req, res, next) => {
        try {
            await req.pm.store.enqueue(() => req.pm.store.rescan());
            res.json({ ok: true, count: req.pm.store.index.size });
        } catch (err) { next(err); }
    });

    // ------------------------------------------------------------- presets

    router.get('/presets/:id', (req, res) => {
        res.json(req.pm.store.getPreset(req.params.id));
    });

    router.put('/presets/:id', async (req, res, next) => {
        try {
            const doc = req.body;
            if (doc.id !== req.params.id) {
                return res.status(400).json({ error: `body id ${doc.id} != path id ${req.params.id}` });
            }
            const saved = await req.pm.store.savePreset(doc);
            broadcast(req, 'preset', doc.id);
            res.json(saved);
        } catch (err) { next(err); }
    });

    router.delete('/presets/:id', async (req, res, next) => {
        try {
            await req.pm.store.deletePreset(req.params.id);
            broadcast(req, 'preset', req.params.id);
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

    router.post('/presets', async (req, res, next) => {
        try {
            const doc = /** @type {{id: string}} */ (await req.pm.store.importPreset(req.body ?? {}));
            broadcast(req, 'preset', doc.id);
            res.status(201).json(doc);
        } catch (err) { next(err); }
    });

    // ------------------------------------------------------------ revisions

    router.get('/presets/:id/revisions', (req, res) => {
        res.json(req.pm.store.listRevisions(req.params.id));
    });

    router.get('/presets/:id/revisions/:rev', (req, res) => {
        res.json(req.pm.store.getRevision(req.params.id, Number(req.params.rev)));
    });

    // ---------------------------------------------------------------- slot

    router.get('/slot', (req, res) => {
        res.json(slotView(req));
    });

    router.post('/slot/load', async (req, res, next) => {
        try {
            const { presetId, loadoutId } = req.body ?? {};
            const doc = /** @type {{activeLoadoutId?: string, loadouts?: Record<string, unknown>}} */ (req.pm.store.getPreset(presetId));
            if (!doc) return res.status(404).json({ error: `preset ${presetId} not found` });
            const lid = loadoutId ?? doc.activeLoadoutId;
            if (!lid || !doc.loadouts?.[lid]) return res.status(400).json({ error: `no loadout ${lid}` });
            await req.pm.store.mutateState((/** @type {any} */ st) => {
                st.presetId = presetId;
                st.loadoutId = lid;
            });
            const view = slotView(req);
            broadcast(req, 'slot', null);
            res.json(view);
        } catch (err) { next(err); }
    });

    router.post('/slot/model', async (req, res, next) => {
        try {
            const { modelId, raw } = req.body ?? {};
            await req.pm.store.mutateState((/** @type {any} */ st) => {
                st.modelId = modelId ?? null;
                if (raw) st.raw = raw;
            });
            const view = slotView(req);
            broadcast(req, 'slot', null);
            res.json(view);
        } catch (err) { next(err); }
    });

    router.post('/slot/panel', async (req, res, next) => {
        try {
            const { clientId, snapshot } = req.body ?? {};
            const store = req.pm.store;
            const doc = store.state.presetId ? /** @type {Record<string, unknown>} */ (store.getPreset(/** @type {string} */ (store.state.presetId))) : null;
            if (!doc) return res.status(409).json({ error: 'no preset in the slot' });
            const clean = stripConnectionKeys(snapshot ?? {});
            const model = resolveModel(store.models, rawOf(store));
            const { compiled } = compile(doc, model, readBase(req));
            const { routed, globalTuning, warnings } = routePanelDiff(doc, compiled, clean, model);
            await store.savePreset(doc);
            if (globalTuning && model) {
                await store.mutateModels((/** @type {any} */ reg) => {
                    reg.models[model.name].tuning = { ...reg.models[model.name].tuning, ...globalTuning };
                });
            }
            const view = slotView(req);
            for (const w of warnings) {
                req.pm.hub.broadcast({ rev: store.rev, kind: 'warning', message: w });
            }
            broadcast(req, 'slot', clientId);
            res.json({ rev: view.rev, compiled: view.compiled, hash: view.hash, routed });
        } catch (err) { next(err); }
    });

    // -------------------------------------------------------------- events

    router.get('/events', (req, res) => {
        const clientId = String(/** @type {any} */ (req.query).clientId ?? `c-${Date.now()}`);
        const hello = { rev: req.pm.store.rev, desired: slotView(req).desired };
        req.pm.hub.add(clientId, res, hello);
    });

    // -------------------------------------------------------------- models

    router.get('/models', (req, res) => {
        res.json(req.pm.store.models);
    });

    // ------------------------------------------------------------ profiles

    router.get('/profiles', (req, res) => {
        // read-only view of cc profiles from the user's settings.json
        try {
            const settingsFile = path.join(req.user.directories.root, 'settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            const profiles = settings?.extension_settings?.connectionManager?.profiles
                ?.filter((/** @type {any} */ p) => p?.mode === 'cc')
                .map((/** @type {any} */ p) => ({
                    id: p.id, name: p.name, api: p.api, model: p.model,
                    preset: p.preset ?? null, exclude: p.exclude ?? [],
                })) ?? [];
            res.json(profiles);
        } catch (err) {
            res.status(500).json({ error: `cannot read settings.json: ${err.message}` });
        }
    });

    // --------------------------------------------------------------- shelf

    router.get('/shelf', (req, res) => {
        res.json(req.pm.store.shelfList());
    });

    router.post('/shelf', async (req, res, next) => {
        try {
            const entry = await req.pm.store.shelfAdd(req.body ?? {});
            broadcast(req, 'shelf', null);
            res.status(201).json(entry);
        } catch (err) { next(err); }
    });

    router.delete('/shelf/:id', async (req, res, next) => {
        try {
            await req.pm.store.shelfRemove(req.params.id);
            broadcast(req, 'shelf', null);
            res.json({ ok: true });
        } catch (err) { next(err); }
    });

    return router;
}

/**
 * @param {any} req
 * @param {string} kind
 * @param {string|null} [presetId]
 */
function broadcast(req, kind, presetId = null) {
    req.pm.hub.broadcast({
        rev: req.pm.store.rev,
        kind,
        ...(presetId ? { presetId } : {}),
    });
}

export { TUNING_KEYS, canonicalHash };
