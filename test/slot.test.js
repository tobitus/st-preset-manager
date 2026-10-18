/**
 * Semantic panel-delta routing + atomic stale-check tests (Phase 1 second
 * review findings). Pure store/fs level: the /slot/panel handler is a
 * store.enqueue callback, so the transaction + guard are exercised
 * directly against the same code the route runs (store-queue serialisation
 * included, no HTTP).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, ensureDefaultLoadout, StoreError } from '../plugin/store.js';
import { routePanelDiff, panelDelta, applyOrderToSequences } from '../plugin/slot.js';
import { compile } from '../shared/compile.js';
import { importStPreset } from '../shared/recognizers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @returns {Promise<Store>} fresh store on a tmp root, inited */
async function tmpStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-slot-'));
    const store = new Store(root);
    await store.init();
    return store;
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

async function storeWithDoc(name = 'Delta Test') {
    const store = await tmpStore();
    const doc = await store.importPreset({ st: sampleSt(), name });
    await store.mutateState((st) => {
        store._markSlotChanged();
        st.presetId = doc.id;
    });
    return { store, doc };
}

/**
 * The /slot/panel transaction, verbatim from the route (without HTTP):
 * stale guard + compile + semantic delta routing + writes as ONE store
 * transaction. Returns the view fields the route answers with, or rethrows
 * StoreError (status 409 + slotChangedRev on stale).
 * @param {any} store
 * @param {{baseRev: number, base: any, snapshot: any}} body
 */
function panelTransaction(store, body) {
    const { baseRev, base, snapshot } = body;
    return store.enqueue(async () => {
        const doc = store.state.presetId ? store.getDocNow(store.state.presetId) : null;
        if (!doc) throw new StoreError('no preset in the slot', 409);
        if ((store.slotChangedRev ?? 0) > baseRev) {
            throw new StoreError('stale: desired preset or loadout changed after baseRev', 409, {
                slotChangedRev: store.slotChangedRev ?? 0,
            });
        }
        const model = null; // tests run without a Model resolved
        const desiredLoadout = store.state.loadoutId ?? doc.activeLoadoutId;
        const { compiled: currentCompiled } = compile(doc, model, {}, desiredLoadout);
        const delta = panelDelta(base, snapshot);
        if (delta === null) throw new StoreError('snapshot or base lost prompt_order/prompts structure', 409);
        const { routed, tuningWrite, warnings } = routePanelDiff(doc, currentCompiled, delta, model, desiredLoadout);
        if (routed.length > 0 || tuningWrite) {
            await store._savePresetNow(doc);
            if (tuningWrite && model) {
                await store._mutateModelsNow((/** @type {any} */ reg) => {
                    const t = reg.models[model.name].tunings;
                    t[tuningWrite.name] = { ...(t[tuningWrite.name] ?? {}), ...tuningWrite.values };
                });
            }
        }
        return { routed, warnings, rev: store.rev, docId: doc.id };
    });
}

/** Full panel projection of the doc's CURRENT compiled output. */
function currentProjection(doc) {
    return compile(doc, null, {}).compiled;
}

test('panelDelta: semantic shape — only changed fields ride, per identifier', () => {
    const base = {
        temperature: 0.5,
        prompts: [
            { identifier: 'a', name: 'A', content: 'old a', role: 'system', injection_position: 0, injection_depth: 4 },
            { identifier: 'b', name: 'B', content: 'b', role: 'system' },
        ],
        prompt_order: [{ character_id: 1, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }] }],
    };
    const snap = structuredClone(base);
    snap.prompts[0].content = 'new a';
    snap.prompts[0].injection_depth = 9;
    // a moved before b AND b toggled off in one edit
    snap.prompt_order[0].order = [{ identifier: 'b', enabled: false }, { identifier: 'a', enabled: true }];
    const delta = panelDelta(base, snap);
    assert.deepEqual(delta.prompts, [
        { identifier: 'a', content: 'new a', injection_depth: 9 },
    ]);
    assert.equal(delta.prompt_order.changed, true);
    assert.deepEqual(delta.prompt_order.order, [
        { identifier: 'b', enabled: false },
        { identifier: 'a' }, // enabled bit untouched -> absent
    ]);
    assert.equal(delta.temperature, undefined); // scalar untouched
});

