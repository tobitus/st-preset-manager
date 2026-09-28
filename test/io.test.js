/**
 * Import/Export tab pure logic (shared/io.js, browser-safe): how a picked or
 * dropped file becomes a POST /presets body, and the download file names.
 * A non-preset JSON is NOT rejected here — it goes to the server as {st}
 * so the plugin answers the 400 the tab shows (acceptance 10).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importBodyFromFile, exportFileName, NATIVE_FORMAT } from '../shared/io.js';

test('importBodyFromFile: ST preset → {st, name from file name, sourceRef}', () => {
    const st = { prompts: [], prompt_order: [] };
    const r = importBodyFromFile('Sola V2 Flame.json', JSON.stringify(st));
    assert.deepEqual(r, { body: { st, name: 'Sola V2 Flame', sourceRef: 'upload:Sola V2 Flame.json' } });
});

test('importBodyFromFile: only the LAST extension is dropped (ST import rule)', () => {
    const r = importBodyFromFile('FrankenSIM.2.5.Release.1.json', '{"prompts":[],"prompt_order":[]}');
    assert.equal(r.body?.name, 'FrankenSIM.2.5.Release.1');
    const r2 = importBodyFromFile('noext', '{"prompts":[],"prompt_order":[]}');
    assert.equal(r2.body?.name, 'noext');
});

test('importBodyFromFile: native library document → {native}', () => {
    const doc = { format: NATIVE_FORMAT, version: 1, id: 'p_x', name: 'Mine' };
    const r = importBodyFromFile('whatever.pm.json', JSON.stringify(doc));
    assert.deepEqual(r, { body: { native: doc } });
});

test('importBodyFromFile: replace flag rides on both body kinds', () => {
    const st = importBodyFromFile('a.json', '{"prompts":[],"prompt_order":[]}', { replace: true });
    assert.equal(st.body?.replace, true);
    const nat = importBodyFromFile('b.json', JSON.stringify({ format: NATIVE_FORMAT }), { replace: true });
    assert.equal(nat.body?.replace, true);
    const off = importBodyFromFile('a.json', '{"prompts":[],"prompt_order":[]}', { replace: false });
    assert.equal('replace' in (off.body ?? {}), false);
});

test('importBodyFromFile: a non-preset JSON still goes to the server as {st}', () => {
    const arr = [{ scriptName: 'regex' }];
    const r = importBodyFromFile('FF5 Regex 3.0 Suite.json', JSON.stringify(arr));
    assert.deepEqual(r, { body: { st: arr, name: 'FF5 Regex 3.0 Suite', sourceRef: 'upload:FF5 Regex 3.0 Suite.json' } });
});

test('importBodyFromFile: invalid JSON → {error} naming the file, no body', () => {
    const r = importBodyFromFile('broken.json', '{"prompts": [');
    assert.equal(r.body, undefined);
    assert.match(r.error ?? '', /^broken\.json: not valid JSON/);
});

test('exportFileName: st keeps the preset name (ST names imports by file name); native is marked', () => {
    assert.equal(exportFileName('Freaky Frankenstein 5.4 Internal States (2)', 'st'), 'Freaky Frankenstein 5.4 Internal States (2).json');
    assert.equal(exportFileName('Mine', 'native'), 'Mine.pm-library.json');
});

test('exportFileName: path/reserved characters are replaced, never kept', () => {
    const n = exportFileName('a/b\\c:d*e?f"g<h>i|j', 'st');
    assert.doesNotMatch(n, /[\\/:*?"<>|]/);
    assert.equal(n, 'a_b_c_d_e_f_g_h_i_j.json');
});
