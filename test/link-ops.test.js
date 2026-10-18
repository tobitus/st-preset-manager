/**
 * Displaced modal selection, chunk 2: the linkToGroup / unlink ops, the
 * removeOption refusal for linked members, deleteBlock (op and panel-side)
 * pruning a link, setCardinality counting linked members, createGroup
 * {linked} refusing a marker/ghost among the later rows, and a group copy
 * reporting the linked members it leaves behind (remoteSkipped).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDocOp, OpError, copyPayloadFromDoc, copyIntoDoc } from '../shared/docops.js';
import { collectGroups } from '../shared/groups.js';
import { validateDoc } from '../shared/schema.js';
import { HEADING_SEMANTICS } from '../shared/headings.js';
import { deleteBlockFromDoc } from '../plugin/slot.js';
import { flattenSeq } from '../shared/outline.js';

const B = (/** @type {string} */ id) => ({ identifier: id, name: id.toUpperCase(), content: id, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
const IDS = ['s1', 'h', 'o1', 'x1', 'chatHistory', 's2', 'r1', 'bh', 'p1', 'r2', 'gh'];
const off = () => Object.fromEntries(IDS.map((id) => [id, false]));

/**
 * Sequence 100001:
 *   section S1 (heading s1)
 *     group A (heading h; option o1; remote [r1])  pick-one
 *     x1
 *     marker chatHistory
 *   section S2 (heading s2)
 *     r1                                             (linked to A)
 *     group B (heading bh; options p1, r2)  pick-one
 *     ghost gh
 * Loadouts: R1 (active root), P (playstyle of R1). Every bit off.
 * @returns {any}
 */
function mkDoc() {
    const now = new Date(0).toISOString();
    return {
        format: 'st-preset-manager/library', version: 1, id: 'lo', name: 'link ops', tags: [], notes: '',
        source: { headingSemantics: HEADING_SEMANTICS },
        settings: {}, createdAt: now, updatedAt: now, rev: 1,
        activeLoadoutId: 'R1',
        loadouts: {
            R1: { id: 'R1', name: 'R1', notes: '', kind: 'root', parent: null, enabled: off(), overrides: {} },
            P: { id: 'P', name: 'P', notes: '', kind: 'playstyle', parent: 'R1', enabled: {}, overrides: {} },
        },
        markers: [{ identifier: 'chatHistory', prompt: { identifier: 'chatHistory', marker: true } }],
        blocks: Object.fromEntries(['s1', 'h', 'o1', 'x1', 's2', 'r1', 'bh', 'p1', 'r2'].map((id) => [id, B(id)])),
        sequences: [{ character_id: 100001, rows: [
            { kind: 'section', key: 'sec:k-s1', name: 'S1', header: leaf('s1'), rows: [
                { kind: 'group', key: 'grp:k-h', name: 'A', cardinality: 'pick-one', guessed: false, header: leaf('h'), options: [leaf('o1')], remote: ['k-r1'] },
                leaf('x1'),
                { kind: 'marker', ref: 'chatHistory', key: 'k-chatHistory' },
            ] },
            { kind: 'section', key: 'sec:k-s2', name: 'S2', header: leaf('s2'), rows: [
                leaf('r1'),
                { kind: 'group', key: 'grp:k-bh', name: 'B', cardinality: 'pick-one', guessed: false, header: leaf('bh'), options: [leaf('p1'), leaf('r2')] },
                { kind: 'ghost', identifier: 'gh', key: 'k-gh' },
            ] },
        ] }],
    };
}

const grpA = (/** @type {any} */ doc) => collectGroups(doc).find((g) => g.key === 'grp:k-h');
const grpB = (/** @type {any} */ doc) => collectGroups(doc).find((g) => g.key === 'grp:k-bh');
const bits = (/** @type {any} */ doc) => JSON.stringify(Object.values(doc.loadouts).map((/** @type {any} */ l) => [l.id, l.enabled, l.overrides]));

/**
 * The op throws an OpError with `status` and a message matching `re`, and the
 * document is deep-equal to its state before the call.
 * @param {any} doc @param {string} op @param {any} args @param {RegExp} re @param {number} [status]
 */
function refuses(doc, op, args, re, status = 400) {
    const snapshot = structuredClone(doc);
    assert.throws(() => applyDocOp(doc, op, args), (/** @type {any} */ err) => {
        assert.ok(err instanceof OpError, `OpError, got ${err?.constructor?.name}: ${err?.message}`);
        assert.equal(err.status, status, `status for "${err.message}"`);
        assert.match(err.message, re);
        return true;
    });
    assert.deepEqual(doc, snapshot, `document untouched by a refused ${op}`);
}

test('fixture is valid', () => {
    assert.deepEqual(validateDoc(mkDoc()), []);
});

// ---------------------------------------------------------------- linkToGroup

test('linkToGroup: links rows, keeps the remote list in document order, never touches bits', () => {
    const doc = mkDoc();
    const before = bits(doc);
    const res = applyDocOp(doc, 'linkToGroup', { key: 'grp:k-h', keys: ['k-r2', 'k-x1'] });
    assert.deepEqual(grpA(doc).remote, ['k-x1', 'k-r1', 'k-r2']);
    assert.deepEqual(res, { key: 'grp:k-h', remote: ['k-x1', 'k-r1', 'k-r2'] });
    assert.deepEqual(grpB(doc).options.map((/** @type {any} */ o) => o.ref), ['p1', 'r2'], 'r2 stays an option of B');
    assert.equal(bits(doc), before);
    assert.deepEqual(validateDoc(doc), []);
});

test('linkToGroup: bad arguments -> 400; unknown group / row -> 404; all untouched', () => {
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h' }, /linkToGroup needs \{key, keys\}/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: [] }, /linkToGroup needs \{key, keys\}/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: ['k-x1', 'k-x1'] }, /must not repeat a key/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:nope', keys: ['k-x1'] }, /no group "grp:nope"/, 404);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: ['k-zz'] }, /no row with key "k-zz"/, 404);
});

