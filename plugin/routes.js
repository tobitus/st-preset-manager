/**
 * REST routes (PLAN §1.6). Mounted at /api/plugins/st-preset-manager.
 * Phase 1 subset: /health, /library, /presets (import + get/put/delete +
 * /ops toggle|setSettings), /presets/:id/export, /slot/*, /events, /rescan,
 * /revisions, /models GET, /profiles GET, /shelf. The rest of the table
 * lands with its phase.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { compile, stripConnectionKeys, exportSt } from '../shared/compile.js';
import { routePanelDiff, panelDelta } from './slot.js';
import { StoreError } from './store.js';
import { applyDocOp } from '../shared/docops.js';
import { iterLeaves } from '../shared/groups.js';
import { resolveModel } from '../shared/models.js';
import { canonicalHash, ulid, newId } from '../shared/util.js';
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
 * Current slot view: {rev, slotChangedRev, desired, compiled, hash}. The
 * compile input is the DESIRED loadout (state.loadoutId), not the
 * document's activeLoadoutId: /slot/load stores the requested loadout in
 * state.json, and loading a non-active loadout must return/push that
 * loadout. `slotChangedRev` is the global rev of the last desired-slot
 * change (preset/loadout swap); panel posts carry it in their base so the
 * tab can re-base, and the same-hash reconcile can advance the applied rev
 * (bridge side). Call OUTSIDE the store queue: GET /slot is a read of the
 * last committed state (the panel route builds its view after its
 * transaction commits).
 * @param {any} req
 */
