/**
 * Phase 6: cross-preset copy (shared/docops.js copyPayloadFromDoc /
 * copyIntoDoc / macroWarnings). Pure document level; the store transaction
 * and the shelf live in test/shelf.test.js.
 *
 * Landing rule under test (`before` = the leaf key of the row the drop landed
 * above, null = end of the first sequence):
 *   single block  anchor option  -> an option of that group at that position
 *                 anchor item    -> an item at that position
 *                 anchor heading -> an item right above the heading (a group
 *                                   heading: above the group; a section
 *                                   heading: the end of whatever precedes it)
 *   whole group   anchor option  -> snaps above the anchor's group (never splits)
 *                 anything else  -> right above the anchor
 * Identifiers are re-minted on every copy; markers never transfer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure } from '../shared/outline.js';
import { copyPayloadFromDoc, copyIntoDoc, macroWarnings } from '../shared/docops.js';
import { ensureDefaultLoadout } from '../plugin/store.js';
import { validateDoc } from '../shared/schema.js';

const REPO = path.resolve(import.meta.dirname, '..');
const FF_FILE = path.join(REPO, 'dev/fixtures/presets', 'Freaky Frankenstein 5.4 Internal States (2).json');

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const flatIds = (/** @type {any} */ doc) => flat(doc).map((e) => identOf(e.leaf));

function ffDoc() {
    const doc = importStPreset(JSON.parse(fs.readFileSync(FF_FILE, 'utf8')), 'FF54');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    return stamp(doc);
}

