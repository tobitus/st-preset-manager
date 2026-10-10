/**
 * shared/compare.js — v1 compare.py port (PLAN §1.6 /diff, §2 Phase 5).
 * Matching: identifier first, then normalized name (emoji/whitespace/case
 * folded), duplicate names pair in order. A matched pair is `changed` when a
 * ROW_FIELDS value differs, `moved` when it is equal but out of the longest
 * in-order run of matched pairs, else `same`. Rows run in left order;
 * a right-only block sits right after the row holding its right-hand
 * predecessor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { comparePresets, normName, blockOrder, ROW_FIELDS, CompareError, MAX_DIFF_LEAVES } from '../shared/compare.js';
import { importStPreset } from '../shared/recognizers.js';
import { ensureDefaultLoadout } from '../plugin/store.js';

const REPO = path.resolve(import.meta.dirname, '..');

/**
 * Minimal library doc: `blocks` in outline order, every one placed as a
 * top-level leaf of sequences[0]. `extra` blocks exist but are unplaced.
 * @param {{id: string, name: string, content?: string, role?: string, on?: boolean, fields?: any}[]} blocks
 * @param {{ settings?: any, extra?: any[] }} [opts]
 */
function mkDoc(blocks, opts = {}) {
    const all = [...blocks, ...(opts.extra ?? [])];
    return {
        format: 'st-preset-manager/library', version: 1, id: 'p_x', name: 'X', tags: [], notes: '',
        settings: opts.settings ?? {},
        markers: [],
        blocks: Object.fromEntries(all.map((b) => [b.id, {
            identifier: b.id, name: b.name, content: b.content ?? `content of ${b.name}`,
            role: b.role ?? 'system', fields: b.fields ?? {}, notes: '',
        }])),
        sequences: [{ character_id: 100001, rows: blocks.map((b) => ({ kind: 'block', ref: b.id, key: `k_${b.id}` })) }],
        loadouts: { l1: { id: 'l1', name: 'Default', notes: '', kind: 'root', parent: null, enabled: Object.fromEntries(all.map((b) => [b.id, b.on ?? true])), overrides: {} } },
        activeLoadoutId: 'l1',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1,
    };
}
const B = (/** @type {string} */ id, /** @type {any} */ extra = {}) => ({ id, name: id.toUpperCase(), ...extra });
const summary = (/** @type {any} */ res) => res.rows.map((/** @type {any} */ r) => `${r.status}:${r.left?.identifier ?? '-'}>${r.right?.identifier ?? '-'}`);

test('ROW_FIELDS are the v1 fields', () => {
    assert.deepEqual(ROW_FIELDS, ['content', 'role', 'injection_position', 'injection_depth', 'injection_order', 'enabled']);
});

test('normName strips emoji, whitespace and case (v1 norm_name)', () => {
    assert.equal(normName('⚡️Main Prompt 🤖'), normName('main   prompt'));
    assert.equal(normName('  Kimi K3 '), 'kimik3');
    assert.equal(normName(''), '');
    assert.equal(normName(null), '');
    assert.notEqual(normName('Kimi K3'), normName('Kimi K3 JB (secondary)'));
});

test('blockOrder: placed blocks of sequences[0] in flat order, 1-based; unplaced and dangling refs skipped', () => {
    const doc = mkDoc([B('a'), B('b')], { extra: [B('orphan')] });
    doc.sequences[0].rows.push({ kind: 'block', ref: 'missing', key: 'k_missing' });
    doc.sequences[0].rows.splice(1, 0, { kind: 'marker', ref: 'chatHistory', key: 'k_ch' });
    assert.deepEqual(blockOrder(doc), [{ pos: 1, identifier: 'a' }, { pos: 2, identifier: 'b' }]);
});

test('a preset against itself: every row same, identical, counts', () => {
    const doc = mkDoc([B('a'), B('b'), B('c')], { settings: { wi_format: '{0}' } });
    const res = comparePresets(doc, structuredClone(doc));
    assert.deepEqual(summary(res), ['same:a>a', 'same:b>b', 'same:c>c']);
    assert.equal(res.identical, true);
    assert.deepEqual(res.settings, []);
    assert.deepEqual(res.counts, { same: 3, changed: 0, moved: 0, 'only-left': 0, 'only-right': 0 });
    const r = res.rows[1];
    assert.deepEqual(r.left, { pos: 2, identifier: 'b', name: 'B' });
    assert.deepEqual(r.right, { pos: 2, identifier: 'b', name: 'B' });
    assert.equal(r.matchedBy, 'id');
    assert.deepEqual(r.fields, []);
    assert.equal(r.movedFrom, undefined);
});

