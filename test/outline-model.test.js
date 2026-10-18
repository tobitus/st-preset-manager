/**
 * ext/outline-model.js — the pure view model behind the Presets tab
 * outline (sub-phase 2b): doc -> render tree with switch types and pick-one
 * conflict flags, keyboard mapping, pick-one/none click -> ops, drag ->
 * moveLeaf op, leaf lookup for the editor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importStPreset } from '../shared/recognizers.js';
import { deriveStructure, promote } from '../shared/outline.js';
import { ensureDefaultLoadout } from '../plugin/store.js';
import { buildOutline, keyAction, pickOneOps, dragOps, findLeaf, leadingRun, linkSelectionOp } from '../ext/outline-model.js';

const REPO = path.resolve(import.meta.dirname, '..');

function ffDoc() {
    const st = JSON.parse(fs.readFileSync(path.join(REPO, 'dev/fixtures/presets', 'Freaky Frankenstein 5.4 Internal States (2).json'), 'utf8'));
    const doc = importStPreset(st, 'FF54');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    return doc;
}

/** small hand-built doc: section with an item and a headerless pick-one group */
function tinyDoc() {
    return {
        blocks: {
            h: { identifier: 'h', name: 'Heading', content: '', role: 'system', fields: {}, notes: '' },
            a: { identifier: 'a', name: 'A', content: 'aa', role: 'system', fields: {}, notes: 'na' },
            b: { identifier: 'b', name: '', content: 'bb', role: 'user', fields: {}, notes: '' },
            c: { identifier: 'c', name: 'C', content: 'cc', role: 'system', fields: {}, notes: '' },
        },
        markers: [{ identifier: 'chatHistory', prompt: { identifier: 'chatHistory', marker: true } }],
        sequences: [{
            character_id: 100001,
            rows: [
                { kind: 'marker', ref: 'chatHistory', key: 'k-m' },
                { kind: 'ghost', identifier: 'gone', key: 'k-g' },
                {
                    kind: 'section', key: 'sec:k-h', name: 'Sec', header: { kind: 'block', ref: 'h', key: 'k-h' },
                    rows: [
                        { kind: 'block', ref: 'a', key: 'k-a' },
                        {
                            kind: 'group', key: 'grp:k-b', name: 'G', cardinality: 'pick-one', guessed: false, header: null,
                            options: [{ kind: 'block', ref: 'b', key: 'k-b' }, { kind: 'block', ref: 'c', key: 'k-c' }],
                        },
                    ],
                },
            ],
        }],
        loadouts: {
            L1: { id: 'L1', name: 'One', notes: '', enabled: { chatHistory: true, gone: false, h: true, a: false, b: true, c: true }, overrides: {} },
            L2: { id: 'L2', name: 'Two', notes: '', enabled: { chatHistory: false, gone: true, h: false, a: true, b: false, c: false }, overrides: {} },
        },
        activeLoadoutId: 'L1',
    };
}

// ------------------------------------------------------------ buildOutline

test('buildOutline: FF top level = 2 items, 6 groups, 8 markers, 2 groups; one sequence', () => {
    const doc = ffDoc();
    const out = buildOutline(doc);
    assert.equal(out.sequences.length, doc.sequences.length);
    const nodes = out.sequences[0].nodes;
    assert.equal(out.sequences[0].characterId, 100001);
    assert.deepEqual(nodes.map((n) => n.type), [
        'leaf', 'leaf', 'group', 'group', 'group', 'group', 'group', 'group',
        'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'group', 'group',
    ]);
    assert.equal(nodes[0].name, doc.blocks[doc.sequences[0].rows[0].ref].name);
    assert.equal(nodes[8].leafKind, 'marker');
    assert.equal(nodes[8].switchType, 'readonly');
    assert.equal(nodes[8].name, 'worldInfoBefore');
});

