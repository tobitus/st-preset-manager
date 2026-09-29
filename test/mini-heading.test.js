/**
 * Mini round (2026-09-29), server side:
 *   item 1 — a section's / headed group's name IS its heading block's name:
 *     `containerName` (display rule) and the stored-name sync done by
 *     editBlock / renameBlock / renameGroup / addSection / createGroup and
 *     the group copy payload;
 *   item 2 — `makeSection {key}` / `unmakeSection {key}`: a plain item
 *     becomes a section heading directly (and back), byte-exact inverse,
 *     content / name / enabled bit untouched, refusals for every other rank.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure, containerName } from '../shared/outline.js';
import { applyDocOp, copyPayloadFromDoc, OpError } from '../shared/docops.js';
import { compile } from '../shared/compile.js';
import { ensureDefaultLoadout } from '../plugin/store.js';
import { panelDelta, routePanelDiff } from '../plugin/slot.js';

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const promptIds = (/** @type {any} */ compiled) => compiled.prompts.map((/** @type {any} */ p) => p.identifier);
const orderIds = (/** @type {any} */ compiled) => compiled.prompt_order[0].order.map((/** @type {any} */ o) => o.identifier);

/**
 * chatHistory(marker), a, a2,
 * s(section, STALE stored name '== New section ==', content ''){
 *   b, g(group heading, STALE stored name 'New block', content ''){ o1, o2 },
 *   c, (headerless group 'QG'){ q1, q2 } },
 * t(section 'N t', content 'T text'){ d, e(content ''), zz(ghost) }.
 * Every block is named `N <id>`. Bits: all on except c and d.
 */
function mkDoc() {
    const content = /** @type {Record<string, string>} */ ({
        a: 'A text', a2: 'A2 text', s: '', b: 'B text', g: '', o1: 'O1', o2: 'O2', c: 'C text',
        q1: 'Q1', q2: 'Q2', t: 'T text', d: 'D text', e: '',
    });
    const ids = Object.keys(content);
    const st = {
        prompts: [
            { identifier: 'chatHistory', marker: true },
            ...ids.map((id) => ({ identifier: id, name: `N ${id}`, content: content[id], role: 'system', enabled: true })),
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true },
            ...ids.map((id) => ({ identifier: id, enabled: !['c', 'd'].includes(id) })),
            { identifier: 'zz', enabled: true },
        ] }],
    };
    const doc = importStPreset(st, 'T');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    const entries = flattenSeq(doc.sequences[0].rows);
    const at = (/** @type {string} */ id) => {
        const e = entries.find((x) => identOf(x.leaf) === id);
        assert.ok(e, `fixture: ${id} imported`);
        return e;
    };
    const gm = { name: 'New block', cardinality: 'pick-one', guessed: false };
    const qm = { name: 'QG', cardinality: 'pick-one-or-more', guessed: false };
    Object.assign(at('s'), { rank: 'section', sname: '== New section ==' });
    Object.assign(at('g'), { rank: 'group', gmeta: { ...gm } });
    Object.assign(at('o1'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('o2'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('q1'), { rank: 'option', gmeta: { ...qm } });
    Object.assign(at('q2'), { rank: 'option', gmeta: { ...qm } });
    Object.assign(at('t'), { rank: 'section', sname: 'N t' });
    doc.sequences[0].rows = rebuildSeq(entries);
    assert.equal(at('zz').leaf.kind, 'ghost', 'fixture: zz is an order-only ghost');
    return doc;
}

/** @param {any} doc @param {string} id */
function keyOf(doc, id) {
    for (const seq of doc.sequences) {
        for (const e of flattenSeq(seq.rows)) if (identOf(e.leaf) === id) return e.leaf.key;
    }
    throw new Error(`no leaf ${id}`);
}

/** Every container row (section/group) in every sequence, depth-first. @param {any} doc */
function containers(doc) {
    /** @type {any[]} */
    const out = [];
    const walk = (/** @type {any[]} */ rows) => {
        for (const r of rows) {
            if (r.kind === 'section') { out.push(r); walk(r.rows ?? []); }
            else if (r.kind === 'group') out.push(r);
        }
    };
    for (const seq of doc.sequences) walk(seq.rows);
    return out;
}

/** The section/group headed by block `id` (first sequence hit). @param {any} doc @param {string} id @param {'section'|'group'} kind */
function headedBy(doc, id, kind) {
    return containers(doc).find((r) => r.kind === kind && r.header && identOf(r.header) === id) ?? null;
}

const headerless = (/** @type {any} */ doc) => containers(doc).find((r) => r.kind === 'group' && !r.header);

/** @param {() => any} fn @param {RegExp} re @param {number} [status] */
function refuses(fn, re, status = 400) {
    assert.throws(fn, (/** @type {any} */ err) => {
        assert.ok(err instanceof OpError, `OpError, got ${err?.constructor?.name}: ${err?.message}`);
        assert.equal(err.status, status, `status for "${err.message}"`);
        assert.match(err.message, re);
        return true;
    });
}

// ------------------------------------------------------------ display rule

test('containerName: a headed section or group shows its heading block name, never its stale stored name', () => {
    const doc = mkDoc();
    const s = headedBy(doc, 's', 'section');
    const g = headedBy(doc, 'g', 'group');
    assert.equal(s.name, '== New section ==', 'precondition: stale stored section name');
    assert.equal(g.name, 'New block', 'precondition: stale stored group name');
    assert.equal(containerName(doc, s), 'N s');
    assert.equal(containerName(doc, g), 'N g');
    assert.equal(containerName(doc, headerless(doc)), 'QG', 'a headerless group keeps its stored name');
    headerless(doc).name = '';
    assert.equal(containerName(doc, headerless(doc)), '', 'an unnamed headerless group is blank (callers show "(options)")');
});

// ------------------------------------------------------------ stored-name sync

test('editBlock {name} on a section heading renames the stored section name in the same op', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'editBlock', { identifier: 's', name: '  ━⏱️ Pacing & Rhythm  ', content: 'x' });
    assert.equal(doc.blocks.s.name, '━⏱️ Pacing & Rhythm');
    assert.equal(headedBy(doc, 's', 'section').name, '━⏱️ Pacing & Rhythm');
});

