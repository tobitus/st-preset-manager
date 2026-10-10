/**
 * Round 2 B3: the outline follows the picker's loadout and shows inheritance.
 * buildOutline(doc, loadoutId, modelName) resolves through effectiveEnabled;
 * a playstyle row whose bit comes from the root is `inherited`, one the
 * playstyle sets itself is `explicit`; a root has neither. pickOneOps carries
 * the outline's loadoutId on every op it emits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutline, pickOneOps } from '../ext/outline-model.js';

const B = (/** @type {string} */ id) => ({ identifier: id, name: id.toUpperCase(), content: `content ${id}`, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });

/**
 * a, b, c, then a headerless pick-one group {o1,o2}.
 * R (root, active): a on, o1 on. P (playstyle of R): b on, o2 on + o1 off
 * (the completeOverride shape a sparse pick-one write stores).
 * P × M override: a off.
 * @returns {any}
 */
function mkDoc() {
    return {
        blocks: Object.fromEntries(['a', 'b', 'c', 'o1', 'o2'].map((id) => [id, B(id)])),
        markers: [],
        sequences: [{ character_id: 100001, rows: [
            leaf('a'), leaf('b'), leaf('c'),
            { kind: 'group', key: 'grp:k-o1', name: 'G', cardinality: 'pick-one', guessed: false, header: null, options: [leaf('o1'), leaf('o2')] },
        ] }],
        loadouts: {
            R: { id: 'R', name: 'Root', notes: '', kind: 'root', parent: null, enabled: { a: true, b: false, c: false, o1: true, o2: false }, overrides: {} },
            P: { id: 'P', name: 'Play', notes: '', kind: 'playstyle', parent: 'R', enabled: { b: true, o2: true, o1: false }, overrides: { M: { enabled: { a: false }, tuning: null } } },
        },
        activeLoadoutId: 'R',
    };
}

/** @param {any} model @returns {Record<string, any>} identifier -> leaf node */
function leaves(model) {
    /** @type {Record<string, any>} */
    const out = {};
    const walk = (/** @type {any[]} */ nodes) => {
        for (const n of nodes) {
            if (n.type === 'leaf') out[n.identifier] = n;
            else if (n.type === 'group') { if (n.header) out[n.header.identifier] = n.header; for (const o of n.options) out[o.identifier] = o; }
            else if (n.type === 'section') { if (n.header) out[n.header.identifier] = n.header; walk(n.nodes); }
        }
    };
    for (const seq of model.sequences) walk(seq.nodes);
    return out;
}

/** @param {Record<string, any>} ls @param {string} key @returns {Record<string, any>} */
const pick = (ls, key) => Object.fromEntries(Object.entries(ls).map(([id, n]) => [id, n[key]]));

test('buildOutline on a playstyle: effective bits, inherited vs explicit per row', () => {
    const ls = leaves(buildOutline(mkDoc(), 'P'));
    assert.deepEqual(pick(ls, 'enabled'), { a: true, b: true, c: false, o1: false, o2: true });
    assert.deepEqual(pick(ls, 'inherited'), { a: true, b: false, c: true, o1: false, o2: false });
    assert.deepEqual(pick(ls, 'explicit'), { a: false, b: true, c: false, o1: true, o2: true });
});

test('buildOutline on a root: raw bits, nothing inherited or explicit', () => {
    const ls = leaves(buildOutline(mkDoc(), 'R'));
    assert.deepEqual(pick(ls, 'enabled'), { a: true, b: false, c: false, o1: true, o2: false });
    assert.deepEqual(pick(ls, 'inherited'), { a: false, b: false, c: false, o1: false, o2: false });
    assert.deepEqual(pick(ls, 'explicit'), { a: false, b: false, c: false, o1: false, o2: false });
});

test('buildOutline defaults to the active loadout and no Model', () => {
    const doc = mkDoc();
    assert.deepEqual(buildOutline(doc), buildOutline(doc, 'R'));
    doc.activeLoadoutId = 'P';
    assert.deepEqual(buildOutline(doc), buildOutline(doc, 'P', null));
});

test('buildOutline with a Model applies that loadout override (neither inherited nor explicit)', () => {
    const ls = leaves(buildOutline(mkDoc(), 'P', 'M'));
    assert.equal(ls.a.enabled, false);
    assert.equal(ls.a.inherited, false);
    assert.equal(ls.a.explicit, false);
    assert.equal(ls.b.enabled, true);
    assert.equal(ls.c.inherited, true);
});

test('buildOutline follows the root live: a root change shows through an inherited playstyle row', () => {
    const doc = mkDoc();
    doc.loadouts.R.enabled.c = true;
    const ls = leaves(buildOutline(doc, 'P'));
    assert.equal(ls.c.enabled, true);
    assert.equal(ls.c.inherited, true);
});

test('buildOutline: the pick-one group of a playstyle never shows two on (no conflict)', () => {
    const model = buildOutline(mkDoc(), 'P');
    const grp = model.sequences[0].nodes.find((/** @type {any} */ n) => n.type === 'group');
    assert.equal(/** @type {any} */ (grp).conflict, false);
});

test('buildOutline on an unknown loadout id renders every switch off (structure-only callers)', () => {
    const ls = leaves(buildOutline(mkDoc(), 'nope'));
    assert.deepEqual(pick(ls, 'enabled'), { a: false, b: false, c: false, o1: false, o2: false });
    assert.deepEqual(pick(ls, 'inherited'), { a: false, b: false, c: false, o1: false, o2: false });
});

test('buildOutline keeps a stored pick-one conflict visible (no normalization in the view)', () => {
    const doc = mkDoc();
    doc.loadouts.R.enabled.o2 = true; // o1 and o2 both on in the root
    const grp = /** @type {any} */ (buildOutline(doc, 'R').sequences[0].nodes.find((/** @type {any} */ n) => n.type === 'group'));
    assert.equal(grp.conflict, true);
    assert.deepEqual(grp.options.map((/** @type {any} */ o) => o.enabled), [true, true]);
});

test('pickOneOps carries loadoutId on every op when given', () => {
    const grp = /** @type {any} */ (buildOutline(mkDoc(), 'P').sequences[0].nodes.find((/** @type {any} */ n) => n.type === 'group'));
    assert.deepEqual(pickOneOps(grp, 'o1', 'P'), [{ op: 'setGroup', group: 'grp:k-o1', identifier: 'o1', loadoutId: 'P' }]);
    assert.deepEqual(pickOneOps(grp, null, 'P'), [{ op: 'toggle', identifier: 'o2', value: false, loadoutId: 'P' }]);
    // without a loadoutId the ops are unchanged (no key at all)
    assert.deepEqual(pickOneOps(grp, 'o1'), [{ op: 'setGroup', group: 'grp:k-o1', identifier: 'o1' }]);
});
