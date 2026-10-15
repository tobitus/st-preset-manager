/**
 * Nemo recognizer: ST macro-comment tags `{{// @section-header true }}`.
 * A header block whose name is `=== … ===` opens a section; every other
 * header is a SUB header that heads the run right after it (an exclusive
 * run -> pick-one group, a plain run -> pick-many group), moving up over an
 * exclusive run it splits. Other contiguous runs (>=2) of one
 * `{{// @mutual-exclusive-group X }}` value become headerless pick-one
 * groups (guessed:false). Runs of 1 stay plain, prompt order never changes
 * except for moved sub headers, split groups are recorded in the notes.
 * Comment-only headings (`{{// … }}` + `{{trim}}`) are no pick-one members
 * and show no switch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStPreset, pickRecognizer, nemoTags } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq } from '../shared/outline.js';
import { normalize, groupOfLeaf, completeOverride, isCommentOnly } from '../shared/groups.js';
import { applyDocOp } from '../shared/docops.js';
import { buildOutline, pickOneOps } from '../ext/outline-model.js';
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

test('nemo: sections only at === top headers, in order, header = its block', () => {
    const st = nemoSt();
    const doc = importStPreset(st, 'Nemo synth');
    assert.equal(doc.source.recognizer.kind, 'nemo');
    const rows = doc.sequences[0].rows;
    const { sections } = collect(rows);
    assert.deepEqual(sections.map((s) => s.name), ['=== 📁 One ===', '=== Three ===']);
    assert.deepEqual(sections.map((s) => s.header?.ref), ['H1', 'H3']);
    assert.ok(sections.every((s) => s.header.kind === 'block'));
    // the leading plain block stays top-level, before the first section
    assert.equal(rows[0].kind, 'block');
    assert.equal(rows[0].ref, 'pre');
    // no nesting: sections are all top-level
    assert.deepEqual(rows.filter((r) => r.kind === 'section').map((s) => s.header.ref), ['H1', 'H3']);
});

test('nemo: prompt order is never changed', () => {
    const st = nemoSt();
    const doc = importStPreset(st, 'Nemo synth');
    const ids = flattenSeq(doc.sequences[0].rows).map((e) => leafId(e.leaf));
    assert.deepEqual(ids, st.orderIds);
});

test('nemo: groups are the sub-headed runs plus contiguous runs of >=2, pick-one, not guessed', () => {
    const doc = importStPreset(nemoSt(), 'Nemo synth');
    const { groups } = collect(doc.sequences[0].rows);
    assert.deepEqual(groups.map((g) => [g.name, g.header ? leafId(g.header) : null, g.options.map(leafId)]), [
        ['A', null, ['a1', 'a2', 'a3']],
        ['B', 'H2', ['b1']],
        ['B', null, ['b2', 'b3']],
    ]);
    for (const g of groups) {
        assert.equal(g.cardinality, 'pick-one');
        assert.equal(g.guessed, false);
    }
    // runs of 1 (b4, c*, d*, e*, g*) and the ghost stay plain items
    const byId = new Map(flattenSeq(doc.sequences[0].rows).map((e) => [leafId(e.leaf), e]));
    for (const id of ['b4', 'c1', 'd1', 'c2', 'd2', 'e1', 'e2', 'g1', 'g2', 'x', 'x2', 'cmt', 'ghost-missing']) {
        assert.equal(byId.get(id).rank, 'item', id);
    }
    // a section header that also carries a group tag is a section, never an option
    assert.equal(byId.get('H3').rank, 'section');
    // a sub header is never a section
    assert.equal(byId.get('H2').rank, 'group');
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
    assert.ok(notes.some((n) => /^nemo: 2 sections, 3 pick-one groups from @mutual-exclusive-group/.test(n)), notes.join(' | '));
    assert.ok(!notes.some((n) => n.includes('moved sub header')), 'nothing moved in the synthetic preset');
});

test('nemo: store import round-trip validates and folds nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-nemo-'));
    const store = new Store(root);
    await store.init();
    const st = nemoSt();
    const doc = await store.importPreset({ st, name: 'Nemo synth' });
    const { sections, groups } = collect(doc.sequences[0].rows);
    assert.equal(sections.length, 2);
    assert.deepEqual(groups.map((g) => [g.name, g.header ? leafId(g.header) : null, g.options.length, g.cardinality, g.guessed]), [
        ['A', null, 3, 'pick-one', false],
        ['B', 'H2', 1, 'pick-one', false],
        ['B', null, 2, 'pick-one', false],
    ]);
    assert.deepEqual(flattenSeq(doc.sequences[0].rows).map((e) => leafId(e.leaf)), st.orderIds);
});

/** Nemo's own heading content: comments + {{trim}} only. */
const hdrContent = (/** @type {string} */ name, /** @type {string} */ cat) =>
    `\n{{// @category ${cat} }}\n{{// @section-header true }}\n{{// @header ${name} }}{{trim}}\n`;