test('editBlock {name} on a group heading renames the stored group name; cardinality kept', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'editBlock', { identifier: 'g', name: 'Anti-Slop' });
    const g = headedBy(doc, 'g', 'group');
    assert.equal(g.name, 'Anti-Slop');
    assert.equal(g.cardinality, 'pick-one');
    assert.equal(doc.blocks.g.name, 'Anti-Slop');
});

test('renameBlock syncs the section and the group it heads', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'renameBlock', { identifier: 's', name: 'Sec 2' });
    applyDocOp(doc, 'renameBlock', { identifier: 'g', name: 'Grp 2' });
    assert.equal(headedBy(doc, 's', 'section').name, 'Sec 2');
    assert.equal(headedBy(doc, 'g', 'group').name, 'Grp 2');
});

test('a rename made in ST\'s prompt panel (write-back) syncs the section the block heads', () => {
    const doc = mkDoc();
    const { compiled } = compile(doc, null, {});
    const snap = structuredClone(compiled);
    snap.prompts.find((/** @type {any} */ p) => p.identifier === 't').name = 'Panel T';
    routePanelDiff(doc, compiled, panelDelta(compiled, snap), null);
    assert.equal(doc.blocks.t.name, 'Panel T');
    assert.equal(headedBy(doc, 't', 'section').name, 'Panel T');
});

test('renaming a block that heads nothing changes no container name', () => {
    const doc = mkDoc();
    const before = JSON.stringify(doc.sequences);
    applyDocOp(doc, 'renameBlock', { identifier: 'b', name: 'Bee' });
    applyDocOp(doc, 'editBlock', { identifier: 'o1', name: 'Oh one' });
    assert.equal(JSON.stringify(doc.sequences), before);
});

test('a heading block present in two sequences is synced in both', () => {
    const doc = mkDoc();
    doc.sequences.push({ ...structuredClone(doc.sequences[0]), character_id: 100000 });
    applyDocOp(doc, 'renameBlock', { identifier: 's', name: 'Both' });
    const secs = containers(doc).filter((r) => r.kind === 'section' && identOf(r.header) === 's');
    assert.equal(secs.length, 2);
    assert.deepEqual(secs.map((r) => r.name), ['Both', 'Both']);
});