test('panelDelta: added prompt carries full fields; deleted prompt is {identifier, deleted}', () => {
    const base = {
        prompts: [{ identifier: 'a', name: 'A', content: 'a', role: 'system' }],
        prompt_order: [{ character_id: 1, order: [{ identifier: 'a', enabled: true }] }],
    };
    const snap = {
        prompts: [
            { identifier: 'a', name: 'A', content: 'a', role: 'system' },
            { identifier: 'n', name: 'N', content: 'new block', role: 'user', injection_position: 1 },
        ],
        prompt_order: [{ character_id: 1, order: [{ identifier: 'a', enabled: true }] }],
    };
    const delta = panelDelta(base, snap);
    assert.deepEqual(delta.prompts, [{ identifier: 'n', name: 'N', content: 'new block', role: 'user', injection_position: 1 }]);
    const delta2 = panelDelta(snap, base);
    assert.deepEqual(delta2.prompts, [{ identifier: 'n', deleted: true }]);
});

test('finding: API edits block B content while the panel toggles A from an older base — both survive', async () => {
    const { store, doc } = await storeWithDoc();
    const base = currentProjection(doc); // what the tab based its edit on
    const baseRev = store.rev;

    // concurrent API edit lands AFTER the tab snapshotted: B's content changes
    const docNow = store.getDocNow(doc.id);
    docNow.blocks.b.content = 'API wrote B';
    await store._savePresetNow(docNow);

    // the panel post (queued behind the API write): user toggled A off only;
    // the snapshot still carries B's OLD content because the tab never saw
    // the API edit
    const snapshot = structuredClone(base);
    snapshot.prompt_order.at(-1).order.find((/** @type {any} */ o) => o.identifier === 'a').enabled = false;

    const { routed, rev } = await panelTransaction(store, { baseRev, base, snapshot });
    assert.ok(routed.some((r) => r.key === 'a' && r.layer === 'loadout'), JSON.stringify(routed));
    assert.ok(!routed.some((r) => r.key === 'b'), 'B must not route from the panel post');

    const stored = store.getPreset(doc.id);
    assert.equal(stored.loadouts[stored.activeLoadoutId].enabled.a, false); // panel toggle landed
    assert.equal(stored.blocks.b.content, 'API wrote B'); // API edit SURVIVED
    assert.ok(rev > baseRev);
});

test('finding: API reorder plus panel toggle — both survive', async () => {
    const { store, doc } = await storeWithDoc();
    const base = currentProjection(doc);
    const baseRev = store.rev;

    // concurrent API reorder: b, a, c (blocks layer)
    const docNow = store.getDocNow(doc.id);
    applyOrderToSequences(docNow, ['chatHistory', 'b', 'a', 'c']);
    await store._savePresetNow(docNow);

    // the panel post (based on the OLD order a, b, c): user toggles C on.
    // The snapshot still carries the OLD sequence (a, b, c) — an old-school
    // whole-array route would reorder b/a back and eat the API reorder.
    const snapshot = structuredClone(base);
    snapshot.prompt_order.at(-1).order.find((/** @type {any} */ o) => o.identifier === 'c').enabled = true;

    const { routed } = await panelTransaction(store, { baseRev, base, snapshot });
    assert.ok(routed.some((r) => r.key === 'c' && r.layer === 'loadout'), JSON.stringify(routed));
    // the delta's prompt_order section carries NO order change (the user
    // did not reorder), so the API order must survive untouched
    assert.ok(!routed.some((r) => r.key === 'prompt_order.order'), 'no reorder may route');

    const stored = store.getPreset(doc.id);
    assert.equal(stored.loadouts[stored.activeLoadoutId].enabled.c, true);
    const flat = stored.sequences[0].rows.filter((/** @type {any} */ r) => r.kind === 'block').map((/** @type {any} */ r) => r.ref);
    assert.deepEqual(flat, ['b', 'a', 'c']); // API reorder SURVIVED
});

