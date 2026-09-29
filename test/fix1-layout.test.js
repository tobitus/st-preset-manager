/**
 * Fix round 1, items 5 and 10: saved window rects and floating-button
 * positions are clamped back on screen before they are applied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampRect, clampPoint } from '../ext/layout.js';

const VP = { width: 1500, height: 950 };

test('clampRect: an on-screen rect is unchanged', () => {
    assert.deepEqual(clampRect({ left: 100, top: 50, width: 800, height: 600 }, VP), { left: 100, top: 50, width: 800, height: 600 });
});

test('clampRect: a rect hanging off the right/bottom edge is pulled back in, size kept', () => {
    assert.deepEqual(clampRect({ left: 1400, top: 900, width: 800, height: 600 }, VP), { left: 700, top: 350, width: 800, height: 600 });
});

test('clampRect: negative coordinates clamp to 0', () => {
    assert.deepEqual(clampRect({ left: -300, top: -50, width: 800, height: 600 }, VP), { left: 0, top: 0, width: 800, height: 600 });
});

test('clampRect: a rect larger than the viewport shrinks to it', () => {
    assert.deepEqual(clampRect({ left: 10, top: 10, width: 2000, height: 1200 }, VP), { left: 0, top: 0, width: 1500, height: 950 });
});

test('clampRect: a rect below the minimum size grows to it (360x220 by default)', () => {
    assert.deepEqual(clampRect({ left: 10, top: 10, width: 100, height: 50 }, VP), { left: 10, top: 10, width: 360, height: 220 });
    assert.deepEqual(clampRect({ left: 10, top: 10, width: 100, height: 50 }, VP, { width: 200, height: 100 }), { left: 10, top: 10, width: 200, height: 100 });
});

test('clampRect: malformed input returns null', () => {
    for (const bad of [null, undefined, 'x', {}, { left: 'a', top: 0, width: 800, height: 600 }, { left: 0, top: 0, width: NaN, height: 600 }, { left: 0, top: Infinity, width: 800, height: 600 }]) {
        assert.equal(clampRect(/** @type {any} */ (bad), VP), null, JSON.stringify(bad));
    }
});

test('clampPoint: keeps a box of the given size fully on screen', () => {
    const size = { width: 40, height: 40 };
    assert.deepEqual(clampPoint({ left: 2000, top: 20 }, size, VP), { left: 1460, top: 20 });
    assert.deepEqual(clampPoint({ left: -5, top: -5 }, size, VP), { left: 0, top: 0 });
    assert.deepEqual(clampPoint({ left: 300, top: 5000 }, size, VP), { left: 300, top: 910 });
    assert.deepEqual(clampPoint({ left: 300, top: 400 }, size, VP), { left: 300, top: 400 });
});

test('clampPoint: malformed input returns null', () => {
    for (const bad of [null, {}, { left: 'a', top: 0 }, { left: 0, top: NaN }]) {
        assert.equal(clampPoint(/** @type {any} */ (bad), { width: 40, height: 40 }, VP), null, JSON.stringify(bad));
    }
});
