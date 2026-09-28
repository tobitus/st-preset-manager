/**
 * Library store: the fs-backed preset library + global files (models.json,
 * state.json, shelf/, revisions/). Layout (PLAN §1.2):
 *
 *   <root>/presets/<folder>/<Name>.json    one native document per preset
 *   <root>/models.json  state.json  shelf/  revisions/<presetId>/<docRev>.json
 *
 * All writes are tmp+rename atomic; every mutation runs through one promise
 * queue (single writer). `rev` on state.json is the global monotonic counter
 * bumped by every mutation of any file. Multi-file transactions (a doc plus
 * models.json, or several docs together) go through `_commit`: it writes
 * every file first and only then, with no `await` in between, swaps
 * `index`/`models`/`state` in memory in one synchronous instant — a failed
 * write restores whatever it already wrote and leaves memory untouched.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validateDoc, validateRegistry, nativeShapeErrors } from '../shared/schema.js';
import { canonicalHash, newId, ulid } from '../shared/util.js';
import { ensureAllLeaves, completeOverride, iterLeaves, collectGroups } from '../shared/groups.js';
import { ImportError, importStPreset, assertStPreset } from '../shared/recognizers.js';
import { rebuildSeq, flattenSeq, deriveStructure } from '../shared/outline.js';
import { resolveModel, seedFromProfiles, mergeModels } from '../shared/models.js';
import { TUNING_KEYS } from '../shared/st-keys.js';

export class StoreError extends Error {
    /**
     * @param {string} message
     * @param {number} [status]
     * @param {Record<string, unknown>} [extra] additional JSON body fields
     *   the error middleware merges into the response (e.g. the stale 409's
     *   `slotChangedRev`)
     */
    constructor(message, status = 400, extra = undefined) {
        super(message);
        this.status = status;
        if (extra) Object.assign(this, extra);
    }
}

/** @param {string} name */
export function sanitizeName(name) {
    const s = String(name ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .trim();
    if (!s) throw new StoreError('empty preset name');
    return s;
}

function atomicWriteSync(/** @type {string} */ file, /** @type {string} */ data) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

async function atomicWrite(/** @type {string} */ file, /** @type {string} */ data) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
}

