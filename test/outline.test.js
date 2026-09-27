/**
 * Outline flatten/rebuild round-trip + invariants (Phase 1 slice of the v1
 * smoke suite; rank ops are Phase 2 but reuse exactly these functions).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenSeq, rebuildSeq, OutlineError } from '../shared/outline.js';
import { importStPreset } from '../shared/recognizers.js';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');

function loadPreset(rel) {
    for (const base of [
        path.join(process.env.HOME ?? '', 'projects/sillysystem/st/data/default-user/OpenAI Settings'),
        path.join(REPO, 'dev/fixtures/presets'),
    ]) {
        const c = path.join(base, rel);
        if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
    }
    return null;
}

const leaf = (kind, id, enabled, key) => (kind === 'ghost' ? { kind, identifier: id, enabled, key } : { kind, ref: id, enabled, key });

test('flatten -> rebuild is the identity on nested rows (container keys re-derived)', () => {
    const rows = [
        leaf('block', 'a', true, 'k1'),
        {
            kind: 'section', key: 'sec:k2', name: 'S', header: leaf('block', 'h', false, 'k2'),
            rows: [
                leaf('block', 'b', true, 'k3'),
                {
                    kind: 'group', key: 'grp:k4', name: 'G', cardinality: 'pick-one', guessed: false,
                    header: leaf('block', 'gh', true, 'k4'),
                    options: [leaf('block', 'o1', true, 'k5'), leaf('block', 'o2', false, 'k6')],
                },
            ],
        },
        leaf('marker', 'chatHistory', true, 'k7'),
    ];
    const once = rebuildSeq(flattenSeq(rows));
    // container keys are DERIVED from headings; a trailing item after a
    // section re-attaches into it (v1 semantics: groups/sections end only at
    // the next heading). The leaf sequence is what must be identical.
    const onceFlat = flattenSeq(once).map((e) => e.leaf);
    const origFlat = flattenSeq(rows).map((e) => e.leaf);
    assert.deepEqual(onceFlat, origFlat);
    const twice = rebuildSeq(flattenSeq(once));
    assert.deepEqual(twice, once);
});

test('flatten preserves compile order and enabled bits on real presets', () => {
    const st = loadPreset('Freaky Frankenstein 5.4 Internal States (2).json');
    if (!st) return;
    const doc = importStPreset(st, 'FF54');
    for (const seq of doc.sequences) {
        const flat = flattenSeq(seq.rows);
        const rebuilt = rebuildSeq(flat);
        // container keys are derived (grp:<heading key>), so compare leaves + ranks
        const flat2 = flattenSeq(rebuilt);
        assert.deepEqual(flat2.map((e) => e.leaf), flat.map((e) => e.leaf));
        assert.deepEqual(flat2.map((e) => e.rank), flat.map((e) => e.rank));
    }
});

test('rebuild derives container keys from headings (pure function of entries)', () => {
    const rows1 = [
        { kind: 'group', key: 'whatever', name: 'G', cardinality: 'pick-one', guessed: true, header: leaf('block', 'h', true, 'k9'), options: [leaf('block', 'o', false, 'k10')] },
    ];
    const out = rebuildSeq(flattenSeq(rows1));
    assert.equal(out[0].key, 'grp:k9');
    const rows2 = [{ kind: 'section', key: 'x', name: 'S', header: leaf('block', 'sh', false, 'k11'), rows: [leaf('block', 'i', true, 'k12')] }];
    const out2 = rebuildSeq(flattenSeq(rows2));
    assert.equal(out2[0].key, 'sec:k11');
});

test('markers refuse to be headings or options (v1 rule)', () => {
    const marker = leaf('marker', 'chatHistory', true, 'k1');
    assert.throws(() => rebuildSeq([{ leaf: marker, rank: 'group', gmeta: null, sname: null }]), OutlineError);
    assert.throws(() => rebuildSeq([{ leaf: marker, rank: 'option', gmeta: null, sname: null }]), OutlineError);
    assert.throws(() => rebuildSeq([{ leaf: marker, rank: 'section', gmeta: null, sname: null }]), OutlineError);
    // but items are fine
    assert.equal(rebuildSeq([{ leaf: marker, rank: 'item', gmeta: null, sname: null }])[0].kind, 'marker');
});

test('headerless option runs re-form as headerless groups', () => {
    const entries = [
        { leaf: leaf('block', 'o1', true, 'k1'), rank: 'option', gmeta: { name: 'G', cardinality: 'pick-one', guessed: false }, sname: null },
        { leaf: leaf('block', 'o2', false, 'k2'), rank: 'option', gmeta: { name: 'G', cardinality: 'pick-one', guessed: false }, sname: null },
    ];
    const out = rebuildSeq(entries);
    assert.equal(out[0].kind, 'group');
    assert.equal(out[0].header, null);
    assert.equal(out[0].key, 'grp:k1');
    assert.equal(out[0].options.length, 2);
});
