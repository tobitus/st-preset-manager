/**
 * Displaced modal selection, chunk 1 (model core): a group row may carry
 * `remote: string[]` — row keys of block leaves elsewhere in the SAME
 * sequence that count as members of the group. The field survives every
 * flatten -> rebuild, is pruned by rebuildSeq's post-pass, is written only
 * when non-empty, and every member funnel (pickOneMembers -> normalize,
 * completeOverride, effectiveEnabled, inheritResetKeys) treats linked
 * members as ordinary members. validateDoc checks the keys; upgradeDoc
 * leaves a linked doc byte-identical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenSeq, rebuildSeq, promote, demote, moveLeaf, deriveStructure } from '../shared/outline.js';
import { normalize, completeOverride, pickOneMembers, collectGroups, groupOfLeaf } from '../shared/groups.js';
import { effectiveEnabled, inheritResetKeys } from '../shared/loadouts.js';
import { validateDoc, upgradeDoc, nativeShapeErrors } from '../shared/schema.js';
import { applyDocOp } from '../shared/docops.js';
import { HEADING_SEMANTICS } from '../shared/headings.js';

const B = (/** @type {string} */ id) => ({ identifier: id, name: id.toUpperCase(), content: id, role: 'system', fields: {}, notes: '' });
const leaf = (/** @type {string} */ id) => ({ kind: 'block', ref: id, key: `k-${id}` });
const IDS = ['s1', 'h', 'o1', 'x1', 'chatHistory', 's2', 'r1', 'bh', 'p1', 'r2', 'gh'];
const off = () => Object.fromEntries(IDS.map((id) => [id, false]));

/**
 * Sequence 100001, in canonical (rebuildSeq) shape and key order:
 *   section S1 (heading s1)
 *     group A (heading h; option o1; remote [r1, r2])  pick-one
 *     x1
 *     marker chatHistory
 *   section S2 (heading s2)
 *     r1                                                 (linked to A)
 *     group B (heading bh; options p1, r2)  pick-one     (r2 also linked to A)
 *     ghost gh
 * Loadouts: R1 (active root), P (playstyle of R1).
 * @returns {any}
 */
