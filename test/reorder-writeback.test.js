/**
 * ST-panel reorder write-back keeps the outline's structure (owner decision
 * 2026-09-29, option (a)): a reorder done in ST's own prompt-manager panel is
 * applied to the library as the MINIMAL set of moved leaves (outside the
 * heaviest in-order chain), each landing on its new following neighbour with
 * v2's drop rules. Every leaf that did not move keeps its rank, group and
 * section; groups and sections keep their name and cardinality; suppressed
 * empty headings stay above the row that followed them; a group or section
 * heading moved alone takes its whole block with it.
 *
 * Every case asserts the invariants: identifier multiset unchanged, stored
 * enabled bits unchanged (pick-one normalisation happens in the compile, as
 * for a v2 drag), every group/section still present with the same name and
 * cardinality, and the compiled order equals ST's order — or, where the
 * rule moves a whole block, the compiled order is a fixed point (re-sending
 * it is a no-op, so ST converges with no loop).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure } from '../shared/outline.js';
import { compile } from '../shared/compile.js';
import { ensureDefaultLoadout } from '../plugin/store.js';
import { panelDelta, routePanelDiff, applyOrderToSequences } from '../plugin/slot.js';
import { MAX_PANEL_MOVES } from '../shared/reorder.js';

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const flatIds = (/** @type {any} */ doc) => flattenSeq(doc.sequences[0].rows).map((e) => identOf(e.leaf));
const orderIds = (/** @type {any} */ doc) => compile(doc, null, {}).compiled.prompt_order[0].order.map((/** @type {any} */ o) => o.identifier);

/**
 * intro, chatHistory(marker),
 * s1 (section "One", content)   { a, b, c, g1 (group G1 pick-one, EMPTY heading) [o1*, o2, o3], d }
 * s2 (section "Two", EMPTY)     { e, f, g2 (group G2 pick-one-or-more, content) [p1*, p2], h }
 * s3 (section "Three", content) { i, j }
 * Every bit on except o2, o3, p2. Suppressed in the slot: g1, s2.
 */
function mkDoc() {
    const content = /** @type {Record<string, string>} */ ({
        intro: 'I', s1: 'S1 text', a: 'A', b: 'B', c: 'C', g1: '', o1: 'O1', o2: 'O2', o3: 'O3', d: 'D',
        s2: '', e: 'E', f: 'F', g2: 'G2 text', p1: 'P1', p2: 'P2', h: 'H', s3: 'S3 text', i: 'I2', j: 'J',
    });
    const off = new Set(['o2', 'o3', 'p2']);
    const ids = Object.keys(content);
    const order = ['intro', 'chatHistory', ...ids.slice(1)];
    const st = {
        prompts: [
            { identifier: 'chatHistory', marker: true },
            ...ids.map((id) => ({ identifier: id, name: `N ${id}`, content: content[id], role: 'system', enabled: !off.has(id) })),
        ],
        prompt_order: [{ character_id: 100001, order: order.map((id) => ({ identifier: id, enabled: !off.has(id) })) }],
    };
    const doc = importStPreset(st, 'T');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    const entries = flattenSeq(doc.sequences[0].rows);
    const at = (/** @type {string} */ id) => {
        const e = entries.find((x) => identOf(x.leaf) === id);
        if (!e) throw new Error(`fixture: no ${id}`);
        return e;
    };
    const G1 = { name: 'G1', cardinality: 'pick-one', guessed: false };
    const G2 = { name: 'G2', cardinality: 'pick-one-or-more', guessed: false };
    for (const e of entries) Object.assign(e, { rank: 'item', gmeta: null, sname: null });
    Object.assign(at('s1'), { rank: 'section', sname: 'One' });
    Object.assign(at('s2'), { rank: 'section', sname: 'Two' });
    Object.assign(at('s3'), { rank: 'section', sname: 'Three' });
    Object.assign(at('g1'), { rank: 'group', gmeta: { ...G1 } });
    for (const id of ['o1', 'o2', 'o3']) Object.assign(at(id), { rank: 'option', gmeta: { ...G1 } });
    Object.assign(at('g2'), { rank: 'group', gmeta: { ...G2 } });
    for (const id of ['p1', 'p2']) Object.assign(at(id), { rank: 'option', gmeta: { ...G2 } });
    doc.sequences[0].rows = rebuildSeq(entries);
    return doc;
}