/** the store mints id/timestamps/rev; validateDoc needs them */
function stamp(/** @type {any} */ doc) {
    Object.assign(doc, { id: 'p_test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1 });
    return doc;
}

const IDS = ['a', 'b', 'g', 'o1', 'o2', 's1', 'c', 'd', 's2', 'e'];

/**
 * Target document, first sequence (flat):
 *   0 a item · 1 b item · 2 g group heading (pick-one "Pick G") · 3 o1 option
 *   4 o2 option · 5 s1 section heading ("S1") · 6 c item · 7 d item
 *   8 s2 section heading ("S2") · 9 e item · 10 chatHistory marker item
 * Two loadouts (active + a second one); a's content mentions {{getvar::known}}.
 */
function target() {
    const st = {
        prompts: [
            { identifier: 'chatHistory', marker: true },
            ...IDS.map((id) => ({ identifier: id, name: id.toUpperCase(), content: id === 'a' ? 'uses {{getvar::known}} and {{char}}' : `content ${id}`, role: 'system' })),
        ],
        prompt_order: [{ character_id: 100001, order: [...IDS, 'chatHistory'].map((identifier) => ({ identifier, enabled: true })) }],
    };
    const doc = importStPreset(st, 'Target');
    ensureDefaultLoadout(doc);
    const lid = doc.activeLoadoutId;
    doc.loadouts.l_second = { ...structuredClone(doc.loadouts[lid]), id: 'l_second', name: 'Second' };
    const leaf = Object.fromEntries(flattenSeq(doc.sequences[0].rows).map((e) => [identOf(e.leaf), e.leaf]));
    const gm = { name: 'Pick G', cardinality: 'pick-one', guessed: false };
    const E = (/** @type {string} */ id, /** @type {string} */ rank, /** @type {any} */ gmeta = null, /** @type {string|null} */ sname = null) => ({ leaf: leaf[id], rank, gmeta, sname });
    doc.sequences[0].rows = rebuildSeq([
        E('a', 'item'), E('b', 'item'),
        E('g', 'group', { ...gm }), E('o1', 'option', { ...gm }), E('o2', 'option', { ...gm }),
        E('s1', 'section', null, 'S1'), E('c', 'item', null, 'S1'), E('d', 'item', null, 'S1'),
        E('s2', 'section', null, 'S2'), E('e', 'item', null, 'S2'), E('chatHistory', 'item', null, 'S2'),
    ]);
    return stamp(doc);
}

const keyOf = (/** @type {any} */ doc, /** @type {string} */ id) => flat(doc).find((e) => identOf(e.leaf) === id).leaf.key;

/** Every group in seq 0 as {header ident|null, options idents, name, cardinality, guessed}. */
function groups(/** @type {any} */ doc) {
    /** @type {any[]} */
    const out = [];
    const walk = (/** @type {any[]} */ rows) => {
        for (const row of rows) {
            if (row.kind === 'group') {
                out.push({ header: row.header ? identOf(row.header) : null, options: (row.options ?? []).map(identOf), name: row.name, cardinality: row.cardinality, guessed: row.guessed });
            }
            for (const f of ['rows', 'options']) if (Array.isArray(row[f])) walk(row[f]);
        }
    };
    walk(doc.sequences[0].rows);
    return out;
}

/** Section name -> its direct row idents (groups contribute their header, or first option). */
function sectionRows(/** @type {any} */ doc) {
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const row of doc.sequences[0].rows) {
        if (row.kind !== 'section') continue;
        out[row.name] = row.rows.map((/** @type {any} */ r) => (r.kind === 'group' ? identOf(r.header ?? r.options[0]) : identOf(r)));
    }
    return out;
}

/** @returns {any} */
const blockPayload = (/** @type {any} */ over = {}) => ({
    kind: 'block',
    block: { name: 'Copied', content: 'plain text', role: 'user', fields: { injection_depth: 2, marker: true }, notes: 'my note', ...over },
});

const status = (/** @type {number} */ code) => (/** @type {any} */ err) => err?.status === code;

// ---------------------------------------------------------------- single block

test('copy block before an item: lands at that index with a fresh id, fields copied (marker forced false), off in every loadout', () => {
    const doc = target();
    const before = new Set(flatIds(doc));
    const payload = blockPayload();
    const res = copyIntoDoc(doc, payload, keyOf(doc, 'b'));
    assert.equal(res.identifiers.length, 1);
    const NEW = res.identifiers[0];
    assert.ok(!before.has(NEW), 'fresh identifier');
    assert.ok(!Object.keys(target().blocks).includes(NEW));
    assert.deepEqual(flatIds(doc).slice(0, 3), ['a', NEW, 'b']);
    assert.equal(flat(doc)[1].rank, 'item');
    assert.equal(flat(doc)[1].leaf.key, res.keys[0]);
    assert.equal(flat(doc)[1].leaf.kind, 'block');
    const blk = doc.blocks[NEW];
    assert.equal(blk.identifier, NEW);
    assert.equal(blk.name, 'Copied');
    assert.equal(blk.content, 'plain text');
    assert.equal(blk.role, 'user');
    assert.equal(blk.notes, 'my note');
    assert.deepEqual(blk.fields, { injection_depth: 2, marker: false });
    for (const lo of Object.values(doc.loadouts)) assert.equal(/** @type {any} */ (lo).enabled[NEW], false);
    // no shared references with the payload
    payload.block.fields.injection_depth = 9;
    assert.equal(doc.blocks[NEW].fields.injection_depth, 2);
    assert.deepEqual(validateDoc(doc), []);
    assert.equal(res.group, null);
});

test('copy block with before null appends to the end of the first sequence', () => {
    const doc = target();
    const res = copyIntoDoc(doc, blockPayload(), null);
    assert.equal(flatIds(doc).at(-1), res.identifiers[0]);
    assert.equal(flatIds(doc).length, IDS.length + 2);
});

test('copy block before an option joins that group at that position; cardinality unchanged', () => {
    const doc = target();
    const res = copyIntoDoc(doc, blockPayload(), keyOf(doc, 'o2'));
    const g = groups(doc).find((x) => x.header === 'g');
    assert.deepEqual(g.options, ['o1', res.identifiers[0], 'o2']);
    assert.equal(g.cardinality, 'pick-one');
});

test('copy block before a group heading lands as an item right above the group', () => {
    const doc = target();
    const res = copyIntoDoc(doc, blockPayload(), keyOf(doc, 'g'));
    assert.deepEqual(flatIds(doc).slice(0, 4), ['a', 'b', res.identifiers[0], 'g']);
    assert.equal(flat(doc)[2].rank, 'item');
    assert.deepEqual(groups(doc).find((x) => x.header === 'g').options, ['o1', 'o2']);
});

test('copy block before a section heading lands at the end of the previous section', () => {
    const doc = target();
    const res = copyIntoDoc(doc, blockPayload(), keyOf(doc, 's2'));
    assert.deepEqual(sectionRows(doc).S1, ['c', 'd', res.identifiers[0]]);
    assert.deepEqual(sectionRows(doc).S2, ['e', 'chatHistory']);
});

test('copy block: unknown anchor is a 404, a non-string anchor a 400; the document is untouched', () => {
    const doc = target();
    const snap = structuredClone(doc);
    assert.throws(() => copyIntoDoc(doc, blockPayload(), 'row_nope'), status(404));
    assert.deepEqual(doc, snap);
    assert.throws(() => copyIntoDoc(doc, blockPayload(), /** @type {any} */ (7)), status(400));
    assert.deepEqual(doc, snap);
});

test('two copies of the same payload get two distinct fresh identifiers and row keys', () => {
    const doc = target();
    const old = new Set(Object.keys(doc.blocks));
    const r1 = copyIntoDoc(doc, blockPayload(), keyOf(doc, 'b'));
    const r2 = copyIntoDoc(doc, blockPayload(), keyOf(doc, 'b'));
    assert.notEqual(r1.identifiers[0], r2.identifiers[0]);
    assert.notEqual(r1.keys[0], r2.keys[0]);
    assert.ok(!old.has(r1.identifiers[0]) && !old.has(r2.identifiers[0]));
    assert.equal(Object.keys(doc.blocks).length, old.size + 2);
    const ids = flatIds(doc);
    assert.equal(new Set(ids).size, ids.length, 'no identifier appears twice in the sequence');
});

// ---------------------------------------------------------------- whole group

function ffPov() {
    const ff = ffDoc();
    const pov = ff.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'group' && /POV/.test(r.name));
    assert.ok(pov && pov.header && pov.options.length === 4, 'precondition: FF POV group = heading + 4 options');
    return { ff, pov };
}