function mkDoc() {
    const now = new Date(0).toISOString();
    return {
        format: 'st-preset-manager/library', version: 1, id: 'lg', name: 'linked groups', tags: [], notes: '',
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
                { kind: 'group', key: 'grp:k-h', name: 'A', cardinality: 'pick-one', guessed: false, header: leaf('h'), options: [leaf('o1')], remote: ['k-r1', 'k-r2'] },
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

const rowsOf = (/** @type {any} */ doc) => doc.sequences[0].rows;
const grpA = (/** @type {any} */ doc) => collectGroups(doc).find((g) => g.key === 'grp:k-h');
const grpB = (/** @type {any} */ doc) => collectGroups(doc).find((g) => g.key === 'grp:k-bh');
const rebuild = (/** @type {any[]} */ rows) => rebuildSeq(flattenSeq(rows));
/** The fixture with every `remote` field removed (an ordinary, pre-feature document). */
function plainDoc() {
    const doc = mkDoc();
    delete grpA(doc).remote;
    return doc;
}
/** fixture with A.remote replaced by `remote` (and optionally B.remote). */
function withRemote(/** @type {any} */ remote, /** @type {any} */ bRemote = undefined) {
    const doc = mkDoc();
    grpA(doc).remote = remote;
    if (bRemote !== undefined) grpB(doc).remote = bRemote;
    return doc;
}

// ------------------------------------------------------------- (i) round trip

test('(i) fixture is a valid document; plain variant too', () => {
    assert.deepEqual(validateDoc(mkDoc()), []);
    assert.deepEqual(validateDoc(plainDoc()), []);
});

test('(i) flattenSeq -> rebuildSeq is byte-identical and keeps remote', () => {
    const doc = mkDoc();
    const before = JSON.stringify(rowsOf(doc));
    const rows = rebuild(rowsOf(doc));
    assert.deepEqual(rows, rowsOf(doc));
    assert.equal(JSON.stringify(rows), before);
    const a = rows[0].rows[0];
    assert.deepEqual(a.remote, ['k-r1', 'k-r2']);
    assert.notEqual(a.remote, grpA(doc).remote, 'rebuilt remote must be a fresh array (no aliasing)');
    // twice is still identical
    assert.equal(JSON.stringify(rebuild(rows)), before);
});

test('(i) a document without remote round-trips with no remote field anywhere', () => {
    const doc = plainDoc();
    const before = JSON.stringify(rowsOf(doc));
    const rows = rebuild(rowsOf(doc));
    assert.equal(JSON.stringify(rows), before);
    assert.equal(JSON.stringify(rows).includes('remote'), false);
});

test('(i) flat entries of a plain group carry no remote in gmeta (gmeta signature unchanged)', () => {
    const entries = flattenSeq(rowsOf(plainDoc()));
    for (const e of entries) {
        if (e.gmeta) assert.deepEqual(Object.keys(e.gmeta).sort(), ['cardinality', 'guessed', 'name']);
    }
    const linked = flattenSeq(rowsOf(mkDoc()));
    const h = linked.find((e) => e.leaf.key === 'k-h');
    const o1 = linked.find((e) => e.leaf.key === 'k-o1');
    assert.deepEqual(h.gmeta.remote, ['k-r1', 'k-r2']);
    assert.deepEqual(o1.gmeta.remote, ['k-r1', 'k-r2']);
});

// ----------------------------------------------------------------- (ii) prune

test('(ii) pruning drops own header/option, marker, ghost, section heading, group heading, unknown key; keeps order of the rest', () => {
    const doc = withRemote(['k-zz', 'k-r2', 'k-o1', 'k-h', 'k-chatHistory', 'k-gh', 'k-s2', 'k-bh', 'k-r1']);
    const rows = rebuild(rowsOf(doc));
    assert.deepEqual(rows[0].rows[0].remote, ['k-r2', 'k-r1']);
});

test('(ii) pruning drops a key already remote in an earlier group, and a repeated key in the same group', () => {
    const doc = withRemote(['k-r1', 'k-r1'], ['k-r1', 'k-x1']);
    const rows = rebuild(rowsOf(doc));
    assert.deepEqual(rows[0].rows[0].remote, ['k-r1']);
    assert.deepEqual(rows[1].rows[1].remote, ['k-x1'], 'B keeps x1 (an item above B is fine), loses r1 (A has it)');
});

test('(ii) an empty pruning result omits the field', () => {
    for (const remote of [['k-o1', 'k-zz'], []]) {
        const rows = rebuild(rowsOf(withRemote(remote)));
        assert.equal('remote' in rows[0].rows[0], false, JSON.stringify(remote));
    }
});

test('(ii) deriveStructure prunes a key whose leaf was deleted', () => {
    const doc = mkDoc();
    rowsOf(doc)[1].rows.splice(0, 1); // drop r1's row
    deriveStructure(doc);
    assert.deepEqual(grpA(doc).remote, ['k-r2']);
});

// ---------------------------------------------------------- (iii) structural ops

test('(iii) promote(o1) + demote(o1) restores remote byte-identically, also through JSON persistence', () => {
    const doc = mkDoc();
    const before = JSON.stringify(doc);
    promote(doc, 'k-o1');
    assert.deepEqual(grpA(doc).remote, ['k-r1', 'k-r2'], 'heading-only group keeps its links');
    const persisted = JSON.parse(JSON.stringify(doc));
    const cloned = structuredClone(doc);
    demote(doc, 'k-o1');
    demote(persisted, 'k-o1');
    demote(cloned, 'k-o1');
    assert.equal(JSON.stringify(doc), before);
    assert.equal(JSON.stringify(persisted), before);
    assert.equal(JSON.stringify(cloned), before);
});

test('(iii) promote(h) to section + demote(h) restores the linked group byte-identically', () => {
    const doc = mkDoc();
    const before = JSON.stringify(doc);
    promote(doc, 'k-h');
    const persisted = JSON.parse(JSON.stringify(doc));
    demote(persisted, 'k-h');
    assert.equal(JSON.stringify(persisted), before);
});

test('(iii) moveLeaf of the remote leaf keeps the link; moving back is byte-identical', () => {
    const doc = mkDoc();
    const before = JSON.stringify(doc);
    moveLeaf(doc, 'k-r1', +1);
    assert.deepEqual(rowsOf(doc)[1].rows.map((/** @type {any} */ r) => r.key), ['grp:k-bh', 'k-r1', 'k-gh']);
    assert.deepEqual(grpA(doc).remote, ['k-r1', 'k-r2']);
    moveLeaf(doc, 'k-r1', -1);
    assert.equal(JSON.stringify(doc), before);
});

test('(iii) dissolving the group (gmeta = null rebuild) drops the links', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'dissolveGroup', { key: 'grp:k-h' });
    assert.equal(grpA(doc), undefined);
    for (const g of collectGroups(doc)) assert.equal('remote' in g, false);
    assert.equal(JSON.stringify(rowsOf(doc)).includes('remote'), false);
});