/**
 * id -> { rank, group: "name|cardinality"|null, head: group heading id|null,
 *         section: governing section name|null }
 * @param {any} doc
 */
function structure(doc) {
    /** @type {Map<string, {rank: string, group: string|null, head: string|null, section: string|null}>} */
    const out = new Map();
    let section = /** @type {string|null} */ (null);
    let head = /** @type {string|null} */ (null);
    for (const e of flattenSeq(doc.sequences[0].rows)) {
        const id = identOf(e.leaf);
        if (e.rank === 'section') { section = e.sname ?? null; head = null; }
        if (e.rank === 'group') head = id;
        else if (e.rank !== 'option') head = null;
        const group = e.gmeta && (e.rank === 'group' || e.rank === 'option') ? `${e.gmeta.name}|${e.gmeta.cardinality}` : null;
        out.set(id, { rank: e.rank, group, head: e.rank === 'option' || e.rank === 'group' ? head : null, section });
    }
    return out;
}

/** Group containers of sequence 0: [{ name, cardinality, head, members }]. */
function groups(/** @type {any} */ doc) {
    /** @type {{name: string, cardinality: string, head: string|null, members: string[]}[]} */
    const out = [];
    const walk = (/** @type {any[]} */ rows) => {
        for (const row of rows) {
            if (row.kind === 'section') walk(row.rows ?? []);
            else if (row.kind === 'group') {
                out.push({
                    name: row.name, cardinality: row.cardinality,
                    head: row.header ? identOf(row.header) : null,
                    members: (row.options ?? []).map(identOf),
                });
            }
        }
    };
    walk(doc.sequences[0].rows);
    return out;
}
const sections = (/** @type {any} */ doc) => doc.sequences[0].rows.filter((/** @type {any} */ r) => r.kind === 'section')
    .map((/** @type {any} */ r) => ({ name: r.name, head: r.header ? identOf(r.header) : null }));

/** ST's order after moving `id` directly above `before` (null: to the end). */
function moved(/** @type {string[]} */ order, /** @type {string} */ id, /** @type {string|null} */ before) {
    const out = order.filter((x) => x !== id);
    const at = before === null ? out.length : out.indexOf(before);
    assert.ok(at >= 0, `no ${before} in the order`);
    out.splice(at, 0, id);
    return out;
}

/**
 * Route an ST-panel reorder the way POST /slot/panel does: base = the
 * current compile, snapshot = the same with the order replaced by `T`.
 * @param {any} doc
 * @param {string[]} T
 */
function panelReorder(doc, T) {
    const { compiled } = compile(doc, null, {});
    const snap = structuredClone(compiled);
    const byId = new Map(compiled.prompt_order[0].order.map((/** @type {any} */ o) => [o.identifier, o]));
    snap.prompt_order[0].order = T.map((id) => ({ ...byId.get(id) }));
    return routePanelDiff(doc, compiled, panelDelta(compiled, snap), null);
}

/**
 * The invariants every case asserts.
 * @param {any} before doc before the write-back (a clone)
 * @param {any} after doc after it
 * @param {string[]} T ST's order
 * @param {{ moved?: string[], converges?: boolean, emptiedGroups?: string[] }} [opts]
 *   moved: leaves whose rank/group/section may change (everything else must
 *   keep its structure); converges: the compiled order is NOT T but a fixed
 *   point; emptiedGroups: group names allowed to disappear
 */
