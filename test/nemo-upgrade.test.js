/**
 * Round 3: an existing Nemo document whose group was headed by its own first
 * member (pre-round-3 import rule) upgrades on load: the former heading
 * becomes options[0] (same identifier, so every loadout/playstyle/override bit
 * carries over), and the group gets a synthesized comment-only default
 * heading (`pmh-…`), ON in every root, absent from playstyles and overrides.
 * The fixture `dev/fixtures/native/nemo-adjacent-pre-r3.json` was generated
 * once on 7d09262 (the pre-round-3 code) and is never regenerated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upgradeDoc, validateDoc } from '../shared/schema.js';
import { compile } from '../shared/compile.js';
import { collectGroups, isCommentOnly } from '../shared/groups.js';
import { flattenSeq } from '../shared/outline.js';
import { Store } from '../plugin/store.js';

const REPO = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(REPO, 'dev/fixtures/native/nemo-adjacent-pre-r3.json');
const loadOld = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const idOf = (/** @type {any} */ l) => l?.ref ?? l?.identifier ?? null;
const PMH = /^pmh-[0-9a-f]{8}$/;
const M = { name: 'M', tunings: { default: {} }, defaultTuning: 'default' };

/** [name, header id, option ids] per group */
const shape = (/** @type {any} */ doc) => collectGroups(doc).map((g) => [g.name, idOf(g.header), g.options.map(idOf)]);

/**
 * The text a compile sends: contents of enabled prompts in prompt_order
 * order, comment-only prompts dropped (they resolve to nothing in ST), plus
 * the ids of the dropped comment-only enabled prompts.
 */
function sent(/** @type {any} */ doc, /** @type {string} */ lid, /** @type {any} */ model = null) {
    const { compiled } = compile(doc, model, {}, lid);
    const byId = new Map(compiled.prompts.map((/** @type {any} */ p) => [p.identifier, p]));
    /** @type {string[]} */
    const text = [];
    /** @type {string[]} */
    const silent = [];
    for (const o of compiled.prompt_order[0].order) {
        if (!o.enabled) continue;
        const content = String(byId.get(o.identifier)?.content ?? '');
        if (isCommentOnly(content)) silent.push(o.identifier);
        else text.push(content);
    }
    return { text: text.join('\n---\n'), silent };
}

test('fixture is the pre-round-3 shape: Q and R headed by their first members', () => {
    const old = loadOld();
    assert.equal(old.source.recognizer.kind, 'nemo');
    assert.deepEqual(shape(old), [
        ['P', null, ['p1', 'p2']],
        ['Q', 'q1', ['q2', 'q3']],
        ['R', 'r1', ['r2']],
        ['S', null, ['s1', 's2']],
    ]);
});

test('upgradeDoc: former heading -> options[0], synthesized comment-only heading, bits carried over', () => {
    const old = loadOld();
    const doc = upgradeDoc(structuredClone(old));
    const groups = collectGroups(doc);
    const [p, q, r, s] = groups;
    assert.equal(p.header, null);
    assert.equal(s.header, null);
    for (const [g, name, opts] of /** @type {[any, string, string[]][]} */ ([[q, 'Q', ['q1', 'q2', 'q3']], [r, 'R', ['r1', 'r2']]])) {
        const hid = idOf(g.header);
        assert.match(hid, PMH, name);
        assert.equal(g.header.kind, 'block');
        assert.equal(g.key, `grp:${g.header.key}`, 'group key follows the new heading key');
        assert.deepEqual(g.options.map(idOf), opts, `${name}: former heading is options[0], same identifier`);
        assert.equal(g.name, name);
        assert.equal(g.cardinality, 'pick-one');
        const block = doc.blocks[hid];
        assert.deepEqual(block, {
            identifier: hid, name, content: `{{// ${name} }}{{trim}}`, role: 'system',
            fields: { system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false },
            notes: '',
        });
        assert.equal(isCommentOnly(block.content), true);
    }
    const qh = idOf(q.header);
    const rh = idOf(r.header);
    assert.notEqual(qh, rh);
    // every root: old bits unchanged + the new headings ON
    for (const [lid, l] of Object.entries(/** @type {Record<string, any>} */ (doc.loadouts))) {
        const was = old.loadouts[lid];
        if (l.kind === 'root') {
            assert.deepEqual(l.enabled, { ...was.enabled, [qh]: true, [rh]: true }, lid);
        } else {
            assert.deepEqual(l.enabled, was.enabled, `${lid}: playstyle untouched`);
        }
        assert.deepEqual(l.overrides, was.overrides, `${lid}: overrides untouched`);
    }
    // prompt order: original ids unchanged, headings right before their groups
    assert.deepEqual(flattenSeq(doc.sequences[0].rows).map((e) => idOf(e.leaf)),
        ['H', 'p1', 'p2', qh, 'q1', 'q2', 'q3', rh, 'r1', 'r2', 'z', 's1', 's2']);
    const notes = doc.source.recognizer.notes;
    assert.ok(notes.includes("upgrade: group 'Q' got a default heading; its former heading 'Q one' is now an option"), notes.join(' | '));
    assert.ok(notes.includes("upgrade: group 'R' got a default heading; its former heading 'R one' is now an option"), notes.join(' | '));
    assert.deepEqual(validateDoc(doc), []);
});

