/**
 * Hashing + id helpers. Zero deps.
 * canonicalJson and newKey live in ./canonical.js (browser-safe, no
 * node: imports).
 */
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from './canonical.js';

/**
 * sha256 hex digest of the canonical JSON of `value`.
 * @param {any} value
 */
export function canonicalHash(value) {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * ULID-ish id: monotonic enough for one process, sortable by time.
 * Format: p_<10 char time><16 char random> for presets, arbitrary prefix.
 * @param {string} [prefix]
 */
export function newId(prefix = 'p') {
    let time = Date.now();
    let timePart = '';
    for (let i = 0; i < 10; i++) {
        timePart = ENCODE32[time % 32] + timePart;
        time = Math.floor(time / 32);
    }
    return `${prefix}_${timePart}${randomBytes(10).toString('base64url').slice(0, 16).replace(/[-_]/g, 'x')}`;
}

const ENCODE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID-style id used for documents (stable, sortable).
 * @returns {string} e.g. "01Jxxxxxxxxxxxxxxxxxxxxxxx"
 */
export function ulid() {
    let time = Date.now();
    let timePart = '';
    for (let i = 0; i < 10; i++) {
        timePart = ENCODE32[time % 32] + timePart;
        time = Math.floor(time / 32);
    }
    // 80 bits of randomness in Crockford base32
    const bytes = randomBytes(10);
    let acc = 0n;
    for (const b of bytes) acc = (acc << 8n) | BigInt(b);
    let randPart = '';
    for (let i = 0; i < 16; i++) {
        randPart = ENCODE32[Number(acc & 31n)] + randPart;
        acc >>= 5n;
    }
    return timePart + randPart;
}
