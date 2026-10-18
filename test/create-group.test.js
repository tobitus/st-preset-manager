/**
 * Round 3: createGroup hardening. Every refusal happens BEFORE the document
 * is mutated: a section heading or an existing group member/heading never
 * becomes a member; members (heading included) must be adjacent in flat
 * order; the new group must not merge with a neighbouring headerless group in
 * rebuildSeq; pick-one refuses while any loadout / Model override has 2+ of
 * the options on (the heading never counts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq, deriveStructure } from '../shared/outline.js';
import { applyDocOp, OpError } from '../shared/docops.js';
import { ensureDefaultLoadout } from '../plugin/store.js';

const identOf = (/** @type {any} */ leaf) => leaf.ref ?? leaf.identifier;

/**
 * chatHistory(marker), a, a2,
 * s(section){ b, g(group heading){ o1, o2 }, c, (headerless group 'QG'){ q1, q2 } },
 * t(section){ d, e, f }.
 * Every block is named `N <id>`. Bits: all on except c and d.
 */
function mkDoc() {
    const ids = ['a', 'a2', 's', 'b', 'g', 'o1', 'o2', 'c', 'q1', 'q2', 't', 'd', 'e', 'f'];
    const st = {
        prompts: [
            { identifier: 'chatHistory', marker: true },
            ...ids.map((id) => ({ identifier: id, name: `N ${id}`, content: `${id} text`, role: 'system', enabled: true })),
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true },
            ...ids.map((id) => ({ identifier: id, enabled: !['c', 'd'].includes(id) })),
        ] }],
    };
    const doc = importStPreset(st, 'T');
    ensureDefaultLoadout(doc);
    deriveStructure(doc);
    const entries = flattenSeq(doc.sequences[0].rows);
    const at = (/** @type {string} */ id) => {
        const e = entries.find((x) => identOf(x.leaf) === id);
        assert.ok(e, `fixture: ${id} imported`);
        return e;
    };
    for (const e of entries) Object.assign(e, { rank: 'item', gmeta: undefined, sname: undefined });
    const gm = { name: 'G one', cardinality: 'pick-one', guessed: false };
    const qm = { name: 'QG', cardinality: 'pick-one-or-more', guessed: false };
    Object.assign(at('s'), { rank: 'section', sname: 'N s' });
    Object.assign(at('g'), { rank: 'group', gmeta: { ...gm } });
    Object.assign(at('o1'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('o2'), { rank: 'option', gmeta: { ...gm } });
    Object.assign(at('q1'), { rank: 'option', gmeta: { ...qm } });
    Object.assign(at('q2'), { rank: 'option', gmeta: { ...qm } });
    Object.assign(at('t'), { rank: 'section', sname: 'N t' });
    doc.sequences[0].rows = rebuildSeq(entries);
    return doc;
}

/** @param {any} doc @param {string} id */
function keyOf(doc, id) {
    for (const e of flattenSeq(doc.sequences[0].rows)) if (identOf(e.leaf) === id) return e.leaf.key;
    throw new Error(`no leaf ${id}`);
}

/** Flat `rank:id` list of sequence 0. @param {any} doc */
const flatShape = (doc) => flattenSeq(doc.sequences[0].rows).map((e) => `${e.rank}:${identOf(e.leaf)}`);

/** Every loadout's enabled map + overrides. @param {any} doc */
const bits = (doc) => JSON.stringify(Object.values(doc.loadouts).map((/** @type {any} */ l) => [l.id, l.enabled, l.overrides ?? null]));

