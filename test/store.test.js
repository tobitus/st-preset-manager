/**
 * Store + schema + slot routing tests (plugin side, pure fs on a tmp root).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, ensureDefaultLoadout } from '../plugin/store.js';
import { validateDoc, validateRegistry, splitSnapshot } from '../shared/schema.js';
import { routePanelDiff, applyOrderToSequences, deleteBlockFromDoc, panelDelta } from '../plugin/slot.js';
import { compile } from '../shared/compile.js';
import { importStPreset } from '../shared/recognizers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-test-'));
    return new Store(root);
}

function sampleSt() {
    return {
        temperature: 0.5,
        prompts: [
            { identifier: 'chatHistory', marker: true },
            { identifier: 'a', name: 'A', content: 'content a', role: 'system', enabled: true },
            { identifier: 'b', name: 'B', content: 'content b', role: 'system', enabled: true },
            { identifier: 'c', name: 'C', content: 'content c', role: 'system', enabled: false },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
            { identifier: 'c', enabled: false },
        ] }],
    };
}

async function storeWithDoc() {
    const store = tmpStore();
    await store.init();
    const doc = await store.importPreset({ st: sampleSt(), name: 'Test Preset' });
    return { store, doc };
}

test('store: import -> library -> get roundtrip; name conflict is 409', async () => {
    const { store, doc } = await storeWithDoc();
    const lib = store.listLibrary();
    assert.equal(lib.length, 1);
    assert.equal(lib[0].name, 'Test Preset');
    assert.equal(lib[0].loadouts.length, 1);
    assert.deepEqual(store.getPreset(doc.id), doc);
    await assert.rejects(
        () => store.importPreset({ st: sampleSt(), name: 'Test Preset' }),
        (err) => /** @type {{status?: number}} */ (err).status === 409,
    );
    // replace: true wins, and replaces the SAME document (identity kept)
    const doc2 = await store.importPreset({ st: sampleSt(), name: 'Test Preset', replace: true });
    assert.equal(doc2.id, doc.id);
    assert.equal(store.listLibrary().length, 1);
});

test('store: import rejects non-CC JSON with 400', async () => {
    const store = tmpStore();
    await store.init();
    await assert.rejects(
        () => store.importPreset({ st: { foo: 'bar' }, name: 'x' }),
        (err) => /** @type {{status?: number}} */ (err).status === 400
            && /not a Chat Completion preset/.test(/** @type {{message?: string}} */ (err).message ?? ''),
    );
});

test('store: folders are confined to the preset root (no .. / absolute escape)', async () => {
    const { store } = await storeWithDoc();
    // savePreset (PUT move) with an escaping folder must be rejected...
    for (const folder of ['../../OpenAI Settings', '..', '/etc/passwd', 'a/../../b']) {
        const doc = store.getPreset(store.listLibrary()[0].id);
        doc.folder = folder;
        await assert.rejects(() => store.savePreset(doc), /escapes the preset library|absolute paths/);
    }
    // ...and the same guard holds on the import path
    await assert.rejects(
        () => store.importPreset({ st: sampleSt(), name: 'Escape Import', folder: '../../OpenAI Settings' }),
        (err) => /** @type {{status?: number}} */ (err).status === 400,
    );
    // a legal subfolder still lands inside the library and scans back
    const doc = await store.importPreset({ st: sampleSt(), name: 'Nested', folder: 'sub/dir' });
    assert.ok(fs.existsSync(path.join(store.root, 'presets', 'sub', 'dir', 'Nested.json')));
    await store.rescan();
    const entry = store.listLibrary().find((i) => i.id === doc.id);
    assert.equal(entry.folder, 'sub/dir');
});

test('store: savePreset bumps doc rev, writes a revision, rename moves the file', async () => {
    const { store, doc } = await storeWithDoc();
    doc.notes = 'edited';
    const saved = await store.savePreset(doc);
    assert.equal(saved.rev, 2);
    assert.equal(saved.notes, 'edited');
    assert.deepEqual(store.listRevisions(doc.id).map((r) => r.rev), [1]);
    saved.name = 'Renamed';
    await store.savePreset(saved);
    assert.ok(store.findByName('Renamed'));
    assert.equal(store.findByName('Test Preset'), null);
    assert.ok(fs.readdirSync(path.join(store.root, 'presets')).includes('Renamed.json'));
});