function assertInvariants(before, after, T, opts = {}) {
    // 1. identifier multiset
    assert.deepEqual([...flatIds(after)].sort(), [...flatIds(before)].sort(), 'identifier multiset changed');
    assert.deepEqual(Object.keys(after.blocks).sort(), Object.keys(before.blocks).sort(), 'blocks changed');
    // 2. stored enabled bits (every loadout) untouched
    for (const [lid, L] of Object.entries(before.loadouts)) {
        assert.deepEqual(after.loadouts[lid].enabled, /** @type {any} */ (L).enabled, `loadout ${lid} bits changed`);
    }
    // 3. every group and section still exists, same name/cardinality, once
    const gKey = (/** @type {any} */ g) => `${g.name}|${g.cardinality}`;
    const gAfter = groups(after).map(gKey);
    for (const g of groups(before)) {
        if (opts.emptiedGroups?.includes(g.name)) continue;
        assert.equal(gAfter.filter((k) => k === gKey(g)).length, 1, `group ${gKey(g)} lost or duplicated: ${JSON.stringify(gAfter)}`);
    }
    assert.equal(groups(after).length, groups(before).length - (opts.emptiedGroups?.length ?? 0), 'phantom or lost group');
    const bySection = (/** @type {{name: string|null, head: string|null}[]} */ s) => [...s].sort((x, y) => String(x.head).localeCompare(String(y.head)));
    assert.deepEqual(bySection(sections(after)), bySection(sections(before)), 'sections changed');
    // 4. leaves that did not move keep rank, group and section
    const sb = structure(before);
    const sa = structure(after);
    for (const [id, s] of sb) {
        if (opts.moved?.includes(id)) continue;
        assert.deepEqual(sa.get(id), s, `unmoved ${id} changed structure`);
    }
    // 5. the compiled order is ST's order, or a fixed point ST converges to
    const compiledAfter = orderIds(after);
    if (opts.converges) {
        assert.notDeepEqual(compiledAfter, T, 'expected the library to differ from ST (whole-block rule)');
    } else {
        assert.deepEqual(compiledAfter, T, 'compiled order != ST order');
    }
    const again = structuredClone(after);
    assert.equal(applyOrderToSequences(again, compiledAfter), false, 're-sending the library order must change nothing');
    assert.deepEqual(again.sequences, after.sequences, 're-sending the library order changed the document');
    // 6. pick-one groups compile with at most one option on
    const { compiled } = compile(after, null, {});
    const on = new Map(compiled.prompt_order[0].order.map((/** @type {any} */ o) => [o.identifier, o.enabled]));
    for (const g of groups(after)) {
        if (g.cardinality !== 'pick-one') continue;
        assert.ok(g.members.filter((m) => on.get(m)).length <= 1, `pick-one ${g.name} compiles with >1 on`);
    }
}

function run(/** @type {(T0: string[]) => string[]} */ reorder, /** @type {any} */ opts = {}) {
    const doc = mkDoc();
    const before = structuredClone(doc);
    const T = reorder(orderIds(doc));
    const { routed } = panelReorder(doc, T);
    assertInvariants(before, doc, T, opts);
    return { doc, before, T, routed };
}

test('fixture: the slot order hides the empty headings g1 and s2', () => {
    assert.deepEqual(orderIds(mkDoc()), ['intro', 'chatHistory', 's1', 'a', 'b', 'c', 'o1', 'o2', 'o3', 'd', 'e', 'f', 'g2', 'p1', 'p2', 'h', 's3', 'i', 'j']);
    assert.deepEqual(groups(mkDoc()).map((g) => [g.name, g.cardinality, g.head, g.members.join()]), [
        ['G1', 'pick-one', 'g1', 'o1,o2,o3'], ['G2', 'pick-one-or-more', 'g2', 'p1,p2'],
    ]);
});

test('an item moving within its section stays an item of that section, above the empty group heading', () => {
    const { doc, routed } = run((T0) => moved(T0, 'a', 'o1'), { moved: ['a'] });
    assert.ok(routed.some((r) => r.key === 'prompt_order.order' && r.layer === 'blocks'));
    assert.deepEqual(structure(doc).get('a'), { rank: 'item', group: null, head: null, section: 'One' });
    assert.deepEqual(flatIds(doc).slice(2, 8), ['s1', 'b', 'c', 'a', 'g1', 'o1']);
});

test('an item moving up across a visible section heading joins the end of the section above', () => {
    const { doc } = run((T0) => moved(T0, 'i', 's3'), { moved: ['i'] });
    assert.deepEqual(structure(doc).get('i'), { rank: 'item', group: null, head: null, section: 'Two' });
});

// ST cannot tell "h dragged below s3" from "s3 dragged above h": a heading
// outweighs one row, so the single row is the one that moved.
test('an item moving down across a visible section heading (or the heading swapped with it) becomes the first row of that section', () => {
    const { doc } = run((T0) => moved(T0, 'h', 'i'), { moved: ['h'] });
    assert.deepEqual(structure(doc).get('h'), { rank: 'item', group: null, head: null, section: 'Three' });
});