/** The group (any depth) that lists leaf `id` as an option. @param {any} doc @param {string} id */
function groupWithOption(doc, id) {
    /** @param {any[]} rows @returns {any} */
    const walk = (rows) => {
        for (const r of rows) {
            if (r.kind === 'group' && r.options.some((/** @type {any} */ o) => identOf(o) === id)) return r;
            if (r.kind === 'section') {
                const hit = walk(r.rows);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(doc.sequences[0].rows);
}

/**
 * The op throws an OpError with `status` and a message matching `re`, and the
 * document is deep-equal to its state before the call.
 * @param {any} doc @param {any} args @param {RegExp} re @param {number} [status]
 */
function refuses(doc, args, re, status = 400) {
    const snapshot = structuredClone(doc);
    assert.throws(() => applyDocOp(doc, 'createGroup', args), (/** @type {any} */ err) => {
        assert.ok(err instanceof OpError, `OpError, got ${err?.constructor?.name}: ${err?.message}`);
        assert.equal(err.status, status, `status for "${err.message}"`);
        assert.match(err.message, re);
        return true;
    });
    assert.deepEqual(doc, snapshot, 'document untouched by a refused createGroup');
}

test('fixture shape', () => {
    assert.deepEqual(flatShape(mkDoc()), [
        'item:chatHistory', 'item:a', 'item:a2',
        'section:s', 'item:b', 'group:g', 'option:o1', 'option:o2', 'item:c', 'option:q1', 'option:q2',
        'section:t', 'item:d', 'item:e', 'item:f',
    ]);
});

test('adjacent items + heading -> one group in place, rows never move, bits untouched', () => {
    const doc = mkDoc();
    doc.loadouts[doc.activeLoadoutId].enabled.f = false; // pick-one: only e on among the options
    const before = bits(doc);
    const res = applyDocOp(doc, 'createGroup', { headerKey: keyOf(doc, 'd'), keys: [keyOf(doc, 'e'), keyOf(doc, 'f')], cardinality: 'pick-one' });
    assert.ok(res.groupKey);
    assert.equal(res.options, 2);
    assert.deepEqual(flatShape(doc), [
        'item:chatHistory', 'item:a', 'item:a2',
        'section:s', 'item:b', 'group:g', 'option:o1', 'option:o2', 'item:c', 'option:q1', 'option:q2',
        'section:t', 'group:d', 'option:e', 'option:f',
    ]);
    const g = groupWithOption(doc, 'e');
    assert.equal(g.key, res.groupKey);
    assert.equal(identOf(g.header), 'd');
    assert.equal(g.name, 'N d');
    assert.equal(g.cardinality, 'pick-one');
    assert.equal(g.guessed, false);
    assert.equal(bits(doc), before);
});

test('options come out in document order whatever order the keys are given in', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'createGroup', { keys: [keyOf(doc, 'f'), keyOf(doc, 'd'), keyOf(doc, 'e')], name: 'Rev' });
    const g = groupWithOption(doc, 'd');
    assert.equal(g.header, null);
    assert.equal(g.name, 'Rev');
    assert.deepEqual(g.options.map(identOf), ['d', 'e', 'f']);
    assert.equal(g.cardinality, 'pick-one-or-more', 'default cardinality unchanged');
});

test('top-level adjacent rows (a heading + one option) group in place', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'createGroup', { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'a2')] });
    assert.deepEqual(flatShape(doc).slice(0, 4), ['item:chatHistory', 'group:a', 'option:a2', 'section:s']);
});

test('non-adjacent members -> 400 "selected rows must be adjacent", document untouched', () => {
    // a section heading sits between a2 and b
    let doc = mkDoc();
    refuses(doc, { keys: [keyOf(doc, 'a2'), keyOf(doc, 'b')] }, /selected rows must be adjacent/);
    // d and f with e between them
    doc = mkDoc();
    refuses(doc, { keys: [keyOf(doc, 'd'), keyOf(doc, 'f')], cardinality: 'pick-one-or-more' }, /selected rows must be adjacent/);
    // the heading counts for adjacency too
    doc = mkDoc();
    refuses(doc, { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'e'), keyOf(doc, 'f')] }, /selected rows must be adjacent/);
});

test('a section heading key -> 400 naming the section rule, as member or as heading', () => {
    let doc = mkDoc();
    refuses(doc, { keys: [keyOf(doc, 's'), keyOf(doc, 'b')] }, /a section heading cannot become a group member — unmake the section first/);
    doc = mkDoc();
    refuses(doc, { headerKey: keyOf(doc, 't'), keys: [keyOf(doc, 'd')] }, /a section heading cannot become a group member/);
});

test('an option or the heading of another group -> 400 "already in group" (its displayed name), document untouched', () => {
    // a headed group shows its heading block's name (containerName), not its stale stored name
    let doc = mkDoc();
    refuses(doc, { keys: [keyOf(doc, 'o2'), keyOf(doc, 'c')] }, /"N o2" is already in group "N g" — dissolve it first/);
    doc = mkDoc();
    refuses(doc, { keys: [keyOf(doc, 'b'), keyOf(doc, 'g')] }, /"N g" is already in group "N g" — dissolve it first/);
    doc = mkDoc();
    refuses(doc, { headerKey: keyOf(doc, 'q1'), keys: [] }, /"N q1" is already in group "QG"/);
});