test('store: revisions coalesce within 5 minutes, labelled always writes', async () => {
    const { store, doc } = await storeWithDoc();
    doc.notes = 'first';
    await store.savePreset(doc);
    doc.notes = 'second';
    await store.savePreset(doc); // coalesced into revision 1
    assert.deepEqual(store.listRevisions(doc.id).map((r) => r.rev), [1]);
    doc.notes = 'third';
    await store.savePreset(doc, { label: 'checkpoint' });
    assert.deepEqual(store.listRevisions(doc.id).map((r) => r.rev), [1, 2]);
    assert.equal(store.getRevision(doc.id, 2).label, 'checkpoint');
});

test('store: revisions order numerically and never reuse a pruned number', async () => {
    const { store, doc } = await storeWithDoc();
    const dir = path.join(store.root, 'revisions', doc.id);
    fs.mkdirSync(dir, { recursive: true });
    // after pruning, 200 snapshots numbered 2..201 remain; revision 1 was
    // pruned and 10.json sorts before 9.json lexicographically
    for (let r = 2; r <= 201; r++) {
        fs.writeFileSync(path.join(dir, `${r}.json`), JSON.stringify({ rev: r, at: new Date(0).toISOString(), label: null, doc }));
    }
    doc.notes = 'after-prune';
    await store.savePreset(doc); // newest is 201 -> next must be 202, not 2
    const revs = store.listRevisions(doc.id).map((r) => r.rev);
    assert.equal(revs.length, 200); // 201 seeded + 1 new, pruned to newest 200
    assert.equal(Math.max(...revs), 202);
    assert.equal(store.getRevision(doc.id, 202).rev, 202);
    // a second save 6+ hours later cannot coalesce (at is epoch 0), so the
    // next snapshot is 203 even though 9.json > 10.json lexicographically
    doc.notes = 'second-later';
    await store.savePreset(doc, { label: 'labelled' });
    assert.deepEqual(store.listRevisions(doc.id).map((r) => r.rev).filter((r) => r >= 202), [202, 203]);
});

test('store: state + models mutation bump the global rev monotonically', async () => {
    const { store } = await storeWithDoc();
    const r0 = store.rev;
    await store.mutateState((st) => { st.presetId = 'p_x'; });
    await store.mutateModels((reg) => { reg.models['Kimi K3'] = { id: 'm_1', name: 'Kimi K3', matches: [], profiles: [], preferredProfile: null, tuning: {} }; });
    assert.equal(store.rev, r0 + 2);
    assert.equal(store.state.presetId, 'p_x');
    assert.ok(store.models.models['Kimi K3']);
});

test('schema: validateDoc rejects bad documents with paths', () => {
    assert.deepEqual(validateDoc({ format: 'st-preset-manager/library' }), [
        'version', 'id', 'name', 'tags', 'notes', 'source', 'settings', 'markers', 'blocks', 'sequences',
        'loadouts', 'activeLoadoutId', 'tuningOverrides', 'createdAt', 'updatedAt', 'rev',
    ]);
    const st = sampleSt();
    const doc = importStPreset(st, 'ok');
    ensureDefaultLoadout(doc);
    doc.id = 'p_x';
    doc.createdAt = doc.updatedAt = 'now';
    doc.rev = 1;
    assert.deepEqual(validateDoc(doc), []);
    doc.settings.chat_completion_source = 'custom'; // connection key must never be stored
    assert.ok(validateDoc(doc).includes('settings.chat_completion_source (connection key — never stored)'));
});

test('schema: registry validation', () => {
    assert.deepEqual(validateRegistry({ version: 1, models: {} }), []);
    const errs = validateRegistry({ version: 1, models: { M: { id: '', name: 'M', matches: [{}], profiles: null, preferredProfile: 5, tuning: { evil: 1 } } } });
    assert.ok(errs.length >= 5);
});

test('schema: splitSnapshot classifies keys', () => {
    const { settings, tuning, rejected } = splitSnapshot({ temperature: 1, custom_url: 'x', wi_format: 'f', prompts: [], prompt_order: [] });
    assert.deepEqual(tuning, { temperature: 1 });
    assert.deepEqual(settings, { wi_format: 'f' });
    assert.deepEqual(rejected, ['custom_url']);
});