/**
 * Sub headers, modelled on Nemo 11.5.2:
 *   T1 === Vex ===, dv (V), VP <Vex Personas>, v1 v2 v3 (V), m1 m2 plain,
 *   T2 === Core ===, CS <Core: Speech>, s1 s2 (S), AU <Authors>, a1 a2 plain,
 *   y1 y2 (Y), x (X, single), EH <Empty> (next is a top header),
 *   T3 === Last ===, SH <Before marker>, chatHistory (marker), z plain.
 * Every heading is ON; VP and v2 are ON, so is s1.
 */
function subSt() {
    /** @type {[string, string, string][]} */
    const spec = [
        ['T1', '=== 🎭 Vex ===', hdrContent('=== 🎭 Vex ===', 'Vex')],
        ['dv', '📋 Default: Vex', `${grp('V')}\ndefault vex`],
        ['VP', '<Vex Personas>', hdrContent('<Vex Personas>', 'Vex-Personality')],
        ['v1', 'Vex one', `${grp('V')}\nv1`], ['v2', 'Vex two', `${grp('V')}\nv2`], ['v3', 'Vex three', `${grp('V')}\nv3`],
        ['m1', 'Midnight', 'm1 text'], ['m2', 'Commentary', 'm2 text'],
        ['T2', '=== 📁 Core ===', hdrContent('=== 📁 Core ===', 'Core')],
        ['CS', '<Core: Speech>', hdrContent('<Core: Speech>', 'Core')],
        ['s1', 'Speech one', grp('S')], ['s2', 'Speech two', grp('S')],
        ['AU', '<Authors>', hdrContent('<Authors>', 'Writing-Style')],
        ['a1', 'Author one', '{{// @category Influence }}\na1'], ['a2', 'Author two', 'a2'],
        ['y1', 'Y one', grp('Y')], ['y2', 'Y two', grp('Y')],
        ['x', 'X single', grp('X')],
        ['EH', '<Empty>', hdrContent('<Empty>', 'E')],
        ['T3', '=== Last ===', hdrContent('=== Last ===', 'Last')],
        ['SH', '<Before marker>', hdrContent('<Before marker>', 'L')],
        ['z', 'Plain z', 'z'],
    ];
    /** @type {any[]} */
    const prompts = spec.map(([identifier, name, content]) => ({ identifier, name, content, role: 'system' }));
    prompts.push({ identifier: 'chatHistory', name: 'Chat History', marker: true });
    const ids = spec.map(([id]) => id);
    const orderIds = [...ids.slice(0, ids.indexOf('z')), 'chatHistory', 'z'];
    const on = new Set(['T1', 'VP', 'T2', 'CS', 'AU', 'EH', 'T3', 'SH', 'v2', 's1']);
    return {
        prompts,
        prompt_order: [{ character_id: 100001, order: orderIds.map((identifier) => ({ identifier, enabled: on.has(identifier) })) }],
        orderIds,
    };
}

