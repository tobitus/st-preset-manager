/**
 * Synthesized default group headings (round 3). A group heading is never a
 * pick-one choice, so a group that would otherwise sit directly after another
 * group (and merge with it in `rebuildSeq`) gets a comment-only heading block
 * named after the group. Browser-safe: no `node:` imports.
 */
import { newKey } from './canonical.js';
import { iterLeaves } from './groups.js';

/**
 * `source.headingSemantics` value of a document whose group headings already
 * follow the round-3 rules (a heading is never a pick-one choice). Set by the
 * pre-round-3 Nemo upgrade in `upgradeDoc` and by every import/creation under
 * round-3 code, so the legacy first-member-heading conversion never rewrites
 * a legitimate heading created afterwards.
 */
export const HEADING_SEMANTICS = 'heading-semantics/1';

/** v1 add_option defaults for a fresh ST prompt's fields */
export function defaultFields() {
    return {
        system_prompt: false,
        marker: false,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
        forbid_overrides: false,
    };
}

/**
 * Every identifier already taken in `doc`: block keys, marker identifiers and
 * every leaf ref/identifier. Tolerates missing blocks/markers/sequences.
 * @param {any} doc
 * @returns {Set<string>}
 */
export function usedIdentifiers(doc) {
    /** @type {Set<string>} */
    const used = new Set();
    if (doc?.blocks && typeof doc.blocks === 'object') {
        for (const k of Object.keys(doc.blocks)) used.add(k);
    }
    if (Array.isArray(doc?.markers)) {
        for (const m of doc.markers) if (typeof m?.identifier === 'string') used.add(m.identifier);
    }
    for (const leaf of iterLeaves(doc ?? {})) {
        const id = leaf?.ref ?? leaf?.identifier;
        if (typeof id === 'string') used.add(id);
    }
    return used;
}

/**
 * Mint a fresh `pmh-xxxxxxxx` identifier not in `used`, and add it to `used`.
 * @param {Set<string>} used
 * @returns {string}
 */
export function headingId(used) {
    for (;;) {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
        const id = 'pmh-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        if (!used.has(id)) {
            used.add(id);
            return id;
        }
    }
}

/**
 * A comment-only heading block (sends nothing).
 * @param {string} identifier
 * @param {string} name
 */
export function makeHeadingBlock(identifier, name) {
    const safe = String(name).replace(/[{}]/g, '');
    return {
        identifier,
        name,
        content: `{{// ${safe} }}{{trim}}`,
        role: 'system',
        fields: defaultFields(),
        notes: '',
    };
}

/**
 * Give every headerless group that directly follows another group a default
 * heading, in `rows` and recursively in every section's rows (not group
 * options). Mutates in place.
 * @param {any[]} rows
 * @param {Record<string, any>} blocks
 * @param {Set<string>} used
 * @param {string[]} notes
 * @param {string} label
 * @param {any} [source] the document's `source` object, stamped with
 *   `headingSemantics` when a heading is synthesized
 */
export function headGroupsAfterGroups(rows, blocks, used, notes, label, source) {
    for (let i = 0; i < rows.length; i++) {
        const g = rows[i];
        if (g?.kind === 'section' && Array.isArray(g.rows)) headGroupsAfterGroups(g.rows, blocks, used, notes, label, source);
        const prev = rows[i - 1];
        if (i > 0 && g?.kind === 'group' && g.header == null && prev?.kind === 'group') {
            const id = headingId(used);
            blocks[id] = makeHeadingBlock(id, g.name);
            g.header = { kind: 'block', ref: id, key: newKey('row'), enabled: true };
            if (source && typeof source === 'object') source.headingSemantics = HEADING_SEMANTICS;
            notes.push(
                `${label}: group '${g.name}' directly follows group '${prev.name}'; ` +
                    `it gets a default heading '${g.name}' (comment-only, sends nothing) so the groups stay apart`,
            );
        }
    }
}
