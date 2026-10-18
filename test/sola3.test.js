/**
 * Round 3: the Sola V3 recognizer (`sola3`). Sections are `… ══════════`
 * rows; `[PICK 1: T]` runs of >= 2 adjacent rows are headerless pick-one
 * groups named `T`; a `[PICK 1: ↓] A` row immediately followed by a
 * `[PICK 1: ↑] B` row is a pick-one pair group named `A / B`; a lone ↓/↑ row
 * stays a plain row with a note. A tag with several runs (split by other
 * rows or a marker) is ONE linked group: its first run (even a run of 1) is
 * the headerless pick-one group, every later run's rows are its linked
 * members (`remote`), with a note naming the positions.
 * A group directly after another group gets a default comment-only heading
 * (headGroupsAfterGroups); rows never move.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { importStPreset, pickRecognizer } from '../shared/recognizers.js';
import { flattenSeq } from '../shared/outline.js';
import { validateDoc } from '../shared/schema.js';
import { Store } from '../plugin/store.js';

const REPO = path.resolve(import.meta.dirname, '..');
const REAL = path.join(REPO, 'dev/fixtures/presets', 'Sola V3 Flame.json');
const PMH = /^pmh-[0-9a-f]{8}$/;
const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;

/** [identifier, name, enabled] rows of the synthetic file, in prompt order. */
const ROWS = /** @type {[string, string, boolean][]} */ ([
    ['S00', "🧠 00. SOLA'S MIND ══════════", true],
    ['m1', '👾 Gremlin Sola [PICK 1: MIND] ', false],
    ['m2', '👑 Velvet Sola  [PICK 1: MIND] ', false],
    ['m3', '🗡️ Riot Sola [PICK 1: MIND] ', true],
    ['S01', '👁️ 01. POINT OF VIEW (POV) ══════════', true],
    ['p1', 'First-Person Present Tense [PICK 1: POV] ', false],
    ['p2', 'Second-Person Present Tense [PICK 1: POV] ', false],
    ['p3', 'Freaky Hybrid (3rd World + 2nd Touch) [PICK 1: POV] ', false],
    ['p4', 'Third-Person Past Tense [PICK 1: POV] ', false],
    ['p5', 'Third-Person Present Tense [PICK 1: POV] ', true],
    ['r1', 'He / Him [PICK 1: PRONOUN] ', false],
    ['r2', 'She / Her [PICK 1: PRONOUN] ', false],
    ['r3', 'They / Them [PICK 1: PRONOUN] ', false],
    ['S02', '📜 02. CORE FOUNDATIONS ══════════', true],
    ['dn1', '[PICK 1: ↓] Agency-Lite', true],
    ['up1', '[PICK 1: ↑] Embellished User', false],
    ['oath', 'Oath', true],
    ['dn2', '[PICK 1: ↓] Lone Down', false],
    ['prose', 'Prose Standards ', true],
    ['gr1', 'Story Grounding [PICK 1: GROUNDING] ', false],
    ['stac', 'Anti-Staccato', false],
    ['st1', 'Lean & Direct (Hemingway) [PICK 1: STYLE] ', false],
    ['st2', 'Gritty Realism (McCarthy) [PICK 1: STYLE] ', false],
    ['npc', 'Authentic NPCs', true],
    ['S09', '🗂️ 09. REASONING & MARKERS ══════════', true],
    ['chatHistory', 'Chat History', true],
    ['gr2', 'Story Grounding [PICK 1: GROUNDING] ', false],
    ['x1', 'Split [PICK 1: SPLIT] ', false],
    ['worldInfoAfter', 'World Info (after)', true],
    ['x2', 'Split again [PICK 1: SPLIT] ', false],
    ['post', 'Post-History Instructions', true],
]);
const MARKERS = new Set(['chatHistory', 'worldInfoAfter']);

/** @param {(rows: typeof ROWS) => typeof ROWS} [edit] */
function synth(edit = (r) => r) {
    const rows = edit(structuredClone(ROWS));
    return {
        temperature: 1,
        prompts: rows.map(([identifier, name]) => (MARKERS.has(identifier)
            ? { identifier, name, marker: true, system_prompt: true }
            : { identifier, name, content: `${identifier} text`, role: 'system', system_prompt: false })),
        prompt_order: [{ character_id: 100001, order: rows.map(([identifier, , enabled]) => ({ identifier, enabled })) }],
    };
}

