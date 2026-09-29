/**
 * Mini round (2026-09-29), pure client model:
 *   item 1 — buildOutline / sourceItems show a section's or headed group's
 *     HEADING BLOCK name (a stale stored name never shows);
 *   item 2 — headingAction (the Make/Unmake section/group heading buttons'
 *     label, op and refusal) and the Alt+S / Alt+G shortcuts in keyAction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutline, sourceItems, headingAction, keyAction } from '../ext/outline-model.js';

const B = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ content = '') => ({ identifier: id, name, content, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });

/**
 * chatHistory(marker), a, zz(ghost),
 * s(section, stale '== New section =='){ b, g(group, stale 'New block'){ o1 }, (headerless 'QG'){ q1 } }
 */
function mkDoc() {
    return {
        activeLoadoutId: 'L',
        loadouts: { L: { id: 'L', name: 'L', notes: '', enabled: { a: true }, overrides: {} } },
        markers: [{ identifier: 'chatHistory', prompt: { identifier: 'chatHistory', marker: true } }],
        blocks: {
            a: B('a', 'Alpha', 'x'),
            s: B('s', '━⏱️ Pacing & Rhythm'),
            b: B('b', 'Beta', 'y'),
            g: B('g', 'Anti-Slop'),
            o1: B('o1', 'Opt one', 'z'),
            q1: B('q1', 'Q one', 'q'),
        },
        sequences: [{ character_id: 100001, rows: [
            { kind: 'marker', ref: 'chatHistory', key: 'k-ch' },
            leaf('a'),
            { kind: 'ghost', identifier: 'zz', key: 'k-zz' },
            { kind: 'section', key: 'sec:k-s', name: '== New section ==', header: leaf('s'), rows: [
                leaf('b'),
                { kind: 'group', key: 'grp:k-g', name: 'New block', cardinality: 'pick-one', guessed: false, header: leaf('g'), options: [leaf('o1')] },
                { kind: 'group', key: 'grp:k-q1', name: 'QG', cardinality: 'pick-one-or-more', guessed: false, header: null, options: [leaf('q1')] },
            ] },
        ] }],
    };
}

test('buildOutline: section and headed-group nodes carry the heading block name; a headerless group its stored name', () => {
    const nodes = buildOutline(mkDoc()).sequences[0].nodes;
    const sec = nodes[3];
    assert.equal(sec.type, 'section');
    assert.equal(sec.name, '━⏱️ Pacing & Rhythm');
    assert.equal(sec.nodes[1].type, 'group');
    assert.equal(sec.nodes[1].name, 'Anti-Slop');
    assert.equal(sec.nodes[2].name, 'QG');
});

test('sourceItems (shelf rows): the section heading row and the group row show the heading block name', () => {
    const items = sourceItems(mkDoc());
    const sec = items.find((it) => it.kind === 'leaf' && it.heading === 'section');
    assert.equal(sec?.name, '━⏱️ Pacing & Rhythm');
    const groups = items.filter((it) => it.kind === 'group').map((it) => it.name);
    assert.deepEqual(groups, ['Anti-Slop', 'QG']);
});

// ------------------------------------------------------------ headingAction

test('headingAction section: item -> makeSection, section heading -> unmakeSection', () => {
    const doc = mkDoc();
    assert.deepEqual(headingAction(doc, 'k-a', 'section'), { label: 'Make section heading', op: { op: 'makeSection', key: 'k-a' }, refuse: null });
    assert.deepEqual(headingAction(doc, 'k-b', 'section'), { label: 'Make section heading', op: { op: 'makeSection', key: 'k-b' }, refuse: null });
    assert.deepEqual(headingAction(doc, 'k-s', 'section'), { label: 'Unmake section heading', op: { op: 'unmakeSection', key: 'k-s' }, refuse: null });
});

test('headingAction group: item -> promote, group heading -> demote', () => {
    const doc = mkDoc();
    assert.deepEqual(headingAction(doc, 'k-a', 'group'), { label: 'Make group heading', op: { op: 'promote', key: 'k-a' }, refuse: null });
    assert.deepEqual(headingAction(doc, 'k-g', 'group'), { label: 'Unmake group heading', op: { op: 'demote', key: 'k-g' }, refuse: null });
});

test('headingAction refuses options and the other heading kind with "make it a plain row first"', () => {
    const doc = mkDoc();
    for (const [key, kind, label] of /** @type {const} */ ([
        ['k-o1', 'section', 'Make section heading'],
        ['k-q1', 'section', 'Make section heading'],
        ['k-g', 'section', 'Make section heading'],
        ['k-o1', 'group', 'Make group heading'],
        ['k-s', 'group', 'Make group heading'],
    ])) {
        const r = headingAction(doc, key, kind);
        assert.equal(r.label, label, `${key}/${kind} label`);
        assert.equal(r.op, null, `${key}/${kind} op`);
        assert.match(String(r.refuse), /make it a plain row first/, `${key}/${kind} refuse`);
    }
});

test('headingAction refuses markers and ghosts; no selection gives just the label', () => {
    const doc = mkDoc();
    for (const kind of /** @type {const} */ (['section', 'group'])) {
        const m = headingAction(doc, 'k-ch', kind);
        assert.equal(m.op, null);
        assert.match(String(m.refuse), /marker/i);
        const g = headingAction(doc, 'k-zz', kind);
        assert.equal(g.op, null);
        assert.match(String(g.refuse), /order-only/i);
        assert.deepEqual(headingAction(doc, null, kind), { label: `Make ${kind} heading`, op: null, refuse: null });
        assert.deepEqual(headingAction(doc, 'k-nope', kind), { label: `Make ${kind} heading`, op: null, refuse: null });
    }
});

// ------------------------------------------------------------ shortcuts

test('keyAction: Alt+S toggles the section heading, Alt+G the group heading (by physical key); modifiers beyond Alt are not ours', () => {
    const k = (/** @type {any} */ o) => keyAction({ key: '', code: '', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o });
    assert.deepEqual(k({ key: 's', code: 'KeyS', altKey: true }), { op: 'heading', kind: 'section' });
    assert.deepEqual(k({ key: 'ß', code: 'KeyS', altKey: true }), { op: 'heading', kind: 'section' }, 'macOS Option+S');
    assert.deepEqual(k({ key: 'g', code: 'KeyG', altKey: true }), { op: 'heading', kind: 'group' });
    assert.equal(k({ key: 's', code: 'KeyS' }), null, 'plain S types, never acts');
    assert.equal(k({ key: 'S', code: 'KeyS', altKey: true, shiftKey: true }), null);
    assert.equal(k({ key: 's', code: 'KeyS', altKey: true, ctrlKey: true }), null);
    assert.equal(k({ key: 'g', code: 'KeyG', altKey: true, metaKey: true }), null);
    assert.deepEqual(k({ key: 'Tab' }), { op: 'promote' }, 'existing shortcuts unchanged');
});
