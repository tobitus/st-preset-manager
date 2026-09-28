/**
 * Library store: the fs-backed preset library + global files (models.json,
 * state.json, shelf/, revisions/). Layout (PLAN §1.2):
 *
 *   <root>/presets/<folder>/<Name>.json    one native document per preset
 *   <root>/models.json  state.json  shelf/  revisions/<presetId>/<docRev>.json
 *
 * All writes are tmp+rename atomic; every mutation runs through one promise
 * queue (single writer). `rev` on state.json is the global monotonic counter
 * bumped by every mutation of any file.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validateDoc, validateRegistry } from '../shared/schema.js';
import { canonicalHash, newId, ulid } from '../shared/util.js';
import { ensureAllLeaves } from '../shared/groups.js';
import { ImportError, importStPreset } from '../shared/recognizers.js';
import { rebuildSeq, flattenSeq, deriveStructure } from '../shared/outline.js';

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
     * @param {{ st?: any, native?: any, name?: string, folder?: string, tags?: string[], replace?: boolean, sourceRef?: string }} body
     */
    async importPreset(body) {
        return this.enqueue(async () => {
            let doc;
            if (body.folder !== undefined) {
                // validate BEFORE building the doc: rejects absolute paths
                // and `..` escapes with a 400 (folders are the library's
                // layout, never a write target outside presetsDir)
                this._safeDir(body.folder);
            }
            if (body.native) {
                doc = structuredClone(body.native);
                doc.id = doc.id || `p_${ulid()}`;
                doc.rev = 1;
                doc.createdAt = doc.createdAt || new Date().toISOString();
                doc.updatedAt = new Date().toISOString();
                if (!doc.loadouts || Object.keys(doc.loadouts).length === 0) {
                    ensureDefaultLoadout(doc);
                }
                stripLeafEnabled(doc); // native uploads may still carry leaf bits
                const errs = validateDoc(doc);
                if (errs.length) throw new StoreError(`invalid native document: ${errs.join(', ')}`);
            } else if (body.st) {
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
            doc.folder = String(body.folder ?? doc.folder ?? '');
            const existing = this.findByName(doc.name);
            if (existing && existing.id !== doc.id && !body.replace) {
                throw Object.assign(new StoreError(`name "${doc.name}" is already taken`, 409), { conflict: existing.id });
            }
            if (existing && existing.id !== doc.id && body.replace) {
                // the new doc overwrites the same file: drop the stale index
                // entry (until now /library listed both and the old id served
                // a document whose file no longer exists) and retire the old
                // preset's revisions with its id
                this.index.delete(existing.id);
                await fsp.rm(path.join(this.revisionsDir, existing.id), { recursive: true, force: true });
            }
            // normalize structure so outline ops are byte-exact from the start (v1 derive_structure)
            for (const seq of doc.sequences) seq.rows = rebuildSeq(flattenSeq(seq.rows));
            if (!body.native) {
                // native docs were validated above; validate the ST-derived
                // one too (connection keys etc. must never reach disk)
                const errs = validateDoc(doc);
                if (errs.length) throw new StoreError(`invalid imported document: ${errs.join(', ')}`);
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
     * @param {{ label?: string }} [opts]
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
            await this._writeDoc(doc, path.dirname(newPath));
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

    /** @param {any} doc @param {string} dir */
    async _writeDoc(doc, dir) {
        const file = path.join(dir, `${sanitizeName(doc.name)}.json`);
        await atomicWrite(file, JSON.stringify(doc, null, 2) + '\n');
        this.index.set(doc.id, {
            id: doc.id,
            path: file,
            name: doc.name,
            folder: path.relative(this.presetsDir, dir),
            tags: doc.tags ?? [],
            updatedAt: doc.updatedAt,
            doc: structuredClone(doc),
        });
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
            if (age < 5 * 60 * 1000) coalesce = true;
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
     * store-queue transaction (see _savePresetNow). Never call outside the
     * queue.
     * @param {(reg: any) => any} fn
     */
    async _mutateModelsNow(fn) {
        {
            const reg = structuredClone(this.models);
            const result = await fn(reg);
            const errs = validateRegistry(reg);
            if (errs.length) throw new StoreError(`invalid registry: ${errs.join(', ')}`);
            this.models = reg;
            await atomicWrite(this.modelsFile, JSON.stringify(reg, null, 2));
            await this._bumpRev();
            return result;
        }
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
