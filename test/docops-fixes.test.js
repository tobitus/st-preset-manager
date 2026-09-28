/**
 * Regression tests for the four sub-phase 2a review findings:
 *   1. deleteBlock on a group/section heading must not destroy its children;
 *   2. addBlock must accept a group/section heading as its `before` anchor;
 *   3. createGroup must refuse (404, document untouched) when any key is
 *      missing, and 400 on a malformed `keys`;
 *   4. no leaf row in `sequences` ever carries an `enabled` bit (PLAN Phase 2
 *      Must NOT) — new leaves, imports, and stored docs loaded at rescan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, deriveStructure } from '../shared/outline.js';
import { applyDocOp } from '../shared/docops.js';
import { Store, ensureDefaultLoadout } from '../plugin/store.js';

const REPO = path.resolve(import.meta.dirname, '..');
const FF_FILE = path.join(REPO, 'dev/fixtures/presets', 'Freaky Frankenstein 5.4 Internal States (2).json');

function ffSt() {
    return JSON.parse(fs.readFileSync(FF_FILE, 'utf8'));
}

/** FF 5.4 through the store's import path (see outline.test.js ffDoc). */
function ffDoc() {
    const doc = importStPreset(ffSt(), 'FF54');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    return doc;
}

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => doc.sequences.flatMap((/** @type {any} */ s) => flattenSeq(s.rows));
const flatIds = (/** @type {any} */ doc) => flat(doc).map((e) => identOf(e.leaf));

/** Every group as {header ident|null, option idents}, keyed by header ident (or first option). */
function groupsOf(/** @type {any} */ doc) {
    /** @type {Record<string, {header: string|null, options: string[], cardinality: string}>} */
    const out = {};
    const walk = (/** @type {any[]} */ rows) => {
        for (const row of rows) {
            if (row.kind === 'group') {
                const header = row.header ? identOf(row.header) : null;
                const options = (row.options ?? []).map(identOf);
                out[header ?? options[0]] = { header, options, cardinality: row.cardinality };
            }
            for (const f of ['rows', 'options']) if (Array.isArray(row[f])) walk(row[f]);
        }
    };
    for (const s of doc.sequences) walk(s.rows);
    return out;
}

/** All leaf rows (incl. group/section headers) anywhere in sequences. */
function allLeafRows(/** @type {any} */ doc) {
    /** @type {any[]} */
    const out = [];
    const walk = (/** @type {any[]} */ rows) => {
        for (const row of rows) {
            if (['marker', 'block', 'ghost'].includes(row.kind)) out.push(row);
            if (row.header) out.push(row.header);
            for (const f of ['rows', 'options']) if (Array.isArray(row[f])) walk(row[f]);
        }
    };
    for (const s of doc.sequences) walk(s.rows);
    return out;
}

const topGroup = (/** @type {any} */ doc, /** @type {RegExp} */ re) => doc.sequences[0].rows.find(
    (/** @type {any} */ r) => r.kind === 'group' && re.test(r.name),
);

const without = (/** @type {string[]} */ ids, /** @type {string} */ gone) => {
    const i = ids.indexOf(gone);
    assert.ok(i !== -1);
    return [...ids.slice(0, i), ...ids.slice(i + 1)];
};

// ------------------------------------------------------------ finding 1

test('fix 1: deleteBlock on a GROUP heading keeps its options, in place and in order, as items', () => {
    const doc = ffDoc();
    const pov = topGroup(doc, /POV/);
    const headerId = identOf(pov.header);
    const optionIds = pov.options.map(identOf);
    assert.equal(optionIds.length, 4);
    const before = flatIds(doc);
    const groupsBefore = groupsOf(doc);
    const enabledBefore = { ...doc.loadouts[doc.activeLoadoutId].enabled };

    applyDocOp(doc, 'deleteBlock', { identifier: headerId });

    // invariant: the flattened identifier sequence loses exactly the heading
    assert.deepEqual(flatIds(doc), without(before, headerId));
    // the options are now plain top-level items at the heading's position
    const entries = flat(doc);
    for (const id of optionIds) {
        const e = entries.find((x) => identOf(x.leaf) === id);
        assert.equal(e.rank, 'item', `${id} is an item after its heading went`);
    }
    // every OTHER group is untouched (no merge into the neighbouring group)
    const groupsAfter = groupsOf(doc);
    delete groupsBefore[headerId];
    assert.deepEqual(groupsAfter, groupsBefore);
    // enabled bits: only the deleted identifier left the loadout
    const enabledAfter = doc.loadouts[doc.activeLoadoutId].enabled;
    delete enabledBefore[headerId];
    assert.deepEqual(enabledAfter, enabledBefore);
    assert.equal(doc.blocks[headerId], undefined);
});