test('renameGroup on a headed group renames its heading block too (the group name drives the block)', () => {
    const doc = mkDoc();
    const g = headedBy(doc, 'g', 'group');
    applyDocOp(doc, 'renameGroup', { key: g.key, name: ' Anti-Slop ' });
    assert.equal(doc.blocks.g.name, 'Anti-Slop');
    assert.equal(headedBy(doc, 'g', 'group').name, 'Anti-Slop');
    assert.equal(doc.blocks.g.content, '', 'content untouched');
});

test('renameGroup on a headerless group changes only its stored name', () => {
    const doc = mkDoc();
    const blocks = JSON.stringify(doc.blocks);
    applyDocOp(doc, 'renameGroup', { key: headerless(doc).key, name: 'Q options' });
    assert.equal(headerless(doc).name, 'Q options');
    assert.equal(JSON.stringify(doc.blocks), blocks);
});

test('renameGroup with a blank name renames nothing', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'renameGroup', { key: headedBy(doc, 'g', 'group').key, name: '   ' });
    assert.equal(doc.blocks.g.name, 'N g');
    assert.equal(headedBy(doc, 'g', 'group').name, 'New block');
});

test('addSection: the new section stores exactly its heading block name', () => {
    const doc = mkDoc();
    const known = new Set(Object.keys(doc.blocks));
    applyDocOp(doc, 'addSection', { name: '  == Fresh ==  ', before: keyOf(doc, 'd') });
    const id = Object.keys(doc.blocks).find((k) => !known.has(k));
    assert.ok(id);
    assert.equal(doc.blocks[id].name, '== Fresh ==');
    assert.equal(headedBy(doc, id, 'section').name, '== Fresh ==');
});

test('createGroup with a headerKey stores the heading block name; without one it keeps the given name', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'createGroup', { headerKey: keyOf(doc, 'd'), keys: [keyOf(doc, 'e')], name: 'Ignored' });
    assert.equal(headedBy(doc, 'd', 'group').name, 'N d');
    const doc2 = mkDoc();
    applyDocOp(doc2, 'createGroup', { keys: [keyOf(doc2, 'd'), keyOf(doc2, 'e')], name: 'Named' });
    const grp = containers(doc2).find((r) => r.kind === 'group' && !r.header && r.options.some((/** @type {any} */ o) => identOf(o) === 'd'));
    assert.equal(grp.name, 'Named');
});

test('the copy payload of a headed group carries the heading block name', () => {
    const doc = mkDoc();
    const payload = /** @type {any} */ (copyPayloadFromDoc(doc, { group: headedBy(doc, 'g', 'group').key }));
    assert.equal(payload.kind, 'group');
    assert.equal(payload.name, 'N g');
});

// ------------------------------------------------------------ makeSection / unmakeSection

test('makeSection on a top-level item: a section headed by it, named after the block, with the rows below as children', () => {
    const doc = mkDoc();
    const block = structuredClone(doc.blocks.a);
    const loadouts = JSON.stringify(doc.loadouts);
    const order = orderIds(compile(doc, null, {}).compiled);
    applyDocOp(doc, 'makeSection', { key: keyOf(doc, 'a') });
    const sec = headedBy(doc, 'a', 'section');
    assert.ok(sec, 'a heads a section');
    assert.equal(sec.name, 'N a');
    assert.deepEqual(sec.rows.map((/** @type {any} */ r) => identOf(r)), ['a2'], 'rows below it up to the next section heading');
    assert.equal(doc.sequences[0].rows[0].kind, 'marker', 'rows above stay outside');
    assert.deepEqual(doc.blocks.a, block, 'block untouched');
    assert.equal(JSON.stringify(doc.loadouts), loadouts, 'enabled bits untouched');
    const compiled = compile(doc, null, {}).compiled;
    assert.deepEqual(orderIds(compiled), order, 'a non-blank heading keeps sending, same compile order');
    assert.equal(compiled.prompts.find((/** @type {any} */ p) => p.identifier === 'a')?.content, 'A text');
});

test('makeSection on an item inside a section splits it: the rows below it join the new section', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'makeSection', { key: keyOf(doc, 'c') });
    const s = headedBy(doc, 's', 'section');
    const c = headedBy(doc, 'c', 'section');
    assert.deepEqual(s.rows.map((/** @type {any} */ r) => r.kind === 'group' ? `grp(${identOf(r.header)})` : identOf(r)), ['b', 'grp(g)']);
    assert.equal(c.rows.length, 1);
    assert.equal(c.rows[0].kind, 'group');
    assert.equal(c.rows[0].header, null);
    assert.equal(c.rows[0].name, 'QG', 'the headerless group moves intact');
    assert.equal(doc.sequences[0].rows.filter((/** @type {any} */ r) => r.kind === 'section').length, 3);
});