test('copy a whole FF group: heading + options land above the anchor, name and cardinality kept, all ids fresh', () => {
    const { ff, pov } = ffPov();
    const payload = copyPayloadFromDoc(ff, { group: pov.key });
    assert.equal(payload.kind, 'group');
    const doc = target();
    const res = copyIntoDoc(doc, payload, keyOf(doc, 'b'));
    const srcIds = [pov.header.ref, ...pov.options.map((/** @type {any} */ o) => o.ref)];
    assert.equal(res.identifiers.length, 5);
    assert.equal(new Set(res.identifiers).size, 5);
    for (const id of res.identifiers) {
        assert.ok(!srcIds.includes(id), 'never the source identifier');
        assert.ok(!IDS.includes(id));
    }
    assert.deepEqual(flatIds(doc).slice(0, 7), ['a', ...res.identifiers, 'b']);
    const g = groups(doc).find((x) => x.header === res.identifiers[0]);
    assert.ok(g, 'a new group headed by the copied heading');
    assert.deepEqual(g.options, res.identifiers.slice(1));
    assert.equal(g.name, pov.name);
    assert.equal(g.cardinality, pov.cardinality);
    assert.equal(g.cardinality, 'pick-one');
    assert.equal(g.guessed, false);
    assert.equal(res.group, `grp:${res.keys[0]}`);
    srcIds.forEach((sid, i) => {
        assert.equal(doc.blocks[res.identifiers[i]].name, ff.blocks[sid].name);
        assert.equal(doc.blocks[res.identifiers[i]].content, ff.blocks[sid].content);
    });
    for (const lo of Object.values(doc.loadouts)) {
        for (const id of res.identifiers) assert.equal(/** @type {any} */ (lo).enabled[id], false);
    }
    assert.deepEqual(validateDoc(doc), []);
});

test('copy a whole group onto an option snaps above that group (never splits it)', () => {
    const { ff, pov } = ffPov();
    const doc = target();
    const res = copyIntoDoc(doc, copyPayloadFromDoc(ff, { group: pov.key }), keyOf(doc, 'o2'));
    assert.deepEqual(flatIds(doc).slice(0, 8), ['a', 'b', ...res.identifiers, 'g']);
    assert.deepEqual(groups(doc).find((x) => x.header === 'g').options, ['o1', 'o2']);
});

test('copy a whole group onto a section heading lands at the end of the previous section', () => {
    const { ff, pov } = ffPov();
    const doc = target();
    const res = copyIntoDoc(doc, copyPayloadFromDoc(ff, { group: pov.key }), keyOf(doc, 's2'));
    assert.deepEqual(sectionRows(doc).S1, ['c', 'd', res.identifiers[0]]);
});

test('copy a whole group with before null appends it', () => {
    const { ff, pov } = ffPov();
    const doc = target();
    const res = copyIntoDoc(doc, copyPayloadFromDoc(ff, { group: pov.key }), null);
    assert.deepEqual(flatIds(doc).slice(-5), res.identifiers);
});

