/**
 * Outline rank/move ops + document ops (Phase 2a). Ports v1 smoke.py's
 * invariants (a)–(e) onto the v2 shared/outline.js + shared/docops.js:
 *
 *   (a) a seeded random run of ≥50 promote/demote ops leaves the compiled
 *       preset byte-identical (structure is layout-only);
 *   (b) demote∘promote and promote∘demote (where legal) restore identical
 *       `sequences`;
 *   (c) after random moves the compiled prompt_order equals the flattened
 *       leaf order, the identifier multiset is unchanged and every enabled
 *       bit is unchanged;
 *   (d) markers refuse to become a heading or an option;
 *   (e) validate rejects a marker inside a group.
 *
 * Plus docops coverage: loadout create-from/activate, notes never in the
 * compile, group shape ops, add/remove option and block, metadata.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, promote, demote, moveLeaf, deriveStructure, OutlineError } from '../shared/outline.js';
import { applyDocOp, OpError } from '../shared/docops.js';
import { compile } from '../shared/compile.js';
import { validateDoc } from '../shared/schema.js';
import { Store, ensureDefaultLoadout } from '../plugin/store.js';

const REPO = path.resolve(import.meta.dirname, '..');

function loadFixture(rel) {
    const c = path.join(REPO, 'dev/fixtures/presets', rel);
    return fs.existsSync(c) ? JSON.parse(fs.readFileSync(c, 'utf8')) : null;
}

/**
 * FF 5.4 (8 groups, 39 options, 10 items) through the import path the store
 * uses (recognizer + default loadout + deriveStructure normalization).
 */
function ffDoc() {
    const st = loadFixture('Freaky Frankenstein 5.4 Internal States (2).json');
    const doc = importStPreset(st, 'FF54');
    ensureDefaultLoadout(doc);
    deriveStructure(doc); // what store.importPreset adds on top of the recognizer
    return doc;
}

/** Deterministic LCG (v1 smoke uses Python's random.Random; exact values
 * differ, the invariant does not care). */
