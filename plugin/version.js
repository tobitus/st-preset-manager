/**
 * The one version string: read from the repo's package.json at runtime.
 * manifest.json is kept equal by test/fix-round.test.js.
 */
import fs from 'node:fs';

/** @type {string} */
export const VERSION = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
