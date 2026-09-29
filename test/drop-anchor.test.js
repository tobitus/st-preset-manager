/**
 * Phase 6 review round 1, finding 2: dropAnchor (ext/tabs/outline.js) maps a
 * drop position in the rendered outline to `{ before, outsideGroup }`:
 * `before` = the key of the first leaf BELOW the drop point (null = end of
 * the outline), `outsideGroup` = the drop point is outside the group that
 * leaf belongs to (it was reached by descending into a HEADERLESS container,
 * whose own row has no key). copyIntoDoc then lands a block above that
 * group instead of inside it.
 *
 * The DOM here is a minimal fake with exactly the properties dropAnchor may
 * use: tagName, classList.contains, dataset, children, parentElement,
 * nextElementSibling. Its shape mirrors ext/tabs/outline.js leafLi/groupLi/
 * sectionLi: li.pm-node[data-key] > (div.pm-row, ul.pm-list > li.pm-node…).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropAnchor } from '../ext/tabs/outline.js';

/** @returns {any} */
function el(/** @type {string} */ tag, /** @type {string[]} */ classes, /** @type {Record<string, string>} */ data = {}, /** @type {any[]} */ children = []) {
    const node = {
        tagName: tag.toUpperCase(),
        classList: { contains: (/** @type {string} */ c) => classes.includes(c) },
        dataset: { ...data },
        children,
        parentElement: null,
        get nextElementSibling() {
            const sibs = this.parentElement?.children ?? [];
            return sibs[sibs.indexOf(this) + 1] ?? null;
        },
    };
    for (const c of children) c.parentElement = node;
    return node;
}
const row = () => el('div', ['pm-row']);
const list = (/** @type {any[]} */ items) => el('ul', ['pm-list'], {}, items);
const leaf = (/** @type {string} */ key) => el('li', ['pm-node'], { kind: 'leaf', key }, [row()]);
const group = (/** @type {string} */ key, /** @type {any[]} */ opts) => el('li', ['pm-node'], { kind: 'group', key }, [row(), list(opts)]);
const section = (/** @type {string} */ key, /** @type {any[]} */ rows) => el('li', ['pm-node'], { kind: 'section', key }, [row(), list(rows)]);
/** the dropped item (a clone of a shelf row) */
const dropped = () => el('li', ['pm-src-item'], { shelfId: 'b_x' }, [row()]);

/**
 * seq list:
 *   a
 *   G  (headed group g: o1, o2)
 *   H  (headerless group: p1, p2)
 *   S1 (section s1: c, headerless group [q1])
 *   S0 (headerless section: [headerless group [r1]], d)
 *   e
 */
function outline() {
    const n = {
        a: leaf('a'), o1: leaf('o1'), o2: leaf('o2'), p1: leaf('p1'), p2: leaf('p2'),
        c: leaf('c'), q1: leaf('q1'), r1: leaf('r1'), d: leaf('d'), e: leaf('e'),
    };
    const G = group('g', [n.o1, n.o2]);
    const H = group('', [n.p1, n.p2]);
    const Q = group('', [n.q1]);
    const S1 = section('s1', [n.c, Q]);
    const R = group('', [n.r1]);
    const S0 = section('', [R, n.d]);
    const seq = list([n.a, G, H, S1, S0, n.e]);
    const root = el('div', ['pm-outline'], {}, [seq]);
    return { ...n, G, H, Q, S1, R, S0, seq, root };
}

/** Put a dropped item into `ul` right before `beforeNode` (null = at the end). */
function dropAt(/** @type {any} */ ul, /** @type {any} */ beforeNode) {
    const d = dropped();
    const i = beforeNode ? ul.children.indexOf(beforeNode) : ul.children.length;
    ul.children.splice(i, 0, d);
    d.parentElement = ul;
    return d;
}
const opts = (/** @type {any} */ g) => g.children[1];

test('drop before a leaf or a headed container: that row, not outside a group', () => {
    const o = outline();
    assert.deepEqual(dropAnchor(dropAt(o.seq, o.a)), { before: 'a', outsideGroup: false });
    const o2 = outline();
    assert.deepEqual(dropAnchor(dropAt(o2.seq, o2.G)), { before: 'g', outsideGroup: false });
    const o3 = outline();
    assert.deepEqual(dropAnchor(dropAt(o3.seq, o3.S1)), { before: 's1', outsideGroup: false });
});

test('drop inside an options list: the next option, inside the group', () => {
    const o = outline();
    assert.deepEqual(dropAnchor(dropAt(opts(o.G), o.o2)), { before: 'o2', outsideGroup: false });
    const o2 = outline();
    assert.deepEqual(dropAnchor(dropAt(opts(o2.H), o2.p1)), { before: 'p1', outsideGroup: false });
    const o3 = outline();
    assert.deepEqual(dropAnchor(dropAt(opts(o3.H), o3.p2)), { before: 'p2', outsideGroup: false });
});

test('drop in the parent list right before a HEADERLESS group: its first option, but outside the group', () => {
    const o = outline();
    assert.deepEqual(dropAnchor(dropAt(o.seq, o.H)), { before: 'p1', outsideGroup: true });
});

test('drop at the end of an options list climbs out; a headerless group next is outside', () => {
    const o = outline();
    assert.deepEqual(dropAnchor(dropAt(opts(o.G), null)), { before: 'p1', outsideGroup: true });
    const o2 = outline();
    // end of H's options -> next is section s1's heading
    assert.deepEqual(dropAnchor(dropAt(opts(o2.H), null)), { before: 's1', outsideGroup: false });
});

test('drop inside a section: before its row; at its end climbs out to the next top-level row', () => {
    const o = outline();
    const rows = (/** @type {any} */ s) => s.children[1];
    assert.deepEqual(dropAnchor(dropAt(rows(o.S1), o.c)), { before: 'c', outsideGroup: false });
    const o2 = outline();
    assert.deepEqual(dropAnchor(dropAt(rows(o2.S1), o2.Q)), { before: 'q1', outsideGroup: true });
    const o3 = outline();
    // end of the headerless group inside s1 -> end of s1 -> next top-level: headerless section
    // whose first leaf is inside a headerless group
    assert.deepEqual(dropAnchor(dropAt(opts(o3.Q), null)), { before: 'r1', outsideGroup: true });
    const o4 = outline();
    assert.deepEqual(dropAnchor(dropAt(rows(o4.S0), null)), { before: 'e', outsideGroup: false });
    const o5 = outline();
    assert.deepEqual(dropAnchor(dropAt(rows(o5.S0), o5.d)), { before: 'd', outsideGroup: false });
});

test('drop before a headerless section whose first row is a plain leaf is not outside a group', () => {
    const o = outline();
    const rows = o.S0.children[1];
    // make S0 start with d
    rows.children.reverse();
    assert.deepEqual(dropAnchor(dropAt(o.seq, o.S0)), { before: 'd', outsideGroup: false });
});

test('drop at the very end of the outline: no anchor', () => {
    const o = outline();
    assert.deepEqual(dropAnchor(dropAt(o.seq, null)), { before: null, outsideGroup: false });
});