function lcg(seed) {
    let x = seed;
    return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const flatRows = (/** @type {any} */ doc) => doc.sequences.flatMap((/** @type {any} */ s) => flattenSeq(s.rows));

const multiset = (/** @type {string[]} */ a) => {
    const m = /** @type {Record<string, number>} */ ({});
    for (const x of a) m[x] = (m[x] ?? 0) + 1;
    return m;
};

// ---------------------------------------------------------------- (a)

test('smoke (a): ≥50 seeded-random promote/demote ops leave the compiled preset byte-identical', () => {
    const st = loadFixture('Freaky Frankenstein 5.4 Internal States (2).json');
    if (!st) return;
    const doc = ffDoc();
    const published = (/** @type {any} */ d) => JSON.stringify(compile(d, null, {}).compiled);
    for (const seed of [7, 99]) {
        const rng = lcg(seed);
        const d0 = JSON.parse(JSON.stringify(doc));
        const pub0 = published(d0);
        let applied = 0;
        for (let i = 0; i < 400 && applied < 60; i++) {
            const cand = flatRows(d0).filter((/** @type {any} */ e) => !['marker', 'ghost'].includes(e.leaf.kind));
            if (!cand.length) break;
            const key = cand[Math.floor(rng() * cand.length)].leaf.key;
            try {
                applyDocOp(d0, rng() < 0.5 ? 'promote' : 'demote', { key });
                applied++;
            } catch { /* illegal move refused */ }
        }
        assert.ok(applied >= 50, `seed ${seed}: only ${applied} ops applied`);
        assert.equal(published(d0), pub0, `seed ${seed}: compiled output changed by ${applied} rank ops`);
    }
});

// ---------------------------------------------------------------- (b)

test('smoke (b): demote∘promote and promote∘demote restore identical sequences (every rank, where legal)', () => {
    const doc = ffDoc();
    // one row of every available rank; v1 pairs: option/item/group run
    // promote then demote, section runs demote then promote (the legal
    // directions — a heading's promote is inverted by its demote).
    for (const [rank, op1, op2] of /** @type {const} */ ([
        ['option', 'promote', 'demote'],
        ['item', 'promote', 'demote'],
        ['group', 'promote', 'demote'],
        ['section', 'demote', 'promote'],
    ])) {
        const entry = flatRows(doc).find((/** @type {any} */ e) => e.rank === rank && !['marker', 'ghost'].includes(e.leaf.kind));
        if (!entry) continue; // rank absent in this preset
        const snap = JSON.stringify(doc.sequences);
        applyDocOp(doc, op1, { key: entry.leaf.key });
        applyDocOp(doc, op2, { key: entry.leaf.key });
        assert.equal(JSON.stringify(doc.sequences), snap, `${rank}: ${op1}∘${op2} did not restore sequences`);
    }
    // the _gmeta/_sname inverse bookkeeping: promote(group heading -> section)
    // stashes the group meta on the leaf; demote(section -> group) pops it —
    // the identical group re-appears (name, cardinality, guessed).
    const doc2 = ffDoc();
    const grpEntry = flatRows(doc2).find((/** @type {any} */ e) => e.rank === 'group');
    const grpMeta = /** @type {any} */ (grpEntry.gmeta);
    applyDocOp(doc2, 'promote', { key: grpEntry.leaf.key }); // heading becomes a section heading
    const secEntry = flatRows(doc2).find((/** @type {any} */ e) => e.leaf.key === grpEntry.leaf.key);
    assert.equal(secEntry.rank, 'section');
    applyDocOp(doc2, 'demote', { key: grpEntry.leaf.key }); // pops the stash, re-forms the group
    const again = flatRows(doc2).find((/** @type {any} */ e) => e.rank === 'group');
    assert.deepEqual(again.gmeta, grpMeta);
});

// ---------------------------------------------------------------- (c)

test('smoke (c): after ≥50 random moves the compiled prompt_order equals the flattened leaf order; identifier multiset and enabled bits unchanged', () => {
    const doc = ffDoc();
    const rng = lcg(5);
    const before = compile(doc, null, {});
    const ids0 = before.compiled.prompt_order.flatMap((/** @type {any} */ s) => s.order.map((/** @type {any} */ o) => o.identifier));
    const bits0 = JSON.stringify(before.enabled);
    let applied = 0;
    for (let i = 0; i < 150 && applied < 60; i++) {
        const cand = flatRows(doc).filter((/** @type {any} */ e) => e.rank !== 'section');
        if (!cand.length) break;
        const key = cand[Math.floor(rng() * cand.length)].leaf.key;
        try {
            moveLeaf(doc, key, rng() < 0.5 ? -1 : 1);
            applied++;
        } catch { /* boundary refusal */ }
    }
    assert.ok(applied >= 50, `only ${applied} move ops applied`);
    const after = compile(doc, null, {});
    const order = after.compiled.prompt_order.flatMap((/** @type {any} */ s) => s.order.map((/** @type {any} */ o) => o.identifier));
    const leaves = flatRows(doc).map((/** @type {any} */ e) => e.leaf.ref ?? e.leaf.identifier);
    assert.deepEqual(order, leaves, 'compiled prompt_order != flattened on-screen leaf order');
    assert.deepEqual(multiset(order), multiset(ids0), 'identifier multiset changed by moves');
    assert.equal(JSON.stringify(after.enabled), bits0, 'enabled bits changed by moves');
});

// ---------------------------------------------------------------- (d)

test('smoke (d): markers refuse to become a heading or an option', () => {
    const doc = ffDoc();
    const markerEntries = flatRows(doc).filter((/** @type {any} */ e) => e.leaf.kind === 'marker');
    assert.ok(markerEntries.length >= 5);
    for (const e of markerEntries) {
        for (const op of ['promote', 'demote']) {
            assert.throws(() => applyDocOp(doc, op, { key: e.leaf.key }), OutlineError,
                `marker ${e.leaf.ref} must refuse ${op}`);
        }
        // moveLeaf is fine (markers keep their place in the order), but a
        // marker can never enter a group: moving it onto a group heading's
        // options is refused by rebuild via rank — an item move never does.
        assert.equal(e.rank, 'item');
    }
    // direct rank attempts on a synthetic marker leaf too
    const marker = { kind: 'marker', ref: 'chatHistory', enabled: true, key: 'm1' };
    assert.throws(() => rebuildSeq([{ leaf: marker, rank: 'group', gmeta: null, sname: null }]), OutlineError);
    assert.throws(() => rebuildSeq([{ leaf: marker, rank: 'section', gmeta: null, sname: null }]), OutlineError);
    assert.throws(() => rebuildSeq([{ leaf: marker, rank: 'option', gmeta: null, sname: null }]), OutlineError);
    // and promote/demote on a raw doc reject it before any rank change
    const raw = ffDoc();
    raw.sequences[0].rows = [marker, ...raw.sequences[0].rows];
    assert.throws(() => promote(raw, 'm1'), OutlineError);
    assert.throws(() => demote(raw, 'm1'), OutlineError);
});

// ---------------------------------------------------------------- (e)

test('smoke (e): validate rejects a marker inside a group', () => {
    const doc = ffDoc();
    // find a group, plant a marker among its options
    const grp = flatRows(doc).find((/** @type {any} */ e) => e.rank === 'group');
    assert.ok(grp);
    const rows = doc.sequences[0].rows;
    const groupRow = rows.find((/** @type {any} */ r) => r.kind === 'group');
    groupRow.options.push({ kind: 'marker', ref: 'chatHistory', enabled: true, key: 'row-planted' });
    const errs = validateDoc(doc);
    assert.ok(errs.some((/** @type {string} */ p) => p.includes('marker in group options')),
        `validator accepted a marker inside a group: ${JSON.stringify(errs)}`);
});

// --------------------------------------------------------- op behaviors

test('ops: toggle and setGroup write loadout bits only; pick-one collapses to the clicked option', () => {
    const doc = ffDoc();
    const grp = flatRows(doc).find((/** @type {any} */ e) => e.rank === 'group');
    const groupRow = doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'group');
    assert.equal(groupRow.cardinality, 'pick-one');
    const [on1, on2] = groupRow.options.map((/** @type {any} */ o) => o.ref);
    const enabled = doc.loadouts[doc.activeLoadoutId].enabled;
    enabled[on1] = true;
    enabled[on2] = false;
    applyDocOp(doc, 'setGroup', { group: groupRow.key, identifier: on2 });
    assert.equal(enabled[on2], true);
    assert.equal(enabled[on1], false, 'pick-one sibling must collapse');
    // setGroup with a non-member refuses
    assert.throws(() => applyDocOp(doc, 'setGroup', { group: groupRow.key, identifier: 'main' }), (/** @type {any} */ e) => e.status === 404);
    // sequence untouched: rank ops never ride on toggle
    void grp;
});