test('identifier match wins over name; a renamed block with new content is changed (content field)', () => {
    const a = mkDoc([B('a'), { id: 'k', name: 'Kimi K3', content: 'one\ntwo' }]);
    const b = mkDoc([B('a'), { id: 'k', name: 'Kimi K3 JB (secondary)', content: 'one\nTWO' }]);
    const res = comparePresets(a, b);
    assert.deepEqual(summary(res), ['same:a>a', 'changed:k>k']);
    const row = res.rows[1];
    assert.equal(row.matchedBy, 'id');
    assert.equal(row.name, 'Kimi K3');
    assert.deepEqual(row.fields, [{ key: 'content', a: 'one\ntwo', b: 'one\nTWO' }]);
    assert.equal(res.identical, false);
});

test('name match across different identifiers (a fork re-mints ids); duplicate names pair in order', () => {
    const a = mkDoc([{ id: 'x1', name: '━━ Div ━━' }, { id: 'm', name: '⚡️Main Prompt 🤖' }, { id: 'x2', name: '━━ Div ━━', content: 'second' }]);
    const b = mkDoc([{ id: 'y1', name: '━━ Div ━━' }, { id: 'n', name: 'main prompt', content: 'content of ⚡️Main Prompt 🤖' }, { id: 'y2', name: '━━ Div ━━', content: 'second' }]);
    const res = comparePresets(a, b);
    assert.deepEqual(summary(res), ['same:x1>y1', 'same:m>n', 'same:x2>y2']);
    assert.ok(res.rows.every((/** @type {any} */ r) => r.matchedBy === 'name'));
});

test('one block moved: only that pair is moved (movedFrom = its left position); the rest stay same', () => {
    const a = mkDoc(['a', 'b', 'c', 'd', 'e'].map((x) => B(x)));
    const b = mkDoc(['a', 'c', 'd', 'b', 'e'].map((x) => B(x)));
    const res = comparePresets(a, b);
    assert.deepEqual(summary(res), ['same:a>a', 'moved:b>b', 'same:c>c', 'same:d>d', 'same:e>e']);
    const row = res.rows[1];
    assert.equal(row.movedFrom, 2);
    assert.equal(row.left.pos, 2);
    assert.equal(row.right.pos, 4);
    assert.deepEqual(res.counts, { same: 4, changed: 0, moved: 1, 'only-left': 0, 'only-right': 0 });
    // moved backwards too
    const back = comparePresets(a, mkDoc(['a', 'e', 'b', 'c', 'd'].map((x) => B(x))));
    assert.deepEqual(summary(back), ['same:a>a', 'same:b>b', 'same:c>c', 'same:d>d', 'moved:e>e']);
    assert.equal(back.rows[4].movedFrom, 5);
    assert.equal(back.rows[4].right.pos, 2);
});

test('a block that moved AND changed is changed, still carrying movedFrom', () => {
    const a = mkDoc(['a', 'b', 'c', 'd'].map((x) => B(x)));
    const b = mkDoc([B('a'), B('c'), B('d'), B('b', { content: 'new' })]);
    const res = comparePresets(a, b);
    assert.deepEqual(summary(res), ['same:a>a', 'changed:b>b', 'same:c>c', 'same:d>d']);
    assert.equal(res.rows[1].movedFrom, 2);
    assert.equal(res.rows[0].movedFrom, undefined);
});

test('only-left / only-right: right-only rows sit after their right-hand predecessor, in left order otherwise', () => {
    const a = mkDoc(['a', 'b', 'c'].map((x) => B(x)));
    const b = mkDoc(['a', 'x', 'b', 'c', 'y'].map((x) => B(x)));
    assert.deepEqual(summary(comparePresets(a, b)), ['same:a>a', 'only-right:->x', 'same:b>b', 'same:c>c', 'only-right:->y']);
    const c = mkDoc(['x', 'a', 'c'].map((x) => B(x)));
    const res = comparePresets(a, c);
    assert.deepEqual(summary(res), ['only-right:->x', 'same:a>a', 'only-left:b>-', 'same:c>c']);
    assert.deepEqual(res.counts, { same: 2, changed: 0, moved: 0, 'only-left': 1, 'only-right': 1 });
    const ol = res.rows[2];
    assert.deepEqual(ol.left, { pos: 2, identifier: 'b', name: 'B' });
    assert.equal(ol.right, undefined);
    assert.deepEqual(ol.fields, []);
    // two right-only blocks in a row at the front keep their right order
    const d = mkDoc(['x', 'y', 'a', 'b', 'c'].map((x) => B(x)));
    assert.deepEqual(summary(comparePresets(a, d)), ['only-right:->x', 'only-right:->y', 'same:a>a', 'same:b>b', 'same:c>c']);
});