test('slot routing: toggle in panel goes to loadout; pick-one sibling collapses', () => {
    const st = {
        temperature: 0.5,
        prompts: [
            { identifier: 'chatHistory', marker: true },
            { identifier: 'h', name: 'H', content: 'h', role: 'system', enabled: true },
            { identifier: 'o1', name: 'O1', content: '1', role: 'system', enabled: true },
            { identifier: 'o2', name: 'O2', content: '2', role: 'system', enabled: false },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'h', enabled: true },
            { identifier: 'o1', enabled: true },
            { identifier: 'o2', enabled: false },
        ] }],
    };
    const doc = importStPreset(st, 'g');
    ensureDefaultLoadout(doc);
    doc.sequences[0].rows.push({
        kind: 'group', key: 'grp:x', name: 'pick', cardinality: 'pick-one', guessed: false, header: null,
        options: [
            { kind: 'block', ref: 'o1', enabled: true, key: 'k1' },
            { kind: 'block', ref: 'o2', enabled: false, key: 'k2' },
        ],
    });
    const { compiled } = compile(doc, null, {});
    // panel turns o2 on while o1 is on: loadout gets o2 on, normalize turns o1 off
    const snap = structuredClone(compiled);
    snap.prompt_order[0].order.find((o) => o.identifier === 'o2').enabled = true;
    const delta = panelDelta(compiled, snap);
    const { routed } = routePanelDiff(doc, compiled, delta, null);
    assert.ok(routed.some((r) => r.key === 'o2' && r.layer === 'loadout'));
    assert.ok(routed.some((r) => r.layer === 'group:pick-one'));
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled.o2, true);
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled.o1, false);
});

test('slot routing: no Model -> temperature goes to doc settings with warning', () => {
    const st = sampleSt();
    const doc = importStPreset(st, 'x');
    ensureDefaultLoadout(doc);
    const { compiled } = compile(doc, null, {});
    const snap = structuredClone(compiled);
    snap.temperature = 0.42;
    const delta = panelDelta(compiled, snap);
    const { routed, warnings, globalTuning } = routePanelDiff(doc, compiled, delta, null);
    assert.equal(doc.settings.temperature, 0.42);
    assert.ok(routed.some((r) => r.key === 'temperature' && r.layer === 'settings'));
    assert.equal(warnings.length, 1);
    assert.equal(globalTuning, null);
});

test('slot routing: with a Model override, tuning goes to the preset override (item 21)', () => {
    const st = sampleSt();
    const doc = importStPreset(st, 'x');
    ensureDefaultLoadout(doc);
    doc.tuningOverrides['Kimi K3'] = {};
    const { compiled } = compile(doc, { name: 'Kimi K3', tuning: {} }, {});
    const snap = structuredClone(compiled);
    snap.temperature = 0.55;
    const delta = panelDelta(compiled, snap);
    const { routed } = routePanelDiff(doc, compiled, delta, /** @type {{name: string, tuning?: Record<string, unknown>|null}|null} */ ({ name: 'Kimi K3', tuning: {} }));
    assert.equal(doc.tuningOverrides['Kimi K3'].temperature, 0.55);
    assert.ok(routed.some((r) => r.key === 'temperature' && r.layer === 'tuningOverride:Kimi K3'));
});

test('slot routing: reorder in panel reorders sequences (blocks layer)', () => {
    const st = sampleSt();
    const doc = importStPreset(st, 'x');
    ensureDefaultLoadout(doc);
    const { compiled } = compile(doc, null, {});
    const snap = structuredClone(compiled);
    const order = snap.prompt_order[0].order;
    // move b before a: a, b, c -> b, a, c
    const reordered = [order.find((o) => o.identifier === 'chatHistory'), order.find((o) => o.identifier === 'b'), order.find((o) => o.identifier === 'a'), order.find((o) => o.identifier === 'c')];
    snap.prompt_order[0].order = reordered;
    const delta = panelDelta(compiled, snap);
    const { routed } = routePanelDiff(doc, compiled, delta, null);
    assert.ok(routed.some((r) => r.key === 'prompt_order.order'));
    const flat = doc.sequences[0].rows.filter((r) => r.kind === 'block').map((r) => r.ref);
    assert.deepEqual(flat, ['b', 'a', 'c']);
});