test('finding: a panel post based on the pre-reorder sequence applies the user reorder around the concurrent API state', async () => {
    // When the USER did reorder in the panel (sequence differs from base),
    // the new sequence is applied to the current doc; identifiers the doc
    // gained in the meantime must keep their relative positions.
    const { store, doc } = await storeWithDoc();
    const base = currentProjection(doc); // order: chatHistory, a, b, c
    const baseRev = store.rev;

    // the doc gained a new block d after the base (Phase-2-ish, but blocks
    // can also arrive via import/replace)
    const docNow = store.getDocNow(doc.id);
    docNow.blocks.d = { identifier: 'd', name: 'D', content: 'd', role: 'system', fields: {}, notes: '' };
    docNow.sequences[0].rows.push({ kind: 'block', ref: 'd', enabled: false, key: 'k-d' });
    docNow.loadouts[docNow.activeLoadoutId].enabled.d = false; // every leaf covered (schema invariant)
    await store._savePresetNow(docNow);

    // the user reordered to c, a, b (from the base's a, b, c; d unknown to them)
    const snapshot = structuredClone(base);
    snapshot.prompt_order.at(-1).order = [
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'c', enabled: false },
        { identifier: 'a', enabled: true },
        { identifier: 'b', enabled: true },
    ];
    const { routed } = await panelTransaction(store, { baseRev, base, snapshot });
    assert.ok(routed.some((r) => r.key === 'prompt_order.order'));
    const stored = store.getPreset(doc.id);
    const flat = stored.sequences[0].rows.filter((/** @type {any} */ r) => r.kind === 'block').map((/** @type {any} */ r) => r.ref);
    // user's sequence wins; d (unknown to the panel) rides at the end
    assert.deepEqual(flat, ['c', 'a', 'b', 'd']);
});

test('finding: prompt field delta is surgical — API edit to B content survives a panel edit of A content', async () => {
    const { store, doc } = await storeWithDoc();
    const base = currentProjection(doc);
    const baseRev = store.rev;

    const docNow = store.getDocNow(doc.id);
    docNow.blocks.b.content = 'API wrote B';
    await store._savePresetNow(docNow);

    // user edits A's content; snapshot still shows B's old content
    const snapshot = structuredClone(base);
    snapshot.prompts.find((/** @type {any} */ p) => p.identifier === 'a').content = 'user rewrote A';

    const { routed } = await panelTransaction(store, { baseRev, base, snapshot });
    assert.ok(routed.some((r) => r.key === 'a' && r.layer === 'blocks'));
    const stored = store.getPreset(doc.id);
    assert.equal(stored.blocks.a.content, 'user rewrote A');
    assert.equal(stored.blocks.b.content, 'API wrote B'); // survived
});

test('finding: panel post queued behind a /slot/load of another preset gets 409 (atomic guard)', async () => {
    const store = await tmpStore();
    const doc1 = await store.importPreset({ st: sampleSt(), name: 'Preset One' });
    const doc2 = await store.importPreset({ st: sampleSt(), name: 'Preset Two' });
    await store.mutateState((st) => {
        store._markSlotChanged();
        st.presetId = doc1.id;
    });
    await store.mutateState((st) => { st.loadoutId = doc1.activeLoadoutId; });
    const base = currentProjection(doc1);
    const baseRev = store.rev;

    // the /slot/load transaction QUEUES FIRST, then the panel post — its
    // body IS the route's body: the mutated state is persisted inside the
    // same queue turn (_mutateStateNow), not just mutated in memory
    const loadPromise = store.enqueue(() => {
        store._markSlotChanged();
        return store._mutateStateNow((/** @type {any} */ st) => {
            st.presetId = doc2.id;
            st.loadoutId = doc2.activeLoadoutId;
        });
    });
    // the panel handler's transaction enqueues behind the load: its guard
    // must see the NEW slotChangedRev inside the same queue
    const panelPromise = panelTransaction(store, { baseRev, base, snapshot: structuredClone(base) });
    await loadPromise;
    await assert.rejects(
        () => panelPromise,
        (err) => err instanceof StoreError && err.status === 409
            && typeof /** @type {any} */ (err).slotChangedRev === 'number'
            && /** @type {any} */ (err).slotChangedRev > baseRev,
    );
    // doc1 was NOT mutated by the stale panel post
    const one = store.getPreset(doc1.id);
    assert.equal(one.rev, 1);
});

