/**
 * Round 3: graceful import. `importStPreset` cleans its INPUT (via
 * `cleanStPreset`) before anything else: bad prompt_order entries, duplicate
 * character ids, malformed order entries and malformed prompts are dropped
 * (or coerced) with a note in `source.recognizer.notes`; the import refuses
 * (ImportError, 400) only when no usable prompt_order or no prompt is left.
 * The stored document stays strict (validateDoc untouched).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStPreset, cleanStPreset, ImportError } from '../shared/recognizers.js';
import { flattenSeq } from '../shared/outline.js';
import { validateDoc } from '../shared/schema.js';
import { Store } from '../plugin/store.js';

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;

/** @param {any[]} orders @param {any[]} [prompts] */
function st(orders, prompts) {
    return {
        temperature: 1,
        prompts: prompts ?? [
            { identifier: 'chatHistory', name: 'Chat History', marker: true, system_prompt: true },
            { identifier: 'a', name: 'A', content: 'A text', role: 'system' },
            { identifier: 'b', name: 'B', content: 'B text', role: 'user' },
        ],
        prompt_order: orders,
    };
}
const order = (/** @type {string[]} */ ids) => ids.map((identifier) => ({ identifier, enabled: true }));
const leafIds = (/** @type {any} */ doc, i = 0) => flattenSeq(doc.sequences[i].rows).map((e) => identOf(e.leaf));
const notesOf = (/** @type {any} */ doc) => /** @type {string[]} */ (doc.source.recognizer.notes);

test('a prompt_order whose character_id is not a number is dropped with a note naming it', () => {
    const data = st([
        { character_id: 'undefined', order: order(['a']) },
        { character_id: 100001, order: order(['chatHistory', 'a', 'b']) },
    ]);
    const before = structuredClone(data);
    const doc = importStPreset(data, 'P');
    assert.deepEqual(data, before, 'the input object is never mutated');
    assert.equal(doc.sequences.length, 1);
    assert.equal(doc.sequences[0].character_id, 100001);
    assert.deepEqual(leafIds(doc), ['chatHistory', 'a', 'b']);
    const note = notesOf(doc).find((n) => n.startsWith('dropped prompt_order[0]'));
    assert.ok(note, notesOf(doc).join(' | '));
    assert.match(note, /character_id "undefined" is not a number/);
});

test('a non-integer number character_id and a missing one are dropped too', () => {
    const doc = importStPreset(st([
        { character_id: 1.5, order: order(['a']) },
        { order: order(['a']) },
        { character_id: 100001, order: order(['a', 'b']) },
    ]), 'P');
    assert.deepEqual(doc.sequences.map((s) => s.character_id), [100001]);
    assert.ok(notesOf(doc).some((n) => n.startsWith('dropped prompt_order[0]')), notesOf(doc).join(' | '));
    assert.ok(notesOf(doc).some((n) => n.startsWith('dropped prompt_order[1]')), notesOf(doc).join(' | '));
});

test('a prompt_order whose order is not an array (or that is not an object) is dropped with a note', () => {
    const doc = importStPreset(st([
        { character_id: 100000, order: 'nope' },
        'junk',
        { character_id: 100001, order: order(['a', 'b']) },
    ]), 'P');
    assert.deepEqual(doc.sequences.map((s) => s.character_id), [100001]);
    const n0 = notesOf(doc).find((n) => n.startsWith('dropped prompt_order[0]'));
    assert.ok(n0, notesOf(doc).join(' | '));
    assert.match(n0, /order/);
    assert.ok(notesOf(doc).some((n) => n.startsWith('dropped prompt_order[1]')), notesOf(doc).join(' | '));
});

test('a duplicate character_id keeps the first prompt_order and notes the drop', () => {
    const doc = importStPreset(st([
        { character_id: 100001, order: order(['a']) },
        { character_id: 100001, order: order(['a', 'b']) },
    ]), 'P');
    assert.equal(doc.sequences.length, 1);
    assert.deepEqual(leafIds(doc), ['a']);
    const note = notesOf(doc).find((n) => n.startsWith('dropped prompt_order[1]'));
    assert.ok(note, notesOf(doc).join(' | '));
    assert.match(note, /duplicate character_id 100001/);
});