test('unmakeSection reverses makeSection byte-for-byte for every plain item', () => {
    for (const id of ['a', 'a2', 'b', 'c', 'd', 'e']) {
        const doc = mkDoc();
        const before = JSON.stringify(doc);
        applyDocOp(doc, 'makeSection', { key: keyOf(doc, id) });
        assert.notEqual(JSON.stringify(doc), before, `${id}: makeSection changed the doc`);
        assert.ok(headedBy(doc, id, 'section'), `${id}: heads a section`);
        applyDocOp(doc, 'unmakeSection', { key: keyOf(doc, id) });
        assert.equal(JSON.stringify(doc), before, `${id}: round trip byte-exact`);
    }
});

test('makeSection on an EMPTY item: the new heading is suppressed from the slot, its bit kept', () => {
    const doc = mkDoc();
    assert.ok(promptIds(compile(doc, null, {}).compiled).includes('e'), 'precondition: empty item e compiles');
    const bit = doc.loadouts[doc.activeLoadoutId].enabled.e;
    applyDocOp(doc, 'makeSection', { key: keyOf(doc, 'e') });
    const { compiled } = compile(doc, null, {});
    assert.ok(!promptIds(compiled).includes('e'));
    assert.ok(!orderIds(compiled).includes('e'));
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled.e, bit);
});

test('makeSection refuses options, group headings, section headings, markers and ghosts, leaving the doc untouched', () => {
    const doc = mkDoc();
    const before = JSON.stringify(doc);
    refuses(() => applyDocOp(doc, 'makeSection', { key: keyOf(doc, 'o1') }), /make it a plain row first/);
    refuses(() => applyDocOp(doc, 'makeSection', { key: keyOf(doc, 'q1') }), /make it a plain row first/);
    refuses(() => applyDocOp(doc, 'makeSection', { key: keyOf(doc, 'g') }), /make it a plain row first/);
    refuses(() => applyDocOp(doc, 'makeSection', { key: keyOf(doc, 's') }), /already a section heading/);
    refuses(() => applyDocOp(doc, 'makeSection', { key: keyOf(doc, 'chatHistory') }), /marker/i);
    refuses(() => applyDocOp(doc, 'makeSection', { key: keyOf(doc, 'zz') }), /order-only/i);
    refuses(() => applyDocOp(doc, 'makeSection', { key: 'nope' }), /no row/, 404);
    refuses(() => applyDocOp(doc, 'makeSection', {}), /makeSection needs \{key\}/);
    assert.equal(JSON.stringify(doc), before);
});

test('unmakeSection refuses anything that is not a section heading, leaving the doc untouched', () => {
    const doc = mkDoc();
    const before = JSON.stringify(doc);
    for (const id of ['a', 'o1', 'g', 'chatHistory']) {
        refuses(() => applyDocOp(doc, 'unmakeSection', { key: keyOf(doc, id) }), /not a section heading/);
    }
    refuses(() => applyDocOp(doc, 'unmakeSection', { key: keyOf(doc, 'zz') }), /order-only|not a section heading/i);
    refuses(() => applyDocOp(doc, 'unmakeSection', { key: 'nope' }), /no row/, 404);
    refuses(() => applyDocOp(doc, 'unmakeSection', {}), /unmakeSection needs \{key\}/);
    assert.equal(JSON.stringify(doc), before);
});

test('unmakeSection on an existing section heading: its rows rejoin the section above (or the top level)', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'unmakeSection', { key: keyOf(doc, 't') });
    assert.equal(headedBy(doc, 't', 'section'), null);
    const s = headedBy(doc, 's', 'section');
    const ids = s.rows.map((/** @type {any} */ r) => r.kind === 'group' ? `grp(${r.header ? identOf(r.header) : '-'})` : identOf(r));
    assert.deepEqual(ids, ['b', 'grp(g)', 'c', 'grp(-)', 't', 'd', 'e', 'zz']);
    assert.equal(doc.blocks.t.content, 'T text');
});