test('a headerless group directly below another group -> 400 asking for a heading', () => {
    const doc = mkDoc();
    // c sits right after the g group: as a headerless group it would fold into it
    refuses(doc, { keys: [keyOf(doc, 'c')], name: 'C' }, /a group without a heading cannot sit directly below another group — pick a heading/);
});

test('a new group directly above a headerless group would swallow it -> 400', () => {
    const doc = mkDoc();
    // c heads a group; the headerless QG options right below would fold into it
    refuses(doc, { headerKey: keyOf(doc, 'c'), keys: [] }, /headerless group below/);
});

test('pick-one with two options on in the root -> 409, document untouched', () => {
    const doc = mkDoc();
    // e and f are both on
    refuses(doc, { keys: [keyOf(doc, 'e'), keyOf(doc, 'f')], cardinality: 'pick-one' }, /^more than one option currently selected/, 409);
    // the same rows as pick-many are fine
    const ok = mkDoc();
    applyDocOp(ok, 'createGroup', { keys: [keyOf(ok, 'e'), keyOf(ok, 'f')], cardinality: 'pick-one-or-more' });
    assert.equal(groupWithOption(ok, 'e').cardinality, 'pick-one-or-more');
});

test('pick-one with two options on only in a Model override -> 409 naming the Model', () => {
    const doc = mkDoc();
    const root = doc.loadouts[doc.activeLoadoutId];
    root.enabled.e = false;
    root.overrides = { M: { enabled: { e: true }, tuning: null } };
    // root: d off, e off, f on -> fine; override M: e on + f on -> refused
    refuses(doc, { keys: [keyOf(doc, 'd'), keyOf(doc, 'e'), keyOf(doc, 'f')], cardinality: 'pick-one' }, /^more than one option currently selected.*for Model "M"/, 409);
});

test('pick-one with the heading on and one option on succeeds (the heading never counts)', () => {
    const doc = mkDoc();
    const root = doc.loadouts[doc.activeLoadoutId];
    root.enabled.d = true;
    root.enabled.f = false;
    const before = bits(doc);
    // heading d on, option e on, option f off
    applyDocOp(doc, 'createGroup', { headerKey: keyOf(doc, 'd'), keys: [keyOf(doc, 'e'), keyOf(doc, 'f')], cardinality: 'pick-one' });
    const g = groupWithOption(doc, 'e');
    assert.equal(g.cardinality, 'pick-one');
    assert.equal(identOf(g.header), 'd');
    assert.equal(bits(doc), before, 'bits untouched');
});

test('markers still refuse membership', () => {
    const doc = mkDoc();
    assert.throws(() => applyDocOp(doc, 'createGroup', { keys: [keyOf(doc, 'chatHistory'), keyOf(doc, 'a')] }), /markers are fixed ST slots/);
});

// ------------------------------------------------- linked: true (displaced modal selection)

/** The group headed by leaf `id` (any depth). @param {any} doc @param {string} id */
function groupHeadedBy(doc, id) {
    /** @param {any[]} rows @returns {any} */
    const walk = (rows) => {
        for (const r of rows) {
            if (r.kind === 'group' && r.header && identOf(r.header) === id) return r;
            if (r.kind === 'section') {
                const hit = walk(r.rows);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(doc.sequences[0].rows);
}

test('linked: the leading run becomes the group in place, later rows become remote in document order; rows never move, bits untouched', () => {
    const doc = mkDoc();
    const before = bits(doc);
    const shape = flatShape(doc);
    const res = applyDocOp(doc, 'createGroup', { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'f'), keyOf(doc, 'a2'), keyOf(doc, 'e')], linked: true });
    const g = groupHeadedBy(doc, 'a');
    assert.ok(g);
    assert.equal(res.groupKey, g.key);
    assert.equal(res.options, 1);
    assert.equal(res.remote, 2);
    assert.deepEqual(g.options.map(identOf), ['a2']);
    assert.deepEqual(g.remote, [keyOf(doc, 'e'), keyOf(doc, 'f')]);
    assert.deepEqual(flatShape(doc), ['item:chatHistory', 'group:a', 'option:a2', ...shape.slice(3)]);
    assert.equal(bits(doc), before);
});

test('linked: a headerless leading run of one row works', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'createGroup', { keys: [keyOf(doc, 'a2'), keyOf(doc, 'e')], name: 'L', linked: true });
    const g = groupWithOption(doc, 'a2');
    assert.equal(g.header, null);
    assert.equal(g.name, 'L');
    assert.deepEqual(g.remote, [keyOf(doc, 'e')]);
});