/** Row shape: sections -> [name, header, rows]; groups -> [name, header, options, cardinality, guessed]; leaves -> id. */
function shape(/** @type {any[]} */ rows) {
    return rows.map((r) => {
        if (r.kind === 'section') return ['section', r.name, leafId(r.header), shape(r.rows)];
        if (r.kind === 'group') return ['group', r.name, r.header ? leafId(r.header) : null, r.options.map(leafId), r.cardinality, r.guessed];
        return leafId(r);
    });
}

const SUB_EXPECTED = [
    ['section', '=== 🎭 Vex ===', 'T1', [
        ['group', 'V', 'VP', ['dv', 'v1', 'v2', 'v3'], 'pick-one', false],
        'm1', 'm2',
    ]],
    ['section', '=== 📁 Core ===', 'T2', [
        ['group', 'S', 'CS', ['s1', 's2'], 'pick-one', false],
        ['group', '<Authors>', 'AU', ['a1', 'a2'], 'pick-one-or-more', false],
        ['group', 'Y', 'y1', ['y2'], 'pick-one', false],
        'x', 'EH',
    ]],
    ['section', '=== Last ===', 'T3', ['SH', 'chatHistory', 'z']],
];

/** orderIds with VP moved up to the start of the V run it split (before dv). */
const subOrder = (/** @type {string[]} */ ids) => {
    const out = ids.filter((id) => id !== 'VP');
    out.splice(out.indexOf('dv'), 0, 'VP');
    return out;
};

test('nemo sub headers: exclusive run -> pick-one, plain run -> pick-many, else plain; moved header noted', () => {
    const st = subSt();
    const doc = importStPreset(st, 'sub');
    assert.equal(doc.source.recognizer.kind, 'nemo');
    assert.deepEqual(shape(doc.sequences[0].rows), SUB_EXPECTED);
    // order: unchanged except the moved sub header
    assert.deepEqual(flattenSeq(doc.sequences[0].rows).map((e) => leafId(e.leaf)), subOrder(st.orderIds));
    const notes = doc.source.recognizer.notes;
    const moved = notes.filter((n) => n.includes('moved sub header'));
    assert.equal(moved.length, 1, notes.join(' | '));
    assert.ok(moved[0].includes('<Vex Personas>'), moved[0]);
    assert.ok(notes.some((n) => /^nemo: 3 sections, /.test(n)), notes.join(' | '));
});

test('nemo sub headers: a split run is joined only across the sub header, content blocks never move', () => {
    // p (V) then a plain block, then H, then v1 v2 (V): the V block before is NOT adjacent -> no move
    const st = {
        prompts: [
            { identifier: 'T', name: '=== T ===', content: hdrContent('=== T ===', 'T') },
            { identifier: 'p', name: 'P', content: grp('V') },
            { identifier: 'q', name: 'Q', content: 'plain' },
            { identifier: 'H', name: '<H>', content: hdrContent('<H>', 'V') },
            { identifier: 'v1', name: 'V1', content: grp('V') },
            { identifier: 'v2', name: 'V2', content: grp('V') },
        ],
        prompt_order: [{ character_id: 100001, order: ['T', 'p', 'q', 'H', 'v1', 'v2'].map((identifier) => ({ identifier, enabled: true })) }],
    };
    const doc = importStPreset(st, 'nomove');
    assert.deepEqual(shape(doc.sequences[0].rows), [
        ['section', '=== T ===', 'T', ['p', 'q', ['group', 'V', 'H', ['v1', 'v2'], 'pick-one', false]]],
    ]);
    assert.ok(!doc.source.recognizer.notes.some((n) => n.includes('moved sub header')));
});