test('buildOutline: pick-one group -> radios on options, checkbox heading; pick-one-or-more -> checkboxes', () => {
    const doc = ffDoc();
    const nodes = buildOutline(doc).sequences[0].nodes;
    const pov = nodes.find((n) => n.type === 'group' && /POV/.test(n.name));
    assert.equal(pov.pickOne, true);
    assert.equal(pov.cardinality, 'pick-one');
    assert.equal(pov.key, doc.sequences[0].rows.find((/** @type {any} */ r) => /POV/.test(r.name ?? '')).key);
    assert.equal(pov.header.switchType, 'checkbox', 'the heading is never a choice');
    assert.deepEqual(pov.options.map((o) => o.switchType), ['radio', 'radio', 'radio', 'radio']);
    assert.deepEqual(pov.options.map((o) => o.enabled), [false, false, false, true]); // Hybrid on
    assert.equal(pov.conflict, false);
    assert.equal(pov.noneOn, false);
    const custom = nodes.find((n) => n.type === 'group' && /custom toggles/.test(n.name));
    assert.equal(custom.pickOne, false);
    assert.equal(custom.header.switchType, 'checkbox');
    assert.ok(custom.options.every((o) => o.switchType === 'checkbox'));
    assert.equal(custom.conflict, false, 'pick-one-or-more never conflicts');
    assert.equal(custom.noneOn, false);
    // ordinary top-level block
    assert.equal(nodes[0].switchType, 'checkbox');
    assert.equal(nodes[0].enabled, true);
});

test('buildOutline: conflict = pick-one with 2+ options on (the heading never counts); nothing is collapsed', () => {
    const doc = tinyDoc();
    const snapshot = structuredClone(doc);
    const out = buildOutline(doc);
    const sec = out.sequences[0].nodes[2];
    assert.equal(sec.type, 'section');
    assert.equal(sec.name, 'Heading', 'a headed section shows its heading block name (the stored "Sec" is stale)');
    assert.equal(sec.header.identifier, 'h');
    assert.equal(sec.header.switchType, 'checkbox');
    const grp = sec.nodes[1];
    assert.equal(grp.type, 'group');
    assert.equal(grp.header, null);
    assert.equal(grp.conflict, true, 'b and c both on in a pick-one group');
    assert.deepEqual(grp.options.map((o) => o.enabled), [true, true], 'the model shows both, never collapses');
    assert.deepEqual(doc, snapshot, 'buildOutline does not mutate the document');
    // a heading is never a member, whatever it sends: FF's comment-only POV
    // heading ({{//Keep toggled off}}{{trim}}) and a heading with text alike
    const ff = ffDoc();
    const povRow = ff.sequences[0].rows.find((/** @type {any} */ r) => /POV/.test(r.name ?? ''));
    ff.loadouts[ff.activeLoadoutId].enabled[povRow.header.ref] = true; // heading + Hybrid on
    const povOf = () => buildOutline(ff).sequences[0].nodes.find((n) => n.type === 'group' && /POV/.test(n.name));
    assert.equal(povOf().header.commentOnly, true);
    assert.equal(povOf().conflict, false);
    ff.blocks[povRow.header.ref].content = 'Pick one POV.';
    assert.equal(povOf().header.commentOnly, false);
    assert.equal(povOf().header.switchType, 'checkbox');
    assert.equal(povOf().conflict, false);
});

test('buildOutline: loadout argument selects whose bits are shown; default = activeLoadoutId', () => {
    const doc = tinyDoc();
    const one = buildOutline(doc).sequences[0].nodes;
    const two = buildOutline(doc, 'L2').sequences[0].nodes;
    assert.equal(one[0].enabled, true);
    assert.equal(two[0].enabled, false);
    const grp2 = two[2].nodes[1];
    assert.equal(grp2.conflict, false);
    assert.equal(grp2.noneOn, true, 'pick-one with nothing on -> the none radio is on');
});