test('slot routing: a panel order that moves rows above their section heading keeps the section (no flattening)', () => {
    // Owner decision 2026-09-29 (option a): the write-back keeps structure.
    // Section S(h1){a, b}; ST's order b, a, h1: the heading outweighs any
    // one row, so it stays put and a, b are the moved rows. Each lands above
    // its following neighbour as a plain item; the section keeps its name
    // and heading (now with no rows).
    const doc = {
        sequences: [{ character_id: 1, rows: [
            { kind: 'section', key: 's', name: 'S', header: { kind: 'block', ref: 'h1', enabled: true, key: 'k1' }, rows: [
                { kind: 'block', ref: 'a', enabled: true, key: 'k2' },
                { kind: 'block', ref: 'b', enabled: true, key: 'k3' },
            ] },
        ] }],
        loadouts: {}, activeLoadoutId: null, blocks: {},
    };
    assert.equal(applyOrderToSequences(doc, ['b', 'a', 'h1']), true);
    const rows = doc.sequences[0].rows;
    assert.deepEqual(rows.map((r) => r.kind), ['block', 'block', 'section']);
    assert.deepEqual(rows.slice(0, 2).map((r) => r.ref), ['b', 'a']);
    assert.equal(rows[2].name, 'S');
    assert.equal(rows[2].header.ref, 'h1');
    assert.deepEqual(rows[2].rows, []);
    deleteBlockFromDoc(doc, 'a');
    const rows2 = doc.sequences[0].rows;
    assert.deepEqual(rows2.map((r) => r.ref ?? r.header?.ref), ['b', 'h1']);
    assert.equal(doc.blocks.a, undefined);
});

test('store: shelf add/list/remove', async () => {
    const { store, doc } = await storeWithDoc();
    const entry = await store.shelfAdd({ fromPresetId: doc.id, identifier: 'a' });
    assert.equal(entry.name, 'A');
    assert.equal(store.shelfList().length, 1);
    await store.shelfRemove(entry.id);
    assert.equal(store.shelfList().length, 0);
    await assert.rejects(() => store.shelfAdd({ fromPresetId: doc.id, identifier: 'nope' }), (/** @type {{status?: number}} */ e) => e.status === 404);
});

test('slot routing: panel DELTA preserves concurrent API writes (temperature survives an older panel toggle)', () => {
    // The tab based its edit on `base` (temperature 0.66 as compiled then).
    // A concurrent API write then changed the document's temperature to 0.9.
    // The user's panel edit toggles block b off and nothing else — the
    // routed delta must carry the toggle but NOT the stale temperature.
    const st = sampleSt();
    const doc = importStPreset(st, 'delta');
    ensureDefaultLoadout(doc);
    const { compiled: base } = compile(doc, null, {});
    const baseRevSnapshot = structuredClone(base);

    // concurrent API write lands AFTER the tab snapshotted its base
    doc.settings.temperature = 0.9;
    const { compiled: current } = compile(doc, null, {});
    assert.equal(current.temperature, 0.9);

    // user toggles b off in the panel; their snapshot still shows 0.66
    const snapshot = structuredClone(baseRevSnapshot);
    snapshot.temperature = 0.66; // tab shows the old value it applied
    const baseWith066 = structuredClone(baseRevSnapshot);
    baseWith066.temperature = 0.66; // ...and its base carried 0.66 too
    snapshot.prompt_order[0].order.find((/** @type {any} */ o) => o.identifier === 'b').enabled = false;
    snapshot.prompts.find((/** @type {any} */ p) => p.identifier === 'b').enabled = false;

    const delta = panelDelta(baseWith066, snapshot);
    assert.equal(delta.temperature, undefined); // untouched by the user
    assert.deepEqual(delta.prompt_order.order, [{ identifier: 'b', enabled: false }]); // only the toggle
    assert.equal(delta.prompt_order.changed, false); // sequence untouched

    const { routed } = routePanelDiff(doc, current, delta, null);
    assert.ok(routed.some((r) => r.key === 'b' && r.layer === 'loadout'));
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled.b, false);
    // the API write SURVIVED: no stale temperature routed over it
    assert.equal(doc.settings.temperature, 0.9);
    assert.ok(!routed.some((r) => r.key === 'temperature'));
});

