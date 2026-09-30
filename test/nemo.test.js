/**
 * Nemo recognizer: ST macro-comment tags `{{// @section-header true }}` open
 * a section at that block; contiguous runs (>=2) of one
 * `{{// @mutual-exclusive-group X }}` value become headerless pick-one
 * groups (guessed:false). Runs of 1 stay plain, prompt order never changes,
 * split groups are recorded in the recognizer notes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStPreset, pickRecognizer, nemoTags } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq } from '../shared/outline.js';
import { normalize } from '../shared/groups.js';
import { Store } from '../plugin/store.js';

const REPO = path.resolve(import.meta.dirname, '..');
const NEMO_FILE = 'Nemo Engine 11.5.2 - Default RP.json';

function loadNemo() {
    const candidates = [
        path.join(process.env.HOME ?? '', 'projects/sillysystem/presets/Nemo', NEMO_FILE),
        path.join(REPO, 'dev/fixtures/presets', NEMO_FILE),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
    }
    return null;
}

const SEC = '{{// @section-header true }}';
const grp = (/** @type {string} */ g) => `{{// @mutual-exclusive-group ${g} }}`;

/**
 * Synthetic Nemo preset. Order (ids): pre, H1, a1 a2 a3 (A), x, H2, b1 (B),
 * x2, b2 b3 (B), chatHistory (marker), b4 (B), c1 d1 c2 d2 (C/D alternating),
 * e1 (E), H3 (section header ALSO tagged E), e2 (E), cmt (plain ST comment),
 * g1 (G), <ghost>, g2 (G).
 */
function nemoSt() {
    /** @type {[string, string, string][]} [identifier, name, content] */
    const spec = [
        ['pre', 'Preamble', 'plain text'],
        ['H1', ' === 📁 One === ', `${SEC}{{// @header One }}`],
        ['a1', 'A one', `${grp('A')}\nbody a1`],
        ['a2', 'A two', `${grp('A')}\nbody a2`],
        ['a3', 'A three', `${grp('A')}\nbody a3`],
        ['x', 'Plain x', '{{// @category misc }}\nno structure tags'],
        ['H2', '<Two: Sub>', `${SEC}{{// @header Two }}`],
        ['b1', 'B one', grp('B')],
        ['x2', 'Plain x2', 'text'],
        ['b2', 'B two', grp('B')],
        ['b3', 'B three', grp('B')],
        ['b4', 'B four', grp('B')],
        ['c1', 'C one', grp('C')],
        ['d1', 'D one', grp('D')],
        ['c2', 'C two', grp('C')],
        ['d2', 'D two', grp('D')],
        ['e1', 'E one', grp('E')],
        ['H3', '=== Three ===', `${SEC}\n${grp('E')}`],
        ['e2', 'E two', grp('E')],
        ['cmt', 'Comment', '{{// just a plain comment }}\ntext'],
        ['g1', 'G one', grp('G')],
        ['g2', 'G two', grp('G')],
    ];
    /** @type {any[]} */
    const prompts = spec.map(([identifier, name, content]) => ({
        identifier, name, content, role: 'system', enabled: true,
    }));
    prompts.push({ identifier: 'chatHistory', name: 'Chat History', marker: true });
    const ids = spec.map(([id]) => id);
    const orderIds = [
        ...ids.slice(0, ids.indexOf('b4')), 'chatHistory',
        ...ids.slice(ids.indexOf('b4'), ids.indexOf('g2')), 'ghost-missing',
        'g2',
    ];
    return {
        temperature: 1,
        prompts,
        prompt_order: [{ character_id: 100001, order: orderIds.map((identifier) => ({ identifier, enabled: true })) }],
        orderIds,
    };
}

const leafId = (/** @type {any} */ l) => l.ref ?? l.identifier;

/** @param {any[]} rows */
function collect(rows) {
    /** @type {any[]} */ const sections = [];
    /** @type {any[]} */ const groups = [];
    const walk = (/** @type {any[]} */ rs) => {
        for (const r of rs) {
            if (r.kind === 'section') { sections.push(r); walk(r.rows); }
            else if (r.kind === 'group') groups.push(r);
        }
    };
    walk(rows);
    return { sections, groups };
}