test('linkToGroup: each ineligible row -> 400 naming it, untouched', () => {
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: ['k-chatHistory'] }, /"chatHistory" cannot be linked: markers are fixed ST slots/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: ['k-gh'] }, /"gh" cannot be linked: order-only entries have no name or content/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: ['k-s2'] }, /"S2" cannot be linked: it is a section heading/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: ['k-bh'] }, /"BH" cannot be linked: it is a group heading/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: ['k-o1'] }, /"O1" cannot be linked: it is already a member of this group/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: ['k-h'] }, /"H" cannot be linked: it is already a member of this group/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-h', keys: ['k-r1'] }, /"R1" cannot be linked: it is already linked to group "H"/);
    refuses(mkDoc(), 'linkToGroup', { key: 'grp:k-bh', keys: ['k-r1'] }, /"R1" cannot be linked: it is already linked to group "H"/);
});

test('linkToGroup: a row of the other sequence -> 400', () => {
    const doc = mkDoc();
    doc.sequences.push({ character_id: 100000, rows: [{ kind: 'block', ref: 'x1', key: 'k2-x1' }] });
    refuses(doc, 'linkToGroup', { key: 'grp:k-h', keys: ['k2-x1'] }, /"X1" cannot be linked: it is not in the group's sequence/);
});

test('linkToGroup on a pick-one group with a member and the new row both on -> 409, untouched', () => {
    const doc = mkDoc();
    doc.loadouts.R1.enabled.o1 = true;
    doc.loadouts.R1.enabled.r2 = true;
    refuses(doc, 'linkToGroup', { key: 'grp:k-h', keys: ['k-r2'] }, /^more than one option currently selected/, 409);
    // a playstyle layer counts too
    const d2 = mkDoc();
    d2.loadouts.R1.enabled.o1 = true;
    d2.loadouts.P.enabled = { x1: true };
    refuses(d2, 'linkToGroup', { key: 'grp:k-h', keys: ['k-x1'] }, /^more than one option currently selected in loadout "P"/, 409);
});

// --------------------------------------------------------------------- unlink

test('unlink: removes the link, omits an empty field, never touches bits', () => {
    const doc = mkDoc();
    doc.loadouts.R1.enabled.r1 = true;
    const before = bits(doc);
    const res = applyDocOp(doc, 'unlink', { key: 'grp:k-h', keys: ['k-r1'] });
    assert.equal('remote' in grpA(doc), false);
    assert.deepEqual(res, { key: 'grp:k-h', remote: [] });
    assert.equal(bits(doc), before);
    assert.deepEqual(validateDoc(doc), []);
});

test('unlink: a row that is not linked to this group -> 400; bad args 400; unknown group 404', () => {
    refuses(mkDoc(), 'unlink', { key: 'grp:k-h', keys: ['k-x1'] }, /"X1" is not linked to this group/);
    refuses(mkDoc(), 'unlink', { key: 'grp:k-bh', keys: ['k-r1'] }, /"R1" is not linked to this group/);
    refuses(mkDoc(), 'unlink', { key: 'grp:k-h', keys: [] }, /unlink needs \{key, keys\}/);
    refuses(mkDoc(), 'unlink', { key: 'grp:nope', keys: ['k-r1'] }, /no group "grp:nope"/, 404);
});

// ------------------------------------------------------------- removeOption

test('removeOption on a linked member -> 400 pointing at unlink, untouched', () => {
    refuses(mkDoc(), 'removeOption', { key: 'k-r1' }, /"R1" is a linked member — use unlink/);
});

test('removeOption on an option of B that is also linked to A drops it from both', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'linkToGroup', { key: 'grp:k-h', keys: ['k-r2'] });
    applyDocOp(doc, 'removeOption', { key: 'k-r2' });
    assert.deepEqual(grpB(doc).options.map((/** @type {any} */ o) => o.ref), ['p1']);
    assert.deepEqual(grpA(doc).remote, ['k-r1']);
    assert.deepEqual(validateDoc(doc), []);
});