test('slot routing: unchanged panel sections collapse to empty in the delta (no wholesale rewrite)', () => {
    const st = sampleSt();
    const doc = importStPreset(st, 'same');
    ensureDefaultLoadout(doc);
    const { compiled: base } = compile(doc, null, {});
    const snapshot = structuredClone(base);
    snapshot.wi_format = 'user edited this'; // only a settings key changes
    const delta = panelDelta(base, snapshot);
    assert.deepEqual(delta.prompt_order, { changed: false, order: [] }); // untouched -> no entries
    assert.deepEqual(delta.prompts, []); // no changed prompts
    assert.equal(delta.wi_format, 'user edited this');
    // rerouted against the CURRENT compiled output: enabled bits are not
    // clobbered by an empty section, and only wi_format routes
    const doc2 = importStPreset(st, 'same2');
    ensureDefaultLoadout(doc2);
    doc2.loadouts[doc2.activeLoadoutId].enabled.c = true; // API changed a bit meanwhile
    const { compiled: current } = compile(doc2, null, {});
    const { routed } = routePanelDiff(doc2, current, delta, null);
    assert.deepEqual(routed.map((r) => r.key), ['wi_format']);
    assert.equal(doc2.loadouts[doc2.activeLoadoutId].enabled.c, true); // survived
});

test('store: /slot/panel state guard — slotChangedRev rejects pre-load panel posts', async () => {
    // Mirrors the route's 409 rule: baseRev older than the last desired-slot
    // change must be rejected, else an old preset's panel delta would be
    // poured into the newly loaded document.
    const { store, doc } = await storeWithDoc();
    const revAtBase = store.rev;
    await store.mutateState((st) => {
        store._markSlotChanged();
        st.presetId = doc.id; // /slot/load equivalent
    });
    assert.equal(store.slotChangedRev, revAtBase + 1);
    // the guard expression the route evaluates:
    const stale = (store.slotChangedRev ?? 0) > revAtBase;
    assert.equal(stale, true); // -> 409, tab re-reconciles and re-bases
    // a base taken AFTER the load is fine
    const fresh = (store.slotChangedRev ?? 0) > store.rev;
    assert.equal(fresh, false); // -> proceed with delta routing
});

test('store: deletePreset removes the file, its revisions and the index entry; second delete is 404', async () => {
    const { store, doc } = await storeWithDoc();
    doc.notes = 'edited';
    await store.savePreset(doc); // writes revision 1
    const entryPath = store.index.get(doc.id).path;
    const revDir = path.join(store.revisionsDir, doc.id);
    assert.ok(fs.existsSync(entryPath));
    assert.ok(fs.existsSync(revDir));
    const res = await store.deletePreset(doc.id);
    assert.deepEqual(res, { wasDesired: false });
    assert.equal(fs.existsSync(entryPath), false);
    assert.equal(fs.existsSync(revDir), false);
    assert.equal(store.listLibrary().length, 0);
    await assert.rejects(() => store.deletePreset(doc.id), (err) => /** @type {any} */ (err).status === 404);
    // a restarted store does not resurrect it
    const again = new Store(store.root);
    await again.init();
    assert.equal(again.listLibrary().length, 0);
});

test('store: deleting the slot-bound preset empties the desired slot in the same transaction (restart-safe)', async () => {
    const { store, doc } = await storeWithDoc();
    await store.mutateState((st) => {
        store._markSlotChanged();
        st.presetId = doc.id;
        st.loadoutId = doc.activeLoadoutId;
    });
    assert.ok(store.state.loadoutId);
    const revBefore = store.rev;
    const res = await store.deletePreset(doc.id);
    assert.deepEqual(res, { wasDesired: true });
    assert.equal(store.state.presetId, null);
    assert.equal(store.state.loadoutId, null);
    assert.equal(store.slotChangedRev, store.rev);
    assert.ok(store.rev > revBefore);
    const again = new Store(store.root);
    await again.init();
    assert.equal(again.state.presetId, null);
    assert.equal(again.state.loadoutId, null);
    assert.equal(again.slotChangedRev, store.rev);
});

test('store: deleting a preset that is not in the slot leaves the slot alone', async () => {
    const { store, doc } = await storeWithDoc();
    const other = await store.importPreset({ st: sampleSt(), name: 'Other' });
    await store.mutateState((st) => {
        store._markSlotChanged();
        st.presetId = doc.id;
        st.loadoutId = doc.activeLoadoutId;
    });
    const slotRev = store.slotChangedRev;
    const res = await store.deletePreset(other.id);
    assert.deepEqual(res, { wasDesired: false });
    assert.equal(store.state.presetId, doc.id);
    assert.equal(store.state.loadoutId, doc.activeLoadoutId);
    assert.equal(store.slotChangedRev, slotRev);
    assert.equal(store.listLibrary().length, 1);
});
