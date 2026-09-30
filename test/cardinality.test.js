/**
 * setCardinality refusal (temporary 1/N toggle, 2026-09-30):
 *   switching a group TO pick-one is refused (OpError 409) while any
 *   loadout — base map or a per-Model override's effective map — has 2+
 *   of the group's members on (an enabled heading counts). Nothing is ever
 *   switched off; switching to pick-one-or-more always succeeds. After any
 *   successful switch, normalize flips nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDocOp, OpError } from '../shared/docops.js';
import { normalize } from '../shared/groups.js';

const PREFIX = 'more than one option currently selected';
const B = (/** @type {string} */ id) => ({ identifier: id, name: id.toUpperCase(), content: id, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
const off = () => ({ a: false, g: false, o1: false, o2: false, p1: false, p2: false });

/** a, headed group g{o1,o2}, headerless group {p1,p2}; loadouts L1 (active), L2. */
function mkDoc() {
    return {
        activeLoadoutId: 'L1',
        loadouts: {
            L1: { id: 'L1', name: 'L1', notes: '', enabled: off(), overrides: {} },
            L2: { id: 'L2', name: 'L2', notes: '', enabled: off(), overrides: {} },
        },
        markers: [],
        blocks: { a: B('a'), g: B('g'), o1: B('o1'), o2: B('o2'), p1: B('p1'), p2: B('p2') },
        sequences: [{ character_id: 100001, rows: [
            leaf('a'),
            { kind: 'group', key: 'grp:k-g', name: 'G', cardinality: 'pick-one-or-more', guessed: true, header: leaf('g'), options: [leaf('o1'), leaf('o2')] },
            { kind: 'group', key: 'grp:k-p1', name: 'P', cardinality: 'pick-one-or-more', guessed: true, header: null, options: [leaf('p1'), leaf('p2')] },
        ] }],
    };
}

const grpOf = (/** @type {any} */ doc, /** @type {string} */ key) => doc.sequences[0].rows.find((/** @type {any} */ r) => r.key === key);
const loadoutState = (/** @type {any} */ doc) => JSON.stringify(Object.values(doc.loadouts).map((/** @type {any} */ l) => [l.enabled, l.overrides]));

/** Every map compile could see: each loadout's base, and base ⊕ each override's boolean entries. */
function effectiveMaps(/** @type {any} */ doc) {
    /** @type {Record<string, boolean>[]} */
    const maps = [];
    for (const l of Object.values(doc.loadouts)) {
        const L = /** @type {any} */ (l);
        maps.push({ ...L.enabled });
        for (const ov of Object.values(L.overrides ?? {})) {
            const m = { ...L.enabled };
            for (const [id, on] of Object.entries(/** @type {any} */ (ov).enabled ?? {})) if (typeof on === 'boolean') m[id] = on;
            maps.push(m);
        }
    }
    return maps;
}

/** Switch succeeds: cardinality set, guessed false, no enabled bit touched, normalize flips nothing. */
function assertSwitchOk(/** @type {any} */ doc, /** @type {string} */ key, /** @type {string} */ cardinality) {
    const before = loadoutState(doc);
    const res = applyDocOp(doc, 'setCardinality', { key, cardinality });
    assert.deepEqual(res, { key, cardinality });
    const grp = grpOf(doc, key);
    assert.equal(grp.cardinality, cardinality);
    assert.equal(grp.guessed, false);
    assert.equal(loadoutState(doc), before, 'enabled maps must be byte-identical');
    for (const m of effectiveMaps(doc)) {
        /** @type {string[]} */
        const changed = [];
        normalize(doc, m, changed);
        assert.deepEqual(changed, [], 'normalize must flip nothing after a successful switch');
    }
}

/** Switch refused: OpError 409 with exactly `message`; group and every enabled bit untouched. */
function assertRefused(/** @type {any} */ doc, /** @type {string} */ key, /** @type {string} */ message) {
    const before = loadoutState(doc);
    const grpBefore = JSON.stringify(grpOf(doc, key));
    assert.throws(() => applyDocOp(doc, 'setCardinality', { key, cardinality: 'pick-one' }), (/** @type {any} */ e) => {
        assert.ok(e instanceof OpError, 'must be an OpError');
        assert.equal(e.status, 409);
        assert.ok(e.message.startsWith(PREFIX), `message must start with the owner's wording: ${e.message}`);
        assert.equal(e.message, message);
        return true;
    });
    assert.equal(JSON.stringify(grpOf(doc, key)), grpBefore, 'group (cardinality, guessed) must be untouched');
    assert.equal(loadoutState(doc), before, 'no enabled bit may change on refusal');
}

test('1: nothing on -> pick-one succeeds, maps untouched', () => {
    assertSwitchOk(mkDoc(), 'grp:k-g', 'pick-one');
});

test('2: one option on -> pick-one succeeds, maps untouched', () => {
    const doc = mkDoc();
    doc.loadouts.L1.enabled.o1 = true;
    assertSwitchOk(doc, 'grp:k-g', 'pick-one');
});

test('2b: only the heading on -> pick-one succeeds (one member)', () => {
    const doc = mkDoc();
    doc.loadouts.L1.enabled.g = true;
    assertSwitchOk(doc, 'grp:k-g', 'pick-one');
});

test('2c: members of OTHER groups and loose leaves do not count', () => {
    const doc = mkDoc();
    Object.assign(doc.loadouts.L1.enabled, { a: true, o1: true, p1: true, p2: true });
    assertSwitchOk(doc, 'grp:k-g', 'pick-one');
});

test('3: two options on in the active loadout -> 409, plain message, nothing changed', () => {
    const doc = mkDoc();
    Object.assign(doc.loadouts.L1.enabled, { o1: true, o2: true });
    assertRefused(doc, 'grp:k-g', PREFIX);
});

test('4: heading on + one option on -> refused, message says the heading counts', () => {
    const doc = mkDoc();
    Object.assign(doc.loadouts.L1.enabled, { g: true, o2: true });
    assertRefused(doc, 'grp:k-g', `${PREFIX} (the group heading counts)`);
});

test('5: active clean, another loadout has 2 on -> refused naming that loadout', () => {
    const doc = mkDoc();
    Object.assign(doc.loadouts.L2.enabled, { o1: true, o2: true });
    assertRefused(doc, 'grp:k-g', `${PREFIX} in loadout "L2"`);
});

test('5b: other loadout with heading on + option on -> loadout named and heading suffix', () => {
    const doc = mkDoc();
    Object.assign(doc.loadouts.L2.enabled, { g: true, o1: true });
    assertRefused(doc, 'grp:k-g', `${PREFIX} in loadout "L2" (the group heading counts)`);
});

test('6: per-Model override makes a second option on -> refused naming loadout and Model', () => {
    const doc = mkDoc();
    doc.loadouts.L1.enabled.o1 = true;
    /** @type {any} */ (doc.loadouts.L1.overrides).ModelX = { enabled: { o2: true } };
    assertRefused(doc, 'grp:k-g', `${PREFIX} in loadout "L1" for Model "ModelX"`);
});

test('6b: override on a non-active loadout is checked too', () => {
    const doc = mkDoc();
    doc.loadouts.L2.enabled.o2 = true;
    /** @type {any} */ (doc.loadouts.L2.overrides).ModelY = { enabled: { o1: true } };
    assertRefused(doc, 'grp:k-g', `${PREFIX} in loadout "L2" for Model "ModelY"`);
});

test('6c: override turning a base-on option OFF leaves one on -> succeeds', () => {
    const doc = mkDoc();
    doc.loadouts.L1.enabled.o1 = true;
    /** @type {any} */ (doc.loadouts.L1.overrides).ModelX = { enabled: { o1: false, o2: true } };
    assertSwitchOk(doc, 'grp:k-g', 'pick-one');
});

test('6d: non-boolean override values are ignored (compile ignores them) -> succeeds', () => {
    const doc = mkDoc();
    doc.loadouts.L1.enabled.o1 = true;
    /** @type {any} */ (doc.loadouts.L1.overrides).ModelX = { enabled: { o2: null, g: 'yes' } };
    assertSwitchOk(doc, 'grp:k-g', 'pick-one');
});

test('7: pick-one with 2 on -> pick-one-or-more always succeeds, nothing switched off', () => {
    const doc = mkDoc();
    grpOf(doc, 'grp:k-g').cardinality = 'pick-one';
    Object.assign(doc.loadouts.L1.enabled, { g: true, o1: true, o2: true });
    Object.assign(doc.loadouts.L2.enabled, { o1: true, o2: true });
    assertSwitchOk(doc, 'grp:k-g', 'pick-one-or-more');
    assert.equal(doc.loadouts.L1.enabled.o1 && doc.loadouts.L1.enabled.o2 && doc.loadouts.L1.enabled.g, true);
});

test('8a: headerless group, nothing on -> pick-one succeeds by its grp:<first option> key', () => {
    assertSwitchOk(mkDoc(), 'grp:k-p1', 'pick-one');
});

test('8b: headerless group, two options on -> refused, no heading suffix', () => {
    const doc = mkDoc();
    Object.assign(doc.loadouts.L1.enabled, { p1: true, p2: true });
    assertRefused(doc, 'grp:k-p1', PREFIX);
});

test('bad args still 400/404 as before', () => {
    const doc = mkDoc();
    assert.throws(() => applyDocOp(doc, 'setCardinality', { key: 'grp:k-g', cardinality: 'pick-two' }), (/** @type {any} */ e) => e instanceof OpError && e.status === 400);
    assert.throws(() => applyDocOp(doc, 'setCardinality', { key: 'grp:nope', cardinality: 'pick-one' }), (/** @type {any} */ e) => e instanceof OpError && e.status === 404);
});