test('buildOutline: leaf fields — key, identifier, kind, name fallbacks, ghost is a checkbox', () => {
    const nodes = buildOutline(tinyDoc()).sequences[0].nodes;
    assert.deepEqual(nodes[0], { type: 'leaf', key: 'k-m', identifier: 'chatHistory', leafKind: 'marker', name: 'chatHistory', enabled: true, switchType: 'readonly', hasContent: false, commentOnly: false, pos: 1, inherited: false, explicit: false, linkedTo: null });
    assert.deepEqual(nodes[1], { type: 'leaf', key: 'k-g', identifier: 'gone', leafKind: 'ghost', name: 'gone', enabled: false, switchType: 'checkbox', hasContent: false, commentOnly: false, pos: 2, inherited: false, explicit: false, linkedTo: null });
    const b = nodes[2].nodes[1].options[0];
    assert.equal(b.name, 'b', 'empty block name falls back to the identifier');
    assert.equal(b.switchType, 'radio');
    assert.equal(nodes[2].key, 'sec:k-h');
    assert.equal(nodes[2].nodes[1].key, 'grp:k-b');
});

test('buildOutline: a promoted section on FF still renders every leaf exactly once', () => {
    const doc = ffDoc();
    const tpKey = doc.sequences[0].rows[1].key; // Time and Place: item -> group -> section (by LEAF key)
    promote(doc, tpKey);
    promote(doc, tpKey);
    const idents = [];
    const walk = (/** @type {any[]} */ nodes) => {
        for (const n of nodes) {
            if (n.type === 'leaf') idents.push(n.identifier);
            else {
                if (n.header) idents.push(n.header.identifier);
                walk(n.type === 'group' ? n.options : n.nodes);
            }
        }
    };
    walk(buildOutline(doc).sequences[0].nodes);
    assert.equal(idents.length, 57);
    assert.equal(new Set(idents).size, 57);
});

// ------------------------------------------------------------ keyAction

test('keyAction: Tab promote, Shift+Tab demote, Alt+Up/Down move; everything else null', () => {
    const k = (/** @type {any} */ o) => keyAction({ key: '', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o });
    assert.deepEqual(k({ key: 'Tab' }), { op: 'promote' });
    assert.deepEqual(k({ key: 'Tab', shiftKey: true }), { op: 'demote' });
    assert.deepEqual(k({ key: 'ArrowUp', altKey: true }), { op: 'moveLeaf', delta: -1 });
    assert.deepEqual(k({ key: 'ArrowDown', altKey: true }), { op: 'moveLeaf', delta: 1 });
    assert.equal(k({ key: 'ArrowUp' }), null);
    assert.equal(k({ key: 'Tab', ctrlKey: true }), null);
    assert.equal(k({ key: 'Tab', altKey: true }), null);
    assert.equal(k({ key: 'Tab', metaKey: true }), null);
    assert.equal(k({ key: 'ArrowDown', altKey: true, ctrlKey: true }), null);
    assert.equal(k({ key: 'a' }), null);
});

