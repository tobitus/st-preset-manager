/**
 * A group heading is an ordinary checkbox and never a pick-one member, for
 * every recognizer kind: it does not take part in conflict, "none" or
 * setGroup. A comment-only heading is flagged `commentOnly` (the row renders
 * no switch); an empty heading has no content and keeps its checkbox flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutline, pickOneOps } from '../ext/outline-model.js';
import { applyDocOp } from '../shared/docops.js';

/**
 * @param {{ hContent?: string, cardinality?: string, enabled?: Record<string, boolean>, kind?: string }} [o]
 */
function doc(o = {}) {
    return {
        source: { recognizer: { kind: o.kind ?? 'nemo', notes: [] } },
        blocks: {
            h: { identifier: 'h', name: 'Q one', content: o.hContent ?? 'heading text', role: 'system', fields: {}, notes: '' },
            b: { identifier: 'b', name: 'Q two', content: 'bb', role: 'system', fields: {}, notes: '' },
            c: { identifier: 'c', name: 'Q three', content: 'cc', role: 'system', fields: {}, notes: '' },
        },
        markers: [],
        sequences: [{
            character_id: 100001,
            rows: [{
                kind: 'group', key: 'grp:k-h', name: 'Q', cardinality: o.cardinality ?? 'pick-one', guessed: false,
                header: { kind: 'block', ref: 'h', key: 'k-h' },
                options: [{ kind: 'block', ref: 'b', key: 'k-b' }, { kind: 'block', ref: 'c', key: 'k-c' }],
            }],
        }],
        loadouts: {
            L1: { id: 'L1', name: 'One', notes: '', kind: 'root', parent: null, enabled: o.enabled ?? { h: false, b: false, c: true }, overrides: {} },
        },
        activeLoadoutId: 'L1',
    };
}

const groupOf = (/** @type {any} */ d) => /** @type {any} */ (buildOutline(d).sequences[0].nodes[0]);

test('heading: a checkbox and never a member, for every recognizer kind and both cardinalities', () => {
    for (const kind of ['nemo', 'sola3', 'ff5', 'dem', 'sola', 'casus', 'flat']) {
        for (const cardinality of ['pick-one', 'pick-one-or-more']) {
            const label = `${kind}/${cardinality}`;
            let g = groupOf(doc({ kind, cardinality }));
            assert.equal('headerSwitch' in g, false, label);
            assert.equal(g.header.switchType, 'checkbox', label);
            assert.equal(g.header.commentOnly, false, label);
            // only the heading on: none is on (pick-one), never a conflict
            g = groupOf(doc({ kind, cardinality, enabled: { h: true, b: false, c: false } }));
            assert.equal(g.noneOn, cardinality === 'pick-one', label);
            assert.equal(g.conflict, false, label);
            assert.equal(g.header.enabled, true, label);
            // heading + one option on: no conflict
            g = groupOf(doc({ kind, cardinality, enabled: { h: true, b: true, c: false } }));
            assert.equal(g.conflict, false, label);
            assert.equal(g.noneOn, false, label);
        }
    }
    const noSource = /** @type {any} */ (doc());
    delete noSource.source;
    assert.equal(groupOf(noSource).header.switchType, 'checkbox');
});

test('heading: comment-only is flagged (no switch rendered); empty is no content', () => {
    const silent = groupOf(doc({ hContent: '{{// Q }}{{trim}}' }));
    assert.equal(silent.header.commentOnly, true);
    assert.equal(silent.header.hasContent, false);
    const empty = groupOf(doc({ hContent: '   ', enabled: { h: true, b: false, c: false } }));
    assert.equal(empty.header.commentOnly, false);
    assert.equal(empty.header.hasContent, false);
    assert.equal(empty.noneOn, true);
});

test('heading: setGroup refuses it; toggle switches it alone; none leaves it on', () => {
    const d = doc({ enabled: { h: false, b: true, c: false } });
    assert.throws(() => applyDocOp(d, 'setGroup', { group: 'grp:k-h', identifier: 'h' }), (/** @type {any} */ e) => e.status === 400);
    applyDocOp(d, 'toggle', { identifier: 'h', value: true });
    assert.deepEqual(d.loadouts.L1.enabled, { h: true, b: true, c: false });
    const ops = pickOneOps(groupOf(d), 'c');
    assert.deepEqual(ops, [{ op: 'setGroup', group: 'grp:k-h', identifier: 'c' }]);
    for (const { op, ...args } of /** @type {any[]} */ (ops)) applyDocOp(d, op, args);
    assert.deepEqual(d.loadouts.L1.enabled, { h: true, b: false, c: true });
    const noneOps = pickOneOps(groupOf(d), null);
    assert.deepEqual(noneOps, [{ op: 'toggle', identifier: 'c', value: false }]);
    for (const { op, ...args } of /** @type {any[]} */ (noneOps)) applyDocOp(d, op, args);
    assert.deepEqual(d.loadouts.L1.enabled, { h: true, b: false, c: false });
    assert.equal(groupOf(d).noneOn, true);
});
