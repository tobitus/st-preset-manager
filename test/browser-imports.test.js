/**
 * The extension is served to the browser as raw ES modules: nothing reachable
 * from index.js may import a `node:` module or a bare package (Phase 5: the
 * Diff tab pulled shared/outline.js, which then imported node:crypto through
 * util.js and would have failed the whole extension load).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');

test('no module reachable from index.js imports node:* or a bare package', () => {
    const seen = new Set();
    /** @type {string[]} */
    const bad = [];
    const walk = (/** @type {string} */ file) => {
        if (seen.has(file) || !fs.existsSync(file)) return; // ST's own modules live outside the repo
        seen.add(file);
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
            const spec = m[1] ?? m[2] ?? m[3];
            if (spec.startsWith('.') || spec.startsWith('/')) walk(path.resolve(path.dirname(file), spec));
            else bad.push(`${path.relative(REPO, file)} -> ${spec}`);
        }
    };
    walk(path.join(REPO, 'index.js'));
    assert.ok(seen.has(path.join(REPO, 'shared/compare.js')), 'the walk reaches the Diff tab\'s shared/compare.js');
    assert.deepEqual(bad, []);
});
