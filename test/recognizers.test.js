/**
 * Recognizer parity: the JS port must reproduce v1's group/section output
 * (names, cardinality, ordered member identifiers) for DEM, FF 5.4, Sola
 * V1.2, Casus and flat. Reference values captured by running v1's importer
 * on 2026-09-27 (see report); Phase 3 re-checks against the live tool.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset, pickRecognizer } from '../shared/recognizers.js';
import { rebuildSeq, flattenSeq } from '../shared/outline.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function loadPreset(rel) {
    const candidates = [
        path.join(process.env.HOME ?? '', 'projects/sillysystem/st/data/default-user/OpenAI Settings', rel),
        path.join(REPO, 'dev/fixtures/presets', rel),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
    }
    return null;
}

const REPO = path.resolve(import.meta.dirname, '..');

function summarize(doc) {
    /** @type {any[]} */
    const acc = [];
    const walk = (rows, depth) => {
        for (const r of rows) {
            if (r.kind === 'section') {
                acc.push({ kind: 'section', name: r.name, depth });
                walk(r.rows, depth + 1);
            } else if (r.kind === 'group') {
                acc.push({
                    kind: 'group',
                    name: r.name,
                    cardinality: r.cardinality,
                    depth,
                    options: r.options.map((o) => o.ref),
                });
            }
        }
    };
    for (const s of doc.sequences) walk(s.rows, 0);
    return acc;
}

test('recognizer: FF 5.4 Internal States (2) -> 8 ff5 groups', () => {
    const st = loadPreset('Freaky Frankenstein 5.4 Internal States (2).json');
    if (!st) return; // fixtures not present on this machine
    const doc = importStPreset(st, 'FF54');
    assert.equal(doc.source.recognizer.kind, 'ff5');
    const groups = summarize(doc).filter((x) => x.kind === 'group');
    assert.equal(groups.length, 8);
    assert.deepEqual(groups.map((g) => g.cardinality),
        ['pick-one', 'pick-one', 'pick-one', 'pick-one', 'pick-one-or-more', 'pick-one-or-more', 'pick-one-or-more', 'pick-one-or-more']);
    assert.equal(groups[0].options.length, 2);
    assert.equal(groups[6].options.length, 10); // Internal States
    // groups never swallow markers: every marker row stays an item
    const flat = doc.sequences.flatMap((s) => flattenSeq(s.rows));
    const markerRows = flat.filter((e) => e.leaf.kind === 'marker');
    assert.equal(markerRows.length, 8);
    assert.ok(markerRows.every((e) => e.rank === 'item'));
});

test('recognizer: DEM -> 16 groups (15 pick-one + Card-Default bare run), 13 sections', () => {
    const st = loadPreset('DEUS.EX.MACHINA.V2.5.ST.json');
    if (!st) return;
    const doc = importStPreset(st, 'DEM');
    assert.equal(doc.source.recognizer.kind, 'dem');
    const rows = summarize(doc);
    const groups = rows.filter((x) => x.kind === 'group');
    const sections = rows.filter((x) => x.kind === 'section');
    assert.equal(groups.length, 16);
    assert.equal(sections.length, 13);
    assert.ok(groups.every((g) => g.cardinality === 'pick-one' || g.name === 'Card-Default'));
    const cardDefault = groups.find((g) => g.name === 'Card-Default');
    assert.equal(cardDefault.cardinality, 'pick-one-or-more');
    assert.equal(cardDefault.options.length, 10);
    // section names match v1's output
    assert.deepEqual(sections.map((s) => s.name),
        ['CORE', 'CARD & LORE', 'STORY', null, 'VISUALS', 'NARRATIVE MODE', 'NARRATIVE STYLES', 'FORMATTING', 'CONSTRAINTS', 'ADD-ONS', null, 'USER UTILITY', 'SYSTEM UTILITY']);
});