/**
 * sections -> ['section', name, header id, rows]; groups -> ['group', name, header id|'pmh'|null, option ids, cardinality, guessed]
 * plus a 7th element, the linked member ids, when the group has `remote`; leaves -> id
 * @param {any[]} rows
 * @param {Map<string, string>} idOfKey leaf key -> identifier
 */
function shape(rows, idOfKey) {
    return rows.map((r) => {
        if (r.kind === 'section') return ['section', r.name, r.header ? identOf(r.header) : null, shape(r.rows, idOfKey)];
        if (r.kind === 'group') {
            const h = r.header ? identOf(r.header) : null;
            const g = ['group', r.name, h && PMH.test(h) ? 'pmh' : h, r.options.map(identOf), r.cardinality, r.guessed];
            if (r.remote) g.push(r.remote.map((/** @type {string} */ k) => idOfKey.get(k) ?? `?${k}`));
            return g;
        }
        return identOf(r);
    });
}
/** @param {any} doc */
const keyMap = (doc) => new Map(flattenSeq(doc.sequences[0].rows).map((e) => [e.leaf.key, identOf(e.leaf)]));

test('sola3: synthetic V3 layout -> sections, named groups, pairs, linked split tags; PRONOUN gets a default heading', () => {
    const data = synth();
    const doc = importStPreset(data, 'V3');
    assert.equal(doc.source.recognizer.kind, 'sola3');
    assert.deepEqual(shape(doc.sequences[0].rows, keyMap(doc)), [
        ['section', "🧠 00. SOLA'S MIND", 'S00', [
            ['group', 'MIND', null, ['m1', 'm2', 'm3'], 'pick-one', false],
        ]],
        ['section', '👁️ 01. POINT OF VIEW (POV)', 'S01', [
            ['group', 'POV', null, ['p1', 'p2', 'p3', 'p4', 'p5'], 'pick-one', false],
            ['group', 'PRONOUN', 'pmh', ['r1', 'r2', 'r3'], 'pick-one', false],
        ]],
        ['section', '📜 02. CORE FOUNDATIONS', 'S02', [
            ['group', 'Agency-Lite / Embellished User', null, ['dn1', 'up1'], 'pick-one', false],
            'oath', 'dn2', 'prose',
            ['group', 'GROUNDING', null, ['gr1'], 'pick-one', false, ['gr2']],
            'stac',
            ['group', 'STYLE', null, ['st1', 'st2'], 'pick-one', false],
            'npc',
        ]],
        ['section', '🗂️ 09. REASONING & MARKERS', 'S09', [
            'chatHistory', 'gr2',
            ['group', 'SPLIT', null, ['x1'], 'pick-one', false, ['x2']],
            'worldInfoAfter', 'x2', 'post',
        ]],
    ]);
    // the default heading is a comment-only block named after the group
    const pron = doc.sequences[0].rows[1].rows[1];
    const hb = doc.blocks[identOf(pron.header)];
    assert.equal(hb.name, 'PRONOUN');
    assert.equal(hb.content, '{{// PRONOUN }}{{trim}}');
    // rows never move: the original ids keep their order
    const ids = flattenSeq(doc.sequences[0].rows).map((e) => identOf(e.leaf)).filter((id) => !PMH.test(id));
    assert.deepEqual(ids, ROWS.map(([id]) => id));
    // block names never change
    assert.equal(doc.blocks.dn1.name, '[PICK 1: ↓] Agency-Lite');
    assert.equal(doc.blocks.m2.name, '👑 Velvet Sola  [PICK 1: MIND] ');
});

test('sola3: notes name the linked GROUNDING and SPLIT positions (1-based prompt order), the lone ↓ row, and summarize', () => {
    const notes = /** @type {string[]} */ (importStPreset(synth(), 'V3').source.recognizer.notes);
    const all = notes.join(' | ');
    assert.ok(notes.includes('sola3: [PICK 1: GROUNDING] members are linked across file positions #20, #27'), all);
    assert.ok(notes.includes('sola3: [PICK 1: SPLIT] members are linked across file positions #28, #30'), all);
    assert.ok(!notes.some((n) => n.includes('later feature') || n.includes('not adjacent')), all);
    assert.ok(notes.some((n) => n.startsWith('sola3: ') && n.includes('Lone Down') && n.includes('plain')), all);
    assert.ok(notes.some((n) => n.startsWith("sola3: group 'PRONOUN' directly follows group 'POV'")), all);
    assert.ok(notes.includes('sola3: 4 sections, 6 named groups, 1 pairs'), all);
});

