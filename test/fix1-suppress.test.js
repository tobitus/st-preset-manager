/**
 * Fix round 1, item 3: a section- or group-heading BLOCK whose content is
 * empty or whitespace-only is omitted from the working-slot compile
 * (`prompts` and every `prompt_order`). Headings with real content, and
 * empty blocks that are not headings, still compile. The ST-format export
 * keeps every block. Panel write-back still maps the (shorter) slot back to
 * the library: suppressed headings are never read as deleted, their loadout
 * bit is library-only, and a panel reorder keeps them next to the row that
 * followed them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure } from '../shared/outline.js';
import { compile, exportSt } from '../shared/compile.js';
import { ensureDefaultLoadout } from '../plugin/store.js';
import { panelDelta, routePanelDiff, applyOrderToSequences } from '../plugin/slot.js';

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;
const orderIds = (/** @type {any} */ compiled) => compiled.prompt_order[0].order.map((/** @type {any} */ o) => o.identifier);
const promptIds = (/** @type {any} */ compiled) => compiled.prompts.map((/** @type {any} */ p) => p.identifier);

/**
 * chatHistory(marker), a, h(section, content ''){ b }, hc(section, content
 * 'real text'){ c, g(group heading, content '  '){ o1, o2 } }, w(section,
 * content ' \n\t'){ e(item, content '') }. Every bit on.
 */
