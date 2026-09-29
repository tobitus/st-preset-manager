/**
 * Browser-safe canonical JSON + outline key helpers (no node: imports; the
 * extension loads this through shared/compare.js → shared/outline.js).
 * Zero deps.
 */

/**
 * Deterministic JSON: object keys sorted recursively. Arrays keep order.
 * @param {any} value
 * @returns {string}
 */
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/**
 * New short outline key, mirrors v1 `new_key(prefix)`.
 * @param {string} prefix
 */
export function newKey(prefix) {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