// -------------------------------------------------------------- (iv) normalize

test('pickOneMembers: options then remote leaves in remote order; groupOfLeaf sees remote members', () => {
    const doc = mkDoc();
    assert.deepEqual(pickOneMembers(doc, grpA(doc)).map((l) => l.ref), ['o1', 'r1', 'r2']);
    assert.deepEqual(pickOneMembers(doc, grpB(doc)).map((l) => l.ref), ['p1', 'r2']);
    const owner = groupOfLeaf(doc);
    assert.equal(owner.get('r1'), grpA(doc));
    assert.equal(owner.get('r2'), grpA(doc), 'first group listing r2 (A walks before B)');
    assert.equal(owner.get('p1'), grpB(doc));
    // an unresolvable key contributes nothing
    const d2 = withRemote(['k-zz', 'k-r1']);
    assert.deepEqual(pickOneMembers(d2, grpA(d2)).map((l) => l.ref), ['o1', 'r1']);
});

test('(iv) normalize: o1 and r1 on -> exactly one survives; preferred wins', () => {
    const doc = mkDoc();
    let en = { ...off(), o1: true, r1: true };
    /** @type {string[]} */
    let changed = [];
    normalize(doc, en, changed);
    assert.equal(en.o1, false);
    assert.equal(en.r1, true);
    assert.deepEqual(changed, ['o1']);
    en = { ...off(), o1: true, r1: true };
    changed = [];
    normalize(doc, en, changed, 'o1');
    assert.equal(en.o1, true);
    assert.equal(en.r1, false);
    assert.deepEqual(changed, ['r1']);
});

test('(iv) normalize: r2 (remote of A, option of B) gets both rules, exhaustively', () => {
    const doc = mkDoc();
    const ids = ['o1', 'r1', 'r2', 'p1'];
    for (let mask = 0; mask < 16; mask++) {
        for (const pref of [null, ...ids]) {
            const en = off();
            ids.forEach((id, i) => { en[id] = !!(mask & (1 << i)); });
            const before = { ...en };
            normalize(doc, en, undefined, pref);
            const tag = `mask=${mask} pref=${pref}`;
            assert.ok(['o1', 'r1', 'r2'].filter((id) => en[id]).length <= 1, `A ≤1 ${tag}`);
            assert.ok(['p1', 'r2'].filter((id) => en[id]).length <= 1, `B ≤1 ${tag}`);
            for (const id of IDS) if (!before[id]) assert.equal(en[id], false, `never switches on ${id} ${tag}`);
            if (pref && before[pref]) assert.equal(en[pref], true, `preferred stays on ${tag}`);
        }
    }
});