test('upgradeDoc is idempotent', () => {
    const once = upgradeDoc(structuredClone(loadOld()));
    const twice = upgradeDoc(structuredClone(once));
    assert.deepEqual(twice, once);
});

test('upgradeDoc: the sent text is unchanged for every loadout and the override; only the new headings are extra silent prompts', () => {
    const old = loadOld();
    const doc = upgradeDoc(structuredClone(old));
    const [, q, r] = collectGroups(doc);
    const newIds = [idOf(q.header), idOf(r.header)];
    for (const lid of Object.keys(old.loadouts)) {
        for (const model of [null, M]) {
            const before = sent(old, lid, model);
            const after = sent(doc, lid, model);
            const label = `${lid}/${model?.name ?? '-'}`;
            assert.equal(after.text, before.text, label);
            assert.deepEqual(after.silent.filter((id) => !before.silent.includes(id)), newIds, label);
        }
    }
});

test('upgradeDoc leaves alone: a sub-header-headed pick-one group, a header tagged section-header, a non-Nemo doc', () => {
    const SUB = '\n{{// @category V }}\n{{// @section-header true }}\n{{// @header <Vex> }}{{trim}}\n';
    const mk = (/** @type {string} */ kind, /** @type {string} */ hContent) => {
        const now = new Date(0).toISOString();
        const B = (/** @type {string} */ id, /** @type {string} */ c) => ({ identifier: id, name: id, content: c, role: 'system', fields: {}, notes: '' });
        return {
            format: 'st-preset-manager/library', version: 1, id: 'x', name: 'x', tags: [], notes: '', settings: {},
            source: { recognizer: { kind, notes: [] } }, createdAt: now, updatedAt: now, rev: 1,
            markers: [],
            blocks: { h: B('h', hContent), a: B('a', '{{// @mutual-exclusive-group V }}\na'), b: B('b', '{{// @mutual-exclusive-group V }}\nb') },
            sequences: [{ character_id: 100001, rows: [
                { kind: 'group', key: 'grp:k-h', name: 'V', cardinality: 'pick-one', guessed: false,
                    header: { kind: 'block', ref: 'h', key: 'k-h' }, options: [{ kind: 'block', ref: 'a', key: 'k-a' }, { kind: 'block', ref: 'b', key: 'k-b' }] },
            ] }],
            loadouts: { L: { id: 'L', name: 'L', notes: '', kind: 'root', parent: null, enabled: { h: true, a: true, b: false }, overrides: {} } },
            activeLoadoutId: 'L',
        };
    };
    for (const [kind, content] of [
        ['nemo', SUB],
        ['nemo', `${SUB}{{// @mutual-exclusive-group V }}`],
        ['ff5', '{{// @mutual-exclusive-group V }}\nh'],
        ['sola3', '{{// @mutual-exclusive-group V }}\nh'],
    ]) {
        const doc = mk(kind, content);
        const snap = structuredClone(doc);
        upgradeDoc(doc);
        assert.deepEqual(doc, snap, `${kind}: ${JSON.stringify(content)}`);
    }
    // a pick-many group headed by a tagged member is not a former first-member heading either
    const many = mk('nemo', '{{// @mutual-exclusive-group V }}\nh');
    many.sequences[0].rows[0].cardinality = 'pick-one-or-more';
    const snap = structuredClone(many);
    assert.deepEqual(upgradeDoc(many), snap);
    // ...but the same shape as pick-one IS upgraded
    const yes = upgradeDoc(mk('nemo', '{{// @mutual-exclusive-group V }}\nh'));
    assert.deepEqual(collectGroups(yes)[0].options.map(idOf), ['h', 'a', 'b']);
    assert.match(idOf(collectGroups(yes)[0].header), PMH);
});

