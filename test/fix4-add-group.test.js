/**
 * Fix round 4 (owner review 2026-10-15), heading -> group path: the
 * `addGroup {name, cardinality?, before?|after?}` op inserts ONE empty
 * headed group (a fresh, empty heading block, ON in the active loadout,
 * false in every other root, no playstyle entry) in one revision. Landing
 * rules are addSection's except after a section heading, where the group is
 * the section's FIRST ROW; a group never lands at the start of a headerless
 * option run (it would swallow it as its options). An empty pick-one group
 * compiles, normalizes and completes an override without error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure } from '../shared/outline.js';
import { applyDocOp, OpError } from '../shared/docops.js';
import { validateDoc } from '../shared/schema.js';
import { compile, exportSt } from '../shared/compile.js';
import { normalize, completeOverride } from '../shared/groups.js';
import { ensureDefaultLoadout } from '../plugin/store.js';

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flat = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows);
const order = (/** @type {any} */ doc) => flat(doc).map((e) => identOf(e.leaf));
const keyOf = (/** @type {any} */ doc, /** @type {string} */ id) => flat(doc).find((e) => identOf(e.leaf) === id).leaf.key;
const entryOf = (/** @type {any} */ doc, /** @type {string} */ id) => flat(doc).find((e) => identOf(e.leaf) === id);
const orderIds = (/** @type {any} */ compiled) => compiled.prompt_order[0].order.map((/** @type {any} */ o) => o.identifier);
const promptIds = (/** @type {any} */ compiled) => compiled.prompts.map((/** @type {any} */ p) => p.identifier);

/** ids of every leaf under a nested rows array (headers included), in order */
function idsIn(/** @type {any[]} */ rows) {
    return flattenSeq(rows).map((e) => identOf(e.leaf));
}

/** the top-level section row whose header is `id` */
function sectionOf(/** @type {any} */ doc, /** @type {string} */ id) {
    return doc.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'section' && r.header && identOf(r.header) === id) ?? null;
}

/** every group row (headed or not) in the first sequence, in order */
function groupsOf(/** @type {any} */ doc) {
    /** @type {any[]} */
    const out = [];
    /** @param {any[]} rows */
    const walk = (rows) => {
        for (const r of rows) {
            if (r.kind === 'group') out.push(r);
            if (r.kind === 'section') walk(r.rows);
        }
    };
    walk(doc.sequences[0].rows);
    return out;
}

/** the group row headed by `id` */
function groupOf(/** @type {any} */ doc, /** @type {string} */ id) {
    return groupsOf(doc).find((g) => g.header && identOf(g.header) === id) ?? null;
}

/**
 * chatHistory(marker item), a(item), s1(section: b, g{o1,o2}, c), s2(section: d).
 * Flat: chatHistory a s1 b g o1 o2 c s2 d. Loadouts: the active root, root
 * 'L2' and playstyle 'P' (child of the active root, empty).
 * `headerless`: g is a plain item, so o1/o2 are a HEADERLESS group after it.
 */