// -------------------------------------------------------------- deleteBlock

test('deleteBlock of a linked leaf prunes the link and its loadout bits', () => {
    const doc = mkDoc();
    doc.loadouts.R1.overrides = { M: { enabled: { r1: true }, tuning: null } };
    doc.loadouts.P.enabled = { r1: true };
    applyDocOp(doc, 'deleteBlock', { identifier: 'r1' });
    assert.equal('remote' in grpA(doc), false);
    assert.equal('r1' in doc.loadouts.R1.enabled, false);
    assert.equal('r1' in doc.loadouts.P.enabled, false);
    assert.equal('r1' in doc.loadouts.R1.overrides.M.enabled, false);
    assert.deepEqual(validateDoc(doc), []);
});

test('deleteBlockFromDoc (panel-side delete) prunes the link too', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'linkToGroup', { key: 'grp:k-h', keys: ['k-x1'] });
    deleteBlockFromDoc(doc, 'r1');
    assert.deepEqual(grpA(doc).remote, ['k-x1']);
    deleteBlockFromDoc(doc, 'x1');
    assert.equal('remote' in grpA(doc), false);
    for (const id of ['r1', 'x1']) {
        delete doc.loadouts.R1.enabled[id];
    }
    assert.deepEqual(validateDoc(doc), []);
});

test('deleteBlockFromDoc of a section heading drops the section and every link into it', () => {
    const doc = mkDoc();
    // group A (in S1) links r1, which sits in S2; deleting S2's heading drops S2
    deleteBlockFromDoc(doc, 's2');
    assert.equal(doc.sequences[0].rows.some((/** @type {any} */ r) => r.key === 'sec:k-s2'), false);
    assert.equal('remote' in grpA(doc), false);
    assert.equal(validateDoc(doc).filter((e) => /remote/.test(e)).length, 0, validateDoc(doc).join(' | '));
});

test('deleteBlockFromDoc of a group heading prunes links to rows that did not survive', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'linkToGroup', { key: 'grp:k-h', keys: ['k-r2'] });
    assert.deepEqual(grpA(doc).remote, ['k-r1', 'k-r2']);
    deleteBlockFromDoc(doc, 'bh');
    const present = new Set(flattenSeq(doc.sequences[0].rows).map((/** @type {any} */ e) => e.leaf.key));
    for (const k of grpA(doc).remote ?? []) assert.ok(present.has(k), `dangling ${k}`);
    assert.equal(validateDoc(doc).filter((e) => /remote/.test(e)).length, 0, validateDoc(doc).join(' | '));
});

// ----------------------------------------------------------- setCardinality