test('nemoTags: reads section-header and mutual-exclusive-group values', () => {
    const t = nemoTags(`${SEC}{{//@mutual-exclusive-group Vex-Personality}}\n{{// @header  Foo }} text`);
    assert.equal(t.get('section-header'), 'true');
    assert.equal(t.get('mutual-exclusive-group'), 'Vex-Personality');
    assert.equal(nemoTags('{{// @mutual-exclusive-group   World-Logic   }}').get('mutual-exclusive-group'), 'World-Logic');
    assert.equal(nemoTags('{{// plain comment }}').size, 0);
    assert.equal(nemoTags('').size, 0);
    assert.equal(nemoTags(undefined).size, 0);
});

test('nemo: sections at every section-header block, in order, header = its block', () => {
    const st = nemoSt();
    const doc = importStPreset(st, 'Nemo synth');
    assert.equal(doc.source.recognizer.kind, 'nemo');
    const rows = doc.sequences[0].rows;
    const { sections } = collect(rows);
    assert.deepEqual(sections.map((s) => s.name), ['=== 📁 One ===', '<Two: Sub>', '=== Three ===']);
    assert.deepEqual(sections.map((s) => s.header?.ref), ['H1', 'H2', 'H3']);
    assert.ok(sections.every((s) => s.header.kind === 'block'));
    // the leading plain block stays top-level, before the first section
    assert.equal(rows[0].kind, 'block');
    assert.equal(rows[0].ref, 'pre');
    // no nesting: sections are all top-level
    assert.deepEqual(rows.filter((r) => r.kind === 'section').map((s) => s.header.ref), ['H1', 'H2', 'H3']);
});

test('nemo: prompt order is never changed', () => {
    const st = nemoSt();
    const doc = importStPreset(st, 'Nemo synth');
    const ids = flattenSeq(doc.sequences[0].rows).map((e) => leafId(e.leaf));
    assert.deepEqual(ids, st.orderIds);
});

test('nemo: groups are exactly the contiguous runs of >=2, headerless pick-one, not guessed', () => {
    const doc = importStPreset(nemoSt(), 'Nemo synth');
    const { groups } = collect(doc.sequences[0].rows);
    assert.deepEqual(groups.map((g) => [g.name, g.options.map(leafId)]), [
        ['A', ['a1', 'a2', 'a3']],
        ['B', ['b2', 'b3']],
    ]);
    for (const g of groups) {
        assert.equal(g.cardinality, 'pick-one');
        assert.equal(g.guessed, false);
        assert.equal(g.header, null);
    }
    // runs of 1 (b1, b4, c*, d*, e*, g*) and the ghost stay plain items
    const byId = new Map(flattenSeq(doc.sequences[0].rows).map((e) => [leafId(e.leaf), e]));
    for (const id of ['b1', 'b4', 'c1', 'd1', 'c2', 'd2', 'e1', 'e2', 'g1', 'g2', 'x', 'x2', 'cmt', 'ghost-missing']) {
        assert.equal(byId.get(id).rank, 'item', id);
    }
    // a section header that also carries a group tag is a section, never an option
    assert.equal(byId.get('H3').rank, 'section');
});

test('nemo: markers stay items and end a group run', () => {
    const doc = importStPreset(nemoSt(), 'Nemo synth');
    const entries = flattenSeq(doc.sequences[0].rows);
    const marker = entries.find((e) => leafId(e.leaf) === 'chatHistory');
    assert.equal(marker.leaf.kind, 'marker');
    assert.equal(marker.rank, 'item');
    // b2,b3 | chatHistory | b4: the marker split B, b4 is not in the group
    const { groups } = collect(doc.sequences[0].rows);
    assert.ok(!groups.find((g) => g.name === 'B').options.some((o) => leafId(o) === 'b4'));
});

test('nemo: notes name every split group and summarize counts', () => {
    const notes = importStPreset(nemoSt(), 'Nemo synth').source.recognizer.notes;
    const split = (/** @type {string} */ g) => notes.find((n) => n.includes(`group '${g}'`) && n.includes('non-contiguous'));
    for (const g of ['B', 'C', 'D', 'E', 'G']) assert.ok(split(g), `split note for ${g}: ${notes.join(' | ')}`);
    assert.ok(!split('A'), 'A is one run: no split note');
    assert.match(split('B'), /3 non-contiguous run/);
    assert.ok(split('B').includes('B one'), 'split note lists member names');
    assert.ok(notes.some((n) => /^nemo: 3 sections, 2 pick-one groups from @mutual-exclusive-group/.test(n)), notes.join(' | '));
});