test('a headerless group cannot land right below another group (its options would merge): 400, untouched', () => {
    const doc = target();
    const snap = structuredClone(doc);
    const payload = {
        kind: 'group', name: 'H', cardinality: 'pick-one-or-more', header: null,
        options: [blockPayload({ name: 'X' }).block, blockPayload({ name: 'Y' }).block],
    };
    // s1 heading follows o2 (an option of g)
    assert.throws(() => copyIntoDoc(doc, /** @type {any} */ (payload), keyOf(doc, 's1')), status(400));
    assert.deepEqual(doc, snap);
    // elsewhere it lands as a headerless group
    const res = copyIntoDoc(doc, /** @type {any} */ (payload), keyOf(doc, 'b'));
    const g = groups(doc).find((x) => x.header === null);
    assert.deepEqual(g.options, res.identifiers);
    assert.equal(res.group, `grp:${res.keys[0]}`);
});

test('a group cannot land directly above a headerless group\'s options (they would join it): 400, untouched', () => {
    const doc = target();
    // make b..: a, [q1 q2 headerless options], ...
    const f = flat(doc);
    const leaf = Object.fromEntries(f.map((e) => [identOf(e.leaf), e.leaf]));
    const gm = { name: '', cardinality: 'pick-one-or-more', guessed: false };
    doc.sequences[0].rows = rebuildSeq([
        { leaf: leaf.a, rank: 'item', gmeta: null, sname: null },
        { leaf: leaf.b, rank: 'option', gmeta: { ...gm }, sname: null },
        { leaf: leaf.c, rank: 'option', gmeta: { ...gm }, sname: null },
        { leaf: leaf.d, rank: 'item', gmeta: null, sname: null },
    ]);
    const snap = structuredClone(doc);
    const { ff, pov } = ffPov();
    assert.throws(() => copyIntoDoc(doc, copyPayloadFromDoc(ff, { group: pov.key }), leaf.b.key), status(400));
    assert.deepEqual(doc, snap);
    // a single block onto the headerless group's first option joins it
    const res = copyIntoDoc(doc, blockPayload(), leaf.b.key);
    assert.deepEqual(groups(doc).find((x) => x.header === null).options, [res.identifiers[0], 'b', 'c']);
});

// ---------------------------------------------------------------- payloads

test('copyPayloadFromDoc: a marker never transfers (400); unknown identifier/group 404; exactly one of identifier/group', () => {
    const ff = ffDoc();
    assert.ok(ff.markers.some((/** @type {any} */ m) => m.identifier === 'chatHistory'), 'precondition');
    assert.throws(() => copyPayloadFromDoc(ff, { identifier: 'chatHistory' }), (/** @type {any} */ e) => e.status === 400 && /marker/i.test(e.message));
    assert.throws(() => copyPayloadFromDoc(ff, { identifier: 'no-such-block' }), status(404));
    assert.throws(() => copyPayloadFromDoc(ff, { group: 'grp:nope' }), status(404));
    assert.throws(() => copyPayloadFromDoc(ff, {}), status(400));
    const pov = ff.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'group');
    assert.throws(() => copyPayloadFromDoc(ff, { identifier: pov.header.ref, group: pov.key }), status(400));
});

test('copyPayloadFromDoc: a single block copies name/content/role/fields/notes, detached from the source', () => {
    const ff = ffDoc();
    const [id, src] = Object.entries(ff.blocks)[0];
    src.notes = 'n1';
    const p = copyPayloadFromDoc(ff, { identifier: id });
    assert.equal(p.kind, 'block');
    assert.equal(p.block.name, src.name);
    assert.equal(p.block.content, src.content);
    assert.equal(p.block.role, src.role);
    assert.equal(p.block.notes, 'n1');
    assert.deepEqual(p.block.fields, src.fields);
    p.block.fields.injection_depth = 1234;
    assert.notEqual(ff.blocks[id].fields.injection_depth, 1234);
});

test('copyPayloadFromDoc: marker and ghost members of a group are skipped, never transferred', () => {
    const doc = target();
    const f = flat(doc);
    const leaf = Object.fromEntries(f.map((e) => [identOf(e.leaf), e.leaf]));
    // hand-built rows (rebuildSeq refuses marker options): g + [o1, chatHistory, ghost, o2]
    doc.sequences[0].rows = [
        { kind: 'group', key: 'grp:' + leaf.g.key, name: 'Mixed', cardinality: 'pick-one', guessed: false, header: leaf.g,
            options: [leaf.o1, leaf.chatHistory, { kind: 'ghost', identifier: 'gone', key: 'row_ghost' }, leaf.o2] },
    ];
    const p = copyPayloadFromDoc(doc, { group: 'grp:' + leaf.g.key });
    assert.equal(p.kind, 'group');
    assert.equal(p.header.name, 'G');
    assert.deepEqual(p.options.map((/** @type {any} */ b) => b.name), ['O1', 'O2']);
    assert.equal(p.cardinality, 'pick-one');
    assert.equal(p.name, 'Mixed');
});