test('nemo sub headers: a sub header that sends text never moves (order unchanged)', () => {
    const ids = ['T', 'a', 'H', 'b'];
    const st = {
        prompts: [
            { identifier: 'T', name: '=== T ===', content: hdrContent('=== T ===', 'T') },
            { identifier: 'a', name: 'A', content: `${grp('V')}\na text` },
            { identifier: 'H', name: '<H>', content: `${SEC}\nReal prompt text.` },
            { identifier: 'b', name: 'B', content: `${grp('V')}\nb text` },
        ],
        prompt_order: [{ character_id: 100001, order: ids.map((identifier) => ({ identifier, enabled: true })) }],
    };
    const doc = importStPreset(st, 'textheader');
    assert.deepEqual(flattenSeq(doc.sequences[0].rows).map((e) => leafId(e.leaf)), ids);
    // H stays put and heads the run after it; a stays plain (run of 1)
    assert.deepEqual(shape(doc.sequences[0].rows), [
        ['section', '=== T ===', 'T', ['a', ['group', 'V', 'H', ['b'], 'pick-one', false]]],
    ]);
    const notes = doc.source.recognizer.notes;
    assert.ok(!notes.some((n) => n.includes('moved sub header')), notes.join(' | '));
    assert.ok(notes.some((n) => n.includes("group 'V' spans 2 non-contiguous")), notes.join(' | '));
});

test('nemo sub headers: survive the store round-trip unchanged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-nemo-sub-'));
    const store = new Store(root);
    await store.init();
    const st = subSt();
    const doc = await store.importPreset({ st, name: 'sub' });
    const strip = (/** @type {any[]} */ s) => JSON.parse(JSON.stringify(s));
    assert.deepEqual(strip(shape(doc.sequences[0].rows)), SUB_EXPECTED);
    assert.deepEqual(flattenSeq(doc.sequences[0].rows).map((e) => leafId(e.leaf)), subOrder(st.orderIds));
});

test('isCommentOnly: {{// }} comments and {{trim}} only, never blank or text', () => {
    assert.equal(isCommentOnly(hdrContent('<Vex Personas>', 'Vex-Personality')), true);
    assert.equal(isCommentOnly('{{// a }}'), true);
    assert.equal(isCommentOnly('{{trim}}'), true);
    assert.equal(isCommentOnly('  {{// x\n y }}\n{{TRIM}} '), true);
    assert.equal(isCommentOnly(''), false, 'blank is the existing empty rule, not comment-only');
    assert.equal(isCommentOnly('   \n'), false);
    assert.equal(isCommentOnly(undefined), false);
    assert.equal(isCommentOnly('{{// x }} hello'), false);
    assert.equal(isCommentOnly('hello'), false);
    assert.equal(isCommentOnly('{{char}}'), false);
    assert.equal(isCommentOnly('{{// x }}{{char}}'), false);
});

/** subSt imported with one loadout L built from the ST enabled bits. */
function subDoc() {
    const st = subSt();
    const doc = /** @type {any} */ (importStPreset(st, 'sub'));
    const enabled = Object.fromEntries(st.prompt_order[0].order.map((o) => [o.identifier, o.enabled]));
    doc.loadouts = { L: { id: 'L', name: 'L', notes: '', enabled, overrides: {} } };
    doc.activeLoadoutId = 'L';
    return doc;
}

const groupByHeader = (/** @type {any} */ doc, /** @type {string} */ id) => {
    const all = [];
    for (const s of doc.sequences[0].rows) for (const r of s.rows ?? []) if (r.kind === 'group') all.push(r);
    return all.find((g) => g.header && leafId(g.header) === id);
};