test('keyAction: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo; with Alt, or other ctrl keys, null', () => {
    const k = (/** @type {any} */ o) => keyAction({ key: '', code: '', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o });
    assert.deepEqual(k({ key: 'z', code: 'KeyZ', ctrlKey: true }), { op: 'undo' });
    assert.deepEqual(k({ key: 'z', code: 'KeyZ', metaKey: true }), { op: 'undo' });
    assert.deepEqual(k({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), { op: 'redo' });
    assert.deepEqual(k({ key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true }), { op: 'redo' });
    assert.deepEqual(k({ key: 'z', code: 'KeyW', ctrlKey: true }), { op: 'undo' }, 'by produced key (AZERTY z)');
    assert.equal(k({ key: 'z', code: 'KeyZ' }), null, 'bare z is typing');
    assert.equal(k({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true }), null);
    assert.equal(k({ key: 'y', code: 'KeyY', ctrlKey: true }), null);
    assert.equal(k({ key: 'Tab', ctrlKey: true }), null);
});

// ------------------------------------------------------------ pickOneOps

test('pickOneOps: choosing a member -> one setGroup; none -> toggles off every member that is on', () => {
    const nodes = buildOutline(tinyDoc()).sequences[0].nodes;
    const grp = nodes[2].nodes[1];
    assert.deepEqual(pickOneOps(grp, 'c'), [{ op: 'setGroup', group: 'grp:k-b', identifier: 'c' }]);
    assert.deepEqual(pickOneOps(grp, null), [
        { op: 'toggle', identifier: 'b', value: false },
        { op: 'toggle', identifier: 'c', value: false },
    ]);
    const ff = ffDoc();
    const povRow = ff.sequences[0].rows.find((/** @type {any} */ r) => /POV/.test(r.name ?? ''));
    ff.loadouts[ff.activeLoadoutId].enabled[povRow.header.ref] = true;
    const povOf = () => buildOutline(ff).sequences[0].nodes.find((n) => n.type === 'group' && /POV/.test(n.name));
    const hybrid = povRow.options[3].ref;
    assert.deepEqual(pickOneOps(povOf(), null), [
        { op: 'toggle', identifier: hybrid, value: false },
    ], 'a comment-only heading is left alone');
    ff.blocks[povRow.header.ref].content = 'Pick one POV.';
    assert.deepEqual(pickOneOps(povOf(), null), [
        { op: 'toggle', identifier: hybrid, value: false },
    ], 'a heading that sends text is left alone too: options only');
    const none = buildOutline(tinyDoc(), 'L2').sequences[0].nodes[2].nodes[1];
    assert.deepEqual(pickOneOps(none, null), [], 'already none: no ops');
});

// ------------------------------------------------------------ dragOps

test('dragOps: index difference in the sibling list -> one moveLeaf; unchanged -> none', () => {
    assert.deepEqual(dragOps(['a', 'b', 'c', 'd'], ['b', 'c', 'a', 'd'], 'a'), [{ op: 'moveLeaf', key: 'a', delta: 2 }]);
    assert.deepEqual(dragOps(['a', 'b', 'c', 'd'], ['a', 'd', 'b', 'c'], 'd'), [{ op: 'moveLeaf', key: 'd', delta: -2 }]);
    assert.deepEqual(dragOps(['a', 'b'], ['a', 'b'], 'b'), []);
    // headerless groups sit in the list as null placeholders: they count as one sibling
    assert.deepEqual(dragOps(['a', null, 'c'], [null, 'c', 'a'], 'a'), [{ op: 'moveLeaf', key: 'a', delta: 2 }]);
    assert.throws(() => dragOps(['a', 'b'], ['b', 'a'], 'x'));
    assert.throws(() => dragOps(['a', null], [null, 'a'], null));
});

// ------------------------------------------------------------ findLeaf

test('findLeaf: finds items, options and headings by key with their block; null when absent', () => {
    const doc = tinyDoc();
    const h = findLeaf(doc, 'k-h');
    assert.equal(h.identifier, 'h');
    assert.equal(h.rank, 'section');
    assert.equal(h.block, doc.blocks.h);
    assert.equal(h.marker, false);
    const b = findLeaf(doc, 'k-b');
    assert.equal(b.rank, 'option');
    assert.equal(b.block.content, 'bb');
    const m = findLeaf(doc, 'k-m');
    assert.equal(m.marker, true);
    assert.equal(m.block, null);
    assert.equal(m.rank, 'item');
    const g = findLeaf(doc, 'k-g');
    assert.equal(g.identifier, 'gone');
    assert.equal(g.block, null);
    assert.equal(findLeaf(doc, 'nope'), null);
    const ff = ffDoc();
    const povRow = ff.sequences[0].rows.find((/** @type {any} */ r) => /POV/.test(r.name ?? ''));
    assert.equal(findLeaf(ff, povRow.header.key).rank, 'group');
});

// ------------------------------------------- linked groups (displaced modal selection)

/**
 * A{h; o1} pick-one, remote [r1, r2]; x1; chatHistory; r1; B{bh; p1, r2} pick-many.
 * Flat positions: h1 o1 2 x1 3 chatHistory 4 r1 5 bh 6 p1 7 r2 8.
 * Loadout L1: o1 and r1 on (a stored conflict across positions).
 * @returns {any}
 */
function linkedDoc() {
    const B = (/** @type {string} */ id) => ({ identifier: id, name: id.toUpperCase(), content: id, role: 'system', fields: {}, notes: '' });
    const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
    return {
        blocks: Object.fromEntries(['h', 'o1', 'x1', 'r1', 'bh', 'p1', 'r2'].map((id) => [id, B(id)])),
        markers: [{ identifier: 'chatHistory', prompt: { identifier: 'chatHistory', marker: true } }],
        sequences: [{ character_id: 100001, rows: [
            { kind: 'group', key: 'grp:k-h', name: 'A', cardinality: 'pick-one', guessed: false, header: leaf('h'), options: [leaf('o1')], remote: ['k-r1', 'k-r2'] },
            leaf('x1'),
            { kind: 'marker', ref: 'chatHistory', key: 'k-chatHistory' },
            leaf('r1'),
            { kind: 'group', key: 'grp:k-bh', name: 'B', cardinality: 'pick-one-or-more', guessed: false, header: leaf('bh'), options: [leaf('p1'), leaf('r2')] },
        ] }],
        loadouts: {
            L1: { id: 'L1', name: 'One', notes: '', kind: 'root', parent: null, enabled: { h: false, o1: true, x1: false, chatHistory: true, r1: true, bh: false, p1: false, r2: false }, overrides: {} },
        },
        activeLoadoutId: 'L1',
    };
}

test('linked: GroupNode.remote holds the linked leaves with their own positions and radios; conflict counts them', () => {
    const doc = linkedDoc();
    const nodes = buildOutline(doc).sequences[0].nodes;
    const a = /** @type {any} */ (nodes[0]);
    assert.deepEqual(a.remote.map((/** @type {any} */ n) => n.identifier), ['r1', 'r2']);
    assert.deepEqual(a.remote.map((/** @type {any} */ n) => n.pos), [5, 8]);
    assert.deepEqual(a.remote.map((/** @type {any} */ n) => n.switchType), ['radio', 'radio']);
    assert.deepEqual(a.remote.map((/** @type {any} */ n) => n.enabled), [true, false]);
    assert.equal(a.remote[0].type, 'leaf');
    assert.equal(a.conflict, true, 'o1 and r1 both on');
    assert.equal(a.noneOn, false);
    doc.loadouts.L1.enabled.r1 = false;
    const a2 = /** @type {any} */ (buildOutline(doc).sequences[0].nodes[0]);
    assert.equal(a2.conflict, false);
    doc.loadouts.L1.enabled.o1 = false;
    doc.loadouts.L1.enabled.r2 = true;
    const a3 = /** @type {any} */ (buildOutline(doc).sequences[0].nodes[0]);
    assert.equal(a3.noneOn, false, 'a linked member on counts');
    doc.loadouts.L1.enabled.r2 = false;
    assert.equal(/** @type {any} */ (buildOutline(doc).sequences[0].nodes[0]).noneOn, true);
});

test('linked: the leaf at its own position carries linkedTo and a radio (its own group may be pick-many)', () => {
    const nodes = /** @type {any[]} */ (buildOutline(linkedDoc()).sequences[0].nodes);
    const r1 = nodes[3];
    assert.equal(r1.identifier, 'r1');
    assert.deepEqual(r1.linkedTo, { key: 'grp:k-h', name: 'H', pickOne: true });
    assert.equal(r1.switchType, 'radio');
    const b = nodes[4];
    assert.deepEqual(b.options.map((/** @type {any} */ o) => o.switchType), ['checkbox', 'radio']);
    assert.deepEqual(b.options.map((/** @type {any} */ o) => o.linkedTo?.key ?? null), [null, 'grp:k-h']);
    assert.equal(nodes[0].options[0].linkedTo, null, 'an ordinary option is not linked');
    assert.equal(nodes[1].linkedTo, null);
    assert.equal(nodes[1].switchType, 'checkbox');
    assert.equal(nodes[2].switchType, 'readonly');
});

test('linked: a pick-many linked group renders checkboxes at both places', () => {
    const doc = linkedDoc();
    doc.sequences[0].rows[0].cardinality = 'pick-one-or-more';
    const nodes = /** @type {any[]} */ (buildOutline(doc).sequences[0].nodes);
    assert.deepEqual(nodes[0].remote.map((/** @type {any} */ n) => n.switchType), ['checkbox', 'checkbox']);
    assert.equal(nodes[3].switchType, 'checkbox');
    assert.deepEqual(nodes[3].linkedTo, { key: 'grp:k-h', name: 'H', pickOne: false });
    assert.equal(nodes[0].conflict, false);
});

test('linked: pickOneOps — a linked member is a setGroup choice; "none" turns off options and linked members', () => {
    const a = /** @type {any} */ (buildOutline(linkedDoc()).sequences[0].nodes[0]);
    assert.deepEqual(pickOneOps(a, 'r1'), [{ op: 'setGroup', group: 'grp:k-h', identifier: 'r1' }]);
    assert.deepEqual(pickOneOps(a, null, 'L1'), [
        { op: 'toggle', identifier: 'o1', value: false, loadoutId: 'L1' },
        { op: 'toggle', identifier: 'r1', value: false, loadoutId: 'L1' },
    ]);
});

test('linked: a document without remote renders remote: [] on every group and linkedTo: null on every leaf', () => {
    const doc = tinyDoc();
    /** @param {any} n */
    const visit = (n) => {
        if (n.type === 'group') {
            assert.deepEqual(n.remote, []);
            if (n.header) visit(n.header);
            n.options.forEach(visit);
        } else if (n.type === 'section') {
            if (n.header) visit(n.header);
            n.nodes.forEach(visit);
        } else {
            assert.equal(n.linkedTo, null);
        }
    };
    for (const seq of buildOutline(doc).sequences) seq.nodes.forEach(visit);
    for (const seq of buildOutline(ffDoc()).sequences) seq.nodes.forEach(visit);
});

test('leadingRun: splits a selection into the first adjacent run and the later rows, in document order', () => {
    const doc = linkedDoc();
    assert.deepEqual(leadingRun(doc, ['k-x1', 'k-r1', 'k-o1']), { leading: ['k-o1', 'k-x1'], later: ['k-r1'] });
    assert.deepEqual(leadingRun(doc, new Set(['k-x1', 'k-p1', 'k-r2'])), { leading: ['k-x1'], later: ['k-p1', 'k-r2'] });
    assert.deepEqual(leadingRun(doc, ['k-x1', 'k-chatHistory']), { leading: ['k-x1', 'k-chatHistory'], later: [] });
    assert.deepEqual(leadingRun(doc, []), { leading: [], later: [] });
});

test('linkSelectionOp: one group row plus leaf rows -> one linkToGroup op; anything else is refused with a reason', () => {
    const doc = linkedDoc();
    assert.deepEqual(linkSelectionOp(doc, ['k-h', 'k-x1']), { op: { op: 'linkToGroup', key: 'grp:k-h', keys: ['k-x1'] }, refuse: null });
    assert.deepEqual(linkSelectionOp(doc, new Set(['k-p1', 'grp:k-h', 'k-x1'])), { op: { op: 'linkToGroup', key: 'grp:k-h', keys: ['k-x1', 'k-p1'] }, refuse: null });
    const REFUSE = 'Select one group row and the rows to link to it (Ctrl-click)';
    assert.deepEqual(linkSelectionOp(doc, ['k-x1', 'k-r1']), { op: null, refuse: REFUSE });
    assert.deepEqual(linkSelectionOp(doc, ['k-h']), { op: null, refuse: REFUSE });
    assert.deepEqual(linkSelectionOp(doc, ['k-h', 'k-bh', 'k-x1']), { op: null, refuse: REFUSE });
    assert.deepEqual(linkSelectionOp(doc, []), { op: null, refuse: REFUSE });
});