test('fix 1: deleteBlock on a SECTION heading keeps the whole subtree, in place and in order', () => {
    const doc = ffDoc();
    // Time and Place (a top-level item) -> group -> section: the section
    // then holds every row after it (groups, markers, …)
    const tp = doc.sequences[0].rows[1];
    assert.equal(tp.kind, 'block');
    applyDocOp(doc, 'promote', { key: tp.key });
    applyDocOp(doc, 'promote', { key: tp.key });
    const sec = doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section');
    assert.ok(sec, 'section formed');
    assert.equal(identOf(sec.header), tp.ref);
    const before = flatIds(doc);
    const groupsBefore = groupsOf(doc);
    assert.ok(Object.keys(groupsBefore).length >= 8);

    applyDocOp(doc, 'deleteBlock', { identifier: tp.ref });

    assert.deepEqual(flatIds(doc), without(before, tp.ref));
    assert.ok(!doc.sequences[0].rows.some((/** @type {any} */ r) => r.kind === 'section'), 'no section left');
    assert.deepEqual(groupsOf(doc), groupsBefore, 'every group inside the section survives intact');
});

test('fix 1: deleting a section heading whose first rows are a headerless option run never merges them into the group above', () => {
    const doc = ffDoc();
    const pov = topGroup(doc, /POV/);
    const headerId = identOf(pov.header);
    // POV heading: group -> section (its options become a headerless run
    // inside the section, directly after the Prose Style group)
    applyDocOp(doc, 'promote', { key: pov.header.key });
    const before = flatIds(doc);
    const prose = topGroup(doc, /Prose/);
    const proseOptions = prose.options.map(identOf);

    applyDocOp(doc, 'deleteBlock', { identifier: headerId });

    assert.deepEqual(flatIds(doc), without(before, headerId));
    const proseAfter = topGroup(doc, /Prose/);
    assert.deepEqual(proseAfter.options.map(identOf), proseOptions, 'Prose Style group keeps exactly its own options');
});

test('fix 1: deleteBlock of a group OPTION still removes only that option', () => {
    const doc = ffDoc();
    const pov = topGroup(doc, /POV/);
    const optId = identOf(pov.options[1]);
    const before = flatIds(doc);
    applyDocOp(doc, 'deleteBlock', { identifier: optId });
    assert.deepEqual(flatIds(doc), without(before, optId));
    assert.equal(topGroup(doc, /POV/).options.length, 3);
});

// ------------------------------------------------------------ finding 2

test('fix 2: addBlock anchors before a GROUP heading (lands as an item directly above it)', () => {
    for (const re of [/Prose/, /POV/]) {
        const doc = ffDoc();
        const grp = topGroup(doc, re);
        const groupsBefore = groupsOf(doc);
        const added = applyDocOp(doc, 'addBlock', { name: 'Anchored', before: grp.header.key });
        const entries = flat(doc);
        const idx = entries.findIndex((e) => identOf(e.leaf) === added.identifier);
        assert.ok(idx !== -1);
        assert.equal(entries[idx + 1].leaf.key, grp.header.key, `${re}: directly before the heading`);
        assert.equal(entries[idx].rank, 'item', `${re}: new block is an item, not an option of the group above`);
        assert.deepEqual(groupsOf(doc), groupsBefore, `${re}: groups unchanged`);
    }
});

test('fix 2: addBlock anchors before a SECTION heading (lands outside, directly above the section)', () => {
    const doc = ffDoc();
    const tp = doc.sequences[0].rows[1];
    applyDocOp(doc, 'promote', { key: tp.key });
    applyDocOp(doc, 'promote', { key: tp.key });
    const rows0 = doc.sequences[0].rows;
    const sec = rows0.find((/** @type {any} */ r) => r.kind === 'section');
    const secRowCount = sec.rows.length;
    const added = applyDocOp(doc, 'addBlock', { name: 'Before section', before: tp.key });
    const rows = doc.sequences[0].rows;
    const secIdx = rows.findIndex((/** @type {any} */ r) => r.kind === 'section');
    assert.equal(identOf(rows[secIdx - 1]), added.identifier, 'top-level row directly above the section');
    assert.equal(rows[secIdx].rows.length, secRowCount, 'section content unchanged');
    assert.equal(identOf(rows[secIdx].header), tp.ref);
});