function mkDoc({ headerless = false } = {}) {
    const ids = ['a', 's1', 'b', 'g', 'o1', 'o2', 'c', 's2', 'd'];
    const st = {
        prompts: [
            { identifier: 'chatHistory', marker: true },
            ...ids.map((id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system', enabled: true })),
        ],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }, ...ids.map((id) => ({ identifier: id, enabled: true }))] }],
    };
    const doc = importStPreset(st, 'T');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    const entries = flat(doc);
    const at = (/** @type {string} */ id) => entries.find((e) => identOf(e.leaf) === id);
    const gm = { name: 'G', cardinality: 'pick-one-or-more', guessed: false };
    Object.assign(at('s1'), { rank: 'section', sname: 'S1' });
    if (headerless) Object.assign(at('g'), { rank: 'item', gmeta: null });
    else Object.assign(at('g'), { rank: 'group', gmeta: { ...gm } });
    Object.assign(at('o1'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('o2'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('s2'), { rank: 'section', sname: 'S2' });
    doc.sequences[0].rows = rebuildSeq(entries);
    const active = doc.loadouts[doc.activeLoadoutId];
    doc.loadouts.L2 = { id: 'L2', name: 'Other', notes: '', kind: 'root', parent: null, enabled: { ...active.enabled }, overrides: {} };
    doc.loadouts.P = { id: 'P', name: 'Play', notes: '', kind: 'playstyle', parent: doc.activeLoadoutId, enabled: {}, overrides: {} };
    Object.assign(doc, { id: 'p_test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1 });
    assert.deepEqual(validateDoc(doc), [], 'fixture doc is valid');
    assert.deepEqual(order(doc), ['chatHistory', 'a', 's1', 'b', 'g', 'o1', 'o2', 'c', 's2', 'd'], 'fixture order');
    return doc;
}

/** every result is a valid doc whose nested rows are a rebuild fixed point */
function wellFormed(/** @type {any} */ doc) {
    assert.deepEqual(validateDoc(doc), []);
    const rows = doc.sequences[0].rows;
    assert.deepEqual(rebuildSeq(flattenSeq(rows)), rows, 'rebuildSeq(flattenSeq(rows)) is a fixed point');
}

/**
 * addGroup on a fresh doc; checks the common shape of the result and
 * returns { doc, res, grp } (grp = the new, empty, headed group row).
 * @param {Record<string, any>} args op args; `after`/`before` given as row IDs (resolved to keys here)
 * @param {{ headerless?: boolean }} [fixture]
 */
function groupAt(args, fixture = {}) {
    const doc = mkDoc(fixture);
    /** @type {Record<string, any>} */
    const a = { name: 'NG', ...args };
    if (typeof a.after === 'string') a.after = keyOf(doc, a.after);
    if (typeof a.before === 'string') a.before = keyOf(doc, a.before);
    const res = applyDocOp(doc, 'addGroup', a);
    wellFormed(doc);
    assert.equal(typeof res.identifier, 'string');
    const e = entryOf(doc, res.identifier);
    assert.equal(e.leaf.key, res.key, 'result key is the new heading row key');
    assert.equal(e.rank, 'group');
    const grp = groupOf(doc, res.identifier);
    assert.ok(grp, 'a group headed by the new block');
    assert.deepEqual(grp.options, [], 'the new group is empty');
    return { doc, res, grp };
}

// ------------------------------------------------------------------ shape

test('addGroup {name, cardinality: pick-one, after: a}: one empty headed group directly below a', () => {
    const { doc, res, grp } = groupAt({ name: 'Fix4 Pick', cardinality: 'pick-one', after: 'a' });
    assert.deepEqual(order(doc), ['chatHistory', 'a', res.identifier, 's1', 'b', 'g', 'o1', 'o2', 'c', 's2', 'd']);
    assert.equal(grp.kind, 'group');
    assert.equal(grp.header.kind, 'block');
    assert.equal(grp.header.ref, res.identifier);
    assert.equal(grp.header.key, res.key);
    assert.equal(grp.key, `grp:${res.key}`);
    assert.equal(grp.cardinality, 'pick-one');
    assert.equal(grp.guessed, false);
    assert.equal(grp.name, 'Fix4 Pick', 'the group name is stored as typed (no == == wrapping)');
    // top level: directly in the sequence rows, not inside s1
    assert.ok(doc.sequences[0].rows.includes(grp));
    const blk = doc.blocks[res.identifier];
    assert.equal(blk.identifier, res.identifier);
    assert.equal(blk.name, 'Fix4 Pick');
    assert.equal(blk.content, '');
    assert.equal(blk.role, 'system');
    // fresh identifier, not an existing block's
    assert.ok(!['chatHistory', 'a', 's1', 'b', 'g', 'o1', 'o2', 'c', 's2', 'd'].includes(res.identifier));
});

test('addGroup enabled bits: ON in the active loadout, false in other roots, no entry in playstyles', () => {
    const { doc, res } = groupAt({ cardinality: 'pick-one', after: 'a' });
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled[res.identifier], true);
    assert.equal(doc.loadouts.L2.enabled[res.identifier], false);
    assert.ok(!(res.identifier in doc.loadouts.P.enabled), 'playstyle inherits');
});

test('addGroup trims the name; cardinality defaults to pick-one-or-more', () => {
    const { doc, res, grp } = groupAt({ name: '  Spaced  ', after: 'a' });
    assert.equal(grp.name, 'Spaced');
    assert.equal(doc.blocks[res.identifier].name, 'Spaced');
    assert.equal(grp.cardinality, 'pick-one-or-more');
});

test('addGroup with cardinality pick-one-or-more', () => {
    const { grp } = groupAt({ cardinality: 'pick-one-or-more', after: 'a' });
    assert.equal(grp.cardinality, 'pick-one-or-more');
});

// ------------------------------------------------------------------ landing (after)

test('addGroup after an item inside a section: directly below it, same section, the next group untouched', () => {
    const { doc, res } = groupAt({ after: 'b' });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', res.identifier, 'g', 'o1', 'o2', 'c']);
    assert.deepEqual(groupOf(doc, 'g').options.map(identOf), ['o1', 'o2']);
});

test('addGroup after a group option lands after the whole group (never splits it)', () => {
    const { doc, res } = groupAt({ after: 'o1' });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', res.identifier, 'c']);
    assert.deepEqual(groupOf(doc, 'g').options.map(identOf), ['o1', 'o2']);
});

test('addGroup after a group heading lands after the whole group', () => {
    const { doc, res } = groupAt({ after: 'g' });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', res.identifier, 'c']);
    assert.deepEqual(groupOf(doc, 'g').options.map(identOf), ['o1', 'o2']);
});

test('addGroup after a section heading is the section\'s FIRST ROW (not after the section)', () => {
    const { doc, res } = groupAt({ after: 's1' });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), [res.identifier, 'b', 'g', 'o1', 'o2', 'c']);
    assert.equal(sectionOf(doc, 's1').rows[0].kind, 'group');
});