test('nemo: store import round-trip validates and folds nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-nemo-'));
    const store = new Store(root);
    await store.init();
    const st = nemoSt();
    const doc = await store.importPreset({ st, name: 'Nemo synth' });
    const { sections, groups } = collect(doc.sequences[0].rows);
    assert.equal(sections.length, 3);
    assert.deepEqual(groups.map((g) => [g.name, g.options.length, g.cardinality, g.guessed]), [
        ['A', 3, 'pick-one', false],
        ['B', 2, 'pick-one', false],
    ]);
    assert.deepEqual(flattenSeq(doc.sequences[0].rows).map((e) => leafId(e.leaf)), st.orderIds);
});

/**
 * Adjacent groups: H (section), p1 p2 (P), q1 q2 q3 (Q), r1 r2 (R), z plain,
 * s1 s2 (S). The outline model folds directly adjacent headerless groups
 * into one (rebuildSeq), so a group that directly follows another group is
 * headed by its own first member (headings count as pick-one members).
 */
function adjacentSt() {
    /** @type {[string, string, string][]} */
    const spec = [
        ['H', 'Head', SEC],
        ['p1', 'P one', grp('P')], ['p2', 'P two', grp('P')],
        ['q1', 'Q one', grp('Q')], ['q2', 'Q two', grp('Q')], ['q3', 'Q three', grp('Q')],
        ['r1', 'R one', grp('R')], ['r2', 'R two', grp('R')],
        ['z', 'Plain z', 'text'],
        ['s1', 'S one', grp('S')], ['s2', 'S two', grp('S')],
    ];
    return {
        prompts: spec.map(([identifier, name, content]) => ({ identifier, name, content, role: 'system' })),
        prompt_order: [{ character_id: 100001, order: spec.map(([identifier]) => ({ identifier, enabled: false })) }],
        orderIds: spec.map(([id]) => id),
    };
}

const groupShape = (/** @type {any[]} */ groups) => groups.map((g) => [
    g.name, g.header ? leafId(g.header) : null, g.options.map(leafId), g.cardinality, g.guessed,
]);

const ADJ_EXPECTED = [
    ['P', null, ['p1', 'p2'], 'pick-one', false],
    ['Q', 'q1', ['q2', 'q3'], 'pick-one', false],
    ['R', 'r1', ['r2'], 'pick-one', false],
    ['S', null, ['s1', 's2'], 'pick-one', false],
];

test('nemo: a group directly after another group is headed by its first member; others stay headerless', () => {
    const st = adjacentSt();
    const doc = importStPreset(st, 'adj');
    const rows = doc.sequences[0].rows;
    assert.deepEqual(groupShape(collect(rows).groups), ADJ_EXPECTED);
    assert.deepEqual(flattenSeq(rows).map((e) => leafId(e.leaf)), st.orderIds);
    const notes = doc.source.recognizer.notes;
    assert.ok(notes.some((n) => n.includes("group 'Q' directly follows group 'P'")), notes.join(' | '));
    assert.ok(notes.some((n) => n.includes("group 'R' directly follows group 'Q'")), notes.join(' | '));
    assert.ok(!notes.some((n) => n.includes("group 'S' directly follows")), 'S follows a plain block');
});

test('nemo: adjacent groups survive the store round-trip and keep separate exclusivity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-nemo-adj-'));
    const store = new Store(root);
    await store.init();
    const doc = await store.importPreset({ st: adjacentSt(), name: 'adj' });
    assert.deepEqual(groupShape(collect(doc.sequences[0].rows).groups), ADJ_EXPECTED);
    // one pick per group: q1+q3 collapse to one; p1, r2, s1 are untouched
    const on = normalize(doc, { p1: true, q1: true, q3: true, r2: true, s1: true });
    assert.equal(Number(on.q1) + Number(on.q3), 1);
    assert.equal(on.p1, true);
    assert.equal(on.r2, true);
    assert.equal(on.s1, true);
});