test('finding: slot transactions persist — a fresh Store over the same dir reads the new desired state and slotChangedRev', async () => {
    // Review 3 (blocking): /slot/load's transaction mutated store.state in
    // memory only (_bumpRev({skipWrite:true}) skipped the state.json write),
    // so a plugin restart resurrected the previous preset. The route now
    // persists inside the SAME queue turn via _mutateStateNow; this test
    // runs that exact transaction body and re-reads it from disk.
    const store = await tmpStore();
    const docX = await store.importPreset({ st: sampleSt(), name: 'Slot X' });
    const docY = await store.importPreset({ st: sampleSt(), name: 'Slot Y' });
    // park X in the slot first (mutateState = the store's own queue body)
    await store.mutateState((/** @type {any} */ st) => {
        store._markSlotChanged();
        st.presetId = docX.id;
        st.loadoutId = docX.activeLoadoutId;
    });
    const revBefore = store.rev;

    // THE /slot/load transaction, verbatim from the route
    await store.enqueue(() => {
        store._markSlotChanged();
        return store._mutateStateNow((/** @type {any} */ st) => {
            st.presetId = docY.id;
            st.loadoutId = docY.activeLoadoutId;
        });
    });

    assert.equal(store.state.presetId, docY.id);
    assert.equal(store.rev, revBefore + 1, 'the load bumped the rev once');
    assert.equal(store.slotChangedRev, store.rev, 'slotChangedRev names the rev the load bumped to');
    // the acceptance: a FRESH Store over the same directory — a plugin
    // restart — reads the new desired state, not the one from before
    const fresh = new Store(store.root);
    await fresh.init();
    assert.equal(fresh.state.presetId, docY.id, 'state.json carries the loaded preset');
    assert.equal(fresh.state.loadoutId, docY.activeLoadoutId, 'state.json carries the loaded loadout');
    assert.equal(fresh.slotChangedRev, store.slotChangedRev, 'slotChangedRev persisted');
    assert.equal(fresh.state.rev, store.rev, 'global rev persisted');
});

test('finding: same-rev no-op panel post is not a revision, routed edit is', async () => {
    const { store, doc } = await storeWithDoc();
    const base = currentProjection(doc);
    const baseRev = store.rev;

    // nothing changed -> nothing routes -> no save, no rev bump
    const noop = await panelTransaction(store, { baseRev, base, snapshot: structuredClone(base) });
    assert.deepEqual(noop.routed, []);
    assert.equal(noop.rev, baseRev);
    assert.equal(store.getPreset(doc.id).rev, 1);

    // a real edit routes and bumps
    const snapshot = structuredClone(base);
    snapshot.temperature = 0.77;
    const edit = await panelTransaction(store, { baseRev, base, snapshot });
    assert.ok(edit.routed.some((r) => r.key === 'temperature'));
    assert.equal(edit.rev, baseRev + 1);
    assert.equal(store.getPreset(doc.id).settings.temperature, 0.77);
});

test('routePanelDiff: a full-array-shaped delta is never treated as a replacement (regression pin)', () => {
    // If a future panelDelta regresses to carrying the full arrays, this
    // test must fail: an untouched identifier's STALE enabled bit must not
    // route. Current doc has c enabled (API wrote it); the stale delta
    // shows c disabled because the base did.
    const doc = importStPreset(sampleSt(), 'pin');
    ensureDefaultLoadout(doc);
    doc.loadouts[doc.activeLoadoutId].enabled.c = true; // concurrent API write
    const { compiled: current } = compile(doc, null, {});
    assert.equal(current.prompt_order[0].order.find((o) => o.identifier === 'c').enabled, true);
    // a whole-array replacement would carry c: false (stale) and route it
    const delta = {
        prompt_order: { changed: true, order: [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
            { identifier: 'c', enabled: false }, // stale bit
        ] },
        prompts: [],
    };
    routePanelDiff(doc, current, delta, null);
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled.c, false, 'stale bit routed: whole-array replacement crept back in');
});