test('addGroup after the last row lands at the end (inside the last section)', () => {
    const { doc, res } = groupAt({ after: 'd' });
    assert.equal(order(doc).at(-1), res.identifier);
    assert.deepEqual(idsIn(sectionOf(doc, 's2').rows), ['d', res.identifier]);
});

test('addGroup after a marker: directly below it', () => {
    const { doc, res } = groupAt({ after: 'chatHistory' });
    assert.deepEqual(order(doc).slice(0, 3), ['chatHistory', res.identifier, 'a']);
});

test('addGroup with no anchor (after: null, or none) appends to the end', () => {
    for (const extra of [{ after: null }, {}]) {
        const { doc, res } = groupAt(extra);
        assert.equal(order(doc).at(-1), res.identifier);
    }
});

test('addGroup after a row followed by a HEADERLESS group skips past that run (does not swallow it)', () => {
    const { doc, res } = groupAt({ after: 'g' }, { headerless: true });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', res.identifier, 'c']);
    const hl = groupsOf(doc).find((x) => x.header === null);
    assert.ok(hl, 'the headerless group still exists');
    assert.deepEqual(hl.options.map(identOf), ['o1', 'o2']);
});

test('addGroup after an option of a headerless group lands after the whole run', () => {
    const { doc, res } = groupAt({ after: 'o1' }, { headerless: true });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', 'g', 'o1', 'o2', res.identifier, 'c']);
    assert.deepEqual(groupsOf(doc).find((x) => x.header === null).options.map(identOf), ['o1', 'o2']);
});

// ------------------------------------------------------------------ landing (before)

test('addGroup before an item lands directly above it', () => {
    const { doc, res } = groupAt({ before: 'b' });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), [res.identifier, 'b', 'g', 'o1', 'o2', 'c']);
});

test('addGroup before a group option snaps above the whole group', () => {
    const { doc, res } = groupAt({ before: 'o2' });
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b', res.identifier, 'g', 'o1', 'o2', 'c']);
    assert.deepEqual(groupOf(doc, 'g').options.map(identOf), ['o1', 'o2']);
});

test('addGroup before an option of a HEADERLESS group is refused (400): it would take its options; doc untouched', () => {
    for (const anchor of ['o1', 'o2']) {
        const doc = mkDoc({ headerless: true });
        const snap = structuredClone(doc);
        assert.throws(() => applyDocOp(doc, 'addGroup', { name: 'NG', before: keyOf(doc, anchor) }),
            (/** @type {any} */ e) => e instanceof OpError && e.status === 400 && /headerless group/.test(e.message));
        assert.deepEqual(doc, snap);
    }
});

// ------------------------------------------------------------------ refusals

test('addGroup refusals leave the doc untouched', () => {
    /** @type {[string, (doc: any) => Record<string, any>, number, RegExp][]} */
    const cases = [
        ['no name', () => ({}), 400, /addGroup needs \{name\}/],
        ['blank name', () => ({ name: '   ' }), 400, /addGroup needs \{name\}/],
        ['bad cardinality', () => ({ name: 'X', cardinality: 'pick-two' }), 400, /bad cardinality "pick-two"/],
        ['before + after', (d) => ({ name: 'X', before: keyOf(d, 'b'), after: keyOf(d, 'c') }), 400, /use before or after, not both/],
        ['unknown after', () => ({ name: 'X', after: 'no-such-key' }), 404, /no row with key "no-such-key"/],
        ['unknown before', () => ({ name: 'X', before: 'no-such-key' }), 404, /no row with key "no-such-key"/],
        ['non-string after', () => ({ name: 'X', after: 7 }), 400, /./],
    ];
    for (const [label, args, status, re] of cases) {
        const doc = mkDoc();
        const snap = structuredClone(doc);
        assert.throws(() => applyDocOp(doc, 'addGroup', args(doc)),
            (/** @type {any} */ e) => e instanceof OpError && e.status === status && re.test(e.message), label);
        assert.deepEqual(doc, snap, `${label}: doc untouched`);
    }
});