test('fix 2: addBlock with an unknown anchor is still a 404', () => {
    const doc = ffDoc();
    assert.throws(() => applyDocOp(doc, 'addBlock', { name: 'X', before: 'nope' }), (/** @type {any} */ e) => e.status === 404);
});

// ------------------------------------------------------------ finding 3

test('fix 3: createGroup with a missing member key is a 404 and leaves the document untouched', () => {
    const doc = ffDoc();
    const item = flat(doc).find((e) => e.rank === 'item' && e.leaf.kind === 'block');
    const snapshot = structuredClone(doc);
    assert.throws(
        () => applyDocOp(doc, 'createGroup', { keys: [item.leaf.key, 'NONEXISTENT'], name: 'partial' }),
        (/** @type {any} */ e) => e.status === 404,
    );
    assert.deepEqual(doc, snapshot);
});

test('fix 3: createGroup rejects a malformed keys argument with 400', () => {
    const doc = ffDoc();
    const item = flat(doc).find((e) => e.rank === 'item' && e.leaf.kind === 'block');
    const snapshot = structuredClone(doc);
    for (const keys of [item.leaf.key, [item.leaf.key, 7], { 0: item.leaf.key }]) {
        assert.throws(
            () => applyDocOp(doc, 'createGroup', { keys, name: 'bad' }),
            (/** @type {any} */ e) => e.status === 400,
            `keys=${JSON.stringify(keys)}`,
        );
    }
    assert.deepEqual(doc, snapshot);
});

// ------------------------------------------------------------ finding 4

test('fix 4: addOption and addBlock create leaves without an enabled bit; loadouts carry it', () => {
    const doc = ffDoc();
    // a second loadout, so "every loadout" is exercised
    const lid = 'l_second';
    doc.loadouts[lid] = { id: lid, name: 'B', notes: '', enabled: { ...doc.loadouts[doc.activeLoadoutId].enabled }, overrides: {} };
    const pov = topGroup(doc, /POV/);
    const opt = applyDocOp(doc, 'addOption', { group: pov.key, name: 'Opt' });
    const blk = applyDocOp(doc, 'addBlock', { name: 'Blk' });
    const blk2 = applyDocOp(doc, 'addBlock', { name: 'Blk2', before: pov.header.key });
    for (const id of [opt.identifier, blk.identifier, blk2.identifier]) {
        const row = allLeafRows(doc).find((r) => identOf(r) === id);
        assert.ok(row, id);
        assert.ok(!('enabled' in row), `${id}: no enabled key on the leaf row`);
        for (const l of Object.values(doc.loadouts)) {
            assert.equal(/** @type {any} */ (l).enabled[id], false, `${id}: off in loadout ${/** @type {any} */ (l).name}`);
        }
    }
});

test('fix 4: an imported doc has no enabled bits in sequences; the loadout keeps the imported state', () => {
    const doc = ffDoc();
    assert.deepEqual(allLeafRows(doc).filter((r) => 'enabled' in r).map(identOf), []);
    // the imported on/off state lives in the loadout (FF: Cinematic Realism on, Story Mode off)
    const prose = topGroup(doc, /Prose/);
    const en = doc.loadouts[doc.activeLoadoutId].enabled;
    const st = ffSt();
    const stOrder = new Map(st.prompt_order.find((/** @type {any} */ o) => o.character_id === 100001).order
        .map((/** @type {any} */ o) => [o.identifier, o.enabled]));
    for (const o of prose.options) assert.equal(en[identOf(o)], !!stOrder.get(identOf(o)));
    for (const [id, on] of stOrder) assert.equal(en[id], !!on, `loadout bit for ${id}`);
});

test('fix 4: the store strips enabled bits on import and on loading a stored doc that still carries them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-fix4-'));
    const store = new Store(root);
    await store.init();
    const doc = await store.importPreset({ st: ffSt(), name: 'FF import' });
    assert.deepEqual(allLeafRows(doc).filter((r) => 'enabled' in r).map(identOf), []);
    // a legacy file (written before this fix) with bits on every leaf row
    const legacy = structuredClone(doc);
    for (const row of allLeafRows(legacy)) row.enabled = true;
    const file = path.join(store.root, 'presets', 'FF import.json');
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
    await store.rescan();
    const reread = store.getPreset(doc.id);
    assert.deepEqual(allLeafRows(reread).filter((r) => 'enabled' in r).map(identOf), []);
    assert.deepEqual(reread.loadouts, doc.loadouts, 'loadouts untouched by the strip');
});
