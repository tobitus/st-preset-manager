/**
 * Fix round 1, pure outline-model helpers:
 *   - searchMatches (item 9): leaf keys whose name or content contains the
 *     query, case-insensitively, in outline order;
 *   - buildOutline leaf nodes carry `hasContent` (item 3's ⓘ marker).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutline, searchMatches } from '../ext/outline-model.js';

const B = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ content) => ({ identifier: id, name, content, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });

/**
 * chatHistory(marker), a, s(section '== Sec ==', empty){ b, g(pick-one
 * heading, '  '){ o1, o2 }, c, (headerless group){ p1, p2 } },
 * h(section 'Hdr', content){ d }
 */
function mkDoc() {
    return {
        activeLoadoutId: 'L',
        loadouts: { L: { id: 'L', name: 'L', notes: '', enabled: { a: true }, overrides: {} } },
        markers: [{ identifier: 'chatHistory', prompt: { identifier: 'chatHistory', marker: true } }],
        blocks: {
            a: B('a', 'Alpha', 'the Quick fox'),
            s: B('s', '== Sec ==', ''),
            b: B('b', 'Beta', 'nothing here'),
            g: B('g', 'Gamma head', '  '),
            o1: B('o1', 'Opt one', 'QUICK brown'),
            o2: B('o2', 'Opt two', ''),
            c: B('c', 'Charlie', 'x'),
            p1: B('p1', 'P one', 'p'),
            p2: B('p2', 'P two', 'p'),
            h: B('h', 'Hdr', 'sends words'),
            d: B('d', 'Delta', 'd'),
        },
        sequences: [{ character_id: 100001, rows: [
            { kind: 'marker', ref: 'chatHistory', key: 'k-ch' },
            leaf('a'),
            { kind: 'section', key: 'sec:k-s', name: '== Sec ==', header: leaf('s'), rows: [
                leaf('b'),
                { kind: 'group', key: 'grp:k-g', name: 'Gamma', cardinality: 'pick-one', guessed: false, header: leaf('g'), options: [leaf('o1'), leaf('o2')] },
                leaf('c'),
                { kind: 'group', key: 'grp:k-p1', name: '', cardinality: 'pick-one-or-more', guessed: false, header: null, options: [leaf('p1'), leaf('p2')] },
            ] },
            { kind: 'section', key: 'sec:k-h', name: 'Hdr', header: leaf('h'), rows: [leaf('d')] },
        ] }],
    };
}

test('searchMatches: content matches ignore case and come back in outline order', () => {
    assert.deepEqual(searchMatches(mkDoc(), 'quick'), ['k-a', 'k-o1']);
    assert.deepEqual(searchMatches(mkDoc(), 'x'), ['k-a', 'k-c']);
});

test('searchMatches: names match too, headings included; a marker matches by its shown name', () => {
    assert.deepEqual(searchMatches(mkDoc(), 'OPT'), ['k-o1', 'k-o2']);
    assert.deepEqual(searchMatches(mkDoc(), 'sec'), ['k-s']);
    assert.deepEqual(searchMatches(mkDoc(), 'hdr'), ['k-h']);
    assert.deepEqual(searchMatches(mkDoc(), 'chathistory'), ['k-ch']);
});

test('searchMatches: an empty or blank query matches nothing; surrounding blanks are ignored', () => {
    assert.deepEqual(searchMatches(mkDoc(), ''), []);
    assert.deepEqual(searchMatches(mkDoc(), '   '), []);
    assert.deepEqual(searchMatches(mkDoc(), '  quick '), ['k-a', 'k-o1']);
    assert.deepEqual(searchMatches(mkDoc(), 'zzz-nothing'), []);
});

test('buildOutline: leaf nodes carry hasContent (non-blank block content)', () => {
    const [seq] = buildOutline(mkDoc()).sequences;
    const [marker, a, sec, hsec] = /** @type {any[]} */ (seq.nodes);
    assert.equal(marker.hasContent, false);
    assert.equal(a.hasContent, true);
    assert.equal(sec.header.hasContent, false);
    const grp = sec.nodes.find((/** @type {any} */ n) => n.type === 'group' && n.header);
    assert.equal(grp.header.hasContent, false, 'whitespace-only content is not content');
    assert.equal(grp.options[0].hasContent, true);
    assert.equal(grp.options[1].hasContent, false);
    assert.equal(hsec.header.hasContent, true);
});