test('(iv) normalize: a remote identifier is not skipped because an earlier group (other sequence) already counted it', () => {
    const doc = mkDoc();
    // sequence 100000 first: ordinary pick-one group {x1, r1} walks before A
    doc.sequences.unshift({ character_id: 100000, rows: [
        { kind: 'group', key: 'grp:k0-x1', name: 'G0', cardinality: 'pick-one', guessed: false, header: null,
            options: [{ kind: 'block', ref: 'x1', key: 'k0-x1' }, { kind: 'block', ref: 'r1', key: 'k0-r1' }] },
    ] });
    const en = { ...off(), o1: true, r1: true };
    normalize(doc, en);
    assert.equal([en.o1, en.r1].filter(Boolean).length, 1, 'A must still collapse o1/r1');
});

/** Frozen copy of normalize as of 2.2.1 (pickOneMembers = options). */
function oldNormalize(/** @type {any} */ doc, /** @type {Record<string, boolean>} */ enabled, /** @type {string[]|undefined} */ changedOut = undefined, /** @type {any} */ preferred = null) {
    const seen = new Set();
    for (const grp of collectGroups(doc)) {
        if (grp.cardinality !== 'pick-one') continue;
        const members = [...(grp.options ?? [])];
        const idents = members
            .map((l) => l.ref ?? l.identifier)
            .filter((id) => id != null && !seen.has(id));
        for (const id of idents) seen.add(id);
        const on = idents.filter((id) => !!enabled[id]);
        if (on.length > 1) {
            const pref = preferred instanceof Set
                ? on.filter((id) => preferred.has(id))
                : preferred != null && on.includes(preferred) ? [preferred] : [];
            const keep = pref.length ? pref[pref.length - 1] : on[on.length - 1];
            for (const id of on) {
                if (id !== keep) {
                    enabled[id] = false;
                    changedOut?.push(id);
                }
            }
        }
    }
    return enabled;
}

test('(iv) normalize on documents without remote is identical to the 2.2.1 normalize', () => {
    const single = plainDoc();
    const dual = plainDoc();
    // F-066: the same identifiers listed by a group of the other sequence
    dual.sequences.push({ character_id: 100000, rows: [
        { kind: 'group', key: 'grp:k0-p1', name: 'G0', cardinality: 'pick-one', guessed: false, header: null,
            options: [{ kind: 'block', ref: 'p1', key: 'k0-p1' }, { kind: 'block', ref: 'o1', key: 'k0-o1' }, { kind: 'block', ref: 'x1', key: 'k0-x1' }] },
    ] });
    const ids = ['o1', 'r1', 'r2', 'p1', 'x1'];
    for (const doc of [single, dual]) {
        for (let mask = 0; mask < 32; mask++) {
            for (const pref of [null, ...ids, new Set(['o1', 'p1']), new Set(['x1'])]) {
                const en = off();
                ids.forEach((id, i) => { en[id] = !!(mask & (1 << i)); });
                const a = { ...en };
                const b = { ...en };
                /** @type {string[]} */ const ca = [];
                /** @type {string[]} */ const cb = [];
                normalize(doc, a, ca, pref);
                oldNormalize(doc, b, cb, pref);
                assert.deepEqual(a, b, `mask=${mask}`);
                assert.deepEqual(ca, cb, `mask=${mask}`);
            }
        }
    }
});

// ------------------------------------------------------- (v) completeOverride

test('(v) completeOverride collapses across o1 / r1 / r2', () => {
    const doc = mkDoc();
    assert.deepEqual(completeOverride(doc, { o1: true, r1: true }), { o1: false, r1: true, r2: false });
    assert.deepEqual(completeOverride(doc, { r1: true }), { o1: false, r1: true, r2: false });
    assert.deepEqual(completeOverride(doc, { x1: true }), { x1: true });
});

// ---------------------------------------- (vi) effectiveEnabled / inheritResetKeys

test('(vi) effectiveEnabled: a playstyle switching r1 on turns the root\'s o1 off, sourced from the layer', () => {
    const doc = mkDoc();
    doc.loadouts.R1.enabled.o1 = true;
    doc.loadouts.P.enabled = { r1: true };
    const { enabled, source } = effectiveEnabled(doc, 'P');
    assert.equal(enabled.o1, false);
    assert.equal(enabled.r1, true);
    assert.equal(source.r1, 'loadout');
    assert.equal(source.o1, 'loadout');
});