// ------------------------------------------- linked groups (displaced modal selection)

/**
 * group A (heading h; option o1; remote [r1]) pick-one, x1, chatHistory, r1.
 * Loadouts: R1 (active root, o1 on), P (playstyle of R1).
 * @returns {any}
 */
function linkedDoc() {
    const now = new Date(0).toISOString();
    const B = (/** @type {string} */ id) => ({ identifier: id, name: id.toUpperCase(), content: `${id} text`, role: 'system', fields: {}, notes: '' });
    const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
    return {
        format: 'st-preset-manager/library', version: 1, id: 'ld', name: 'linked', tags: [], notes: '', source: null,
        settings: {}, createdAt: now, updatedAt: now, rev: 1,
        activeLoadoutId: 'R1',
        loadouts: {
            R1: { id: 'R1', name: 'R1', notes: '', kind: 'root', parent: null, enabled: { h: true, o1: true, x1: true, chatHistory: true, r1: false }, overrides: {} },
            P: { id: 'P', name: 'P', notes: '', kind: 'playstyle', parent: 'R1', enabled: {}, overrides: {} },
        },
        markers: [{ identifier: 'chatHistory', prompt: { identifier: 'chatHistory', marker: true } }],
        blocks: { h: B('h'), o1: B('o1'), x1: B('x1'), r1: B('r1') },
        sequences: [{ character_id: 100001, rows: [
            { kind: 'group', key: 'grp:k-h', name: 'A', cardinality: 'pick-one', guessed: false, header: leaf('h'), options: [leaf('o1')], remote: ['k-r1'] },
            leaf('x1'),
            { kind: 'marker', ref: 'chatHistory', key: 'k-chatHistory' },
            leaf('r1'),
        ] }],
    };
}

const tick = (/** @type {string} */ id, /** @type {boolean} */ on) => ({ prompt_order: { order: [{ identifier: id, enabled: on }] }, prompts: [] });

test('linked: a panel tick on the linked member in a root switches the adjacent option off (group:pick-one route)', () => {
    const doc = linkedDoc();
    const { routed } = routePanelDiff(doc, null, tick('r1', true), null);
    assert.equal(doc.loadouts.R1.enabled.r1, true);
    assert.equal(doc.loadouts.R1.enabled.o1, false);
    assert.deepEqual(routed, [{ key: 'r1', layer: 'loadout' }, { key: 'o1', layer: 'group:pick-one' }]);
    // and back: ticking the adjacent option turns the linked member off
    const back = routePanelDiff(doc, null, tick('o1', true), null);
    assert.equal(doc.loadouts.R1.enabled.o1, true);
    assert.equal(doc.loadouts.R1.enabled.r1, false);
    assert.deepEqual(back.routed, [{ key: 'o1', layer: 'loadout' }, { key: 'r1', layer: 'group:pick-one' }]);
});

test('linked: a panel tick on the linked member in a playstyle collapses the pair in its sparse layer', () => {
    const doc = linkedDoc();
    routePanelDiff(doc, null, tick('r1', true), null, 'P');
    assert.deepEqual(doc.loadouts.P.enabled, { r1: true, o1: false });
    assert.equal(doc.loadouts.R1.enabled.o1, true, 'the root is never written');
});

test('linked: a panel tick on the linked member under a per-Model override collapses the pair in the override', () => {
    const doc = linkedDoc();
    doc.loadouts.R1.overrides = { M: { enabled: { o1: true, r1: false }, tuning: null } };
    routePanelDiff(doc, null, tick('r1', true), { name: 'M' });
    assert.deepEqual(doc.loadouts.R1.overrides.M.enabled, { o1: false, r1: true });
});

test('linked: a panel reorder moving the linked leaf keeps the link', () => {
    const doc = linkedDoc();
    assert.equal(applyOrderToSequences(doc, ['h', 'o1', 'x1', 'r1', 'chatHistory']), true);
    const rows = doc.sequences[0].rows;
    assert.deepEqual(rows.map((/** @type {any} */ r) => r.key), ['grp:k-h', 'k-x1', 'k-r1', 'k-chatHistory']);
    assert.deepEqual(rows[0].remote, ['k-r1']);
});