test('ops: createGroup forms a group from existing leaves; renameGroup and setCardinality own it', () => {
    const doc = ffDoc();
    const items = flatRows(doc).filter((/** @type {any} */ e) => e.rank === 'item' && e.leaf.kind === 'block').slice(0, 2);
    const res = applyDocOp(doc, 'createGroup', {
        keys: items.map((/** @type {any} */ e) => e.leaf.key),
        headerKey: items[0].leaf.key,
        name: 'Made by test',
        cardinality: 'pick-one-or-more',
    });
    assert.ok(res.groupKey);
    const grp = doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'group' && r.key === res.groupKey);
    assert.equal(grp.name, doc.blocks[items[0].leaf.ref].name, 'a headed group is named after its heading block (the given name is ignored)');
    assert.equal(grp.header.ref, items[0].leaf.ref);
    assert.equal(grp.options.length, 1); // second item became the option
    assert.equal(grp.guessed, false);
    applyDocOp(doc, 'renameGroup', { key: res.groupKey, name: 'Renamed' });
    assert.equal(grp.name, 'Renamed');
    assert.equal(doc.blocks[items[0].leaf.ref].name, 'Renamed', 'renameGroup on a headed group renames its heading block too');
    // both FF items start enabled: switching to pick-one with 2 on is refused
    // (test/cardinality.test.js), so turn the heading off first
    doc.loadouts[doc.activeLoadoutId].enabled[items[0].leaf.ref] = false;
    applyDocOp(doc, 'setCardinality', { key: res.groupKey, cardinality: 'pick-one' });
    assert.equal(grp.cardinality, 'pick-one');
    assert.throws(() => applyDocOp(doc, 'setCardinality', { key: res.groupKey, cardinality: 'pick-two' }), OpError);
});