test('store: a pre-round-3 file upgrades at boot; the first save keeps the old shape in a "before upgrade" revision', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-nemo-upg-'));
    const old = loadOld();
    fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'presets', `${old.name}.json`), JSON.stringify(old, null, 2));
    const store = new Store(root);
    await store.init();
    const doc = store.getPreset(old.id);
    assert.ok(doc, 'loaded');
    assert.deepEqual(shape(doc).map(([n, h, o]) => [n, h === null ? null : PMH.test(h), o]), [
        ['P', null, ['p1', 'p2']],
        ['Q', true, ['q1', 'q2', 'q3']],
        ['R', true, ['r1', 'r2']],
        ['S', null, ['s1', 's2']],
    ]);
    const saved = await store.savePreset(structuredClone(doc));
    const revs = store.listRevisions(old.id);
    const r = revs.find((x) => x.label === 'before upgrade');
    assert.ok(r, `labels ${JSON.stringify(revs.map((x) => x.label))}`);
    const snap = store.getRevision(old.id, r.rev);
    const snapDoc = snap.doc ?? snap;
    assert.deepEqual(shape(snapDoc), shape(old), 'the revision keeps the old heading');
    assert.deepEqual(shape(saved), shape(doc));
});

test('store: a native upload of the pre-round-3 fixture is upgraded too', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-nemo-upg2-'));
    const store = new Store(root);
    await store.init();
    const doc = await store.importPreset({ native: loadOld() });
    const [, q, r] = collectGroups(doc);
    assert.deepEqual(q.options.map(idOf), ['q1', 'q2', 'q3']);
    assert.deepEqual(r.options.map(idOf), ['r1', 'r2']);
    assert.match(idOf(q.header), PMH);
    assert.deepEqual(validateDoc(doc), []);
});

// ----------------------------------------------------- heading-semantics marker

import { applyDocOp } from '../shared/docops.js';
import { deriveStructure } from '../shared/outline.js';
import { HEADING_SEMANTICS } from '../shared/headings.js';
import { Store as Store2 } from '../plugin/store.js';

/**
 * A round-3 Nemo document whose Q group was dissolved and re-created with
 * "Make group from selection" (createGroup) using the TAGGED first block q1
 * as the heading, then heading + one option enabled: valid under
 * heading-not-a-choice, and it must survive every upgrade path unchanged.
 * Returns { doc, qKey }.
 */
function postRound3UserHeading() {
    const doc = upgradeDoc(structuredClone(loadOld()));
    deriveStructure(doc);
    // dissolve Q: q1, q2, q3 become plain items again
    const qKey = collectGroups(doc).find((g) => g.name === 'Q').key;
    applyDocOp(doc, 'dissolveGroup', { key: qKey });
    // Make group from selection: q1 is the heading, q2 the option (adjacent)
    const flat = (/** @type {any} */ d) => {
        const out = /** @type {any[]} */ ([]);
        const walk = (/** @type {any[]} */ rows) => {
            for (const r of rows ?? []) {
                if (r.kind === 'group') { out.push({ id: null, leaf: r.header, rank: 'group' }); for (const o of r.options ?? []) out.push({ id: null, leaf: o, rank: 'option' }); }
                else if (r.kind === 'section') walk(r.rows);
                else out.push({ leaf: r, rank: 'item' });
            }
        };
        walk(d.sequences[0].rows);
        return out;
    };
    const q1 = flat(doc).find((e) => idOf(e.leaf) === 'q1');
    const q2 = flat(doc).find((e) => idOf(e.leaf) === 'q2');
    applyDocOp(doc, 'createGroup', { headerKey: q1.leaf.key, keys: [q2.leaf.key], cardinality: 'pick-one' });
    // heading + one option on (valid under heading-not-a-choice)
    applyDocOp(doc, 'toggle', { identifier: 'q1', value: true });
    applyDocOp(doc, 'toggle', { identifier: 'q2', value: true });
    return { doc, qKey };
}

