/**
 * Phase 6 store level: the block shelf (shelf/<id>.json, published through
 * the store queue like every other file) and `copyBlock` — ONE queue
 * transaction that reads the source (a shelf item or another preset), copies
 * into the target at the `before` anchor and saves the target.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../plugin/store.js';
import { flattenSeq } from '../shared/outline.js';

async function tmpStore(root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-shelf-'))) {
    const store = new Store(root);
    await store.init();
    return store;
}

function st(/** @type {string} */ tag) {
    return {
        prompts: [
            { identifier: 'chatHistory', marker: true },
            { identifier: 'hdr', name: '=Pick one POV 👇 ====', content: '', role: 'system' },
            { identifier: 'a', name: `A ${tag}`, content: `a ${tag} {{getvar::only_${tag}}}`, role: 'system', injection_depth: 3 },
            { identifier: 'b', name: `B ${tag}`, content: 'b', role: 'system' },
            { identifier: 'c', name: `C ${tag}`, content: 'c', role: 'system' },
            { identifier: 'd', name: `D ${tag}`, content: 'd', role: 'user' },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'hdr', enabled: false },
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: false },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'c', enabled: true },
            { identifier: 'd', enabled: true },
        ] }],
    };
}

/** Store with preset P (target) and Q (source). */
async function fixture() {
    const store = await tmpStore();
    const p = await store.importPreset({ st: st('p'), name: 'P' });
    const q = await store.importPreset({ st: st('q'), name: 'Q' });
    return { store, pid: /** @type {string} */ (p.id), qid: /** @type {string} */ (q.id) };
}

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flatIds = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows).map((e) => identOf(e.leaf));
const keyOf = (/** @type {any} */ doc, /** @type {string} */ id) => flattenSeq(doc.sequences[0].rows).find((e) => identOf(e.leaf) === id).leaf.key;
const status = (/** @type {number} */ code) => (/** @type {any} */ err) => err?.status === code;
const shelfFiles = (/** @type {Store} */ store) => fs.readdirSync(path.join(store.root, 'shelf')).filter((f) => f.endsWith('.json'));
const groupOf = (/** @type {any} */ doc) => doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'group');

// ---------------------------------------------------------------- shelf

test('shelfAdd from a preset: entry shape, one rev bump, on disk, listed, survives a restart', async () => {
    const { store, qid } = await fixture();
    const rev0 = store.rev;
    const e = /** @type {any} */ (await store.shelfAdd({ fromPresetId: qid, identifier: 'a' }));
    assert.match(e.id, /^b_[0-9A-Z]{26}$/);
    assert.equal(e.name, 'A q');
    assert.equal(e.content, 'a q {{getvar::only_q}}');
    assert.equal(e.role, 'system');
    assert.equal(e.fields.injection_depth, 3);
    assert.equal(e.fields.marker, false);
    assert.equal(e.notes, '');
    assert.deepEqual(e.tags, []);
    assert.deepEqual(e.savedFrom, { presetId: qid, identifier: 'a' });
    assert.ok(!Number.isNaN(Date.parse(e.savedAt)));
    assert.equal(store.rev, rev0 + 1);
    assert.deepEqual(shelfFiles(store), [`${e.id}.json`]);
    assert.deepEqual(store.shelfList(), [e]);
    assert.deepEqual(store.shelfGet(e.id), e);
    const again = await tmpStore(store.root);
    assert.deepEqual(again.shelfList(), [e]);
});

test('shelfAdd refuses a marker (400) and an unknown block (404); nothing written, rev unchanged', async () => {
    const { store, qid } = await fixture();
    const rev0 = store.rev;
    await assert.rejects(() => store.shelfAdd({ fromPresetId: qid, identifier: 'chatHistory' }), (/** @type {any} */ err) => err.status === 400 && /marker/i.test(err.message));
    await assert.rejects(() => store.shelfAdd({ fromPresetId: qid, identifier: 'nope' }), status(404));
    await assert.rejects(() => store.shelfAdd({ fromPresetId: 'p_nope', identifier: 'a' }), status(404));
    assert.equal(store.rev, rev0);
    assert.deepEqual(shelfFiles(store), []);
    assert.deepEqual(store.shelfList(), []);
});

