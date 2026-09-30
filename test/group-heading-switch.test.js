/**
 * In a Nemo-imported document, a pick-one group heading whose block sends
 * text is a choosable member (shared/groups.js counts headings as pick-one
 * members): the outline model flags it `headerSwitch`, its radio takes part
 * in the pick-one set and in "none". Empty headings, pick-many headings and
 * every heading of a non-Nemo document (FF/DEM/Sola: informational text)
 * stay switchless.
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
            L1: { id: 'L1', name: 'One', notes: '', enabled: o.enabled ?? { h: false, b: false, c: true }, overrides: {} },
        },
        activeLoadoutId: 'L1',
    };
}

const groupOf = (/** @type {any} */ d) => /** @type {any} */ (buildOutline(d).sequences[0].nodes[0]);

test('heading switch: pick-one heading with content is a radio member; none counts it', () => {
    let g = groupOf(doc());
    assert.equal(g.headerSwitch, true);
    assert.equal(g.header.switchType, 'radio');
    assert.equal(g.noneOn, false);
    // only the heading on: none is NOT on, no conflict
    g = groupOf(doc({ enabled: { h: true, b: false, c: false } }));
    assert.equal(g.noneOn, false);
    assert.equal(g.conflict, false);
    assert.equal(g.header.enabled, true);
    // nothing on: none is on
    g = groupOf(doc({ enabled: { h: false, b: false, c: false } }));
    assert.equal(g.noneOn, true);
    // heading + option on: conflict
    assert.equal(groupOf(doc({ enabled: { h: true, b: true, c: false } })).conflict, true);
});

test('heading switch: an empty heading and a pick-many heading stay switchless', () => {
    const empty = groupOf(doc({ hContent: '   ', enabled: { h: true, b: false, c: false } }));
    assert.equal(empty.headerSwitch, false);
    assert.equal(empty.noneOn, true, 'an unchoosable heading never un-sets none (unchanged rule)');
    const many = groupOf(doc({ cardinality: 'pick-one-or-more' }));
    assert.equal(many.headerSwitch, false);
    assert.equal(many.noneOn, false);
});

test('heading switch: a content heading in a non-Nemo document stays switchless', () => {
    for (const kind of ['ff5', 'dem', 'sola', 'flat']) {
        const g = groupOf(doc({ kind, enabled: { h: true, b: false, c: false } }));
        assert.equal(g.headerSwitch, false, kind);
        assert.equal(g.noneOn, true, `${kind}: the informational heading never un-sets none`);
        assert.equal(g.conflict, false);
    }
    const noSource = /** @type {any} */ (doc());
    delete noSource.source;
    assert.equal(groupOf(noSource).headerSwitch, false);
});

test('heading switch: choosing the heading selects it and turns the options off; none clears it', () => {
    const d = doc({ enabled: { h: false, b: true, c: false } });
    const g = groupOf(d);
    const ops = pickOneOps(g, 'h');
    assert.deepEqual(ops, [{ op: 'setGroup', group: 'grp:k-h', identifier: 'h' }]);
    for (const { op, ...args } of /** @type {any[]} */ (ops)) applyDocOp(d, op, args);
    assert.deepEqual(d.loadouts.L1.enabled, { h: true, b: false, c: false });
    const after = groupOf(d);
    assert.equal(after.noneOn, false);
    const noneOps = pickOneOps(after, null);
    assert.deepEqual(noneOps, [{ op: 'toggle', identifier: 'h', value: false }]);
    for (const { op, ...args } of /** @type {any[]} */ (noneOps)) applyDocOp(d, op, args);
    assert.deepEqual(d.loadouts.L1.enabled, { h: false, b: false, c: false });
    assert.equal(groupOf(d).noneOn, true);
});