test('an option moving within its group stays in the group (to the end, and to the top under the empty heading)', () => {
    const r1 = run((T0) => moved(T0, 'o1', 'd'), { moved: ['o1'] });
    assert.deepEqual(groups(r1.doc)[0].members, ['o2', 'o3', 'o1']);
    assert.equal(groups(r1.doc)[0].head, 'g1');
    const r2 = run((T0) => moved(T0, 'o3', 'o1'), { moved: ['o3'] });
    assert.deepEqual(groups(r2.doc)[0].members, ['o3', 'o1', 'o2']);
    assert.equal(groups(r2.doc)[0].head, 'g1');
    assert.deepEqual(flatIds(r2.doc).slice(5, 10), ['c', 'g1', 'o3', 'o1', 'o2']);
});

test('an option dragged out of its group among plain items becomes a plain item (no phantom group)', () => {
    const { doc } = run((T0) => moved(T0, 'o2', 'f'), { moved: ['o2'] });
    assert.deepEqual(structure(doc).get('o2'), { rank: 'item', group: null, head: null, section: 'Two' });
    assert.deepEqual(groups(doc).map((g) => [g.name, g.members.join()]), [['G1', 'o1,o3'], ['G2', 'p1,p2']]);
});

test("an option dragged among another group's options becomes that group's option", () => {
    const { doc } = run((T0) => moved(T0, 'o2', 'p2'), { moved: ['o2'] });
    assert.deepEqual(structure(doc).get('o2'), { rank: 'option', group: 'G2|pick-one-or-more', head: 'g2', section: 'Two' });
    assert.deepEqual(groups(doc).map((g) => [g.name, g.cardinality, g.members.join()]), [
        ['G1', 'pick-one', 'o1,o3'], ['G2', 'pick-one-or-more', 'p1,o2,p2'],
    ]);
});

test('an option that was its group\'s only member leaves: the group keeps its heading, name and cardinality', () => {
    const doc = mkDoc();
    // make G2 a one-option group: p2 becomes a plain item after it
    const entries = flattenSeq(doc.sequences[0].rows);
    Object.assign(entries.find((e) => identOf(e.leaf) === 'p2'), { rank: 'item', gmeta: null });
    doc.sequences[0].rows = rebuildSeq(entries);
    const before = structuredClone(doc);
    const T = moved(orderIds(doc), 'p1', 'i');
    panelReorder(doc, T);
    assertInvariants(before, doc, T, { moved: ['p1'] });
    assert.deepEqual(groups(doc).find((g) => g.name === 'G2'), { name: 'G2', cardinality: 'pick-one-or-more', head: 'g2', members: [] });
    assert.deepEqual(structure(doc).get('p1'), { rank: 'item', group: null, head: null, section: 'Three' });
});

test('an item dragged into the middle of a pick-one group becomes its option; the compile normalises pick-one', () => {
    const { doc, before } = run((T0) => moved(T0, 'a', 'o2'), { moved: ['a'] });
    assert.deepEqual(structure(doc).get('a'), { rank: 'option', group: 'G1|pick-one', head: 'g1', section: 'One' });
    assert.deepEqual(groups(doc)[0].members, ['o1', 'a', 'o2', 'o3']);
    const L = doc.loadouts[doc.activeLoadoutId].enabled;
    assert.equal(L.a, true, 'stored bit untouched');
    assert.equal(L.o1, true, 'stored bit untouched');
    assert.deepEqual(L, before.loadouts[before.activeLoadoutId].enabled);
    const on = compile(doc, null, {}).compiled.prompt_order[0].order.filter((/** @type {any} */ o) => ['o1', 'a', 'o2', 'o3'].includes(o.identifier) && o.enabled);
    assert.equal(on.length, 1, 'exactly one G1 option compiles on');
});

test('a group heading moved alone takes its whole group with it; the library order is a fixed point ST converges to', () => {
    // g2 dragged up two rows, above e (ST cannot see s2)
    const { doc, T } = run((T0) => moved(T0, 'g2', 'e'), { converges: true });
    assert.deepEqual(T.slice(9, 16), ['d', 'g2', 'e', 'f', 'p1', 'p2', 'h']);
    assert.deepEqual(flatIds(doc).slice(10, 18), ['d', 's2', 'g2', 'p1', 'p2', 'e', 'f', 'h']);
    assert.deepEqual(groups(doc)[1], { name: 'G2', cardinality: 'pick-one-or-more', head: 'g2', members: ['p1', 'p2'] });
    for (const id of ['e', 'f', 'h', 'g2', 'p1', 'p2']) assert.equal(structure(doc).get(id)?.section, 'Two', id);
});