function mkDoc() {
    const content = /** @type {Record<string, string>} */ ({
        a: 'A text', h: '', b: 'B text', hc: 'real text', c: 'C text', g: '  ', o1: 'O1', o2: 'O2', w: ' \n\t', e: '',
    });
    const ids = Object.keys(content);
    const st = {
        prompts: [
            { identifier: 'chatHistory', marker: true },
            ...ids.map((id) => ({ identifier: id, name: `N ${id}`, content: content[id], role: 'system', enabled: true })),
        ],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }, ...ids.map((id) => ({ identifier: id, enabled: true }))] }],
    };
    const doc = importStPreset(st, 'T');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    const entries = flattenSeq(doc.sequences[0].rows);
    const at = (/** @type {string} */ id) => entries.find((e) => identOf(e.leaf) === id);
    const gm = { name: 'G', cardinality: 'pick-one-or-more', guessed: false };
    Object.assign(at('h'), { rank: 'section', sname: 'H' });
    Object.assign(at('hc'), { rank: 'section', sname: 'HC' });
    Object.assign(at('g'), { rank: 'group', gmeta: { ...gm } });
    Object.assign(at('o1'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('o2'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('w'), { rank: 'section', sname: 'W' });
    doc.sequences[0].rows = rebuildSeq(entries);
    return doc;
}

test('compile omits empty/whitespace section and group headings from prompts and prompt_order', () => {
    const doc = mkDoc();
    const { compiled } = compile(doc, null, {});
    assert.deepEqual(orderIds(compiled), ['chatHistory', 'a', 'b', 'hc', 'c', 'o1', 'o2', 'e']);
    for (const id of ['h', 'g', 'w']) {
        assert.ok(!promptIds(compiled).includes(id), `${id} not in prompts`);
    }
    // no suppressed heading re-enters as a disabled orphan, and no duplicates
    assert.equal(new Set(promptIds(compiled)).size, compiled.prompts.length);
});

test('a heading WITH content still compiles, with its content; an empty non-heading block still compiles', () => {
    const doc = mkDoc();
    const { compiled } = compile(doc, null, {});
    const hc = compiled.prompts.find((/** @type {any} */ p) => p.identifier === 'hc');
    assert.equal(hc?.content, 'real text');
    assert.equal(hc?.enabled, true);
    const e = compiled.prompts.find((/** @type {any} */ p) => p.identifier === 'e');
    assert.ok(e, 'empty ITEM e is not a heading: still compiled');
    assert.equal(e.content, '');
});

test('the suppressed heading keeps its loadout bit (library-only) in the returned enabled map', () => {
    const doc = mkDoc();
    const { enabled } = compile(doc, null, {});
    assert.equal(enabled.h, true);
    assert.equal(enabled.g, true);
    assert.equal(doc.loadouts[doc.activeLoadoutId].enabled.h, true);
});

test('a heading demoted to an item is no longer suppressed (the rule is about heading rank)', () => {
    const doc = mkDoc();
    const entries = flattenSeq(doc.sequences[0].rows);
    const h = entries.find((e) => identOf(e.leaf) === 'h');
    Object.assign(h, { rank: 'item', sname: null });
    doc.sequences[0].rows = rebuildSeq(entries);
    const { compiled } = compile(doc, null, {});
    assert.ok(orderIds(compiled).includes('h'));
    assert.ok(promptIds(compiled).includes('h'));
});

test('the ST-format export keeps every block, empty headings included, in document order', () => {
    const doc = mkDoc();
    const E = exportSt(doc);
    assert.deepEqual(orderIds(E), ['chatHistory', 'a', 'h', 'b', 'hc', 'c', 'g', 'o1', 'o2', 'w', 'e']);
    for (const id of ['h', 'g', 'w', 'hc', 'e']) assert.ok(promptIds(E).includes(id), `${id} exported`);
    assert.equal(E.prompts.find((/** @type {any} */ p) => p.identifier === 'w').content, ' \n\t');
});

test('panel write-back: a toggle in the (suppressed) slot routes only that bit; suppressed headings are not read as deleted', () => {
    const doc = mkDoc();
    const { compiled } = compile(doc, null, {});
    const snap = structuredClone(compiled);
    snap.prompt_order[0].order.find((/** @type {any} */ o) => o.identifier === 'b').enabled = false;
    const delta = panelDelta(compiled, snap);
    const { routed } = routePanelDiff(doc, compiled, delta, null);
    assert.deepEqual(routed, [{ key: 'b', layer: 'loadout' }]);
    const L = doc.loadouts[doc.activeLoadoutId].enabled;
    assert.equal(L.b, false);
    assert.equal(L.h, true, 'the suppressed heading bit is untouched');
    assert.ok(doc.blocks.h && doc.blocks.g && doc.blocks.w, 'no heading deleted');
});

test('panel reorder: an identifier the panel does not carry stays right above the row that followed it', () => {
    const doc = mkDoc();
    // panel order lacks the suppressed h, g, w; the user swaps a and b
    applyOrderToSequences(doc, ['chatHistory', 'b', 'a', 'hc', 'c', 'o1', 'o2', 'e']);
    const ids = flattenSeq(doc.sequences[0].rows).map((e) => identOf(e.leaf));
    assert.deepEqual(ids, ['chatHistory', 'h', 'b', 'a', 'hc', 'c', 'g', 'o1', 'o2', 'w', 'e']);
});

test('applyOrderToSequences: absent leaves keep their place (consecutive runs and the old tail)', () => {
    const mk = (/** @type {string[]} */ ids) => ({
        sequences: [{ character_id: 1, rows: ids.map((id, i) => ({ kind: 'block', ref: id, key: `k${i}` })) }],
    });
    const d1 = mk(['h1', 'h2', 'a', 'b']);
    applyOrderToSequences(d1, ['b', 'a']);
    assert.deepEqual(d1.sequences[0].rows.map((r) => r.ref), ['b', 'h1', 'h2', 'a']);
    const d2 = mk(['a', 'b', 'z']);
    applyOrderToSequences(d2, ['b', 'a']);
    assert.deepEqual(d2.sequences[0].rows.map((r) => r.ref), ['b', 'a', 'z']);
    const d3 = mk(['a', 'b', 'c']);
    applyOrderToSequences(d3, ['c', 'b', 'a']);
    assert.deepEqual(d3.sequences[0].rows.map((r) => r.ref), ['c', 'b', 'a']);
});