test('linked: adjacent rows only -> an ordinary group with no remote field', () => {
    const doc = mkDoc();
    const res = applyDocOp(doc, 'createGroup', { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'a2')], linked: true });
    const g = groupHeadedBy(doc, 'a');
    assert.equal('remote' in g, false);
    assert.equal(res.remote, 0);
});

test('without linked, non-adjacent rows are still refused (strict contract unchanged)', () => {
    const doc = mkDoc();
    refuses(doc, { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'a2'), keyOf(doc, 'e')] }, /selected rows must be adjacent/);
    const d2 = mkDoc();
    refuses(d2, { headerKey: keyOf(d2, 'a'), keys: [keyOf(d2, 'a2'), keyOf(d2, 'e')], linked: false }, /selected rows must be adjacent/);
});

test('linked must be a boolean', () => {
    const doc = mkDoc();
    refuses(doc, { keys: [keyOf(doc, 'a2'), keyOf(doc, 'e')], linked: 'yes' }, /createGroup linked must be a boolean/);
});

test('linked: a heading outside the leading run -> 400, untouched', () => {
    const doc = mkDoc();
    refuses(doc, { headerKey: keyOf(doc, 'e'), keys: [keyOf(doc, 'a2')], linked: true }, /the heading must be in the first run of adjacent rows/);
});

test('linked: a section heading or another group\'s heading among the later rows -> 400 naming it, untouched', () => {
    let doc = mkDoc();
    refuses(doc, { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'a2'), keyOf(doc, 't')], linked: true }, /"N t" cannot be linked: it is a section heading/);
    doc = mkDoc();
    refuses(doc, { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'a2'), keyOf(doc, 'g')], linked: true }, /"N g" cannot be linked: it is a group heading/);
});

test('linked: the leading run still obeys round 3 (a section heading / an existing member in the run -> 400)', () => {
    let doc = mkDoc();
    refuses(doc, { keys: [keyOf(doc, 's'), keyOf(doc, 'b'), keyOf(doc, 'e')], linked: true }, /a section heading cannot become a group member/);
    doc = mkDoc();
    refuses(doc, { keys: [keyOf(doc, 'o2'), keyOf(doc, 'c'), keyOf(doc, 'e')], linked: true }, /"N o2" is already in group "N g" — dissolve it first/);
});

test('linked: an option of an ordinary group as a later row is allowed (dual membership)', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'createGroup', { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'a2'), keyOf(doc, 'o1')], linked: true });
    assert.deepEqual(groupHeadedBy(doc, 'a').remote, [keyOf(doc, 'o1')]);
    assert.deepEqual(groupHeadedBy(doc, 'g').options.map(identOf), ['o1', 'o2'], 'o1 stays an option of g');
});

test('linked: a later row already linked to another group -> 400 naming both, untouched', () => {
    const doc = mkDoc();
    applyDocOp(doc, 'createGroup', { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'a2'), keyOf(doc, 'e')], linked: true });
    refuses(doc, { keys: [keyOf(doc, 'b'), keyOf(doc, 'e')], name: 'Other', linked: true }, /"N e" cannot be linked: it is already linked to group "N a"/);
});

test('linked pick-one: the leading option and a later row both on -> 409, untouched; with the later row off it succeeds', () => {
    const doc = mkDoc();
    // a2 and e are both on in the root
    refuses(doc, { headerKey: keyOf(doc, 'a'), keys: [keyOf(doc, 'a2'), keyOf(doc, 'e')], cardinality: 'pick-one', linked: true }, /^more than one option currently selected/, 409);
    const ok = mkDoc();
    ok.loadouts[ok.activeLoadoutId].enabled.e = false;
    applyDocOp(ok, 'createGroup', { headerKey: keyOf(ok, 'a'), keys: [keyOf(ok, 'a2'), keyOf(ok, 'e')], cardinality: 'pick-one', linked: true });
    assert.equal(groupHeadedBy(ok, 'a').cardinality, 'pick-one');
});