test('recognizer: Sola V1.2 -> 9 sections, 6 family groups (after import normalize)', () => {
    const st = loadPreset('Sola V1.2 Flame.json');
    if (!st) return;
    const doc = importStPreset(st, 'Sola V1.2');
    assert.equal(doc.source.recognizer.kind, 'sola');
    // v1's importer derives structure after recognition (derive_structure);
    // the store's importPreset does the same. Consecutive headerless groups
    // with the same shape merge exactly as in v1 (Voice 5+4=9, Tracker 4+2+6=12).
    for (const seq of doc.sequences) seq.rows = rebuildSeq(flattenSeq(seq.rows));
    const rows = summarize(doc);
    assert.equal(rows.filter((x) => x.kind === 'section').length, 9);
    const groups = rows.filter((x) => x.kind === 'group');
    assert.equal(groups.length, 6);
    assert.deepEqual(groups.map((g) => g.name),
        ['Pacing options', 'Voice options', 'World options', 'Tracker options', 'Intimacy options', 'POV options']);
    assert.deepEqual(groups.map((g) => g.options.length), [3, 9, 3, 12, 3, 5]);
    assert.deepEqual(groups.map((g) => g.cardinality),
        ['pick-one-or-more', 'pick-one-or-more', 'pick-one-or-more', 'pick-one-or-more', 'pick-one-or-more', 'pick-one']);
});

test('recognizer: flat preset imports as independent toggles; non-preset rejected', () => {
    const st = loadPreset('Megumin Suite V10 Universal.json');
    if (!st) return;
    const doc = importStPreset(st, 'Megumin');
    assert.equal(doc.source.recognizer.kind, 'flat');
    const rows = summarize(doc);
    assert.equal(rows.filter((x) => x.kind === 'group').length, 0);
    assert.throws(() => importStPreset({ foo: 1 }, 'bad'), /not a Chat Completion preset/);
    assert.throws(() => importStPreset('nope', 'bad'), /not a Chat Completion preset/);
});

test('recognizer: settings passthrough excludes prompts/prompt_order; markers verbatim', () => {
    const st = loadPreset('Freaky Frankenstein 5.4 Internal States (2).json');
    if (!st) return;
    const doc = importStPreset(st, 'FF54');
    assert.equal('prompts' in doc.settings, false);
    assert.equal('prompt_order' in doc.settings, false);
    assert.equal(typeof doc.settings.wi_format, 'string');
    assert.ok(doc.markers.some((m) => m.identifier === 'chatHistory'));
    assert.ok(doc.markers.every((m) => m.prompt.identifier === m.identifier));
    // connection keys must never reach the document (Must-NOT item 3): a
    // regression here persisted chat_completion_source/openai_model/
    // custom_url/proxy_password to disk on import
    for (const key of ['chat_completion_source', 'openai_model', 'claude_model', 'custom_url', 'proxy_password']) {
        assert.equal(key in doc.settings, false, `${key} must be stripped at import`);
    }
});

test('recognizer: pickRecognizer order matches v1 (dem > sola > ff5 > casus > flat)', () => {
    const byid = new Map([['a', { identifier: 'a', name: '🔻PICK: X🔻' }], ['b', { identifier: 'b', name: '━━━ S ━━━' }], ['c', { identifier: 'c', name: '=====' }], ['d', { identifier: 'd', name: '┌CHOOSE ONE┐' }]]);
    const row = (ref) => ({ kind: 'block', ref, enabled: true, key: ref });
    assert.equal(pickRecognizer([row('a'), row('b')], byid), 'dem');
    assert.equal(pickRecognizer([row('b')], byid), 'sola');
    assert.equal(pickRecognizer([row('c')], byid), 'ff5');
    assert.equal(pickRecognizer([row('d')], byid), 'casus');
    assert.equal(pickRecognizer([row('a')], new Map([['a', { identifier: 'a', name: 'plain' }]])), 'flat');
});