// ---------------------------------------------------------------- macros (v1 token_warnings)

test('macroWarnings mirrors v1: macros absent from the rest of the target warn; comments and {{char}}/{{user}} never do; sorted, unique', () => {
    const doc = target();
    const res = copyIntoDoc(doc, blockPayload({
        content: 'x {{getvar::known}} {{getvar::y}} {{getvar::y}} {{// a note}} {{user}} {{char}} {Name} {{trim}} {1} tail',
    }), null);
    assert.deepEqual(res.warnings, [
        "'Copied' references {Name} — absent in target preset",
        "'Copied' references {{getvar::y}} — absent in target preset",
        "'Copied' references {{trim}} — absent in target preset",
    ]);
    assert.deepEqual(macroWarnings(doc, res.identifiers), res.warnings);
});

test('macroWarnings: the copied blocks themselves never count as the target defining a macro', () => {
    const doc = target();
    const payload = {
        kind: 'group', name: 'Pair', cardinality: 'pick-one-or-more',
        header: blockPayload({ name: 'Head', content: '{{setvar::z::1}}' }).block,
        options: [blockPayload({ name: 'Opt', content: 'reads {{getvar::z}} and {{setvar::z::1}}' }).block],
    };
    const res = copyIntoDoc(doc, /** @type {any} */ (payload), null);
    assert.deepEqual(res.warnings, [
        "'Head' references {{setvar::z::1}} — absent in target preset",
        "'Opt' references {{getvar::z}} — absent in target preset",
        "'Opt' references {{setvar::z::1}} — absent in target preset",
    ]);
});

test('macroWarnings: a macro the target mentions in a block NAME counts as present (v1 blob = content + name)', () => {
    const doc = target();
    doc.blocks.b.name = 'B {{getvar::fromname}}';
    const res = copyIntoDoc(doc, blockPayload({ content: '{{getvar::fromname}}' }), null);
    assert.deepEqual(res.warnings, []);
});

// ---------------------------------------------------------------- review round 1: outsideGroup

/** a, [p1 p2 headerless options], b, … — the target with a headerless group after a */
function headerlessTarget() {
    const doc = target();
    const leaf = Object.fromEntries(flat(doc).map((e) => [identOf(e.leaf), e.leaf]));
    const gm = { name: 'Loose', cardinality: 'pick-one', guessed: false };
    doc.sequences[0].rows = rebuildSeq([
        { leaf: leaf.a, rank: 'item', gmeta: null, sname: null },
        { leaf: leaf.o1, rank: 'option', gmeta: { ...gm }, sname: null },
        { leaf: leaf.o2, rank: 'option', gmeta: { ...gm }, sname: null },
        { leaf: leaf.b, rank: 'item', gmeta: null, sname: null },
    ]);
    return doc;
}

test('outsideGroup: a block anchored on a headerless group\'s first option lands ABOVE the group, not in it', () => {
    const doc = headerlessTarget();
    const res = copyIntoDoc(doc, blockPayload(), keyOf(doc, 'o1'), { outsideGroup: true });
    assert.deepEqual(flatIds(doc), ['a', res.identifiers[0], 'o1', 'o2', 'b']);
    assert.equal(flat(doc)[1].rank, 'item');
    const g = groups(doc);
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].options, ['o1', 'o2']);
    assert.equal(g[0].cardinality, 'pick-one');
});

test('outsideGroup false (default) on the same anchor still joins the group', () => {
    const doc = headerlessTarget();
    const res = copyIntoDoc(doc, blockPayload(), keyOf(doc, 'o1'));
    assert.deepEqual(groups(doc)[0].options, [res.identifiers[0], 'o1', 'o2']);
    const doc2 = headerlessTarget();
    const res2 = copyIntoDoc(doc2, blockPayload(), keyOf(doc2, 'o1'), { outsideGroup: false });
    assert.deepEqual(groups(doc2)[0].options, [res2.identifiers[0], 'o1', 'o2']);
});

test('outsideGroup must be a boolean: 400, document untouched', () => {
    const doc = headerlessTarget();
    const snap = structuredClone(doc);
    assert.throws(() => copyIntoDoc(doc, blockPayload(), keyOf(doc, 'o1'), /** @type {any} */ ({ outsideGroup: 'yes' })), status(400));
    assert.deepEqual(doc, snap);
});
