/**
 * Phase 6 review round 1, finding 3: ext/dirty.js createEditGuard — the one
 * "user typed into a text field while its save was in flight" rule shared by
 * the preset notes (Presets tab) and the shelf notes (Shelf tab). A save
 * clears the dirty flag only when nothing was typed and nothing reset the
 * field since the text it saved was taken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditGuard } from '../ext/dirty.js';

test('a save of the current text clears dirty', () => {
    const g = createEditGuard();
    assert.equal(g.dirty, false);
    g.edited();
    assert.equal(g.dirty, true);
    const tok = g.token();
    g.saved(tok);
    assert.equal(g.dirty, false);
});

test('typing after the save started keeps dirty when the save finishes', () => {
    const g = createEditGuard();
    g.edited();
    const tok = g.token();
    g.edited(); // typed while the PATCH was pending
    g.saved(tok);
    assert.equal(g.dirty, true);
    g.saved(g.token());
    assert.equal(g.dirty, false);
});

test('a reset (e.g. another item selected) makes a pending save a no-op, and clears dirty itself', () => {
    const g = createEditGuard();
    g.edited();
    const tok = g.token();
    g.reset();
    assert.equal(g.dirty, false);
    g.edited(); // typing into the newly selected item
    g.saved(tok); // the old item's save completes
    assert.equal(g.dirty, true);
});