function slotView(req) {
    const { store } = req.pm;
    const doc = store.state.presetId ? store.getDocNow(store.state.presetId) : null;
    const model = doc ? resolveModel(store.models, rawOf(store)) : null;
    if (!doc) {
        return {
            rev: store.rev,
            slotChangedRev: store.slotChangedRev ?? 0,
            desired: { presetId: store.state.presetId, loadoutId: store.state.loadoutId, modelId: store.state.modelId },
            compiled: null,
            hash: null,
        };
    }
    const desiredLoadout = store.state.loadoutId ?? doc.activeLoadoutId;
    const { compiled, hash } = compile(doc, model, readBase(req), desiredLoadout);
    return {
        rev: store.rev,
        slotChangedRev: store.slotChangedRev ?? 0,
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

    router.get('/presets/:id/export', (req, res, next) => {
        try {
            const format = req.query.format ?? 'st';
            if (format === 'native') return res.json(req.pm.store.getPreset(req.params.id));
            if (format === 'st') return res.json(exportSt(req.pm.store.getPreset(req.params.id)));
            res.status(400).json({ error: 'format must be st or native' });
        } catch (err) { next(err); }
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
            if (req.pm.store.state.presetId === doc.id) broadcast(req, 'slot', null);
            else broadcast(req, 'preset', doc.id);
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

    // ----------------------------------------------------------------- ops

    // POST /presets/:id/ops {op, ...args} -> {doc, rev} (PLAN §1.6).
    // ONE store-queue transaction per request: read the doc, apply the op,
    // validate, write — no interleaving with a queued /slot/panel or
    // /slot/load (review-3 rule). Exactly one typed event per mutation.
    // Op set (Phase 2): outline ops (promote/demote/moveLeaf operate on
    // sequence structure and never touch enabled bits), switches
    // (toggle/setGroup — the only ops writing loadout bits; pick-one is
    // normalised here like every write path), group shape (createGroup/
    // renameGroup/setCardinality), options (addOption/removeOption), blocks
    // (setContent/editBlock/setBlockNotes/renameBlock/addBlock/deleteBlock),
    // and settings/notes (setSettings/setNotes — notes are library-only and
    // never compiled).
    const OPS = /** @type {const} */ ([
        'toggle', 'setGroup', 'setCardinality', 'promote', 'demote', 'moveLeaf',
        'createGroup', 'renameGroup', 'addOption', 'removeOption',
        'setContent', 'editBlock', 'renameBlock', 'addBlock', 'deleteBlock',
        'setSettings', 'setBlockNotes', 'setNotes',
    ]);
    router.post('/presets/:id/ops', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const { op } = req.body ?? {};
            if (!op) throw new StoreError('missing op', 400);
            if (!OPS.includes(op)) throw new StoreError(`unknown op '${op}'`, 400);
            const saved = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                await applyDocOp(doc, op, req.body ?? {});
                return store._savePresetNow(doc);
            });
            broadcast(req, 'preset', req.params.id);
            res.json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    // --------------------------------------------------------- preset meta

    // PATCH /presets/:id/meta {name?, folder?, tags?, notes?, blockNotes?}
    // -> {doc, rev}. Library metadata; never compiled.
    router.patch('/presets/:id/meta', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const body = req.body ?? {};
            const saved = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                if (body.name !== undefined) {
                    if (typeof body.name !== 'string' || !body.name.trim()) throw new StoreError('name must be a non-empty string', 400);
                    doc.name = body.name.trim();
                }
                if (body.folder !== undefined) {
                    if (typeof body.folder !== 'string') throw new StoreError('folder must be a string', 400);
                    doc.folder = body.folder; // _safeDir validates on save
                }
                if (body.tags !== undefined) {
                    if (!Array.isArray(body.tags) || body.tags.some((/** @type {any} */ t) => typeof t !== 'string')) {
                        throw new StoreError('tags must be an array of strings', 400);
                    }
                    doc.tags = body.tags;
                }
                if (body.notes !== undefined) {
                    if (typeof body.notes !== 'string') throw new StoreError('notes must be a string', 400);
                    doc.notes = body.notes;
                }
                if (body.blockNotes !== undefined) {
                    if (typeof body.blockNotes !== 'object' || body.blockNotes === null) throw new StoreError('blockNotes must be an object', 400);
                    for (const [id, notes] of Object.entries(body.blockNotes)) {
                        if (typeof notes !== 'string') throw new StoreError(`blockNotes.${id} must be a string`, 400);
                        if (doc.blocks?.[id] === undefined) throw new StoreError(`no block ${id}`, 404);
                        doc.blocks[id].notes = notes;
                    }
                }
                return store._savePresetNow(doc);
            });
            broadcast(req, 'preset', req.params.id);
            res.json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    // ----------------------------------------------------- fork / save-as

    // POST /presets/:id/fork {name, folder?, tags?, notes?} -> 201 {doc, rev}.
    // Save-as: a deep copy under a new id with every block identifier
    // re-minted (and every leaf ref/ghost identifier re-pointed). The fork's
    // loadout bits, groups and notes copy over unchanged.
    router.post('/presets/:id/fork', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const { name, folder, tags, notes } = req.body ?? {};
            if (typeof name !== 'string' || !name.trim()) throw new StoreError('fork needs {name}', 400);
            const saved = await store.enqueue(async () => {
                const src = store.getDocNow(req.params.id);
                if (!src) throw new StoreError(`preset ${req.params.id} not found`, 404);
                if (store.findByName(name.trim())) {
                    throw Object.assign(new StoreError(`name "${name.trim()}" is already taken`, 409), { conflict: store.findByName(name.trim()).id });
                }
                const doc = structuredClone(src);
                doc.id = `p_${ulid()}`;
                doc.name = name.trim();
                doc.folder = typeof folder === 'string' ? folder : src.folder;
                if (tags !== undefined) {
                    if (!Array.isArray(tags) || tags.some((/** @type {any} */ t) => typeof t !== 'string')) throw new StoreError('tags must be an array of strings', 400);
                    doc.tags = tags;
                }
                if (notes !== undefined) {
                    if (typeof notes !== 'string') throw new StoreError('notes must be a string', 400);
                    doc.notes = notes;
                }
                // re-mint every block identifier; re-point all leaf refs
                const remap = new Map(/** @type {[string, string][]} */ ([]));
                doc.blocks ??= {};
                for (const ident of /** @type {string[]} */ (Object.keys(doc.blocks))) {
                    remap.set(ident, newId());
                }
                const reblock = /** @type {Record<string, any>} */ ({});
                for (const [ident, block] of Object.entries(doc.blocks)) {
                    const fresh = structuredClone(block);
                    fresh.identifier = remap.get(ident);
                    reblock[fresh.identifier] = fresh;
                }
                doc.blocks = reblock;
                const repoint = (/** @type {any} */ leaf) => {
                    if (leaf && leaf.kind === 'block' && remap.has(leaf.ref)) leaf.ref = remap.get(leaf.ref);
                    if (leaf && leaf.kind === 'ghost' && typeof leaf.identifier === 'string' && remap.has(leaf.identifier)) {
                        leaf.identifier = remap.get(leaf.identifier);
                    }
                };
                const walkRows = (/** @type {any[]} */ rows) => {
                    for (const row of rows) {
                        if (['marker', 'block', 'ghost'].includes(row.kind)) { repoint(row); continue; }
                        if (row.kind === 'section') { repoint(row.header); walkRows(row.rows ?? []); }
                        if (row.kind === 'group') { repoint(row.header); (row.options ?? []).forEach(repoint); }
                    }
                };
                for (const seq of /** @type {any[]} */ (doc.sequences ?? [])) walkRows(seq.rows ?? []);
                // markers keep their fixed ST identifiers — never re-minted
                // new loadout ids (ids are per-document) with the copied
                // bits — and every enabled/override map re-keyed onto the
                // re-minted identifiers
                const rekeyEnabled = (/** @type {Record<string, any>} */ map) => {
                    const out = /** @type {Record<string, boolean>} */ ({});
                    for (const [leafId, on] of Object.entries(map)) {
                        out[remap.get(leafId) ?? leafId] = /** @type {boolean} */ (on);
                    }
                    return out;
                };
                const loadouts = /** @type {Record<string, any>} */ ({});
                for (const lo of /** @type {any[]} */ (Object.values(doc.loadouts ?? {}))) {
                    const lid = `l_${ulid()}`;
                    const overrides = /** @type {Record<string, any>} */ ({});
                    for (const [modelName, ov] of Object.entries(/** @type {Record<string, any>} */ (lo.overrides ?? {}))) {
                        overrides[modelName] = { enabled: rekeyEnabled(ov.enabled ?? {}) };
                    }
                    loadouts[lid] = {
                        ...structuredClone(lo),
                        id: lid,
                        enabled: rekeyEnabled(lo.enabled ?? {}),
                        overrides,
                    };
                }
                doc.loadouts = loadouts;
                // the fork's active loadout is the copy of the source's
                // active one (same position in the new id map)
                const oldIds = /** @type {string[]} */ (Object.keys(src.loadouts ?? {}));
                const newPos = oldIds.indexOf(/** @type {string} */ (src.activeLoadoutId));
                const newIds = /** @type {string[]} */ (Object.keys(doc.loadouts));
                doc.activeLoadoutId = newIds[newPos] ?? newIds[0] ?? null;
                doc.createdAt = new Date().toISOString();
                if (doc.source && typeof doc.source === 'object') {
                    (/** @type {Record<string, any>} */ (doc.source)).forkedFrom = src.id;
                }
                await store._writeNewDocNow(doc);
                await store._bumpRev();
                return structuredClone(doc);
            });
            broadcast(req, 'preset', /** @type {string} */ (saved.id));
            res.status(201).json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    // POST /presets/:id/move {folder?, name?} -> {doc, rev}: rename = move.
    router.post('/presets/:id/move', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const { folder, name } = req.body ?? {};
            if (folder === undefined && name === undefined) throw new StoreError('move needs {folder?, name?}', 400);
            const saved = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                if (folder !== undefined) {
                    if (typeof folder !== 'string') throw new StoreError('folder must be a string', 400);
                    doc.folder = folder;
                }
                if (name !== undefined) {
                    if (typeof name !== 'string' || !name.trim()) throw new StoreError('name must be a non-empty string', 400);
                    doc.name = name.trim();
                }
                return store._savePresetNow(doc);
            });
            broadcast(req, 'preset', req.params.id);
            res.json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    // ------------------------------------------------------------ loadouts

    // POST /presets/:id/loadouts {name, from?} -> {doc, rev}: create a
    // loadout copying `from` (or the current active one when omitted).
    router.post('/presets/:id/loadouts', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const { name, from } = req.body ?? {};
            if (typeof name !== 'string' || !name.trim()) throw new StoreError('loadouts create needs {name}', 400);
            const saved = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                if (Object.values(doc.loadouts ?? {}).some((/** @type {any} */ l) => l.name === name.trim())) {
                    throw new StoreError(`loadout name "${name.trim()}" is already taken`, 409);
                }
                const srcId = from ?? doc.activeLoadoutId;
                const src = srcId ? doc.loadouts?.[srcId] : null;
                if (!src) throw new StoreError(`no loadout ${String(srcId)}`, 404);
                const lid = `l_${ulid()}`;
                doc.loadouts[lid] = {
                    id: lid,
                    name: name.trim(),
                    notes: '',
                    enabled: { ...structuredClone(src.enabled) },
                    overrides: structuredClone(src.overrides ?? {}),
                };
                return store._savePresetNow(doc);
            });
            broadcast(req, 'preset', req.params.id);
            res.status(201).json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    // PATCH /presets/:id/loadouts/:lid {name?, notes?} -> {doc, rev}
    router.patch('/presets/:id/loadouts/:lid', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const saved = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                const loadout = doc.loadouts?.[req.params.lid];
                if (!loadout) throw new StoreError(`no loadout ${req.params.lid}`, 404);
                const { name, notes } = req.body ?? {};
                if (name !== undefined) {
                    if (typeof name !== 'string' || !name.trim()) throw new StoreError('name must be a non-empty string', 400);
                    if (Object.values(doc.loadouts).some((/** @type {any} */ l) => l.id !== req.params.lid && l.name === name.trim())) {
                        throw new StoreError(`loadout name "${name.trim()}" is already taken`, 409);
                    }
                    loadout.name = name.trim();
                }
                if (notes !== undefined) {
                    if (typeof notes !== 'string') throw new StoreError('notes must be a string', 400);
                    loadout.notes = notes;
                }
                return store._savePresetNow(doc);
            });
            broadcast(req, 'preset', req.params.id);
            res.json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    // DELETE /presets/:id/loadouts/:lid -> {doc, rev} (never the last one).
    // Deleting the loadout the slot desires changes the desired state: the
    // in-queue marker + state write clear it so the slot view falls back to
    // the document's active loadout.
    router.delete('/presets/:id/loadouts/:lid', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const { doc, wasDesired } = await store.enqueue(async () => {
                const d = store.getDocNow(req.params.id);
                if (!d) throw new StoreError(`preset ${req.params.id} not found`, 404);
                if (!d.loadouts?.[req.params.lid]) throw new StoreError(`no loadout ${req.params.lid}`, 404);
                if (Object.keys(d.loadouts).length <= 1) throw new StoreError('cannot delete the last loadout', 409);
                delete d.loadouts[req.params.lid];
                if (d.activeLoadoutId === req.params.lid) {
                    d.activeLoadoutId = Object.keys(d.loadouts)[0];
                }
                const desired = store.state.presetId === req.params.id
                    && (store.state.loadoutId === req.params.lid);
                if (desired) {
                    store._markSlotChanged();
                    await store._mutateStateNow((/** @type {any} */ st) => {
                        st.loadoutId = null;
                    });
                }
                const saved = await store._savePresetNow(d);
                return { doc: saved, wasDesired: desired };
            });
            broadcast(req, wasDesired ? 'slot' : 'preset', wasDesired ? null : req.params.id);
            res.json({ doc, rev: store.rev });
        } catch (err) { next(err); }
    });

    // POST /presets/:id/loadouts/:lid/activate -> {slot view}. Recompiles
    // (via GET /slot semantics) when this preset is the slot's preset.
    router.post('/presets/:id/loadouts/:lid/activate', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const view = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                if (!doc.loadouts?.[req.params.lid]) throw new StoreError(`no loadout ${req.params.lid}`, 404);
                doc.activeLoadoutId = req.params.lid;
                await store._savePresetNow(doc);
                if (store.state.presetId === req.params.id) {
                    // the desired slot changes with it: marker BEFORE the
                    // state write (same transaction shape as /slot/load)
                    store._markSlotChanged();
                    await store._mutateStateNow((/** @type {any} */ st) => {
                        st.loadoutId = req.params.lid;
                    });
                }
                return null;
            });
            void view;
            const out = slotView(req);
            broadcast(req, store.state.presetId === req.params.id ? 'slot' : 'preset', store.state.presetId === req.params.id ? null : req.params.id);
            res.json(out);
        } catch (err) { next(err); }
    });

    // PUT/DELETE /presets/:id/loadouts/:lid/overrides/:modelId {enabled:{…}}
    // -> {doc, rev}. Per-Model loadout override (roadmap item 21). PUT with
    // {} deletes... no: PUT replaces the override (creating it), DELETE
    // removes it. Enabled identifiers must be known leaves.
    router.put('/presets/:id/loadouts/:lid/overrides/:modelId', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const saved = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                const loadout = doc.loadouts?.[req.params.lid];
                if (!loadout) throw new StoreError(`no loadout ${req.params.lid}`, 404);
                const { enabled } = req.body ?? {};
                if (typeof enabled !== 'object' || enabled === null || Array.isArray(enabled)) {
                    throw new StoreError('override needs {enabled: {identifier: bool}}', 400);
                }
                const leaves = new Set(iterLeaves(doc).map((/** @type {any} */ l) => l.ref ?? l.identifier));
                for (const [id, on] of Object.entries(enabled)) {
                    if (typeof on !== 'boolean') throw new StoreError(`override.${id} must be a boolean`, 400);
                    if (!leaves.has(id)) throw new StoreError(`unknown leaf ${id}`, 404);
                }
                loadout.overrides ??= {};
                loadout.overrides[req.params.modelId] = { enabled: { ...enabled } };
                return store._savePresetNow(doc);
            });
            // the slot recompiles against overrides when its Model matches
            broadcast(req, store.state.presetId === req.params.id ? 'slot' : 'preset',
                store.state.presetId === req.params.id ? null : req.params.id);
            res.json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    router.delete('/presets/:id/loadouts/:lid/overrides/:modelId', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const saved = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                const loadout = doc.loadouts?.[req.params.lid];
                if (!loadout) throw new StoreError(`no loadout ${req.params.lid}`, 404);
                if (loadout.overrides?.[req.params.modelId] === undefined) {
                    throw new StoreError(`no override for ${req.params.modelId}`, 404);
                }
                delete loadout.overrides[req.params.modelId];
                return store._savePresetNow(doc);
            });
            broadcast(req, store.state.presetId === req.params.id ? 'slot' : 'preset',
                store.state.presetId === req.params.id ? null : req.params.id);
            res.json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    // -------------------------------------------------- tuning overrides

    // PUT/DELETE /presets/:id/tuning-overrides/:modelId {…TUNING_KEYS}
    // -> {doc, rev} (roadmap item 16).
    router.put('/presets/:id/tuning-overrides/:modelId', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const saved = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                const body = req.body ?? {};
                for (const k of Object.keys(body)) {
                    if (!TUNING_KEYS.includes(k)) throw new StoreError(`"${k}" is not a tuning key`, 400);
                }
                doc.tuningOverrides ??= {};
                doc.tuningOverrides[req.params.modelId] = { ...body };
                return store._savePresetNow(doc);
            });
            broadcast(req, store.state.presetId === req.params.id ? 'slot' : 'preset',
                store.state.presetId === req.params.id ? null : req.params.id);
            res.json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    router.delete('/presets/:id/tuning-overrides/:modelId', async (req, res, next) => {
        try {
            const store = req.pm.store;
            const saved = await store.enqueue(async () => {
                const doc = store.getDocNow(req.params.id);
                if (!doc) throw new StoreError(`preset ${req.params.id} not found`, 404);
                if (doc.tuningOverrides?.[req.params.modelId] === undefined) {
                    throw new StoreError(`no tuning override for ${req.params.modelId}`, 404);
                }
                delete doc.tuningOverrides[req.params.modelId];
                return store._savePresetNow(doc);
            });
            broadcast(req, store.state.presetId === req.params.id ? 'slot' : 'preset',
                store.state.presetId === req.params.id ? null : req.params.id);
            res.json({ doc: saved, rev: store.rev });
        } catch (err) { next(err); }
    });

    // ---------------------------------------------------------------- slot

    router.get('/slot', (req, res) => {
        res.json(slotView(req));
    });

    router.post('/slot/load', async (req, res, next) => {
        try {
            const { presetId, loadoutId } = req.body ?? {};
            const store = req.pm.store;
            const doc = /** @type {{activeLoadoutId?: string, loadouts?: Record<string, unknown>}} */ (req.pm.store.getPreset(presetId));
            if (!doc) return res.status(404).json({ error: `preset ${presetId} not found` });
            const lid = loadoutId ?? doc.activeLoadoutId;
            if (!lid || !doc.loadouts?.[lid]) return res.status(400).json({ error: `no loadout ${lid}` });
            // one transaction: the marker, the state write and the rev bump
            // cannot interleave with a queued /slot/panel. _mutateStateNow
            // (the store's non-queued state-write body) persists the mutated
            // state HERE, before the response — a plugin restart must not
            // resurrect the previous preset (Review 3: the transaction used
            // to exist only in memory).
            await store.enqueue(() => {
                store._markSlotChanged();
                return store._mutateStateNow((/** @type {any} */ st) => {
                    st.presetId = presetId;
                    st.loadoutId = lid;
                });
            });
            const view = slotView(req);
            broadcast(req, 'slot', null);
            res.json(view);
        } catch (err) { next(err); }
    });

    router.post('/slot/model', async (req, res, next) => {
        try {
            const { modelId, raw } = req.body ?? {};
            const store = req.pm.store;
            // same transaction shape as /slot/load: the state write lands on
            // disk inside the queue turn (see the load comment above)
            await store.enqueue(() => {
                store._markSlotChanged();
                return store._mutateStateNow((/** @type {any} */ st) => {
                    st.modelId = modelId ?? null;
                    if (raw) st.raw = raw;
                });
            });
            const view = slotView(req);
            broadcast(req, 'slot', null);
            res.json(view);
        } catch (err) { next(err); }
    });

    router.post('/slot/panel', async (req, res, next) => {
        try {
            const { clientId, baseRev, base, snapshot } = req.body ?? {};
            const store = req.pm.store;
            if (typeof baseRev !== 'number' || !base || typeof base !== 'object') {
                return res.status(409).json({ error: 'missing baseRev or base panel projection' });
            }
            // ONE store-queue transaction: the stale check, the current
            // compile, the delta routing and every resulting write observe
            // the same state and cannot interleave with another queued
            // mutation (e.g. a /slot/load queued ahead of this post must
            // turn the guard stale BEFORE the deltas route, not after the
            // save). Queue order and the 409 decision are identical.
            const view = await store.enqueue(/** @returns {Promise<{routed: {key: string, layer: string}[], warnings: string[]}>} */ async () => {
                const doc = store.state.presetId
                    ? store.getDocNow(/** @type {string} */ (store.state.presetId))
                    : null;
                if (!doc) throw new StoreError('no preset in the slot', 409);
                // Stale desired-state guard: if the desired preset or loadout
                // changed after the client's base snapshot was taken, the panel
                // delta was diffed against a different document — replaying it
                // here would pour the OLD preset's fields into the NEW one. The
                // client must re-reconcile and re-base instead (409).
                if ((store.slotChangedRev ?? 0) > baseRev) {
                    throw new StoreError('stale: desired preset or loadout changed after baseRev', 409, {
                        stale: true,
                        slotChangedRev: store.slotChangedRev ?? 0,
                    });
                }
                const clean = stripConnectionKeys(snapshot ?? {});
                const cleanBase = stripConnectionKeys(base);
                const model = resolveModel(store.models, rawOf(store));
                // route against the loadout the tab is actually showing (the
                // desired one), not the document's active default
                const desiredLoadout = /** @type {string} */ (store.state.loadoutId ?? doc.activeLoadoutId);
                const { compiled: currentCompiled } = compile(doc, model, readBase(req), desiredLoadout);
                // DELTA = what the USER changed in the panel (base -> snapshot),
                // as a semantic delta (per identifier/field/key): concurrent
                // API edits to other blocks, bits or keys survive. Most recent
                // wins per field, never wholesale.
                const delta = panelDelta(cleanBase, clean);
                if (delta === null) {
                    // Panel section shape damage (missing prompt_order/prompts)
                    // cannot be diffed field-wise; reject rather than guess.
                    throw new StoreError('snapshot or base lost prompt_order/prompts structure', 409);
                }
                const { routed, globalTuning, warnings } = routePanelDiff(doc, currentCompiled, delta, model, desiredLoadout);
                // A panel observation that routes nothing is not a revision:
                // saving unconditionally here turned every echo of our own apply
                // into doc.rev+1 and fed the apply<->panel loop.
                if (routed.length > 0 || globalTuning) {
                    await store._savePresetNow(doc);
                    if (globalTuning && model) {
                        await store._mutateModelsNow((/** @type {any} */ reg) => {
                            reg.models[model.name].tuning = { ...reg.models[model.name].tuning, ...globalTuning };
                        });
                    }
                }
                return { routed, warnings };
            });
            const slot = slotView(req);
            for (const w of view.warnings) {
                req.pm.hub.broadcast({ rev: store.rev, kind: 'warning', message: w });
            }
            if (view.routed.length > 0) {
                broadcast(req, 'slot', null, clientId);
            }
            res.json({ rev: slot.rev, slotChangedRev: slot.slotChangedRev, compiled: slot.compiled, hash: slot.hash, routed: view.routed });
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
 * @param {string|null} [origin] clientId to suppress (echo suppression)
 */
function broadcast(req, kind, presetId = null, origin = null) {
    req.pm.hub.broadcast({
        rev: req.pm.store.rev,
        kind,
        ...(presetId ? { presetId } : {}),
    }, origin);
}

export { TUNING_KEYS, canonicalHash };