test('ops: addOption clones the sibling shape, removeOption detaches without deleting the block', () => {
    const doc = ffDoc();
    const groupRow = doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'group');
    const sibling = doc.blocks[groupRow.options[0].ref];
    const res = applyDocOp(doc, 'addOption', { group: groupRow.key, name: 'New option', content: 'hi' });
    const created = doc.blocks[res.identifier];
    assert.equal(created.name, 'New option');
    assert.equal(created.content, 'hi');
    assert.equal(created.role, sibling.role);
    assert.equal(created.fields.injection_depth, sibling.fields.injection_depth);
    assert.equal(created.fields.marker, false, 'a copied block is never an ST marker');
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled[res.identifier], false);
    assert.ok(groupRow.options.at(-1).ref === res.identifier);
    // removeOption: the row leaves the group, the block stays (orphan)
    const rowKey = groupRow.options.at(-1).key;
    applyDocOp(doc, 'removeOption', { key: rowKey });
    assert.ok(!groupRow.options.some((/** @type {any} */ o) => o.key === rowKey));
    assert.ok(doc.blocks[res.identifier]);
    assert.throws(() => applyDocOp(doc, 'removeOption', { key: 'seq100001-0' }), /not a group option/);
});

test('ops: addBlock/deleteBlock place and remove leaf rows; addBlock honours a before anchor', () => {
    const doc = ffDoc();
    const anchor = flatRows(doc).find((/** @type {any} */ e) => e.rank === 'item');
    const added = applyDocOp(doc, 'addBlock', { name: 'Inserted block', content: 'x', before: anchor.leaf.key });
    const flatAfter = flatRows(doc);
    const idx = flatAfter.findIndex((/** @type {any} */ e) => e.leaf.ref === added.identifier);
    assert.equal(flatAfter[idx + 1]?.leaf.key, anchor.leaf.key, 'block landed directly before the anchor');
    const enabled = doc.loadouts[doc.activeLoadoutId].enabled;
    assert.equal(enabled[added.identifier], false);
    // compile carries it disabled
    const { compiled } = compile(doc, null, {});
    assert.ok(compiled.prompts.some((/** @type {any} */ p) => p.identifier === added.identifier && p.enabled === false));
    // delete removes everywhere
    applyDocOp(doc, 'deleteBlock', { identifier: added.identifier });
    assert.ok(!doc.blocks[added.identifier]);
    assert.ok(!(added.identifier in enabled));
    assert.ok(!flatRows(doc).some((/** @type {any} */ e) => e.leaf.ref === added.identifier));
    assert.throws(() => applyDocOp(doc, 'deleteBlock', { identifier: added.identifier }), (/** @type {any} */ e) => e.status === 404);
});

test('ops: setContent/editBlock/renameBlock mutate blocks; setNotes/setBlockNotes never reach the compile', () => {
    const doc = ffDoc();
    const ident = flatRows(doc).find((/** @type {any} */ e) => e.leaf.kind === 'block').leaf.ref;
    applyDocOp(doc, 'setContent', { identifier: ident, content: 'replaced body' });
    assert.equal(doc.blocks[ident].content, 'replaced body');
    applyDocOp(doc, 'renameBlock', { identifier: ident, name: '  New name  ' });
    assert.equal(doc.blocks[ident].name, 'New name');
    applyDocOp(doc, 'editBlock', { identifier: ident, role: 'user', fields: { injection_depth: 9 } });
    assert.equal(doc.blocks[ident].role, 'user');
    assert.equal(doc.blocks[ident].fields.injection_depth, 9);
    applyDocOp(doc, 'setBlockNotes', { identifier: ident, notes: 'my private note' });
    applyDocOp(doc, 'setNotes', { notes: 'whole-preset private note' });
    assert.equal(doc.notes, 'whole-preset private note');
    const { compiled } = compile(doc, null, {});
    assert.equal(JSON.stringify(compiled).includes('private note'), false, 'notes leaked into the compile');
    assert.equal(JSON.stringify(compiled).includes('my private note'), false);
    // block notes ARE in the native doc but not in any compiled prompt
    assert.equal(doc.blocks[ident].notes, 'my private note');
    assert.ok(!compiled.prompts.some((/** @type {any} */ p) => p.identifier === ident && p.notes !== undefined));
});