test('sola3: a tag with three runs links every later run (runs of 2+ included) to the first', () => {
    // gr1 | stac | gr1b gr1c (a run of 2) | … | gr2: one group [gr1] + remote [gr1b, gr1c, gr2]
    const doc = importStPreset(synth((rows) => {
        const at = rows.findIndex(([id]) => id === 'st1');
        rows.splice(at, 0, ['gr1b', 'B Grounding [PICK 1: GROUNDING] ', false], ['gr1c', 'C Grounding [PICK 1: GROUNDING] ', false]);
        return rows;
    }), 'V3');
    const groups = doc.sequences[0].rows.flatMap((/** @type {any} */ s) => (s.kind === 'section' ? s.rows : [s])).filter((/** @type {any} */ r) => r.kind === 'group' && r.name === 'GROUNDING');
    assert.equal(groups.length, 1, 'one GROUNDING group, not one per run');
    const km = keyMap(doc);
    assert.deepEqual(groups[0].options.map(identOf), ['gr1']);
    assert.deepEqual(groups[0].remote.map((/** @type {string} */ k) => km.get(k)), ['gr1b', 'gr1c', 'gr2']);
    const ids = flattenSeq(doc.sequences[0].rows).map((e) => identOf(e.leaf)).filter((id) => !PMH.test(id));
    assert.ok(ids.indexOf('gr1b') > ids.indexOf('stac') && ids.indexOf('gr1c') === ids.indexOf('gr1b') + 1, 'rows never move');
});

test('sola3: a linked group with 2 members on in the file keeps its bits and gets the conflict note', () => {
    const doc = importStPreset(synth((rows) => rows.map((r) => (r[0] === 'gr1' || r[0] === 'gr2' ? [r[0], r[1], true] : r))), 'V3');
    assert.ok(doc.source.recognizer.notes.includes("sola3: group 'GROUNDING' has 2 members on in the file; pick-one keeps the last one at compile — fix in the outline"),
        doc.source.recognizer.notes.join(' | '));
});

test('sola3: the synthetic linked groups store through the Store and pass validateDoc; remote = the later row key', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-sola3-syn-'));
    const store = new Store(root);
    await store.init();
    const stored = await store.importPreset({ st: synth(), name: 'V3 synth' });
    assert.deepEqual(validateDoc(stored), []);
    const flat = flattenSeq(stored.sequences[0].rows);
    const keyOf = (/** @type {string} */ id) => flat.find((e) => identOf(e.leaf) === id)?.leaf.key;
    const all = stored.sequences[0].rows.flatMap((/** @type {any} */ s) => (s.kind === 'section' ? s.rows : [s]));
    const gr = all.find((/** @type {any} */ r) => r.kind === 'group' && r.name === 'GROUNDING');
    const sp = all.find((/** @type {any} */ r) => r.kind === 'group' && r.name === 'SPLIT');
    assert.deepEqual(gr.remote, [keyOf('gr2')]);
    assert.deepEqual(sp.remote, [keyOf('x2')]);
    assert.deepEqual(flat.map((e) => identOf(e.leaf)).filter((id) => !PMH.test(id)), ROWS.map(([id]) => id));
});

test('sola3: a lone ↑ row (no ↓ right before it) stays plain with a note', () => {
    const doc = importStPreset(synth((rows) => rows.filter(([id]) => id !== 'dn1')), 'V3');
    const core = doc.sequences[0].rows[2];
    assert.equal(core.rows[0].kind, 'block');
    assert.equal(identOf(core.rows[0]), 'up1');
    assert.ok(doc.source.recognizer.notes.some((/** @type {string} */ n) => n.startsWith('sola3: ') && n.includes('Embellished User')));
});

test('sola3: a group with 2+ members on keeps its bits and gets a note', () => {
    const doc = importStPreset(synth((rows) => rows.map((r) => (r[0] === 'm1' ? [r[0], r[1], true] : r))), 'V3');
    assert.ok(doc.source.recognizer.notes.includes("sola3: group 'MIND' has 2 members on in the file; pick-one keeps the last one at compile — fix in the outline"),
        doc.source.recognizer.notes.join(' | '));
});

test('pickRecognizer: ══ or [PICK 1: …] names -> sola3, after nemo/dem and before sola', () => {
    const byid = new Map([
        ['v3s', { identifier: 'v3s', name: '📜 02. CORE ══════════' }],
        ['v3p', { identifier: 'v3p', name: 'x [PICK 1: POV] ' }],
        ['dem', { identifier: 'dem', name: '🔻PICK: X🔻' }],
        ['sola', { identifier: 'sola', name: '━━━ S ━━━' }],
    ]);
    const row = (/** @type {string} */ ref) => ({ kind: 'block', ref, enabled: true, key: ref });
    assert.equal(pickRecognizer([row('v3s')], byid), 'sola3');
    assert.equal(pickRecognizer([row('v3p')], byid), 'sola3');
    assert.equal(pickRecognizer([row('v3s'), row('sola')], byid), 'sola3');
    assert.equal(pickRecognizer([row('dem'), row('v3s')], byid), 'dem');
    assert.equal(pickRecognizer([row('sola')], byid), 'sola');
});