test('order entries that are not objects or lack a string identifier are dropped with a note each', () => {
    const doc = importStPreset(st([
        { character_id: 100001, order: [{ identifier: 'a', enabled: true }, { enabled: true }, 'junk', { identifier: 7 }, { identifier: 'b', enabled: false }] },
    ]), 'P');
    assert.deepEqual(leafIds(doc), ['a', 'b']);
    for (const j of [1, 2, 3]) {
        assert.ok(notesOf(doc).some((n) => n.startsWith(`dropped prompt_order[0].order[${j}]`)), `order[${j}]: ${notesOf(doc).join(' | ')}`);
    }
});

test('prompts: a non-object or one without a string identifier is dropped; a bad role/content is coerced, with notes', () => {
    const doc = importStPreset(st(
        [{ character_id: 100001, order: order(['a', 'b']) }],
        [
            { identifier: 'a', name: 'A', content: 'A text', role: 7 },
            null,
            { name: 'no id', content: 'x' },
            { identifier: 'b', name: 'B', content: 42, role: 'user' },
        ],
    ), 'P');
    assert.equal(doc.blocks.a.role, 'system');
    assert.equal(doc.blocks.a.content, 'A text');
    assert.equal(doc.blocks.b.content, '');
    assert.equal(doc.blocks.b.role, 'user');
    assert.deepEqual(Object.keys(doc.blocks).sort(), ['a', 'b']);
    const notes = notesOf(doc);
    assert.ok(notes.some((n) => n.startsWith('dropped prompts[1]')), notes.join(' | '));
    assert.ok(notes.some((n) => n.startsWith('dropped prompts[2]')), notes.join(' | '));
    assert.ok(notes.some((n) => /prompts\[0\].*role/.test(n)), notes.join(' | '));
    assert.ok(notes.some((n) => /prompts\[3\].*content/.test(n)), notes.join(' | '));
});

test('only bad prompt_orders -> ImportError 400 "no usable prompt_order" with the reasons', () => {
    assert.throws(() => importStPreset(st([{ character_id: 'undefined', order: order(['a']) }, { character_id: 100001, order: {} }]), 'Bad'),
        (/** @type {any} */ e) => {
            assert.ok(e instanceof ImportError);
            assert.equal(e.status, 400);
            assert.match(e.message, /^Bad: no usable prompt_order \(/);
            assert.match(e.message, /"undefined"/);
            return true;
        });
});

test('no prompts left -> ImportError 400 "no prompts"', () => {
    for (const prompts of [[], [null, { name: 'x' }]]) {
        assert.throws(() => importStPreset(st([{ character_id: 100001, order: order(['a']) }], prompts), 'Empty'),
            (/** @type {any} */ e) => e instanceof ImportError && e.status === 400 && /^Empty: no prompts/.test(e.message));
    }
});

test('cleanStPreset returns cleaned prompts/orders + notes and leaves a clean preset alone', () => {
    const clean = st([{ character_id: 100001, order: order(['chatHistory', 'a', 'b']) }]);
    const res = cleanStPreset(clean, 'Clean');
    assert.deepEqual(res.prompts, clean.prompts);
    assert.deepEqual(res.orders, clean.prompt_order);
    assert.deepEqual(res.notes, []);
});

test('a cleaned import stores through the Store and passes validateDoc', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pm-graceful-'));
    const store = new Store(root);
    await store.init();
    const doc = await store.importPreset({
        st: st([
            { character_id: 'undefined', order: order(['a']) },
            { character_id: 100001, order: [{ identifier: 'a', enabled: true }, { enabled: true }, { identifier: 'b', enabled: true }] },
        ]),
        name: 'Graceful',
    });
    assert.deepEqual(validateDoc(doc), []);
    assert.deepEqual(doc.sequences.map((/** @type {any} */ s) => s.character_id), [100001]);
    assert.ok(notesOf(doc).some((n) => n.includes('"undefined"')));
});