test('enabled (active loadout), role and injection fields make a row changed; unplaced blocks are not rows', () => {
    const a = mkDoc([B('a'), B('b'), B('c')], { extra: [B('o1')] });
    const b = mkDoc([B('a', { on: false }), B('b', { role: 'user' }), B('c', { fields: { injection_depth: 4 } })], { extra: [B('o2')] });
    const res = comparePresets(a, b);
    assert.deepEqual(summary(res), ['changed:a>a', 'changed:b>b', 'changed:c>c']);
    assert.deepEqual(res.rows[0].fields, [{ key: 'enabled', a: true, b: false }]);
    assert.deepEqual(res.rows[1].fields, [{ key: 'role', a: 'system', b: 'user' }]);
    assert.deepEqual(res.rows[2].fields, [{ key: 'injection_depth', a: null, b: 4 }]);
});

test('settings table: differing top-level settings keys, sorted; an absent side has no property', () => {
    const a = mkDoc([B('a')], { settings: { x: 1, y: [1, { z: 2 }], w: 'same' } });
    const b = mkDoc([B('a')], { settings: { y: [1, { z: 2 }], z: 2, w: 'same', v: { q: 1 } } });
    const res = comparePresets(a, b);
    assert.deepEqual(res.settings, [{ key: 'v', b: { q: 1 } }, { key: 'x', a: 1 }, { key: 'z', b: 2 }]);
    assert.equal(res.identical, false, 'a settings difference is not identical');
});

function fixture(/** @type {string} */ name) {
    const st = JSON.parse(fs.readFileSync(path.join(REPO, 'dev/fixtures/presets', `${name}.json`), 'utf8'));
    const doc = importStPreset(st, name);
    ensureDefaultLoadout(doc);
    return doc;
}

test('fixture: FF 5.4 Internal States (2) vs Hapuppy Forced Reasoning (1) -> the Kimi row is changed (v1 README known result)', () => {
    const is2 = fixture('Freaky Frankenstein 5.4 Internal States (2)');
    const hap = fixture('Freaky Frankenstein 5.4 Hapuppy Forced Reasoning (1)');
    const res = comparePresets(is2, hap);
    const kimi = res.rows.filter((/** @type {any} */ r) => /kimi/i.test(r.name));
    assert.equal(kimi.length, 1);
    assert.equal(kimi[0].status, 'changed');
    assert.equal(kimi[0].matchedBy, 'id');
    assert.equal(kimi[0].right.name, 'Kimi K3 JB (secondary)');
    assert.ok(kimi[0].fields.some((/** @type {any} */ f) => f.key === 'content'));
    // FF vs itself: 49 placed blocks, all same
    const self = comparePresets(is2, fixture('Freaky Frankenstein 5.4 Internal States (2)'));
    assert.equal(self.rows.length, 49);
    assert.ok(self.rows.every((/** @type {any} */ r) => r.status === 'same'));
    assert.equal(self.identical, true);
});

// Phase 5 review 1 (finding 2): ST markers are fixed anchors. Moving a block
// across one changes what the model sees, so it is a move even though the
// block-only order is unchanged. Markers never render as rows.
/** mkDoc whose sequence interleaves marker leaves: `order` items are block ids or `@marker` */
function mkMarked(/** @type {string[]} */ order, /** @type {any[]} */ blocks) {
    const doc = mkDoc(blocks);
    doc.sequences[0].rows = order.map((x) => (x.startsWith('@')
        ? { kind: 'marker', ref: x.slice(1), key: `k_${x.slice(1)}` }
        : { kind: 'block', ref: x, key: `k_${x}` }));
    doc.markers = order.filter((x) => x.startsWith('@')).map((x) => ({ identifier: x.slice(1), prompt: { identifier: x.slice(1), marker: true } }));
    return doc;
}