test('sola3: the real Sola V3 Flame file (skips when absent)', async () => {
    if (!fs.existsSync(REAL)) return;
    const st = JSON.parse(fs.readFileSync(REAL, 'utf8'));
    const doc = importStPreset(st, 'Sola V3 Flame');
    assert.equal(doc.source.recognizer.kind, 'sola3');
    assert.deepEqual(doc.sequences.map((s) => s.character_id), [100001]);
    const notes = /** @type {string[]} */ (doc.source.recognizer.notes);
    assert.ok(notes.some((n) => n.includes('"undefined"')), notes.join(' | '));
    assert.ok(notes.includes('sola3: [PICK 1: GROUNDING] members are linked across file positions #25, #94'), notes.join(' | '));
    const rows = doc.sequences[0].rows;
    const sections = rows.filter((/** @type {any} */ r) => r.kind === 'section');
    assert.equal(sections.length, 10);
    sections.forEach((/** @type {any} */ s, i) => assert.ok(s.name.includes(`0${i}. `), s.name));
    /** @type {any[]} */
    const groups = [];
    for (const s of sections) for (const r of s.rows) if (r.kind === 'group') groups.push(r);
    const others = groups.filter((g) => g.name !== 'GROUNDING');
    assert.deepEqual(others.map((g) => [g.name, g.options.length, g.cardinality, g.guessed]), [
        ['MIND', 3, 'pick-one', false],
        ['POV', 5, 'pick-one', false],
        ['PRONOUN', 3, 'pick-one', false],
        ['Agency-Lite / Embellished User', 2, 'pick-one', false],
        ['Anti-Slop Full / Anti-Slop Lite', 2, 'pick-one', false],
        ['STYLE', 5, 'pick-one', false],
        ['NPC Dialogue Colors 🎨 / Gradient ALL The Time 🎨', 2, 'pick-one', false],
        ['Anti-Softening / Anti-Cruelty', 2, 'pick-one', false],
    ]);
    assert.ok(others.every((g) => !g.remote), 'only GROUNDING is linked');
    assert.ok(PMH.test(identOf(others[2].header)), 'PRONOUN has a default heading');
    assert.ok(groups.filter((g) => g !== others[2]).every((g) => g.header === null), 'only PRONOUN is headed');
    // the two Story Grounding rows: the first (#25) is the group's one option,
    // the second (#94) its linked member at its own position
    const grnd = groups.filter((g) => g.name === 'GROUNDING');
    assert.equal(grnd.length, 1);
    assert.deepEqual([grnd[0].options.length, grnd[0].cardinality, grnd[0].guessed, grnd[0].header], [1, 'pick-one', false, null]);
    const flat = flattenSeq(rows);
    const grounding = flat.filter((e) => /GROUNDING/.test(doc.blocks[e.leaf.ref]?.name ?? ''));
    assert.equal(grounding.length, 2);
    assert.deepEqual(grounding.map((e) => e.rank), ['option', 'item']);
    assert.equal(grounding[0].leaf, grnd[0].options[0]);
    assert.deepEqual(grnd[0].remote, [grounding[1].leaf.key]);
    // positions in the file's 100001 prompt order (1-based) are unchanged
    const order = st.prompt_order.find((/** @type {any} */ o) => o.character_id === 100001).order.map((/** @type {any} */ o) => o.identifier);
    assert.deepEqual(grounding.map((e) => order.indexOf(identOf(e.leaf)) + 1), [25, 94]);
    const at = flat.map((e) => identOf(e.leaf)).filter((id) => !PMH.test(id)).map((id) => order.indexOf(id));
    assert.ok(at.every((p, i) => p >= 0 && (i === 0 || p > at[i - 1])), 'rows keep the file order');
    // section 00's header keeps its real content
    assert.ok(doc.blocks[identOf(sections[0].header)].content.length > 4000);

    // stores through the Store and passes validateDoc
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-sola3-'));
    const store = new Store(root);
    await store.init();
    const stored = await store.importPreset({ st, name: 'Sola V3 Flame' });
    assert.deepEqual(validateDoc(stored), []);
});