test('comment-only heading ON + one option ON: not a pick-one member (normalize, setCardinality, overrides)', () => {
    const doc = subDoc();
    const en = doc.loadouts.L.enabled;
    assert.equal(en.VP, true);
    assert.equal(en.v2, true);
    /** @type {string[]} */
    const changed = [];
    normalize(doc, en, changed);
    assert.deepEqual(changed, [], 'normalize flips nothing');
    assert.equal(en.VP, true);
    assert.equal(en.v2, true);
    assert.equal(groupOfLeaf(doc).has('VP'), false, 'the comment-only heading belongs to no group');
    assert.equal(groupOfLeaf(doc).get('v2')?.name, 'V');
    // a per-Model override choosing v1 leaves the heading alone
    assert.deepEqual(completeOverride(doc, { v1: true }), { v1: true, dv: false, v2: false, v3: false });
    // pick-one -> pick-many -> pick-one is never refused for the heading
    const g = groupByHeader(doc, 'VP');
    assert.deepEqual(applyDocOp(doc, 'setCardinality', { key: g.key, cardinality: 'pick-one-or-more' }), { key: g.key, cardinality: 'pick-one-or-more' });
    assert.deepEqual(applyDocOp(doc, 'setCardinality', { key: g.key, cardinality: 'pick-one' }), { key: g.key, cardinality: 'pick-one' });
    // two real options on is still refused
    en.v3 = true;
    assert.throws(() => {
        applyDocOp(doc, 'setCardinality', { key: g.key, cardinality: 'pick-one-or-more' });
        applyDocOp(doc, 'setCardinality', { key: g.key, cardinality: 'pick-one' });
    }, (/** @type {any} */ err) => err.status === 409 && !String(err.message).includes('heading'));
});

test('comment-only heading: outline shows no switch, no conflict, none follows the options', () => {
    const doc = subDoc();
    const seq = buildOutline(doc).sequences[0].nodes;
    const vexSec = /** @type {any} */ (seq[0]);
    assert.equal(vexSec.type, 'section');
    assert.equal(vexSec.header.hasContent, false);
    assert.equal(vexSec.header.commentOnly, true, 'section heading row renders no switch');
    const vg = vexSec.nodes[0];
    assert.equal(vg.type, 'group');
    assert.equal(vg.header.identifier, 'VP');
    assert.equal(vg.header.hasContent, false);
    assert.equal(vg.header.commentOnly, true);
    assert.equal('headerSwitch' in vg, false);
    assert.equal(vg.header.switchType, 'checkbox', 'a heading is never a radio (the row hides it: comment-only)');
    assert.equal(vg.conflict, false, 'heading ON + v2 ON is no conflict');
    assert.equal(vg.noneOn, false);
    assert.deepEqual(vg.options.map((/** @type {any} */ o) => o.switchType), ['radio', 'radio', 'radio', 'radio']);
    // "none" switches off the options only, never the heading
    assert.deepEqual(pickOneOps(vg, null), [{ op: 'toggle', identifier: 'v2', value: false }]);
    // the plain rows after the group keep checkboxes
    assert.deepEqual(vexSec.nodes.slice(1).map((/** @type {any} */ n) => [n.identifier, n.switchType, n.commentOnly]), [['m1', 'checkbox', false], ['m2', 'checkbox', false]]);
    // the pick-many sub-headed group: switchless heading, checkbox options
    const au = /** @type {any} */ (seq[1]).nodes[1];
    assert.equal(au.header.identifier, 'AU');
    assert.equal(au.header.switchType, 'checkbox');
    assert.deepEqual(au.options.map((/** @type {any} */ o) => o.switchType), ['checkbox', 'checkbox']);
});