test("a group heading dragged down inside its own group's options changes nothing (the whole group stays)", () => {
    const doc = mkDoc();
    const before = structuredClone(doc);
    const T = moved(orderIds(doc), 'g2', 'h');
    const { routed } = panelReorder(doc, T);
    assertInvariants(before, doc, T, { converges: true });
    assert.deepEqual(doc.sequences, before.sequences, 'document unchanged');
    assert.ok(!routed.some((r) => r.key === 'prompt_order.order'), 'an unchanged order is not routed (no revision)');
});

test('a section heading moved alone takes its whole section, landing above the section it was dropped into', () => {
    // s3 dragged up two rows, above p2 (inside section Two)
    const { doc } = run((T0) => moved(T0, 's3', 'p2'), { converges: true });
    assert.deepEqual(flatIds(doc).slice(10, 21), ['d', 's3', 'i', 'j', 's2', 'e', 'f', 'g2', 'p1', 'p2', 'h']);
    assert.deepEqual(sections(doc).map((s) => s.name), ['One', 'Three', 'Two']);
});

test('two independent moves in one diff are both applied', () => {
    const { doc } = run((T0) => moved(moved(T0, 'a', 'o1'), 'i', 's3'), { moved: ['a', 'i'] });
    assert.deepEqual(structure(doc).get('a'), { rank: 'item', group: null, head: null, section: 'One' });
    assert.deepEqual(structure(doc).get('i'), { rank: 'item', group: null, head: null, section: 'Two' });
});

test('next to a suppressed empty heading: a foreign row lands above it, the heading stays on its row', () => {
    // d dragged up above o1: in ST it sits right above G1's first option
    const r1 = run((T0) => moved(T0, 'd', 'o1'), { moved: ['d'] });
    assert.deepEqual(structure(r1.doc).get('d'), { rank: 'item', group: null, head: null, section: 'One' });
    assert.deepEqual(flatIds(r1.doc).slice(5, 10), ['c', 'd', 'g1', 'o1', 'o2']);
    assert.deepEqual(groups(r1.doc)[0].members, ['o1', 'o2', 'o3']);
    // e (the first row under the empty s2) dragged below f: both stay in Two
    const r2 = run((T0) => moved(T0, 'e', 'g2'), { moved: ['e', 'f'] });
    const ids = flatIds(r2.doc);
    assert.ok(ids.indexOf('s2') < ids.indexOf('f') && ids.indexOf('s2') < ids.indexOf('e'), `s2 not above its rows: ${ids}`);
    assert.equal(structure(r2.doc).get('e')?.section, 'Two');
    assert.equal(structure(r2.doc).get('f')?.section, 'Two');
    // a row dragged to the end of the preset stays out of every container it did not belong to
    const r3 = run((T0) => moved(T0, 'o1', null), { moved: ['o1'] });
    assert.deepEqual(structure(r3.doc).get('o1'), { rank: 'item', group: null, head: null, section: 'Three' });
});

test('no-op: the identical order changes nothing and routes nothing', () => {
    const doc = mkDoc();
    const before = structuredClone(doc);
    assert.equal(applyOrderToSequences(doc, orderIds(doc)), false);
    assert.deepEqual(doc, before);
    // a stale base (order a/b swapped) with a snapshot equal to the library:
    // the sequence "changed" vs the base, but not vs the document
    const { compiled } = compile(doc, null, {});
    const base = structuredClone(compiled);
    const o = base.prompt_order[0].order;
    const ia = o.findIndex((/** @type {any} */ x) => x.identifier === 'a');
    [o[ia], o[ia + 1]] = [o[ia + 1], o[ia]];
    const delta = panelDelta(base, structuredClone(compiled));
    assert.equal(delta.prompt_order.changed, true);
    const { routed } = routePanelDiff(doc, compiled, delta, null);
    assert.deepEqual(routed, []);
    assertInvariants(before, doc, orderIds(before));
});

test('unknown identifiers in the panel order are ignored; duplicates count once', () => {
    const doc = mkDoc();
    const before = structuredClone(doc);
    const T = moved(orderIds(doc), 'a', 'o1');
    assert.equal(applyOrderToSequences(doc, ['ghost-from-st', ...T, 'a']), true);
    assertInvariants(before, doc, T, { moved: ['a'] });
});