test('(vi) effectiveEnabled: a per-Model override switching r2 on turns the root\'s o1 off', () => {
    const doc = mkDoc();
    doc.loadouts.R1.enabled.o1 = true;
    doc.loadouts.R1.overrides = { M: { enabled: { r2: true }, tuning: null } };
    const { enabled, source } = effectiveEnabled(doc, 'R1', 'M');
    assert.equal(enabled.o1, false);
    assert.equal(enabled.r2, true);
    assert.equal(source.o1, 'override');
});

test('(vi) inheritResetKeys covers options and linked members', () => {
    const doc = mkDoc();
    assert.deepEqual(inheritResetKeys(doc, 'r1'), ['o1', 'r1', 'r2']);
    assert.deepEqual(inheritResetKeys(doc, 'o1'), ['o1', 'r1', 'r2']);
    assert.deepEqual(inheritResetKeys(doc, 'p1'), ['p1', 'r2']);
    assert.deepEqual(inheritResetKeys(doc, 'x1'), ['x1']);
});

// ------------------------------------------------------------ (vii) validateDoc

const A_PATH = 'sequences[0].rows[0].rows[0]';

test('(vii) validateDoc rejects each bad remote with a path and a reason', () => {
    /** @type {[any, string][]} */
    const cases = [
        [['k-o1'], `${A_PATH}.remote[0] (own member)`],
        [['k-h'], `${A_PATH}.remote[0] (own member)`],
        [['k-chatHistory'], `${A_PATH}.remote[0] (marker)`],
        [['k-gh'], `${A_PATH}.remote[0] (ghost)`],
        [['k-s2'], `${A_PATH}.remote[0] (heading)`],
        [['k-bh'], `${A_PATH}.remote[0] (heading)`],
        [['k-zz'], `${A_PATH}.remote[0] (unknown)`],
        [['k-r1', 'k-r1'], `${A_PATH}.remote[1] (duplicate)`],
        [[5], `${A_PATH}.remote[0] (not a string)`],
        ['k-r1', `${A_PATH}.remote`],
    ];
    for (const [remote, want] of cases) {
        const errs = validateDoc(withRemote(remote));
        assert.ok(errs.includes(want), `${JSON.stringify(remote)} -> ${JSON.stringify(errs)}`);
    }
});

test('(vii) validateDoc: a key already remote in an earlier group is a duplicate', () => {
    const errs = validateDoc(withRemote(['k-r1', 'k-r2'], ['k-r1']));
    assert.ok(errs.includes('sequences[0].rows[1].rows[1].remote[0] (duplicate)'), JSON.stringify(errs));
});

test('(vii) validateDoc: a key of a leaf in the OTHER sequence is unknown (same sequence only)', () => {
    const doc = withRemote(['k-r1', 'k2-r1']);
    doc.sequences.push({ character_id: 100000, rows: [{ kind: 'block', ref: 'r1', key: 'k2-r1' }] });
    const errs = validateDoc(doc);
    assert.ok(errs.includes(`${A_PATH}.remote[1] (unknown)`), JSON.stringify(errs));
});

test('(vii) validateDoc accepts remote: [] and a doc with no remote at all', () => {
    assert.deepEqual(validateDoc(withRemote([])), []);
    assert.deepEqual(validateDoc(plainDoc()), []);
});

test('(vii) nativeShapeErrors reports remote type errors', () => {
    const doc = withRemote('k-r1');
    assert.ok(nativeShapeErrors(doc).includes(`${A_PATH}.remote`));
    assert.deepEqual(nativeShapeErrors(mkDoc()), []);
});

// ------------------------------------------------------------- (viii) upgradeDoc

test('(viii) upgradeDoc leaves a linked doc byte-identical and is idempotent', () => {
    const doc = mkDoc();
    const before = JSON.stringify(doc);
    upgradeDoc(doc);
    assert.equal(JSON.stringify(doc), before);
    upgradeDoc(doc);
    assert.equal(JSON.stringify(doc), before);
    assert.deepEqual(validateDoc(doc), []);
});