test('shelfAdd {block}: stored with defaults; a marker-shaped or malformed block is a 400', async () => {
    const store = await tmpStore();
    const e = /** @type {any} */ (await store.shelfAdd({ block: { name: 'Raw', content: 'raw {{user}}', role: 'user', fields: { injection_depth: 2 } }, notes: 'why', tags: ['t'] }));
    assert.equal(e.name, 'Raw');
    assert.equal(e.role, 'user');
    assert.deepEqual(e.fields, { injection_depth: 2, marker: false });
    assert.equal(e.notes, 'why');
    assert.deepEqual(e.tags, ['t']);
    assert.deepEqual(e.savedFrom, { presetId: null, identifier: null });
    await assert.rejects(() => store.shelfAdd({ block: { identifier: 'chatHistory', name: 'x', content: '', marker: true } }), status(400));
    await assert.rejects(() => store.shelfAdd({ block: { name: 'x', content: 5 } }), status(400));
    await assert.rejects(() => store.shelfAdd({ block: { name: 'x', content: '', fields: 'no' } }), status(400));
    await assert.rejects(() => store.shelfAdd(/** @type {any} */ ({ block: { name: 'x', content: '' }, tags: 'no' })), status(400));
    await assert.rejects(() => store.shelfAdd({}), status(400));
    assert.equal(store.shelfList().length, 1);
});

test('shelfUpdate renames and sets notes (persisted); bad input 400; unknown or path-like id 404', async () => {
    const { store, qid } = await fixture();
    const e = /** @type {any} */ (await store.shelfAdd({ fromPresetId: qid, identifier: 'a' }));
    const rev0 = store.rev;
    const u = /** @type {any} */ (await store.shelfUpdate(e.id, { name: '  Renamed  ', notes: 'keep for tense' }));
    assert.equal(u.name, 'Renamed');
    assert.equal(u.notes, 'keep for tense');
    assert.equal(u.content, e.content);
    assert.equal(store.rev, rev0 + 1);
    assert.deepEqual((await tmpStore(store.root)).shelfGet(e.id), u);
    await assert.rejects(() => store.shelfUpdate(e.id, { name: '   ' }), status(400));
    await assert.rejects(() => store.shelfUpdate(e.id, /** @type {any} */ ({ notes: 3 })), status(400));
    await assert.rejects(() => store.shelfUpdate(e.id, /** @type {any} */ ({ content: 'x' })), status(400));
    await assert.rejects(() => store.shelfUpdate('b_01ZZZZZZZZZZZZZZZZZZZZZZZZ', { name: 'x' }), status(404));
    await assert.rejects(() => store.shelfUpdate('../state', { name: 'x' }), status(404));
    assert.throws(() => store.shelfGet('../state'), status(404));
    assert.equal(store.rev, rev0 + 1);
});

test('shelfRemove deletes file and entry; again 404; a path-like id never touches files outside shelf/', async () => {
    const { store, qid } = await fixture();
    const e = /** @type {any} */ (await store.shelfAdd({ fromPresetId: qid, identifier: 'a' }));
    const rev0 = store.rev;
    await store.shelfRemove(e.id);
    assert.equal(store.rev, rev0 + 1);
    assert.deepEqual(store.shelfList(), []);
    assert.deepEqual(shelfFiles(store), []);
    await assert.rejects(() => store.shelfRemove(e.id), status(404));
    await assert.rejects(() => store.shelfRemove('../state'), status(404));
    assert.ok(fs.existsSync(path.join(store.root, 'state.json')));
});

test('shelfAdd publishes atomically: a reader outside the queue never sees the new item with the old rev', async () => {
    const { store, qid } = await fixture();
    const rev0 = store.rev;
    let done = false;
    /** @type {{n: number, rev: number}[]} */
    const seen = [];
    const p = store.shelfAdd({ fromPresetId: qid, identifier: 'a' }).then(() => { done = true; });
    while (!done) {
        seen.push({ n: store.shelfList().length, rev: store.rev });
        await new Promise((r) => setImmediate(r));
    }
    await p;
    assert.ok(seen.length > 1, 'precondition: the reader ran while the write was in flight');
    assert.equal(seen.filter((s) => s.n === 1 && s.rev === rev0).length, 0, 'new item with old rev');
    assert.equal(seen.filter((s) => s.n === 0 && s.rev === rev0 + 1).length, 0, 'new rev without the item');
});

test('shelfAdd: a failed state write leaves the shelf (memory and disk) and rev unchanged', async () => {
    const { store, qid } = await fixture();
    const rev0 = store.rev;
    const blocked = path.join(store.root, 'blocked-state.json');
    fs.mkdirSync(path.join(blocked, 'x'), { recursive: true });
    store.stateFile = blocked;
    await assert.rejects(() => store.shelfAdd({ fromPresetId: qid, identifier: 'a' }));
    assert.equal(store.rev, rev0);
    assert.deepEqual(store.shelfList(), []);
    assert.deepEqual(shelfFiles(store), []);
});