test('nemo: non-Nemo presets are untouched (plain {{// }} comments + === names -> ff5)', () => {
    const st = {
        prompts: [
            { identifier: 'h', name: '=== Header ===', content: '{{// a comment }}', role: 'system' },
            { identifier: 'o1', name: 'Opt 1', content: '{{// @section-header false }}\n{{// @category x }}', role: 'system' },
            { identifier: 'o2', name: 'Opt 2', content: 'text', role: 'system' },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'h', enabled: true },
            { identifier: 'o1', enabled: true },
            { identifier: 'o2', enabled: false },
        ] }],
    };
    assert.equal(importStPreset(st, 'not nemo').source.recognizer.kind, 'ff5');
});

test('pickRecognizer: a Nemo-tagged row beats a 🔻PICK: row', () => {
    const byid = new Map([
        ['p', { identifier: 'p', name: '🔻PICK: Style🔻', content: 'x' }],
        ['n', { identifier: 'n', name: 'Plain', content: grp('Style') }],
    ]);
    const rows = [
        { kind: 'block', ref: 'p', enabled: true, key: 's-0' },
        { kind: 'block', ref: 'n', enabled: true, key: 's-1' },
    ];
    assert.equal(pickRecognizer(rows, byid), 'nemo');
    const secOnly = new Map([
        ['p', byid.get('p')],
        ['n', { identifier: 'n', name: 'Plain', content: SEC }],
    ]);
    assert.equal(pickRecognizer(rows, secOnly), 'nemo');
    const neither = new Map([
        ['p', byid.get('p')],
        ['n', { identifier: 'n', name: 'Plain', content: '{{// @section-header false }}{{// @header X }}' }],
    ]);
    assert.equal(pickRecognizer(rows, neither), 'dem');
});

test('recognizer kind: multi-sequence preset reports the shared recognizer', () => {
    const st = nemoSt();
    st.prompt_order.push({ character_id: 100000, order: structuredClone(st.prompt_order[0].order) });
    const doc = importStPreset(st, 'Nemo two orders');
    assert.equal(doc.sequences.length, 2);
    assert.equal(doc.source.recognizer.kind, 'nemo');
    // mixed recognizers across sequences -> flat (v1 rule kept)
    const mixed = nemoSt();
    mixed.prompt_order.push({ character_id: 100000, order: [{ identifier: 'x', enabled: true }] });
    assert.equal(importStPreset(mixed, 'mixed').source.recognizer.kind, 'flat');
});

test('nemo: real Nemo Engine 11.5.2 file (skips when absent)', () => {
    const st = loadNemo();
    if (!st) return;
    const doc = importStPreset(st, 'Nemo real');
    assert.equal(doc.source.recognizer.kind, 'nemo');
    assert.equal(doc.sequences.length, 2);
    const { sections, groups } = collect(doc.sequences[0].rows);
    assert.equal(sections.length, 49);
    assert.equal(groups.length, 29);
    const size = (/** @type {string} */ n) => {
        const g = groups.find((x) => x.name === n);
        return g ? g.options.length + (g.header ? 1 : 0) : undefined;
    };
    assert.equal(size('Vex-Personality'), 30);
    assert.equal(size('Format'), 10);
    assert.equal(size('Engine-Frame'), 2);
    assert.equal(size('World-Logic'), undefined);
    assert.equal(size('Archetype-Engine'), undefined);
    for (const s of doc.sequences) {
        for (const g of collect(s.rows).groups) {
            assert.equal(g.guessed, false);
            assert.equal(g.cardinality, 'pick-one');
        }
    }
    assert.ok(doc.source.recognizer.notes.some((n) => n.includes("group 'World-Logic' spans 9 non-contiguous")));
    // order invariant on both sequences
    st.prompt_order.forEach((po, i) => {
        assert.deepEqual(flattenSeq(doc.sequences[i].rows).map((e) => leafId(e.leaf)), po.order.map((o) => o.identifier));
    });
    // the store's normalization (rebuildSeq) keeps every group apart
    for (const s of doc.sequences) {
        const names = (/** @type {any[]} */ rows) => collect(rows).groups.map((g) => g.name);
        assert.deepEqual(names(rebuildSeq(flattenSeq(s.rows))), names(s.rows));
    }
    // Tense directly follows NPC-Interiority: headed by its first member
    const tense = groups.find((g) => g.name === 'Tense');
    assert.ok(tense?.header, 'Tense is headed');
    assert.ok(doc.source.recognizer.notes.some((n) => n.includes("group 'Tense' directly follows group 'NPC-Interiority'")));
});