test('setCardinality to pick-one counts linked members (409 with an option and a linked member on)', () => {
    const doc = mkDoc();
    grpA(doc).cardinality = 'pick-one-or-more';
    doc.loadouts.R1.enabled.o1 = true;
    doc.loadouts.R1.enabled.r1 = true;
    refuses(doc, 'setCardinality', { key: 'grp:k-h', cardinality: 'pick-one' }, /^more than one option currently selected/, 409);
    doc.loadouts.R1.enabled.r1 = false;
    applyDocOp(doc, 'setCardinality', { key: 'grp:k-h', cardinality: 'pick-one' });
    assert.equal(grpA(doc).cardinality, 'pick-one');
});

// ------------------------------------------- createGroup {linked} on this doc

test('createGroup linked: a marker or a ghost among the later rows -> 400 naming it, untouched', () => {
    refuses(mkDoc(), 'createGroup', { keys: ['k-x1', 'k-chatHistory'], name: 'L', linked: true },
        /"chatHistory" cannot be linked: markers are fixed ST slots|markers are fixed ST slots/);
    refuses(mkDoc(), 'createGroup', { keys: ['k-p1', 'k-gh'], linked: true }, /"P1" is already in group "BH"/);
    refuses(mkDoc(), 'createGroup', { keys: ['k-x1', 'k-gh'], name: 'L', linked: true }, /"gh" cannot be linked: order-only entries have no name or content/);
});

test('createGroup linked: the new group links past a marker into another section', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'unlink', { key: 'grp:k-h', keys: ['k-r1'] });
    const res = applyDocOp(doc, 'createGroup', { headerKey: 'k-x1', keys: ['k-r1'], linked: true });
    const g = collectGroups(doc).find((x) => x.key === res.groupKey);
    assert.equal(g.header.ref, 'x1');
    assert.deepEqual(g.options, []);
    assert.deepEqual(g.remote, ['k-r1']);
    assert.deepEqual(validateDoc(doc), []);
});

// --------------------------------------------------------------------- copy

test('copy a linked group: heading + adjacent options travel, linked members are reported as remoteSkipped', () => {
    const src = mkDoc();
    applyDocOp(src, 'linkToGroup', { key: 'grp:k-h', keys: ['k-r2'] });
    const payload = copyPayloadFromDoc(src, { group: 'grp:k-h' });
    assert.equal(payload.kind, 'group');
    assert.deepEqual(/** @type {any} */ (payload).header.name, 'H');
    assert.deepEqual(/** @type {any} */ (payload).options.map((/** @type {any} */ o) => o.name), ['O1']);
    assert.deepEqual(/** @type {any} */ (payload).remoteSkipped, ['R1', 'R2']);
    const target = mkDoc();
    const res = copyIntoDoc(target, payload, null);
    assert.deepEqual(res.remoteSkipped, ['R1', 'R2']);
    const copied = collectGroups(target).find((g) => g.key === res.group);
    assert.ok(copied);
    assert.equal('remote' in copied, false);
    assert.deepEqual(validateDoc(target), []);
});

test('copy: an ordinary group or a single block reports remoteSkipped: []', () => {
    const src = mkDoc();
    const target = mkDoc();
    const g = copyPayloadFromDoc(src, { group: 'grp:k-bh' });
    assert.equal('remoteSkipped' in g, false);
    assert.deepEqual(copyIntoDoc(target, g, null).remoteSkipped, []);
    const b = copyPayloadFromDoc(src, { identifier: 'x1' });
    assert.deepEqual(copyIntoDoc(target, b, null).remoteSkipped, []);
});

// ------------------------------------------------------------------ setGroup

test('setGroup accepts a linked member: it goes on, the adjacent option goes off (root and playstyle)', () => {
    const doc = mkDoc();
    doc.loadouts.R1.enabled.o1 = true;
    applyDocOp(doc, 'setGroup', { group: 'grp:k-h', identifier: 'r1' });
    assert.equal(doc.loadouts.R1.enabled.r1, true);
    assert.equal(doc.loadouts.R1.enabled.o1, false);
    const d2 = mkDoc();
    d2.loadouts.R1.enabled.o1 = true;
    applyDocOp(d2, 'setGroup', { group: 'grp:k-h', identifier: 'r1', loadoutId: 'P' });
    assert.equal(d2.loadouts.P.enabled.r1, true);
    assert.equal(d2.loadouts.P.enabled.o1, false);
    // a non-member is still refused
    refuses(mkDoc(), 'setGroup', { group: 'grp:k-h', identifier: 'x1' }, /x1 is not a member of group grp:k-h/, 404);
});