test('a heading that sends text is NOT a member either: it is a checkbox beside the chosen option', () => {
    const doc = subDoc();
    doc.blocks.VP.content = 'Pick your Vex.';
    const en = doc.loadouts.L.enabled;
    assert.equal(groupOfLeaf(doc).has('VP'), false);
    const vg = /** @type {any} */ (buildOutline(doc).sequences[0].nodes[0]).nodes[0];
    assert.equal(vg.header.commentOnly, false);
    assert.equal(vg.header.switchType, 'checkbox');
    assert.equal(vg.conflict, false);
    assert.deepEqual(pickOneOps(vg, null), [{ op: 'toggle', identifier: 'v2', value: false }]);
    /** @type {string[]} */
    const changed = [];
    normalize(doc, en, changed);
    assert.deepEqual(changed, []);
    assert.equal(en.VP, true);
    assert.equal(en.v2, true);
    const g = groupByHeader(doc, 'VP');
    assert.deepEqual(applyDocOp(doc, 'setCardinality', { key: g.key, cardinality: 'pick-one-or-more' }), { key: g.key, cardinality: 'pick-one-or-more' });
    assert.deepEqual(applyDocOp(doc, 'setCardinality', { key: g.key, cardinality: 'pick-one' }), { key: g.key, cardinality: 'pick-one' });
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
        ['H', '=== Head ===', SEC],
        ['p1', 'P one', grp('P')], ['p2', 'P two', grp('P')],
        ['q1', 'Q one', grp('Q')], ['q2', 'Q two', grp('Q')], ['q3', 'Q three', grp('Q')],
        ['r1', 'R one', grp('R')], ['r2', 'R two', grp('R')],
        ['z', 'Plain z', 'text'],
        ['s1', 'S one', grp('S')], ['s2', 'S two', grp('S')],
    ];
    return {
        // options send text (a first-member heading that sends text is a pick-one member)
        prompts: spec.map(([identifier, name, content]) => ({ identifier, name, content: `${content}\n${identifier} text`, role: 'system' })),
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
    // one pick per group: q2+q3 collapse to one; p1, r2, s1 are untouched
    const on = normalize(doc, { p1: true, q2: true, q3: true, r2: true, s1: true });
    assert.equal(Number(on.q2) + Number(on.q3), 1);
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
    // F-066: 100000 next to 100001 is dropped, so a second sequence needs another id
    const st = nemoSt();
    st.prompt_order.push({ character_id: 100002, order: structuredClone(st.prompt_order[0].order) });
    const doc = importStPreset(st, 'Nemo two orders');
    assert.equal(doc.sequences.length, 2);
    assert.equal(doc.source.recognizer.kind, 'nemo');
    // mixed recognizers across sequences -> flat (v1 rule kept)
    const mixed = nemoSt();
    mixed.prompt_order.push({ character_id: 100002, order: [{ identifier: 'x', enabled: true }] });
    assert.equal(importStPreset(mixed, 'mixed').source.recognizer.kind, 'flat');
});

test('F-066: a Nemo preset with 100000 + 100001 imports only 100001, with a note', () => {
    const st = nemoSt();
    st.prompt_order.unshift({ character_id: 100000, order: [{ identifier: 'pre', enabled: true }] });
    const doc = importStPreset(st, 'Nemo two orders');
    assert.equal(doc.sequences.length, 1);
    assert.equal(doc.sequences[0].character_id, 100001);
    assert.equal(doc.source.recognizer.kind, 'nemo');
    assert.ok(doc.source.recognizer.notes.some((n) => n.includes('100000')));
});