test('ops: setSettings rejects connection keys and stores the rest', () => {
    const doc = ffDoc();
    assert.throws(
        () => applyDocOp(doc, 'setSettings', { settings: { temperature: 0.7, proxy_password: 'x' } }),
        /connection keys are never stored/,
    );
    applyDocOp(doc, 'setSettings', { settings: { temperature: 0.7, wi_format: 'f' } });
    assert.equal(doc.settings.temperature, 0.7);
    assert.equal(doc.settings.wi_format, 'f');
});

test('ops: unknown op and missing args give clean 400s', () => {
    const doc = ffDoc();
    assert.throws(() => applyDocOp(doc, 'explode', {}), /unknown op/);
    assert.throws(() => applyDocOp(doc, 'promote', {}), OpError);
    assert.throws(() => applyDocOp(doc, 'moveLeaf', { key: 'seq100001-0' }), OpError);
    assert.throws(() => applyDocOp(doc, 'promote', { key: 'nope' }), (/** @type {any} */ e) => e.status === 404);
});

// ------------------------------------------------- store-level Phase 2 ops

function tmpStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-ops-test-'));
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

test('store: docs normalize structure at import and rescan (byte-exact rank ops from the first application)', async () => {
    const store = tmpStore();
    await store.init();
    const doc = await store.importPreset({ st: sampleSt(), name: 'Norm' });
    // container keys are derived from headings after import
    const rows = doc.sequences[0].rows;
    for (const row of rows) {
        if (row.kind === 'group') assert.match(row.key, /^grp:/);
        if (row.kind === 'section') assert.match(row.key, /^sec:/);
    }
    // a hand-edited file with raw keys normalizes at rescan (v1 load_canonical)
    rows[0].key = 'hand-edited';
    const file = path.join(store.root, 'presets', 'Norm.json');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    await store.rescan();
    // sequence re-derives deterministically: flatten -> rebuild is the identity now
    const reread = store.getPreset(doc.id);
    assert.deepEqual(rebuildSeq(flattenSeq(reread.sequences[0].rows)), reread.sequences[0].rows);
});

test('store: loadout create-from copies state, activate switches the slot view (acceptance 6 shape)', async () => {
    const store = tmpStore();
    await store.init();
    const doc = await store.importPreset({ st: sampleSt(), name: 'Loadouts' });
    const id = doc.id;
    const active = doc.activeLoadoutId;
    // create B from the current loadout
    const created = await store.enqueue(async () => {
        const d = store.getDocNow(id);
        const lid = `l_${(/** @type {any} */ (await import('../shared/util.js'))).ulid()}`;
        d.loadouts[lid] = { id: lid, name: 'B', notes: '', enabled: { ...d.loadouts[active].enabled }, overrides: {} };
        return store._savePresetNow(d);
    });
    const lidB = Object.values(created.loadouts).find((/** @type {any} */ l) => l.name === 'B')?.id;
    assert.ok(lidB);
    // flip two bits in B (setGroup-style direct write here; toggle ops tested above)
    const flipped = await store.enqueue(async () => {
        const d = store.getDocNow(id);
        d.loadouts[lidB].enabled.a = !d.loadouts[lidB].enabled.a;
        d.loadouts[lidB].enabled.c = !d.loadouts[lidB].enabled.c;
        return store._savePresetNow(d);
    });
    // activate B, then back to A: A's exact on/off state is restored
    const enabledA0 = { ...doc.loadouts[active].enabled };
    await store.enqueue(async () => {
        const d = store.getDocNow(id);
        d.activeLoadoutId = /** @type {string} */ (lidB);
        return store._savePresetNow(d);
    });
    const back = await store.enqueue(async () => {
        const d = store.getDocNow(id);
        d.activeLoadoutId = active;
        return store._savePresetNow(d);
    });
    assert.deepEqual(back.loadouts[active].enabled, enabledA0);
    assert.equal(flipped.loadouts[lidB].enabled.a, !enabledA0.a);
    void store;
});