// ------------------------------------------------------------------ an empty pick-one group downstream

test('an EMPTY pick-one group compiles (every loadout), exports, normalizes and completes an override without error', () => {
    const { doc, res } = groupAt({ name: 'Empty', cardinality: 'pick-one', after: 'a' });
    const id = res.identifier;
    for (const lid of [doc.activeLoadoutId, 'L2', 'P']) {
        assert.doesNotThrow(() => compile(doc, null, {}, lid), lid);
    }
    const { compiled, enabled } = compile(doc, null, {});
    // an empty heading is never sent (like an empty section heading)
    assert.ok(!orderIds(compiled).includes(id), 'empty heading absent from prompt_order');
    assert.ok(!promptIds(compiled).includes(id), 'empty heading absent from prompts');
    assert.equal(enabled[id], true, 'the heading stays ON in the effective map');
    // the rest of the compile order is the leaf order without the heading
    assert.deepEqual(orderIds(compiled), order(doc).filter((x) => x !== id));
    // the ST export keeps it
    assert.ok(orderIds(exportSt(doc)).includes(id));
    // normalize flips nothing
    const en = { ...doc.loadouts[doc.activeLoadoutId].enabled };
    /** @type {string[]} */
    const changed = [];
    assert.doesNotThrow(() => normalize(doc, en, changed));
    assert.deepEqual(changed, []);
    assert.equal(en[id], true);
    // completeOverride: the heading is not a choice, nothing is added
    assert.deepEqual(completeOverride(doc, { [id]: true }), { [id]: true });
    assert.deepEqual(completeOverride(doc, {}), {});
});

test('setCardinality on the empty group flips both ways with no 409', () => {
    const { doc, grp } = groupAt({ cardinality: 'pick-one', after: 'a' });
    assert.deepEqual(applyDocOp(doc, 'setCardinality', { key: grp.key, cardinality: 'pick-one-or-more' }), { key: grp.key, cardinality: 'pick-one-or-more' });
    assert.deepEqual(applyDocOp(doc, 'setCardinality', { key: grp.key, cardinality: 'pick-one' }), { key: grp.key, cardinality: 'pick-one' });
    wellFormed(doc);
});

test('addBlock after the new heading is its options[0]; after that option, options[1]; pick-one stays valid', () => {
    const { doc, res } = groupAt({ cardinality: 'pick-one', after: 'a' });
    const b1 = applyDocOp(doc, 'addBlock', { name: 'One', after: res.key });
    wellFormed(doc);
    assert.equal(entryOf(doc, b1.identifier).rank, 'option');
    assert.deepEqual(groupOf(doc, res.identifier).options.map(identOf), [b1.identifier]);
    const b2 = applyDocOp(doc, 'addBlock', { name: 'Two', after: b1.key });
    wellFormed(doc);
    const grp = groupOf(doc, res.identifier);
    assert.deepEqual(grp.options.map(identOf), [b1.identifier, b2.identifier]);
    assert.equal(grp.cardinality, 'pick-one');
    // new options start off: no pick-one conflict
    assert.doesNotThrow(() => applyDocOp(doc, 'setCardinality', { key: grp.key, cardinality: 'pick-one' }));
    assert.doesNotThrow(() => compile(doc, null, {}));
});

// ------------------------------------------------------------------ addSection unchanged by the generalisation

test('addSection still lands as before (after b; before o2 snaps above the group; after s1 = empty sibling)', () => {
    let doc = mkDoc();
    let r = applyDocOp(doc, 'addSection', { name: '== N ==', after: keyOf(doc, 'b') });
    wellFormed(doc);
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b']);
    assert.deepEqual(idsIn(sectionOf(doc, r.identifier).rows), ['g', 'o1', 'o2', 'c']);
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled[r.identifier], true);
    assert.equal(doc.loadouts.L2.enabled[r.identifier], false);
    assert.ok(!(r.identifier in doc.loadouts.P.enabled));
    doc = mkDoc();
    r = applyDocOp(doc, 'addSection', { name: '== N ==', before: keyOf(doc, 'o2') });
    wellFormed(doc);
    assert.deepEqual(idsIn(sectionOf(doc, 's1').rows), ['b']);
    assert.deepEqual(idsIn(sectionOf(doc, r.identifier).rows), ['g', 'o1', 'o2', 'c']);
    doc = mkDoc();
    r = applyDocOp(doc, 'addSection', { name: '== N ==', after: keyOf(doc, 's1') });
    wellFormed(doc);
    assert.deepEqual(sectionOf(doc, r.identifier).rows, []);
    assert.equal(doc.blocks[r.identifier].name, '== N ==');
});