/** @param {any} value */
function isPlainObject(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export class Store {
    /** @param {string} root plugin data root (<user>/preset-manager) */
    constructor(root) {
        this.root = root;
        // absolute: _safeDir compares resolved paths against it (ST's data
        // root can be relative to the server's cwd)
        this.presetsDir = path.resolve(path.join(root, 'presets'));
        this.shelfDir = path.join(root, 'shelf');
        this.revisionsDir = path.join(root, 'revisions');
        this.modelsFile = path.join(root, 'models.json');
        this.stateFile = path.join(root, 'state.json');
        /** @type {Map<string, {id: string, path: string, name: string, folder: string, tags: string[], updatedAt: string, doc: any}>} */
        this.index = new Map();
        /** @type {Promise<any>} tail of the single-writer queue */
        this._queue = Promise.resolve();
        /** @type {number} */
        this.rev = 0;
        /** @type {number} Global rev at the last change of the DESIRED slot
         * (preset or loadout). /slot/panel 409s when the client's baseRev
         * predates it: the panel delta was diffed against a preset that is
         * no longer the desired one, so replaying it onto the current
         * document would pour the old preset's state into the new one. */
        this.slotChangedRev = 0;
    }

    /** Serialize a mutation. @param {() => any} fn */
    enqueue(fn) {
        const run = this._queue.then(fn);
        // keep the queue alive after rejections
        this._queue = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * Resolve a document's `folder` to a directory under presetsDir.
     * Rejects absolute paths and any path that escapes the preset root
     * (`..` segments); presets are user data — the plugin must never write
     * outside its own root (roadmap Must-NOT).
     * @param {string|undefined} folder
     * @returns {string} absolute directory for the preset file
     */
    _safeDir(folder) {
        const raw = String(folder ?? '');
        if (raw.includes('\\')) throw new StoreError(`invalid folder "${folder}": path separators must be "/"`);
        if (path.isAbsolute(raw)) throw new StoreError(`invalid folder "${folder}": absolute paths are not allowed`);
        const rel = raw.trim().replace(/^\/+|\/+$/g, '');
        const dir = path.resolve(this.presetsDir, rel);
        if (dir !== this.presetsDir && !dir.startsWith(this.presetsDir + path.sep)) {
            throw new StoreError(`invalid folder "${folder}": escapes the preset library`);
        }
        return dir;
    }

    // ------------------------------------------------------------- bootstrap

    async init() {
        for (const d of [this.presetsDir, this.shelfDir, this.revisionsDir]) {
            fs.mkdirSync(d, { recursive: true });
        }
        if (!fs.existsSync(this.modelsFile)) {
            atomicWriteSync(this.modelsFile, JSON.stringify({ version: 1, models: {} }, null, 2));
        }
        if (!fs.existsSync(this.stateFile)) {
            atomicWriteSync(this.stateFile, JSON.stringify({
                rev: 0,
                presetId: null,
                loadoutId: null,
                modelId: null,
                updatedAt: new Date().toISOString(),
                lastCompiledHash: null,
            }, null, 2));
        }
        this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.models = JSON.parse(fs.readFileSync(this.modelsFile, 'utf8'));
        this.rev = this.state.rev ?? 0;
        this.slotChangedRev = this.state.slotChangedRev ?? 0;
        await this.rescan();
    }

    /**
     * Bump the global rev and persist it. Queue-transaction callers use the
     * `_mutateStateNow`/`_savePresetNow` bodies, which write the primary
     * file and then call this, so `rev` and `slotChangedRev` land on disk
     * with the state they describe.
     */
    async _bumpRev() {
        this.rev += 1;
        this.state.rev = this.rev;
        this.state.updatedAt = new Date().toISOString();
        await atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2));
    }

    /**
     * Mark the desired slot as changed (preset swapped or loadout switched):
     * records the global rev the change happened at, so /slot/panel can
     * reject stale panel deltas with 409. Call from inside mutateState
     * callbacks or store-queue transactions (single-writer), BEFORE the
     * callback's own mutations: the marker must name the rev where the
     * change becomes visible, i.e. the rev this mutation bumps to.
     */
    _markSlotChanged() {
        this.slotChangedRev = this.rev + 1;
        this.state.slotChangedRev = this.slotChangedRev;
    }

    /**
     * Publish a multi-file transaction atomically: validates everything
     * first (a bad registry or doc throws before any write), snapshots a
     * revision of each touched doc, writes every file, and only then, with
     * no `await` in between, swaps `index`/`models`/`state` into memory in
     * one synchronous instant. A write failure restores every file this
     * call already wrote (best effort) and rethrows — memory stays
     * untouched. Call only from inside the store queue (single writer);
     * never call directly from a route. Docs must already be indexed and
     * keep their name/folder (this is a content transaction, not a
     * rename/move — `_savePresetNow` handles those).
     * @param {{ registry?: any, docs?: any[], revisionLabel?: string }} [opts]
     */
    async _commit({ registry = undefined, docs = [], revisionLabel = undefined } = {}) {
        if (registry !== undefined) {
            const errs = validateRegistry(registry);
            if (errs.length) throw new StoreError(`invalid registry: ${errs.join(', ')}`, 400);
        }
        for (const doc of docs) {
            const errs = validateDoc(doc);
            if (errs.length) throw new StoreError(`invalid document: ${errs.join(', ')}`, 400);
        }
        /** @type {{ entry: any, doc: any }[]} */
        const targets = [];
        for (const doc of docs) {
            const entry = this.index.get(doc.id);
            if (!entry) throw new StoreError(`preset ${doc.id} not found`, 404);
            if (sanitizeName(doc.name) !== sanitizeName(entry.name) || path.resolve(this._safeDir(doc.folder ?? '')) !== path.resolve(path.dirname(entry.path))) {
                throw new StoreError(`_commit cannot rename or move ${doc.id}`, 400);
            }
            targets.push({ entry, doc });
        }

        for (const { entry, doc } of targets) {
            await this._writeRevision(entry.doc, revisionLabel);
            doc.rev = (entry.doc.rev ?? 0) + 1;
            doc.updatedAt = new Date().toISOString();
        }

        const nextState = structuredClone(this.state);
        nextState.rev = this.rev + 1;
        nextState.updatedAt = new Date().toISOString();

        /** @type {{ file: string, prev: string|null }[]} */
        const written = [];
        try {
            for (const { entry, doc } of targets) {
                const prev = fs.existsSync(entry.path) ? await fsp.readFile(entry.path, 'utf8') : null;
                await atomicWrite(entry.path, JSON.stringify(doc, null, 2) + '\n');
                written.push({ file: entry.path, prev });
            }
            if (registry !== undefined) {
                const prev = fs.existsSync(this.modelsFile) ? await fsp.readFile(this.modelsFile, 'utf8') : null;
                await atomicWrite(this.modelsFile, JSON.stringify(registry, null, 2));
                written.push({ file: this.modelsFile, prev });
            }
            {
                const prev = fs.existsSync(this.stateFile) ? await fsp.readFile(this.stateFile, 'utf8') : null;
                await atomicWrite(this.stateFile, JSON.stringify(nextState, null, 2));
                written.push({ file: this.stateFile, prev });
            }
        } catch (err) {
            for (const { file, prev } of written) {
                try {
                    if (prev === null) await fsp.rm(file, { force: true });
                    else await atomicWrite(file, prev);
                } catch { /* best effort restore */ }
            }
            throw err;
        }

        for (const { entry, doc } of targets) {
            this.index.set(doc.id, { ...entry, updatedAt: doc.updatedAt, tags: doc.tags ?? [], doc: structuredClone(doc) });
        }
        if (registry !== undefined) this.models = registry;
        this.state = nextState;
        this.rev = nextState.rev;
    }

    // ------------------------------------------------------------------ scan

    async rescan() {
        /** @type {Map<string, any>} */
        const next = new Map();
        const walk = (/** @type {string} */ dir, /** @type {string} */ rel) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                // directories first: a folder named e.g. "notes.json" must
                // still be traversed (folders are library folders)
                if (ent.isDirectory()) {
                    walk(full, rel ? `${rel}/${ent.name}` : ent.name);
                    continue;
                }
                if (!ent.name.endsWith('.json')) continue;
                let doc;
                try {
                    doc = JSON.parse(fs.readFileSync(full, 'utf8'));
                } catch {
                    continue; // unreadable entries are skipped, not fatal (v1 rule)
                }
                if (doc?.format !== 'st-preset-manager/library') continue;
                // v1 `load_canonical`: derive structure on every load so
                // rank ops are byte-exact invertible and hand-edited files
                // normalize too (no-op for docs the store wrote itself).
                deriveStructure(doc);
                stripLeafEnabled(doc); // legacy files: bits belong to loadouts only
                next.set(doc.id, {
                    id: doc.id,
                    path: full,
                    name: doc.name,
                    folder: rel,
                    tags: doc.tags ?? [],
                    updatedAt: doc.updatedAt,
                    doc,
                });
            }
        };
        walk(this.presetsDir, '');
        this.index = next;
    }

    // --------------------------------------------------------------- listing

    /** @param {string} [tag] */
    listLibrary(tag) {
        const items = [...this.index.values()].map((e) => ({
            id: e.id,
            name: e.name,
            folder: e.folder,
            tags: e.tags,
            updatedAt: e.updatedAt,
            activeLoadoutId: e.doc.activeLoadoutId,
            loadouts: Object.values(e.doc.loadouts ?? {}).map((l) => ({ id: l.id, name: l.name })),
            hasOverrides: Object.keys(e.doc.tuningOverrides ?? {}),
        }));
        items.sort((a, b) => (a.folder + '/' + a.name).toLowerCase().localeCompare((b.folder + '/' + b.name).toLowerCase()));
        if (tag) return items.filter((i) => i.tags.includes(tag));
        return items;
    }

    /** @param {string} id */
    getPreset(id) {
        const entry = this.index.get(id);
        if (!entry) throw new StoreError(`preset ${id} not found`, 404);
        return structuredClone(entry.doc);
    }

    /**
     * Write a NEW document (fork) inside an existing queue transaction:
     * validates, refuses a taken name, writes the file and indexes it. No
     * revision snapshot (the fork's first revision is its first save) and
     * no rename logic (a new file by definition). Call from inside the
     * queue only — same single-writer rule as _savePresetNow.
     * @param {any} doc
     */
    async _writeNewDocNow(doc) {
        const errs = validateDoc(doc);
        if (errs.length) throw new StoreError(`invalid document: ${errs.join(', ')}`);
        const existing = this.findByName(doc.name);
        if (existing) {
            throw Object.assign(new StoreError(`name "${doc.name}" is already taken`, 409), { conflict: existing.id });
        }
        await this._writeDoc(doc, this._safeDir(doc.folder ?? ''));
        return structuredClone(doc);
    }

    /**
     * The slot's preset document WITHOUT the queue (for callers already
     * inside a store-queue transaction): same content as getPreset, minus
     * the queue-tail latency and the not-found StoreError (callers check
     * `null` instead — the panel route answers 409 on it).
     * @param {string} id
     * @returns {any|null}
     */
    getDocNow(id) {
        const entry = this.index.get(id);
        if (!entry) return null;
        return structuredClone(entry.doc);
    }

    /** @param {string} name */
    findByName(name) {
        for (const entry of this.index.values()) {
            if (entry.name === name) return entry;
        }
        return null;
    }

    // ---------------------------------------------------------------- import

    /**
     * Import an ST preset (runs recognizers) or accept a native doc.
     * Replacing an existing name (`replace: true`) keeps the replaced
     * document's identity: id, createdAt, revision history and, if it was
     * bound to the working slot, that binding. A fresh id is minted only
     * for a true copy (new name, or a native id already taken by another
     * document).
     * @param {{ st?: any, native?: any, name?: string, folder?: string, tags?: string[], replace?: boolean, sourceRef?: string }} body
     */
    async importPreset(body) {
        return this.enqueue(async () => {
            let doc;
            if (body.native) {
                const errs0 = nativeShapeErrors(body.native);
                if (errs0.length) throw new StoreError(`invalid native document: ${errs0.join(', ')}`);
                doc = structuredClone(body.native);
                doc.id = (typeof doc.id === 'string' && doc.id && !this.index.has(doc.id)) ? doc.id : `p_${ulid()}`;
                doc.rev = (Number.isInteger(doc.rev) && doc.rev > 0) ? doc.rev : 1;
                doc.createdAt = typeof doc.createdAt === 'string' ? doc.createdAt : new Date().toISOString();
                doc.updatedAt = typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString();
                // an explicit name imports the document as a copy under that name
                if (body.name !== undefined) doc.name = sanitizeName(body.name);
                if (!doc.loadouts || Object.keys(doc.loadouts).length === 0) {
                    ensureDefaultLoadout(doc);
                }
                stripLeafEnabled(doc); // native uploads may still carry leaf bits
            } else if (body.st) {
                assertStPreset(body.st, body.name ?? 'preset');
                const name = sanitizeName(body.name ?? body.st.name);
                doc = importStPreset(body.st, name);
                doc.id = `p_${ulid()}`;
                doc.source.importedFrom = body.sourceRef ?? 'upload:api';
                doc.source.importedAt = new Date().toISOString();
                doc.source.importDigest = canonicalHash({ settings: doc.settings, markers: doc.markers, blocks: doc.blocks, sequences: doc.sequences });
                if (Array.isArray(body.tags)) doc.tags = body.tags.map(String);
                ensureDefaultLoadout(doc);
                doc.createdAt = new Date().toISOString();
                doc.updatedAt = doc.createdAt;
                doc.rev = 1;
                doc.activeLoadoutId = Object.keys(doc.loadouts)[0];
            } else {
                throw new StoreError('body must carry {st, name} or {native}');
            }
            // effective folder: an explicit body.folder wins, otherwise the
            // native doc's own folder; validate it now, BEFORE any lookup
            // or write touches the existing document (a bad folder must
            // never delete history)
            doc.folder = String(body.folder !== undefined ? body.folder : (doc.folder ?? ''));
            this._safeDir(doc.folder);
            // normalize structure so outline ops are byte-exact from the start (v1 derive_structure)
            for (const seq of doc.sequences) seq.rows = rebuildSeq(flattenSeq(seq.rows));
            const errs = validateDoc(doc);
            if (errs.length) {
                const label = body.native ? 'invalid native document' : 'invalid imported document';
                throw new StoreError(`${label}: ${errs.join(', ')}`);
            }

            const existing = this.findByName(doc.name);
            if (existing && !body.replace) {
                throw Object.assign(new StoreError(`name "${doc.name}" is already taken`, 409), { conflict: existing.id });
            }
            if (existing && body.replace) {
                // replace in place: the new content becomes the next
                // revision of the SAME document (same id, same createdAt,
                // history and slot binding kept)
                doc.id = existing.id;
                doc.createdAt = existing.doc.createdAt;
                const desired = this.state.presetId === existing.id;
                // GET /slot reads this.index + this.state OUTSIDE the store
                // queue, so the slot-changed marker and the loadout-id
                // fallback must land in the SAME synchronous instant the
                // new doc is published into this.index — not before (the
                // old doc is still indexed) and not after (a reader could
                // observe the new doc with a stale loadout id in between).
                // onPublish runs synchronously right after this.index.set.
                const saved = await this._savePresetNow(doc, {
                    onPublish: (indexedDoc) => {
                        if (!desired) return;
                        this._markSlotChanged();
                        if (this.state.loadoutId && !Object.prototype.hasOwnProperty.call(indexedDoc.loadouts ?? {}, this.state.loadoutId)) {
                            // the slot's loadout id no longer exists in the
                            // new document (an ST re-import re-mints
                            // loadout ids): fall back to the doc's active
                            // loadout. _bumpRev() right after this persists
                            // this.state to disk with the matching rev.
                            this.state.loadoutId = null;
                        }
                    },
                });
                return saved;
            }
            if (this.index.has(doc.id)) {
                // a native upload whose id is already taken, under a name
                // that isn't: it's a copy, mint it a fresh id
                doc.id = `p_${ulid()}`;
            }
            await this._writeDoc(doc, this._safeDir(doc.folder));
            await this._bumpRev();
            return structuredClone(doc);
        });
    }

    // ------------------------------------------------------------------ save

    /**
     * Write a document (validated), snapshotting a revision first.
     * @param {any} doc
     * @param {{ label?: string }} [opts]
     */
    async savePreset(doc, opts = {}) {
        return this.enqueue(() => this._savePresetNow(doc, opts));
    }

    /**
     * Body of savePreset WITHOUT taking the queue: call from inside a
     * store-queue transaction that must read state, validate and write as
     * one atomic operation (e.g. /slot/panel's stale check + delta routing
     * + save). Never call outside the queue — the single-writer invariant
     * is what makes its reads trustworthy.
     * @param {any} doc
     * @param {{ label?: string, onPublish?: (indexedDoc: any) => void }} [opts]
     */
    async _savePresetNow(doc, opts = {}) {
        {
            const errs = validateDoc(doc);
            if (errs.length) throw new StoreError(`invalid document: ${errs.join(', ')}`);
            const entry = this.index.get(doc.id);
            if (!entry) throw new StoreError(`preset ${doc.id} not found`, 404);
            const oldNamePath = entry.path;
            doc.updatedAt = new Date().toISOString();
            doc.rev = (entry.doc.rev ?? 0) + 1;
            await this._writeRevision(entry.doc, opts.label);
            // rename = move (name or folder change)
            const newPath = path.join(this._safeDir(doc.folder), `${sanitizeName(doc.name)}.json`);
            if (path.resolve(newPath) !== path.resolve(oldNamePath)) {
                if (fs.existsSync(newPath)) throw new StoreError(`target file already exists: ${newPath}`, 409);
                await fsp.mkdir(path.dirname(newPath), { recursive: true });
                await fsp.rename(oldNamePath, newPath);
            }
            await this._writeDoc(doc, path.dirname(newPath), opts.onPublish);
            await this._bumpRev();
            return structuredClone(doc);
        }
    }

    /** @param {string} id */
    async deletePreset(id) {
        return this.enqueue(async () => {
            const entry = this.index.get(id);
            if (!entry) throw new StoreError(`preset ${id} not found`, 404);
            await fsp.rm(entry.path, { force: true });
            await fsp.rm(path.join(this.revisionsDir, id), { recursive: true, force: true });
            this.index.delete(id);
            await this._bumpRev();
        });
    }

    // --------------------------------------------------------- doc patches

    /**
     * Patch a preset's tuning override for a Model: semantic
     * `{set?: {key: value}, unset?: [key]}`, applied inside the store
     * queue (never a whole cached object). 404 when no override exists for
     * that Model.
     * @param {string} presetId
     * @param {string} name
     * @param {{ set?: Record<string, any>, unset?: string[] }} patch
     */
    async patchTuningOverride(presetId, name, patch) {
        return this.enqueue(async () => {
            const doc = this.getDocNow(presetId);
            if (!doc) throw new StoreError(`preset ${presetId} not found`, 404);
            if (doc.tuningOverrides?.[name] === undefined) {
                throw new StoreError(`no tuning override for ${name}`, 404);
            }
            Store._validatePatch(patch, TUNING_KEYS, (k) => `"${k}" is not a tuning key`);
            const next = { ...doc.tuningOverrides[name] };
            for (const k of patch.unset ?? []) delete next[k];
            Object.assign(next, patch.set ?? {});
            doc.tuningOverrides[name] = next;
            return this._savePresetNow(doc);
        });
    }

    /**
     * Patch a loadout's per-Model override: semantic
     * `{set?: {identifier: bool}, unset?: [identifier]}`, applied inside
     * the store queue. 404 when the preset, loadout or override is
     * missing, or an identifier names an unknown leaf (same rule as the
     * PUT route).
     * @param {string} presetId
     * @param {string} lid
     * @param {string} name
     * @param {{ set?: Record<string, any>, unset?: string[] }} patch
     */
    async patchLoadoutOverride(presetId, lid, name, patch) {
        return this.enqueue(async () => {
            const doc = this.getDocNow(presetId);
            if (!doc) throw new StoreError(`preset ${presetId} not found`, 404);
            const loadout = doc.loadouts?.[lid];
            if (!loadout) throw new StoreError(`no loadout ${lid}`, 404);
            const cur = loadout.overrides?.[name];
            if (cur === undefined) throw new StoreError(`no override for ${name}`, 404);
            if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
                throw new StoreError('patch must be an object', 400);
            }
            for (const k of Object.keys(patch)) {
                if (k !== 'set' && k !== 'unset') throw new StoreError(`unknown patch field "${k}"`, 400);
            }
            const { set, unset } = patch;
            if (set !== undefined && !isPlainObject(set)) {
                throw new StoreError('patch.set must be a plain object', 400);
            }
            if (unset !== undefined && !Array.isArray(unset)) {
                throw new StoreError('patch.unset must be an array', 400);
            }
            for (const [id, v] of Object.entries(set ?? {})) {
                if (typeof v !== 'boolean') throw new StoreError(`override.${id} must be a boolean`, 400);
            }
            const leaves = new Set(iterLeaves(doc).map((/** @type {any} */ l) => l.ref ?? l.identifier));
            for (const id of [...Object.keys(set ?? {}), ...(unset ?? [])]) {
                if (!leaves.has(id)) throw new StoreError(`unknown leaf ${id}`, 404);
            }
            const next = { ...cur.enabled };
            for (const id of unset ?? []) delete next[id];
            for (const [id, v] of Object.entries(set ?? {})) {
                delete next[id];
                next[id] = v;
            }
            loadout.overrides[name] = { enabled: completeOverride(doc, next) };
            return this._savePresetNow(doc);
        });
    }

    /**
     * @param {any} doc @param {string} dir
     * @param {((indexedDoc: any) => void)|undefined} [onPublish] invoked
     *   synchronously right after the doc is published into `this.index`,
     *   with no `await` in between. GET /slot reads `this.index` +
     *   `this.state` OUTSIDE the store queue, so a caller that needs a
     *   state change (e.g. slot-changed marker, loadout fallback) to be
     *   visible in the SAME instant the new doc becomes visible must do
     *   it here, not after this call returns.
     */
    async _writeDoc(doc, dir, onPublish = undefined) {
        const file = path.join(dir, `${sanitizeName(doc.name)}.json`);
        await atomicWrite(file, JSON.stringify(doc, null, 2) + '\n');
        const indexed = {
            id: doc.id,
            path: file,
            name: doc.name,
            folder: path.relative(this.presetsDir, dir),
            tags: doc.tags ?? [],
            updatedAt: doc.updatedAt,
            doc: structuredClone(doc),
        };
        this.index.set(doc.id, indexed);
        if (onPublish) onPublish(indexed.doc);
    }

    // ------------------------------------------------------------- revisions

    /**
     * Full snapshot, coalesced: a newest snapshot < 5 min old without a label
     * is replaced; labelled saves always write. Newest 200 kept.
     * @param {any} doc snapshot body (pre-mutation)
     * @param {string} [label]
     */
    async _writeRevision(doc, label) {
        const dir = path.join(this.revisionsDir, doc.id);
        await fsp.mkdir(dir, { recursive: true });
        // numeric order: filenames sort lexicographically (9.json > 10.json),
        // and the count is wrong once pruning removes old files
        const revNumbers = fs.readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => Number(f.slice(0, -5)))
            .filter((n) => Number.isInteger(n) && n > 0)
            .sort((a, b) => a - b);
        const newest = revNumbers.at(-1);
        let coalesce = false;
        if (newest !== undefined && !label) {
            const snap = JSON.parse(await fsp.readFile(path.join(dir, `${newest}.json`), 'utf8'));
            const age = Date.now() - new Date(snap.at).getTime();
            if (!snap.label && age < 5 * 60 * 1000) coalesce = true;
        }
        const revNo = coalesce ? newest : (newest ?? 0) + 1;
        const body = {
            rev: revNo,
            at: new Date().toISOString(),
            label: label ?? null,
            doc: label === undefined ? doc : doc, // full document snapshot
        };
        const file = path.join(dir, `${revNo}.json`);
        await atomicWrite(file, JSON.stringify(body, null, 2));
        // prune to newest 200
        const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
        for (const f of all.slice(0, Math.max(0, all.length - 200))) {
            await fsp.rm(path.join(dir, f), { force: true });
        }
    }

    /** @param {string} presetId */
    listRevisions(presetId) {
        const dir = path.join(this.revisionsDir, presetId);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
            .map((s) => ({ rev: s.rev, at: s.at, label: s.label }))
            .sort((a, b) => a.rev - b.rev);
    }

    /** @param {string} presetId @param {number} revNo */
    getRevision(presetId, revNo) {
        const file = path.join(this.revisionsDir, presetId, `${revNo}.json`);
        if (!fs.existsSync(file)) throw new StoreError(`revision ${revNo} of ${presetId} not found`, 404);
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }

    // ---------------------------------------------------------------- models

    /** @param {(reg: any) => any} fn */
    async mutateModels(fn) {
        return this.enqueue(() => this._mutateModelsNow(fn));
    }

    /**
     * Body of mutateModels WITHOUT taking the queue: compose inside ONE
     * store-queue transaction (see _savePresetNow). Publishes through
     * `_commit`, so validation runs and every write lands before `models`
     * changes in memory. Never call outside the queue.
     * @param {(reg: any) => any} fn
     */
    async _mutateModelsNow(fn) {
        const reg = structuredClone(this.models);
        const result = await fn(reg);
        await this._commit({ registry: reg });
        return result;
    }

    /**
     * Seed the registry from ST connection profiles: one Model per distinct
     * raw id not already resolved by the registry. A re-seed of the same
     * profiles adds nothing and performs no write (no rev bump).
     * @param {any[]} profiles
     */
    async seedModels(profiles) {
        return this.enqueue(async () => {
            if (!Array.isArray(profiles)) throw new StoreError('profiles must be an array', 400);
            const { models: fresh, mergeSuggestions } = seedFromProfiles(profiles, this.models);
            if (Object.keys(fresh).length === 0) {
                return { added: [], models: this.models.models, mergeSuggestions };
            }
            await this._mutateModelsNow((reg) => { Object.assign(reg.models, fresh); });
            return { added: Object.keys(fresh), models: this.models.models, mergeSuggestions };
        });
    }

    /**
     * Replace the whole registry (validated). Registry writes never mark
     * the slot changed or touch state — a panel base is never invalidated
     * by a Model/registry change; each panel post carries the raw its base
     * was compiled for and routes by that.
     * @param {any} reg
     */
    async replaceModels(reg) {
        return this.enqueue(() => this._mutateModelsNow((r) => {
            r.version = reg.version;
            r.models = structuredClone(reg.models);
            return structuredClone(r);
        }));
    }

    /**
     * Replace one Model's global tuning wholesale.
     * @param {string} name
     * @param {any} tuning
     */
    async setModelTuning(name, tuning) {
        return this.enqueue(async () => {
            if (!this.models.models[name]) throw new StoreError(`Model ${name} not found`, 404);
            if (typeof tuning !== 'object' || tuning === null || Array.isArray(tuning)) {
                throw new StoreError('tuning must be an object', 400);
            }
            for (const k of Object.keys(tuning)) {
                if (!TUNING_KEYS.includes(k)) throw new StoreError(`"${k}" is not a tuning key`, 400);
            }
            await this._mutateModelsNow((reg) => { reg.models[name].tuning = { ...tuning }; });
            return structuredClone(this.models.models[name]);
        });
    }

    /**
     * Rename a Model, migrating every document reference: any
     * `tuningOverrides[from]` or `loadouts[*].overrides[from]` moves to
     * `to` (replacing an existing `to` key). One `_commit` transaction: a
     * labelled revision of each touched doc is snapshotted first.
     * @param {string} from
     * @param {string} to
     * @returns {Promise<{ models: Record<string, any>, migrated: string[] }>}
     */
    async renameModel(from, to) {
        return this.enqueue(async () => {
            if (!this.models.models[from]) throw new StoreError(`Model ${from} not found`, 404);
            const trimmed = String(to ?? '').trim();
            if (!trimmed) throw new StoreError('renameModel needs a non-empty name', 400);
            if (from === trimmed) return { models: this.models.models, migrated: [] };
            if (this.models.models[trimmed]) throw new StoreError(`name "${trimmed}" is already used by another Model`, 400);

            const reg = structuredClone(this.models);
            /** @type {Record<string, any>} */
            const models = {};
            for (const key of Object.keys(reg.models)) {
                if (key === from) {
                    const entry = reg.models[key];
                    entry.name = trimmed;
                    models[trimmed] = entry;
                } else {
                    models[key] = reg.models[key];
                }
            }
            reg.models = models;

            /** @type {any[]} */
            const docs = [];
            for (const entry of this.index.values()) {
                const doc = structuredClone(entry.doc);
                let touched = false;
                if (doc.tuningOverrides && Object.prototype.hasOwnProperty.call(doc.tuningOverrides, from)) {
                    doc.tuningOverrides[trimmed] = doc.tuningOverrides[from];
                    delete doc.tuningOverrides[from];
                    touched = true;
                }
                for (const loadout of Object.values(doc.loadouts ?? {})) {
                    if (loadout.overrides && Object.prototype.hasOwnProperty.call(loadout.overrides, from)) {
                        loadout.overrides[trimmed] = loadout.overrides[from];
                        delete loadout.overrides[from];
                        touched = true;
                    }
                }
                if (touched) docs.push(doc);
            }

            await this._commit({ registry: reg, docs, revisionLabel: `Model rename: ${from} -> ${trimmed}` });
            return { models: this.models.models, migrated: docs.map((d) => d.id) };
        });
    }

    /**
     * Merge Models under one name, migrating every document reference: the
     * union of `tuningOverrides`/loadout `overrides` keyed by any merged
     * name (first-listed wins on conflict), moved to `name`. One `_commit`
     * transaction: a labelled revision of each touched doc is snapshotted
     * first.
     * @param {string[]} names Model names to merge, in precedence order
     * @param {string} name the merged Model's name
     * @returns {Promise<{ models: Record<string, any>, migrated: string[] }>}
     */
    async mergeModelsTx(names, name) {
        return this.enqueue(async () => {
            let reg;
            try {
                reg = mergeModels(this.models, names, name);
            } catch (err) {
                throw new StoreError(/** @type {Error} */ (err).message, 400);
            }
            const target = String(name).trim();

            /** @type {any[]} */
            const docs = [];
            for (const entry of this.index.values()) {
                const doc = structuredClone(entry.doc);
                let touched = false;

                if (doc.tuningOverrides && names.some((n) => Object.prototype.hasOwnProperty.call(doc.tuningOverrides, n))) {
                    /** @type {Record<string, any>} */
                    const merged = {};
                    for (let i = names.length - 1; i >= 0; i -= 1) {
                        Object.assign(merged, doc.tuningOverrides[names[i]] ?? {});
                    }
                    for (const n of names) delete doc.tuningOverrides[n];
                    doc.tuningOverrides[target] = merged;
                    touched = true;
                }

                for (const loadout of Object.values(doc.loadouts ?? {})) {
                    if (!loadout.overrides || !names.some((n) => Object.prototype.hasOwnProperty.call(loadout.overrides, n))) continue;
                    /** @type {Record<string, boolean>} */
                    const merged = {};
                    /** @type {Record<string, Record<string, boolean>|undefined>} */
                    const originalEnabled = {};
                    for (const n of names) originalEnabled[n] = loadout.overrides[n]?.enabled;
                    for (let i = names.length - 1; i >= 0; i -= 1) {
                        Object.assign(merged, originalEnabled[names[i]] ?? {});
                    }
                    for (const n of names) delete loadout.overrides[n];

                    // pick-one winner: Model precedence (order of `names`)
                    // decides. Walk `names`; for each Model's own override
                    // map `m`, if `m` has any group member true, the last
                    // such member in `m`'s key order wins and we stop. Else
                    // if `m` names every group member and all are false,
                    // that Model explicitly chose none: every member goes
                    // false and we stop. Otherwise that Model didn't decide
                    // (doesn't mention the group, or only some members) —
                    // move to the next Model. If no Model decides, `merged`
                    // is left as-is.
                    for (const grp of collectGroups(doc)) {
                        if (grp.cardinality !== 'pick-one') continue;
                        const members = [];
                        if (grp.header) members.push(grp.header);
                        for (const opt of grp.options ?? []) members.push(opt);
                        const ids = members.map((leaf) => leaf.ref ?? leaf.identifier).filter((id) => id != null);
                        let winner;
                        let decided = false;
                        for (const n of names) {
                            const m = originalEnabled[n];
                            if (!m) continue;
                            let candidate;
                            for (const k of Object.keys(m)) {
                                if (ids.includes(k) && m[k] === true) candidate = k;
                            }
                            if (candidate !== undefined) {
                                winner = candidate;
                                decided = true;
                                break;
                            }
                            const allNamedFalse = ids.every((id) => Object.prototype.hasOwnProperty.call(m, id) && m[id] === false);
                            if (allNamedFalse) {
                                decided = true;
                                break;
                            }
                        }
                        if (decided) {
                            for (const id of ids) merged[id] = id === winner;
                        }
                    }

                    loadout.overrides[target] = { enabled: completeOverride(doc, merged) };
                    touched = true;
                }

                if (touched) docs.push(doc);
            }

            await this._commit({ registry: reg, docs, revisionLabel: `Model merge: ${names.join(' + ')} -> ${target}` });
            return { models: this.models.models, migrated: docs.map((d) => d.id) };
        });
    }

    /**
     * Validate a semantic patch `{set?, unset?}` against a fixed key
     * domain: `set` keys and `unset` entries must all be in `keys`.
     * @param {any} patch
     * @param {readonly string[]} keys
     * @param {(key: string) => string} badKey error message for a key outside `keys`
     */
    static _validatePatch(patch, keys, badKey) {
        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
            throw new StoreError('patch must be an object', 400);
        }
        for (const k of Object.keys(patch)) {
            if (k !== 'set' && k !== 'unset') throw new StoreError(`unknown patch field "${k}"`, 400);
        }
        const { set, unset } = patch;
        if (set !== undefined) {
            if (!isPlainObject(set)) {
                throw new StoreError('patch.set must be a plain object', 400);
            }
            for (const k of Object.keys(set)) {
                if (!keys.includes(k)) throw new StoreError(badKey(k), 400);
            }
        }
        if (unset !== undefined) {
            if (!Array.isArray(unset)) throw new StoreError('patch.unset must be an array', 400);
            for (const k of unset) {
                if (!keys.includes(k)) throw new StoreError(badKey(k), 400);
            }
        }
    }

    /**
     * Patch one Model's global tuning: `{set?: {key: value}, unset?: [key]}`.
     * @param {string} name
     * @param {{ set?: Record<string, any>, unset?: string[] }} patch
     */
    async patchModelTuning(name, patch) {
        return this.enqueue(async () => {
            if (!this.models.models[name]) throw new StoreError(`Model ${name} not found`, 404);
            Store._validatePatch(patch, TUNING_KEYS, (k) => `"${k}" is not a tuning key`);
            await this._mutateModelsNow((reg) => {
                const tuning = { ...reg.models[name].tuning };
                for (const k of patch.unset ?? []) delete tuning[k];
                Object.assign(tuning, patch.set ?? {});
                reg.models[name].tuning = tuning;
            });
            return structuredClone(this.models.models[name]);
        });
    }

    // ----------------------------------------------------------------- state

    /** @param {(state: any) => any} fn */
    async mutateState(fn) {
        return this.enqueue(() => this._mutateStateNow(fn));
    }

    /**
     * Body of mutateState WITHOUT taking the queue: compose with other
     * reads/writes inside ONE store-queue transaction (see _savePresetNow).
     * Never call outside the queue.
     * @param {(state: any) => any} fn
     */
    async _mutateStateNow(fn) {
        {
            const st = structuredClone(this.state);
            await fn(st);
            this.state = st;
            await atomicWrite(this.stateFile, JSON.stringify(st, null, 2));
            await this._bumpRev();
            return structuredClone(st);
        }
    }

    /**
     * Resolve `raw` and set it as the slot's connection id. A canonically
     * identical raw is a no-op (no write, no rev bump). Per-tab connection:
     * this never marks the slot changed — a panel base is never
     * invalidated by a connection report, only by a library load
     * (/slot/load), Re-attach or Unlink.
     * @param {{ source?: string|null, model?: string|null, profileId?: string|null }} raw
     */
    async setSlotModel(raw) {
        return this.enqueue(async () => {
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
                throw new StoreError('raw must be an object', 400);
            }
            const normalized = { source: raw.source ?? null, model: raw.model ?? null, profileId: raw.profileId ?? null };
            const current = this.state.raw ?? { source: null, model: null, profileId: null };
            if (JSON.stringify(current) === JSON.stringify(normalized)) {
                return { changed: false, modelChanged: false, modelId: resolveModel(this.models, normalized)?.name ?? null };
            }
            const prev = resolveModel(this.models, current)?.name ?? null;
            const next = resolveModel(this.models, normalized)?.name ?? null;
            await this._mutateStateNow((st) => {
                st.raw = normalized;
                st.modelId = next;
            });
            return { changed: true, modelChanged: prev !== next, modelId: next };
        });
    }

    // -------------------------------------------------------------- profiles

    /**
     * Snapshot `profiles` verbatim into `<root>/backups/profiles-<iso>.json`
     * (never overwrites an existing file — appends `-2`, `-3`, … instead).
     * @param {any[]} profiles
     */
    async backupProfiles(profiles) {
        return this.enqueue(async () => {
            if (!Array.isArray(profiles)) throw new StoreError('profiles must be an array', 400);
            const dir = path.join(this.root, 'backups');
            await fsp.mkdir(dir, { recursive: true });
            const at = new Date().toISOString();
            const stem = at.replace(/[:.]/g, '-');
            let file = path.join(dir, `profiles-${stem}.json`);
            let n = 2;
            while (fs.existsSync(file)) {
                file = path.join(dir, `profiles-${stem}-${n}.json`);
                n += 1;
            }
            const body = {
                format: 'st-preset-manager/profiles-backup',
                version: 1,
                at,
                profiles,
            };
            await atomicWrite(file, JSON.stringify(body, null, 2));
            return { file, count: profiles.length };
        });
    }

    // ----------------------------------------------------------------- shelf

    /** @param {{ block?: any, fromPresetId?: string, identifier?: string, tags?: string[] }} body */
    async shelfAdd(body) {
        return this.enqueue(async () => {
            let block;
            if (body.block) {
                block = structuredClone(body.block);
            } else if (body.fromPresetId && body.identifier) {
                const doc = this.getPreset(body.fromPresetId);
                block = doc.blocks?.[body.identifier];
                if (!block) throw new StoreError(`no block ${body.identifier} in ${body.fromPresetId}`, 404);
            } else {
                throw new StoreError('shelf add needs {block} or {fromPresetId, identifier}');
            }
            const id = `b_${ulid()}`;
            const entry = {
                id,
                name: block.name ?? body.identifier ?? '(block)',
                content: block.content ?? '',
                role: block.role ?? 'system',
                fields: block.fields ?? {},
                notes: block.notes ?? '',
                tags: body.tags ?? [],
                savedFrom: { presetId: body.fromPresetId ?? null, identifier: body.identifier ?? null },
                savedAt: new Date().toISOString(),
            };
            await atomicWrite(path.join(this.shelfDir, `${id}.json`), JSON.stringify(entry, null, 2));
            await this._bumpRev();
            return entry;
        });
    }

    shelfList() {
        if (!fs.existsSync(this.shelfDir)) return [];
        return fs.readdirSync(this.shelfDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => JSON.parse(fs.readFileSync(path.join(this.shelfDir, f), 'utf8')))
            .sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1));
    }

    /** @param {string} id */
    async shelfRemove(id) {
        return this.enqueue(async () => {
            const file = path.join(this.shelfDir, `${id}.json`);
            if (!fs.existsSync(file)) throw new StoreError(`shelf item ${id} not found`, 404);
            await fsp.rm(file, { force: true });
            await this._bumpRev();
        });
    }
}