test('markers anchor moves: [A, chatHistory] vs [chatHistory, A] marks A moved and the presets not identical', () => {
    const res = comparePresets(mkMarked(['a', '@chatHistory'], [B('a')]), mkMarked(['@chatHistory', 'a'], [B('a')]));
    assert.deepEqual(summary(res), ['moved:a>a']);
    assert.equal(res.rows[0].movedFrom, 1);
    assert.equal(res.identical, false);
    // markers are anchors, not rows
    assert.ok(res.rows.every((/** @type {any} */ r) => r.left?.identifier !== 'chatHistory' && r.right?.identifier !== 'chatHistory'));
});

test('markers anchor moves: the marker is never the one sacrificed to keep a block in order', () => {
    // [A, B, @chat, C] vs [@chat, A, B, C]: by block order alone nothing moved;
    // keeping A and B in order would need the marker to "move" — it may not
    const l = mkMarked(['a', 'b', '@chatHistory', 'c'], [B('a'), B('b'), B('c')]);
    const r = mkMarked(['@chatHistory', 'a', 'b', 'c'], [B('a'), B('b'), B('c')]);
    assert.deepEqual(summary(comparePresets(l, r)), ['moved:a>a', 'moved:b>b', 'same:c>c']);
    // a block that stays on its side of every marker is not moved
    const l2 = mkMarked(['@main', 'a', 'b', '@chatHistory', 'c'], [B('a'), B('b'), B('c')]);
    const r2 = mkMarked(['@main', 'b', 'a', '@chatHistory', 'c'], [B('a'), B('b'), B('c')]);
    const res2 = comparePresets(l2, r2);
    assert.equal(res2.rows.filter((/** @type {any} */ x) => x.status === 'moved').length, 1);
    assert.equal(res2.rows.find((/** @type {any} */ x) => x.left.identifier === 'c').status, 'same');
    // same sequence with markers: all same, identical
    const same = comparePresets(l2, structuredClone(l2));
    assert.deepEqual(summary(same), ['same:a>a', 'same:b>b', 'same:c>c']);
    assert.equal(same.identical, true);
});

test('markers anchor moves: a marker present on one side only is not an anchor', () => {
    const res = comparePresets(mkMarked(['a', '@worldInfoBefore', 'b'], [B('a'), B('b')]), mkMarked(['a', 'b'], [B('a'), B('b')]));
    assert.deepEqual(summary(res), ['same:a>a', 'same:b>b']);
});

// Phase 5 review 2: POST /diff runs comparePresets synchronously in ST's
// process and move detection is quadratic in the leaf count, so each side is
// bounded (the same 413 policy as /diff/blocks).
test('size bound: a side over MAX_DIFF_LEAVES leaves is refused with 413', () => {
    assert.ok(MAX_DIFF_LEAVES <= 5000, `MAX_DIFF_LEAVES ${MAX_DIFF_LEAVES}`);
    const ids = Array.from({ length: MAX_DIFF_LEAVES + 1 }, (_, i) => `b${i}`);
    const big = mkDoc(ids.map((x) => B(x)));
    const small = mkDoc([B('b0')]);
    for (const [l, r] of [[big, small], [small, big]]) {
        assert.throws(() => comparePresets(l, r), (/** @type {any} */ e) => e instanceof CompareError && e.status === 413);
    }
    // markers count toward the bound too
    const withMarker = mkMarked(['@chatHistory', ...ids.slice(0, MAX_DIFF_LEAVES)], ids.slice(0, MAX_DIFF_LEAVES).map((x) => B(x)));
    assert.throws(() => comparePresets(withMarker, small), CompareError);
});

test('size bound: the worst allowed case (every block reordered, markers interleaved) finishes fast', () => {
    const n = MAX_DIFF_LEAVES;
    const order = Array.from({ length: n }, (_, i) => (i % 500 === 0 ? `@m${i}` : `b${i}`));
    const blocks = order.filter((x) => !x.startsWith('@')).map((x) => B(x));
    const left = mkMarked(order, blocks);
    // right: blocks reversed inside a fixed marker skeleton -> maximal chain work
    const rev = order.filter((x) => !x.startsWith('@')).reverse();
    let k = 0;
    const right = mkMarked(order.map((x) => (x.startsWith('@') ? x : rev[k++])), blocks);
    for (const [l, r] of [[left, structuredClone(left)], [left, right]]) {
        const t0 = performance.now();
        const res = comparePresets(l, r);
        const ms = performance.now() - t0;
        console.log(`# worst allowed compare: ${n} leaves -> ${ms.toFixed(1)} ms`);
        assert.ok(ms < 1000, `compare of ${n} leaves took ${ms.toFixed(0)} ms`);
        assert.equal(res.rows.length, blocks.length);
    }
});