test('nemo: real Nemo Engine 11.5.2 file (skips when absent)', () => {
    const st = loadNemo();
    if (!st) return;
    const doc = importStPreset(st, 'Nemo real');
    assert.equal(doc.source.recognizer.kind, 'nemo');
    // F-066: the file carries 100000 + 100001; only 100001 is imported
    assert.equal(doc.sequences.length, 1);
    assert.equal(doc.sequences[0].character_id, 100001);
    assert.ok(doc.source.recognizer.notes.some((n) => n.includes('dropped prompt_order 100000')));
    const order100001 = st.prompt_order.find((/** @type {any} */ o) => o.character_id === 100001);
    const nameOf = (/** @type {any} */ leaf) => doc.blocks[leafId(leaf)]?.name;
    const byName = new Map(st.prompts.map((/** @type {any} */ p) => [p.name, p.identifier]));
    const subIds = new Set(st.prompts
        .filter((/** @type {any} */ p) => nemoTags(p.content).get('section-header') === 'true' && !/^\s*=+.*=+\s*$/.test(p.name))
        .map((/** @type {any} */ p) => p.identifier));
    for (const [i, s] of doc.sequences.entries()) {
        const { sections, groups } = collect(s.rows);
        // 18 top sections, all top-level, all === names
        assert.equal(sections.length, 18);
        assert.deepEqual(s.rows.filter((/** @type {any} */ r) => r.kind === 'section').length, 18);
        for (const sec of sections) assert.match(sec.name, /^\s*=+.*=+\s*$/);
        for (const g of groups) assert.equal(g.guessed, false);
        // order: unchanged except moved sub headers
        const orig = order100001.order.map((/** @type {any} */ o) => o.identifier);
        const now = flattenSeq(s.rows).map((e) => leafId(e.leaf));
        assert.deepEqual(now.filter((id) => !subIds.has(id)), orig.filter((/** @type {string} */ id) => !subIds.has(id)));
        assert.equal(now.length, orig.length);
        // the store's normalization (rebuildSeq) keeps every group apart
        const shapeOf = (/** @type {any[]} */ rows) => collect(rows).groups.map((g) => [g.name, g.header ? leafId(g.header) : null, g.options.length]);
        assert.deepEqual(shapeOf(rebuildSeq(flattenSeq(s.rows))), shapeOf(s.rows));

        // === 🎭 Vex Personality ===: [<Vex Personas> pick-one of Default: Vex + 30, then 4 plain blocks]
        const vex = sections.find((x) => x.name === '=== 🎭 Vex Personality ===');
        assert.ok(vex);
        assert.equal(vex.rows.length, 5);
        const vg = vex.rows[0];
        assert.equal(vg.kind, 'group');
        assert.equal(nameOf(vg.header), '<Vex Personas>');
        assert.equal(vg.cardinality, 'pick-one');
        assert.equal(vg.options.length, 31);
        assert.equal(nameOf(vg.options[0]), '📋 Default: Vex');
        assert.deepEqual(vex.rows.slice(1).map((/** @type {any} */ r) => [r.kind, nameOf(r)]), [
            ['block', '♠️ Midnight Courier Vex'], ['block', '💬 Vex Commentary'],
            ['block', '💭 Vex Meta-Commentary'], ['block', '📦 Core Assembler'],
        ]);
        assert.equal(now.indexOf(byName.get('<Vex Personas>')) + 1, now.indexOf(byName.get('📋 Default: Vex')), '<Vex Personas> moved above Default: Vex');

        // === 📁 Core ===: <Core: Augments> pick-many, <Core: Narration>/<Core: Speech> pick-one
        const core = sections.find((x) => x.name === '=== 📁 Core ===');
        const headed = (/** @type {string} */ h) => core.rows.find((/** @type {any} */ r) => r.kind === 'group' && r.header && nameOf(r.header) === h);
        assert.deepEqual(['<Core: Augments>', '<Core: Narration>', '<Core: Speech>'].map((h) => {
            const g = headed(h);
            return g && [g.name, g.cardinality, g.options.length];
        }), [
            ['<Core: Augments>', 'pick-one-or-more', 2],
            ['Core-Narration', 'pick-one', 4],
            ['Core-Speech', 'pick-one', 4],
        ]);
        assert.ok(!core.rows.some((/** @type {any} */ r) => r.kind === 'block' && subIds.has(r.ref)), 'no Core sub header left plain');

        // === 🎬 Genre ===: an author sub header heads a pick-many group of its Influence blocks
        const genre = sections.find((x) => x.name === '=== 🎬 Genre ===');
        const aa = genre.rows.find((/** @type {any} */ r) => r.kind === 'group' && r.header && nameOf(r.header) === '<Action & Adventure Authors>');
        assert.ok(aa);
        assert.equal(aa.cardinality, 'pick-one-or-more');
        assert.equal(aa.guessed, false);
        assert.deepEqual(aa.options.map(nameOf), [
            '✒️ Influence: Jin Yong', '✒️ Influence: Gu Long', '✒️ Influence: Kamachi Kazuma',
            '✒️ Influence: Masashi Kishimoto', '✒️ Influence: Quentin Tarantino',
        ]);
    }
    const notes = doc.source.recognizer.notes;
    assert.ok(notes.some((n) => n.includes("group 'World-Logic' spans 9 non-contiguous")));
    assert.ok(notes.some((n) => n.includes('moved sub header') && n.includes('<Vex Personas>')));
});
