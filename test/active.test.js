/**
 * "What is SillyTavern running" labels (ext/active.js): the window header
 * line and the per-tab not-active notice, both derived from GET /slot's
 * `desired` ({presetId, loadoutId}) where a null loadoutId means the
 * document's active loadout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { activeLabel, activeNotice } from '../ext/active.js';

const items = [
    { id: 'p1', name: 'Nemo', activeLoadoutId: 'l1', loadouts: [{ id: 'l1', name: 'Default' }, { id: 'l2', name: 'Alt' }] },
    { id: 'p2', name: '<b>DEM</b> & "Co"', activeLoadoutId: 'm1', loadouts: [{ id: 'm1', name: '<i>Main</i>' }] },
];

test('activeLabel: empty slot reads "none"', () => {
    assert.deepEqual(activeLabel(items, { presetId: null, loadoutId: null }), { presetId: null, text: 'Active in SillyTavern: none' });
    assert.deepEqual(activeLabel(items, null), { presetId: null, text: 'Active in SillyTavern: none' });
    assert.deepEqual(activeLabel(items, undefined), { presetId: null, text: 'Active in SillyTavern: none' });
});

test('activeLabel: null desired loadout falls back to the preset\'s active loadout', () => {
    assert.deepEqual(activeLabel(items, { presetId: 'p1', loadoutId: null }), { presetId: 'p1', text: 'Active in SillyTavern: Nemo · Default' });
});

test('activeLabel: a desired loadout other than the active one is named', () => {
    assert.deepEqual(activeLabel(items, { presetId: 'p1', loadoutId: 'l2' }), { presetId: 'p1', text: 'Active in SillyTavern: Nemo · Alt' });
});

test('activeLabel: names are returned raw (HTML characters are not escaped here; the DOM sets textContent)', () => {
    assert.equal(activeLabel(items, { presetId: 'p2', loadoutId: 'm1' }).text, 'Active in SillyTavern: <b>DEM</b> & "Co" · <i>Main</i>');
});

test('activeLabel: an unknown loadout id drops the loadout part; an unknown preset shows its id', () => {
    assert.equal(activeLabel(items, { presetId: 'p1', loadoutId: 'gone' }).text, 'Active in SillyTavern: Nemo');
    assert.deepEqual(activeLabel(items, { presetId: 'px', loadoutId: null }), { presetId: 'px', text: 'Active in SillyTavern: px' });
});

const doc = { id: 'p1', name: 'Nemo', activeLoadoutId: 'l1', loadouts: { l1: { id: 'l1', name: 'Default' }, l2: { id: 'l2', name: '<u>Alt</u>' } } };

test('activeNotice: another preset (or none) in the slot -> "Not active in SillyTavern"', () => {
    assert.equal(activeNotice('p1', doc, { presetId: 'p2', loadoutId: 'm1' }), 'Not active in SillyTavern');
    assert.equal(activeNotice('p1', doc, { presetId: null, loadoutId: null }), 'Not active in SillyTavern');
    assert.equal(activeNotice('p1', doc, null), 'Not active in SillyTavern');
});

test('activeNotice: this preset with its active loadout (explicit or null) -> no notice', () => {
    assert.equal(activeNotice('p1', doc, { presetId: 'p1', loadoutId: 'l1' }), null);
    assert.equal(activeNotice('p1', doc, { presetId: 'p1', loadoutId: null }), null);
});

test('activeNotice: this preset with a different loadout in the slot names that loadout (raw)', () => {
    assert.equal(activeNotice('p1', doc, { presetId: 'p1', loadoutId: 'l2' }), 'Active in SillyTavern with loadout <u>Alt</u>');
    assert.equal(activeNotice('p1', doc, { presetId: 'p1', loadoutId: 'gone' }), 'Active in SillyTavern with loadout gone');
});