/**
 * Delete the legacy per-leaf `enabled` bits from every leaf row in every
 * sequence (leaves of kind marker/block/ghost at any depth, plus `row.header`
 * of groups and sections). Enabled bits live ONLY in loadouts (PLAN Phase 2
 * Must NOT); the import recognizers still set them for cardinality guessing,
 * so the store strips them after the loadout has been built from them.
 * @param {any} doc
 */
export function stripLeafEnabled(doc) {
    const walk = (/** @type {any[]} */ rows) => {
        for (const row of rows) {
            if (['marker', 'block', 'ghost'].includes(row.kind)) {
                delete row.enabled;
            } else if (row.kind === 'section') {
                if (row.header) delete row.header.enabled;
                walk(row.rows ?? []);
            } else if (row.kind === 'group') {
                if (row.header) delete row.header.enabled;
                walk(row.options ?? []);
            }
        }
    };
    for (const seq of doc.sequences ?? []) walk(seq.rows ?? []);
    return doc;
}

/**
 * Build the default loadout from a fresh import: "Current" = every leaf's
 * enabled bit as imported (which mirrors the source's prompt_order bits).
 * @param {any} doc
 */
export function ensureDefaultLoadout(doc) {
    const enabled = {};
    const walk = (/** @type {any[]} */ rows) => {
        for (const row of rows) {
            if (['marker', 'block', 'ghost'].includes(row.kind)) {
                enabled[row.ref ?? row.identifier] = !!row.enabled;
            } else if (row.kind === 'section') {
                if (row.header) enabled[row.header.ref ?? row.header.identifier] = !!row.header.enabled;
                walk(row.rows ?? []);
            } else if (row.kind === 'group') {
                if (row.header) enabled[row.header.ref ?? row.header.identifier] = !!row.header.enabled;
                walk(row.options ?? []);
            }
        }
    };
    for (const seq of doc.sequences ?? []) walk(seq.rows ?? []);
    const lid = `l_${ulid()}`;
    doc.loadouts = {
        [lid]: { id: lid, name: 'Current', notes: '', enabled, overrides: {} },
    };
    doc.activeLoadoutId = lid;
    ensureAllLeaves(doc, doc.loadouts[lid].enabled);
    stripLeafEnabled(doc); // bits live in the loadout now, never on leaf rows
    return doc;
}

export { newId };
