/**
 * Fix round 4: a fork keeps ST's fixed system-prompt identifiers.
 *
 * ST's PromptManager re-adds any of its default system prompts (main, nsfw,
 * jailbreak, enhanceDefinitions) a preset lacks, so a fork that re-minted
 * them could never show its own compile in ST: the apply never converged
 * and the window stayed behind the apply blocker. Every other block is
 * still re-minted; markers were never re-minted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../plugin/store.js';
import { registerRoutes } from '../plugin/routes.js';
import { flattenSeq } from '../shared/outline.js';
import { compile } from '../shared/compile.js';
import { validateDoc } from '../shared/schema.js';

const B = (/** @type {string} */ id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
const IDS = ['main', 'a', 'nsfw', 'b', 'jailbreak', 'enhanceDefinitions'];

function mkDoc() {
    return {
        format: 'st-preset-manager/library', version: 1, id: 'p_src', name: 'Src', tags: [], notes: '', source: { kind: 'st' },
        settings: {},
        markers: [],
        blocks: Object.fromEntries(IDS.map((i) => [i, B(i)])),
        sequences: [{ character_id: 100001, rows: IDS.map(leaf) }],
        loadouts: {
            R: { id: 'R', name: 'Root', notes: '', kind: 'root', parent: null,
                enabled: { main: true, a: true, nsfw: false, b: true, jailbreak: false, enhanceDefinitions: true }, overrides: {} },
        },
        activeLoadoutId: 'R',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1,
    };
}

/** The handler registerRoutes puts on `method path`, run as {status, body} | {error}. */
function route(/** @type {string} */ method, /** @type {string} */ p) {
    /** @type {{ m: string, p: any, hs: any[] }[]} */
    const routes = [];
    const router = new Proxy({}, { get: (_t, m) => (/** @type {any} */ rp, /** @type {any[]} */ ...hs) => { routes.push({ m: String(m), p: rp, hs }); } });
    registerRoutes(/** @type {any} */ (router));
    const found = routes.find((r) => r.m === method && r.p === p);
    assert.ok(found, `no route ${method} ${p}`);
    const handler = /** @type {any} */ (found).hs.at(-1);
    return (/** @type {any} */ req) => new Promise((resolve) => {
        /** @type {any} */
        const res = {
            code: 200,
            status(/** @type {number} */ c) { res.code = c; return res; },
            json(/** @type {any} */ body) { resolve({ status: res.code, body }); return res; },
        };
        Promise.resolve(handler(req, res, (/** @type {any} */ err) => resolve({ error: err }))).catch((err) => resolve({ error: err }));
    });
}

test('a fork keeps main/nsfw/jailbreak/enhanceDefinitions, re-mints every other block, and re-keys refs and loadout bits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-fork-'));
    const store = new Store(root);
    await store.init();
    const saved = await store.importPreset({ native: mkDoc() });
    const src0 = JSON.stringify(store.getPreset(saved.id));
    const fork = route('post', '/presets/:id/fork');
    const out = /** @type {any} */ (await fork({ params: { id: saved.id }, body: { name: 'Src fork' }, pm: { store, hub: { clientCount: 0, publish() {}, broadcast() {} } } }));
    assert.equal(out.error, undefined, String(out.error?.message));
    assert.equal(out.status, 201);
    const doc = out.body.doc;
    const kept = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'];
    for (const id of kept) {
        assert.ok(doc.blocks[id], `${id} was re-minted`);
        assert.equal(doc.blocks[id].identifier, id);
    }
    assert.equal(doc.blocks.a, undefined, 'a kept its identifier');
    assert.equal(doc.blocks.b, undefined, 'b kept its identifier');
    assert.equal(Object.keys(doc.blocks).length, IDS.length);
    const refs = flattenSeq(doc.sequences[0].rows).map((e) => e.leaf.ref);
    const A = refs[1];
    const Bn = refs[3];
    assert.deepEqual([refs[0], refs[2], refs[4], refs[5]], ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions']);
    assert.ok(A !== 'a' && Bn !== 'b' && doc.blocks[A]?.name === 'A' && doc.blocks[Bn]?.name === 'B', `re-minted refs ${JSON.stringify(refs)}`);
    const lo = /** @type {any} */ (Object.values(doc.loadouts))[0];
    assert.deepEqual(lo.enabled, { main: true, [A]: true, nsfw: false, [Bn]: true, jailbreak: false, enhanceDefinitions: true });
    assert.deepEqual(validateDoc(doc), []);
    const { compiled } = compile(structuredClone(doc), null, {}, doc.activeLoadoutId);
    const ids = compiled.prompts.map((/** @type {any} */ p) => p.identifier);
    for (const id of kept) assert.ok(ids.includes(id), `compiled prompts lack ${id}`);
    assert.equal(JSON.stringify(store.getPreset(saved.id)), src0, 'the source changed');
});