test('a post-round-3 user heading keeps its text through upgradeDoc and compiles', () => {
    const { doc } = postRound3UserHeading();
    assert.equal(doc.source.headingSemantics, HEADING_SEMANTICS, 'the ops stamped the marker');
    assert.deepEqual(validateDoc(doc), []);
    const textBefore = sent(doc, doc.activeLoadoutId).text;
    assert.ok(textBefore.includes('q2 text'), 'q2 text is sent');
    assert.ok(textBefore.includes('q1 text'), 'the heading q1 still sends its text');

    const again = upgradeDoc(structuredClone(doc));
    assert.deepEqual(again, doc, 'upgradeDoc is a no-op on a marked doc');
    const q = collectGroups(again).find((g) => idOf(g.header) === 'q1');
    assert.equal(idOf(q.header), 'q1', 'q1 is still the heading');
    assert.deepEqual(q.options.map(idOf), ['q2'], 'options unchanged (q3 stays a plain item after the group)');
    assert.equal(sent(again, again.activeLoadoutId).text, textBefore, 'sent text unchanged');
});

test('a revision of the post-round-3 heading restores unchanged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-hsmark-'));
    const store = new Store2(root);
    await store.init();
    const { doc } = postRound3UserHeading();
    await store.importPreset({ native: doc });
    const stored = store.getPreset(doc.id);
    assert.equal(idOf(collectGroups(stored).find((g) => idOf(g.header) === 'q1').header), 'q1', 'stored with q1 as heading');
    await store.snapshotRevision(doc.id, 'user heading');
    const restored = await store.restoreRevision(doc.id, 1);
    const q = collectGroups(restored.doc).find((g) => idOf(g.header) === 'q1');
    assert.equal(idOf(q.header), 'q1', 'q1 survived the restore');
    assert.deepEqual(q.options.map(idOf), ['q2']);
    assert.equal(restored.doc.source.headingSemantics, HEADING_SEMANTICS);
    assert.deepEqual(validateDoc(restored.doc), []);
});

test('a legacy unmarked Nemo doc still migrates, idempotently, and carries the marker afterwards', () => {
    const once = upgradeDoc(structuredClone(loadOld()));
    assert.equal(once.source.headingSemantics, HEADING_SEMANTICS, 'the upgrade stamps the marker');
    const shape1 = JSON.stringify(collectGroups(once).map((g) => [g.name, idOf(g.header), g.options.map(idOf)]));
    const twice = upgradeDoc(structuredClone(once));
    assert.deepEqual(twice, once, 'idempotent');
    assert.equal(JSON.stringify(collectGroups(twice).map((g) => [g.name, idOf(g.header), g.options.map(idOf)])), shape1);

    // a marker hand-stamped on a legacy-shaped doc also skips the conversion
    // (the owner declared the semantics; the shape is theirs)
    const declared = structuredClone(loadOld());
    declared.source.headingSemantics = HEADING_SEMANTICS;
    const snap = structuredClone(declared);
    assert.deepEqual(upgradeDoc(declared), snap);
});

test('validateDoc accepts the marker and rejects a foreign value', () => {
    const doc = upgradeDoc(structuredClone(loadOld()));
    assert.deepEqual(validateDoc(doc), []);
    const bad = structuredClone(doc);
    bad.source.headingSemantics = 'heading-semantics/999';
    assert.deepEqual(validateDoc(bad), ['source.headingSemantics']);
    const old = loadOld();
    assert.deepEqual(validateDoc(old), [], 'absent (legacy) is valid');
});