// ---- DEM: the three drags dev/check-reorder.mjs performs in ST's own panel

const DEM_FILE = new URL('../dev/fixtures/presets/DEUS.EX.MACHINA.V2.5.ST.json', import.meta.url);

function demDoc() {
    const doc = importStPreset(JSON.parse(fs.readFileSync(DEM_FILE, 'utf8')), 'DEM');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    return doc;
}
const idByName = (/** @type {any} */ doc, /** @type {string} */ name) => {
    const hit = Object.values(doc.blocks).find((/** @type {any} */ b) => b.name === name);
    if (!hit) throw new Error(`DEM: no block named ${name}`);
    return /** @type {any} */ (hit).identifier;
};

test('DEM: an item dragged two rows down inside CONSTRAINTS', () => {
    const doc = demDoc();
    const before = structuredClone(doc);
    const x = idByName(doc, '| Character Realism |');
    const T = moved(orderIds(doc), x, idByName(doc, '| Anti-Repetition |'));
    panelReorder(doc, T);
    assertInvariants(before, doc, T, { moved: [x] });
    assert.equal(structure(doc).get(x)?.section, 'CONSTRAINTS');
});

test('DEM: the last AGENCY option dragged to the top of its group (the group and section headings are suppressed)', () => {
    const doc = demDoc();
    const before = structuredClone(doc);
    const x = idByName(doc, '「 Director 」');
    const T = moved(orderIds(doc), x, idByName(doc, '「 You control {{user}} 」'));
    panelReorder(doc, T);
    assertInvariants(before, doc, T, { moved: [x] });
    const agency = groups(doc).find((g) => g.name === 'PICK: AGENCY');
    assert.equal(agency?.members[0], x);
    assert.equal(agency?.members.length, 4);
    assert.equal(structure(doc).get(x)?.section, 'STORY');
});

test('DEM: the WORLD-BUILDING group heading dragged two rows up takes its group above PICK: (+18) NSFW', () => {
    const doc = demDoc();
    const before = structuredClone(doc);
    const wb = idByName(doc, '🔻PICK: WORLD-BUILDING🔻');
    const T = moved(orderIds(doc), wb, idByName(doc, '「 Max Lewdness 」'));
    panelReorder(doc, T);
    assertInvariants(before, doc, T, { converges: true });
    const names = groups(doc).map((g) => g.name);
    assert.equal(names.indexOf('PICK: WORLD-BUILDING') + 1, names.indexOf('PICK: (+18) NSFW'));
    const g = groups(doc).find((x) => x.name === 'PICK: WORLD-BUILDING');
    assert.equal(g?.head, wb);
    assert.equal(g?.members.length, 3);
});

test('bounded work: a moved set larger than MAX_PANEL_MOVES is refused (document unchanged); one moved row still applies', () => {
    const mk = () => ({
        sequences: [{ character_id: 1, rows: Array.from({ length: MAX_PANEL_MOVES * 2 + 50 }, (_, i) => ({ kind: 'block', ref: `r${i}`, key: `k${i}` })) }],
    });
    const d = mk();
    const ids = d.sequences[0].rows.map((r) => r.ref);
    const before = structuredClone(d);
    assert.equal(applyOrderToSequences(d, [...ids].reverse()), false, 'a whole-sequence reversal is not a panel drag');
    assert.deepEqual(d, before);
    assert.equal(applyOrderToSequences(d, moved(ids, 'r0', 'r5')), true);
    assert.deepEqual(d.sequences[0].rows.slice(0, 5).map((r) => r.ref), ['r1', 'r2', 'r3', 'r4', 'r0']);
});

test('a marker dragged in ST is an ordinary row: it moves as an item (never an option) and nothing else moves', () => {
    // chatHistory dragged into the middle of G1's options: markers are only
    // ever items, and an item there would split G1, so that step is dropped
    const r1 = run((T0) => moved(T0, 'chatHistory', 'o2'), { converges: true });
    assert.deepEqual(flatIds(r1.doc), flatIds(r1.before));
    // chatHistory dragged below d (plain rows): applied exactly
    const r2 = run((T0) => moved(T0, 'chatHistory', 'e'), { moved: ['chatHistory'] });
    assert.deepEqual(structure(r2.doc).get('chatHistory'), { rank: 'item', group: null, head: null, section: 'One' });
});
