/**
 * Round 3 item 1: a group heading is never a pick-one choice, whatever its
 * content. Compile's normalize, completeOverride, effectiveEnabled,
 * inheritResetKeys, setCardinality's refusal and the outline model all count
 * OPTIONS only; a heading that sends text stays on beside the chosen option
 * and renders an ordinary checkbox; setGroup refuses the heading.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, completeOverride, groupOfLeaf, pickOneMembers } from '../shared/groups.js';
import { effectiveEnabled, inheritResetKeys } from '../shared/loadouts.js';
import { applyDocOp, OpError } from '../shared/docops.js';
import { buildOutline, pickOneOps } from '../ext/outline-model.js';
import { compile } from '../shared/compile.js';
import { validateDoc } from '../shared/schema.js';

const PREFIX = 'more than one option currently selected';
const B = (/** @type {string} */ id, /** @type {string} */ content) => ({ identifier: id, name: id.toUpperCase(), content, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
const off = () => ({ a: false, h: false, o1: false, o2: false });

/**
 * a, then group g{heading h (sends text); options o1, o2}. Loadouts: R1
 * (active root), R2 (root), P (playstyle of R1). `hContent` replaces h's text.
 * @param {{ cardinality?: string, hContent?: string }} [o]
 */
function mkDoc(o = {}) {
    const now = new Date(0).toISOString();
    return {
        format: 'st-preset-manager/library', version: 1, id: 'p1', name: 'heading test', tags: [], notes: '', source: null,
        settings: {}, createdAt: now, updatedAt: now, rev: 1,
        activeLoadoutId: 'R1',
        loadouts: {
            R1: { id: 'R1', name: 'R1', notes: '', kind: 'root', parent: null, enabled: off(), overrides: {} },
            R2: { id: 'R2', name: 'R2', notes: '', kind: 'root', parent: null, enabled: off(), overrides: {} },
            P: { id: 'P', name: 'P', notes: '', kind: 'playstyle', parent: 'R1', enabled: {}, overrides: {} },
        },
        markers: [],
        blocks: { a: B('a', 'loose'), h: B('h', o.hContent ?? 'Pick one.'), o1: B('o1', 'one'), o2: B('o2', 'two') },
        sequences: [{ character_id: 100001, rows: [
            leaf('a'),
            { kind: 'group', key: 'grp:k-h', name: 'G', cardinality: o.cardinality ?? 'pick-one', guessed: false, header: leaf('h'), options: [leaf('o1'), leaf('o2')] },
        ] }],
    };
}

const grpOf = (/** @type {any} */ doc) => doc.sequences[0].rows[1];
const groupNodeOf = (/** @type {any} */ doc, /** @type {string} */ lid = doc.activeLoadoutId) =>
    /** @type {any} */ (buildOutline(doc, lid).sequences[0].nodes[1]);

test('fixture is a valid document', () => {
    assert.deepEqual(validateDoc(mkDoc()), []);
});

test('pickOneMembers / groupOfLeaf: options only, never the heading', () => {
    const doc = mkDoc();
    assert.deepEqual(pickOneMembers(doc, grpOf(doc)).map((l) => l.ref), ['o1', 'o2']);
    const owner = groupOfLeaf(doc);
    assert.equal(owner.has('h'), false);
    assert.equal(owner.get('o1'), grpOf(doc));
    assert.equal(owner.get('o2'), grpOf(doc));
});

test('(i) normalize: heading + one option on flips nothing; heading + both options keeps o2 and the heading', () => {
    const doc = mkDoc();
    /** @type {string[]} */
    const changed = [];
    const en = { a: false, h: true, o1: true, o2: false };
    normalize(doc, en, changed);
    assert.deepEqual(changed, []);
    assert.deepEqual(en, { a: false, h: true, o1: true, o2: false });
    /** @type {string[]} */
    const changed2 = [];
    const en2 = { a: false, h: true, o1: true, o2: true };
    normalize(doc, en2, changed2);
    assert.deepEqual(changed2, ['o1']);
    assert.deepEqual(en2, { a: false, h: true, o1: false, o2: true });
});

test('(ii) completeOverride: the heading is left as given', () => {
    const doc = mkDoc();
    assert.deepEqual(completeOverride(doc, { h: true, o1: true }), { h: true, o1: true, o2: false });
    assert.deepEqual(completeOverride(doc, { h: true }), { h: true });
});

test('(iii) effectiveEnabled: root with heading + option on keeps both, source root', () => {
    const doc = mkDoc();
    Object.assign(doc.loadouts.R1.enabled, { h: true, o1: true });
    const { enabled, source } = effectiveEnabled(doc, 'R1', null);
    assert.equal(enabled.h, true);
    assert.equal(enabled.o1, true);
    assert.equal(enabled.o2, false);
    assert.equal(source.h, 'root');
    assert.equal(source.o1, 'root');
    // a playstyle choosing o2 switches o1 off, never the heading
    doc.loadouts.P.enabled = { o2: true };
    const p = effectiveEnabled(doc, 'P', null).enabled;
    assert.deepEqual([p.h, p.o1, p.o2], [true, false, true]);
});

test('(iv) inheritResetKeys: the heading alone; an option takes its sibling options', () => {
    const doc = mkDoc();
    assert.deepEqual(inheritResetKeys(doc, 'h'), ['h']);
    assert.deepEqual(inheritResetKeys(doc, 'o1'), ['o1', 'o2']);
});

test('(v) setCardinality pick-one with heading + one option on succeeds (active, other root, override); two options still 409', () => {
    const cases = [
        (/** @type {any} */ d) => Object.assign(d.loadouts.R1.enabled, { h: true, o1: true }),
        (/** @type {any} */ d) => Object.assign(d.loadouts.R2.enabled, { h: true, o2: true }),
        (/** @type {any} */ d) => { d.loadouts.R1.enabled.o1 = true; d.loadouts.R1.overrides.M = { enabled: { h: true }, tuning: null }; },
        (/** @type {any} */ d) => { d.loadouts.P.enabled = { h: true, o2: true }; },
    ];
    for (const [i, setup] of cases.entries()) {
        const doc = mkDoc({ cardinality: 'pick-one-or-more' });
        setup(doc);
        const before = JSON.stringify(doc.loadouts);
        assert.deepEqual(applyDocOp(doc, 'setCardinality', { key: 'grp:k-h', cardinality: 'pick-one' }), { key: 'grp:k-h', cardinality: 'pick-one' }, `case ${i}`);
        assert.equal(grpOf(doc).cardinality, 'pick-one');
        assert.equal(JSON.stringify(doc.loadouts), before, `case ${i}: no bit changed`);
    }
    const doc = mkDoc({ cardinality: 'pick-one-or-more' });
    Object.assign(doc.loadouts.R1.enabled, { h: true, o1: true, o2: true });
    assert.throws(() => applyDocOp(doc, 'setCardinality', { key: 'grp:k-h', cardinality: 'pick-one' }), (/** @type {any} */ e) => {
        assert.ok(e instanceof OpError);
        assert.equal(e.status, 409);
        assert.equal(e.message, PREFIX);
        return true;
    });
    const doc2 = mkDoc({ cardinality: 'pick-one-or-more' });
    Object.assign(doc2.loadouts.R2.enabled, { o1: true, o2: true });
    assert.throws(() => applyDocOp(doc2, 'setCardinality', { key: 'grp:k-h', cardinality: 'pick-one' }), (/** @type {any} */ e) => e.status === 409 && e.message === `${PREFIX} in loadout "R2"`);
});

test('(vi) setGroup on the heading is refused 400; on an option it leaves the heading alone', () => {
    const doc = mkDoc();
    const before = JSON.stringify(doc);
    assert.throws(() => applyDocOp(doc, 'setGroup', { group: 'grp:k-h', identifier: 'h' }), (/** @type {any} */ e) => {
        assert.ok(e instanceof OpError);
        assert.equal(e.status, 400);
        assert.equal(e.message, 'the group heading is not a choice — use toggle');
        return true;
    });
    assert.equal(JSON.stringify(doc), before);
    doc.loadouts.R1.enabled.h = true;
    doc.loadouts.R1.enabled.o1 = true;
    applyDocOp(doc, 'setGroup', { group: 'grp:k-h', identifier: 'o2' });
    assert.deepEqual(doc.loadouts.R1.enabled, { a: false, h: true, o1: false, o2: true });
    // a non-member still 404
    assert.throws(() => applyDocOp(doc, 'setGroup', { group: 'grp:k-h', identifier: 'a' }), (/** @type {any} */ e) => e.status === 404);
    // toggle on the heading flips only the heading
    applyDocOp(doc, 'toggle', { identifier: 'h', value: false });
    assert.deepEqual(doc.loadouts.R1.enabled, { a: false, h: false, o1: false, o2: true });
});

test('(vii) buildOutline: the heading is a checkbox; conflict/noneOn count options only; none never lists the heading', () => {
    const doc = mkDoc();
    Object.assign(doc.loadouts.R1.enabled, { h: true, o1: true });
    let g = groupNodeOf(doc);
    assert.equal(g.header.switchType, 'checkbox');
    assert.equal(g.header.commentOnly, false);
    assert.equal(g.header.hasContent, true);
    assert.equal('headerSwitch' in g, false, 'headerSwitch is gone');
    assert.deepEqual(g.options.map((/** @type {any} */ o) => o.switchType), ['radio', 'radio']);
    assert.equal(g.conflict, false);
    assert.equal(g.noneOn, false);
    assert.deepEqual(pickOneOps(g, null), [{ op: 'toggle', identifier: 'o1', value: false }]);
    // only the heading on: none is on, no conflict
    doc.loadouts.R1.enabled.o1 = false;
    g = groupNodeOf(doc);
    assert.equal(g.noneOn, true);
    assert.equal(g.conflict, false);
    assert.deepEqual(pickOneOps(g, null), []);
    // two options on: conflict
    Object.assign(doc.loadouts.R1.enabled, { o1: true, o2: true });
    assert.equal(groupNodeOf(doc).conflict, true);
    // comment-only heading: flagged commentOnly, still no member
    const c = mkDoc({ hContent: '{{// G }}{{trim}}' });
    Object.assign(c.loadouts.R1.enabled, { h: true, o2: true });
    const cg = groupNodeOf(c);
    assert.equal(cg.header.commentOnly, true);
    assert.equal(cg.header.switchType, 'checkbox');
    assert.equal(cg.conflict, false);
    assert.equal(cg.noneOn, false);
    // pick-many: heading and options are checkboxes, never a conflict
    const m = mkDoc({ cardinality: 'pick-one-or-more' });
    Object.assign(m.loadouts.R1.enabled, { h: true, o1: true, o2: true });
    const mg = groupNodeOf(m);
    assert.equal(mg.header.switchType, 'checkbox');
    assert.deepEqual(mg.options.map((/** @type {any} */ o) => o.switchType), ['checkbox', 'checkbox']);
    assert.equal(mg.conflict, false);
});

test('(viii) compile: heading + one option on -> both sent', () => {
    const doc = mkDoc();
    Object.assign(doc.loadouts.R1.enabled, { h: true, o2: true });
    const { compiled } = compile(doc, null, {});
    const order = Object.fromEntries(compiled.prompt_order[0].order.map((/** @type {any} */ o) => [o.identifier, o.enabled]));
    assert.deepEqual(order, { a: false, h: true, o1: false, o2: true });
    // heading + both options: the heading stays, the last option wins
    Object.assign(doc.loadouts.R1.enabled, { o1: true });
    const { compiled: c2 } = compile(doc, null, {});
    const order2 = Object.fromEntries(c2.prompt_order[0].order.map((/** @type {any} */ o) => [o.identifier, o.enabled]));
    assert.deepEqual(order2, { a: false, h: true, o1: false, o2: true });
});