// ---------------------------------------------------------------- copyBlock

test('copyBlock from the shelf lands before the anchor with a fresh id; two copies never share one', async () => {
    const { store, pid, qid } = await fixture();
    const item = /** @type {any} */ (await store.shelfAdd({ fromPresetId: qid, identifier: 'a' }));
    const doc0 = store.getPreset(pid);
    const ids0 = flatIds(doc0);
    const rev0 = store.rev;
    const r1 = /** @type {any} */ (await store.copyBlock(pid, { shelfId: item.id, before: keyOf(doc0, ids0[2]) }));
    assert.equal(store.rev, rev0 + 1, 'one transaction, one rev');
    assert.equal(r1.identifiers.length, 1);
    const n1 = r1.identifiers[0];
    const d1 = store.getPreset(pid);
    assert.deepEqual(r1.doc, d1);
    assert.equal(flatIds(d1).indexOf(n1), 2);
    assert.ok(!ids0.includes(n1) && n1 !== 'a');
    assert.equal(d1.blocks[n1].content, 'a q {{getvar::only_q}}');
    assert.deepEqual(r1.warnings, ["'A q' references {{getvar::only_q}} — absent in target preset"]);
    const r2 = /** @type {any} */ (await store.copyBlock(pid, { shelfId: item.id, before: null }));
    const n2 = r2.identifiers[0];
    assert.notEqual(n1, n2);
    const d2 = store.getPreset(pid);
    assert.equal(flatIds(d2).length, ids0.length + 2);
    assert.equal(Object.keys(d2.blocks).length, Object.keys(doc0.blocks).length + 2);
});

test('copyBlock from another preset: a block, and a whole group with its heading and cardinality', async () => {
    const { store, pid, qid } = await fixture();
    const q = store.getPreset(qid);
    const qg = groupOf(q);
    assert.ok(qg && qg.header, 'precondition: Q has a headed group');
    const d0 = store.getPreset(pid);
    const r = /** @type {any} */ (await store.copyBlock(pid, { fromPresetId: qid, identifier: 'c', before: keyOf(d0, 'a') }));
    const d1 = store.getPreset(pid);
    assert.equal(d1.blocks[r.identifiers[0]].name, 'C q');
    const g = /** @type {any} */ (await store.copyBlock(pid, { fromPresetId: qid, group: qg.key, before: null }));
    const d2 = store.getPreset(pid);
    const srcCount = (qg.header ? 1 : 0) + qg.options.length;
    assert.equal(g.identifiers.length, srcCount);
    assert.deepEqual(flatIds(d2).slice(-srcCount), g.identifiers);
    const landed = d2.sequences[0].rows.find((/** @type {any} */ row) => row.kind === 'group' && row.key === g.group);
    assert.ok(landed, 'the copied group is a group in the target');
    assert.equal(landed.cardinality, qg.cardinality);
    assert.equal(landed.name, qg.name);
    for (const id of g.identifiers) assert.ok(!(id in q.blocks) && !(id in d1.blocks));
});

test('copyBlock refuses a marker (400) and bad sources; the target document and rev are unchanged', async () => {
    const { store, pid, qid } = await fixture();
    const before = store.getPreset(pid);
    const rev0 = store.rev;
    await assert.rejects(() => store.copyBlock(pid, { fromPresetId: qid, identifier: 'chatHistory', before: null }), (/** @type {any} */ err) => err.status === 400 && /marker/i.test(err.message));
    await assert.rejects(() => store.copyBlock(pid, { before: null }), status(400));
    await assert.rejects(() => store.copyBlock(pid, { shelfId: 'b_01ZZZZZZZZZZZZZZZZZZZZZZZZ', fromPresetId: qid, identifier: 'a' }), status(400));
    await assert.rejects(() => store.copyBlock(pid, { shelfId: 'b_01ZZZZZZZZZZZZZZZZZZZZZZZZ' }), status(404));
    await assert.rejects(() => store.copyBlock(pid, { fromPresetId: 'p_nope', identifier: 'a' }), status(404));
    await assert.rejects(() => store.copyBlock('p_nope', { fromPresetId: qid, identifier: 'a' }), status(404));
    await assert.rejects(() => store.copyBlock(pid, { fromPresetId: qid, identifier: 'a', before: 'row_nope' }), status(404));
    assert.deepEqual(store.getPreset(pid), before);
    assert.equal(store.rev, rev0);
});
