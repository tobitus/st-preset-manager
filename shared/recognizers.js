/**
 * Structure recognizers — faithful port of v1 pmcore/importer.py (tools/
 * preset-manager). Parity with v1's group/section output is a Phase 3
 * acceptance gate, so the heuristics are NOT "improved" here: same regexes,
 * same pass structure, same notes. One deliberate v2 difference: input is an
 * in-memory ST preset object (name is supplied by the caller), and output is
 * v2's native document shape (blocks/markers/sequences) instead of v1's
 * components dict.
 */
import { isStMarkerIdentifier, CONNECTION_KEYS } from './st-keys.js';
import { newKey } from './canonical.js';
import { isCommentOnly } from './groups.js';

export const PICK_HEADER = /^🔻PICK:\s*(.+?)\s*🔻$/;
export const SECTION_HEADER = /^🔹🔹\s*(.+?)\s*🔹🔹$/;
export const DIVIDER = '· · ─ ·✶· ─ · ·';
export const DIVIDER_PREFIX = '· · ─';
export const OPTION_NAME = /^「\s*(.+?)\s*」$/;
export const MODULE_NAME = /^[|!]\s*(.+?)\s*[|!]$/;
export const SOLA_SECTION = /^━+\s*(.+?)\s*━+$/;
export const SOLA_TAGGED = /^\[(.+?)\]\s*(.*)$/;
export const FF5_PICK_HINT = /pick\s*one/i;
export const CASUS_BOX_OPEN = /^┌.*$/i;
export const CASUS_BOX_CLOSE = /^└.*$/i;
export const CASUS_NUM_OPTION = /^[|]*\s*[①-⑳]\s*(.*)$/;

const SOLA_FAMILY_TAGS = ['Module', 'Core', 'Reasoning', 'Roleplay System', 'Balancer'];

/** v1 is_ff5_header: boundary from FF's own data ('==' runs / '=' pairs). */
export function isFf5Header(/** @type {string} */ name) {
    const n = (name ?? '').trim();
    return n.startsWith('=') || n.includes('==');
}

/**
 * Guess cardinality from enabled bits: <=1 enabled -> pick-one.
 * Always recorded as guessed:true.
 * @param {{ enabled: boolean }[]} rows
 */
function ff5GuessCardinality(rows) {
    const enabled = rows.filter((r) => r.enabled).length;
    return enabled <= 1 ? 'pick-one' : 'pick-one-or-more';
}

function isStMarker(prompt) {
    return prompt?.marker === true && isStMarkerIdentifier(prompt?.identifier);
}

/**
 * Build blocks + markers from an ST preset's prompts[].
 * @param {any} data ST preset object
 * @returns {{ blocks: Record<string, any>, markers: any[] }}
 */
function buildBlocksAndMarkers(data) {
    /** @type {Record<string, any>} */
    const blocks = {};
    /** @type {any[]} */
    const markers = [];
    const markerSeen = new Set();
    for (const prompt of data.prompts ?? []) {
        const ident = prompt?.identifier;
        if (!ident) continue;
        if (isStMarker(prompt) || (prompt.marker === true && isStMarkerIdentifier(ident))) {
            if (!markerSeen.has(ident)) {
                markers.push({ identifier: ident, prompt: { ...prompt } });
                markerSeen.add(ident);
            }
            continue;
        }
        if (blocks[ident]) continue; // duplicate identifier: keep first
        const fields = {};
        for (const [k, v] of Object.entries(prompt)) {
            if (!['identifier', 'name', 'content', 'role', 'enabled'].includes(k)) fields[k] = v;
        }
        blocks[ident] = {
            identifier: ident,
            name: prompt.name ?? null,
            content: prompt.content ?? '',
            role: prompt.role ?? 'system',
            fields,
            notes: '',
        };
    }
    return { blocks, markers };
}

/**
 * Flat leaf rows for one character_id's order (pre-grouping).
 * kind: 'marker' (ref) | 'block' (ref) | 'ghost' (identifier)
 */
function seqRows(data, order, byid, kindPrefix) {
    /** @type {any[]} */
    const rows = [];
    (order ?? []).forEach((entry, i) => {
        const ident = entry?.identifier;
        const prompt = byid.get(ident);
        const key = `${kindPrefix}-${i}`;
        if (prompt === undefined) {
            rows.push({ kind: 'ghost', identifier: ident, enabled: !!entry?.enabled, key });
        } else if (isStMarker(prompt)) {
            rows.push({ kind: 'marker', ref: ident, enabled: !!entry?.enabled, key });
        } else {
            rows.push({ kind: 'block', ref: ident, enabled: !!entry?.enabled, key });
        }
    });
    return rows;
}

class GroupState {
    constructor(headerRow, name, cardinality, guessed) {
        this.headerRow = headerRow;
        this.name = name;
        this.cardinality = cardinality;
        this.guessed = guessed;
        /** @type {any[]} */
        this.options = [];
    }
}

function closeGroup(state, out, notes) {
    if (state === null) return;
    if (state.options.length > 0) {
        out.push({
            kind: 'group',
            key: newKey('grp'),
            name: state.name,
            cardinality: state.cardinality,
            guessed: state.guessed,
            header: state.headerRow,
            options: state.options,
        });
    } else if (state.headerRow !== null) {
        // a selector header with no options: keep it as a plain leaf row
        state.headerRow.kind = 'block';
        out.push(state.headerRow);
    }
    void notes;
}

function flushSection(state, out) {
    if (state === null) return;
    if ((state.rows && state.rows.length > 0) || state.header !== null) {
        out.push({
            kind: 'section',
            key: newKey('sec'),
            name: state.name,
            header: state.header,
            rows: state.rows,
        });
    }
}

/** Pair each row with its prompt name ('' for ghosts). */
function rowsToNamed(rows, byid) {
    return rows.map((r) => {
        const p = r.kind === 'ghost' ? undefined : byid.get(r.ref);
        return [r, (p ? p.name : '') || ''];
    });
}

function walkAll(rows) {
    /** @type {any[]} */
    const out = [];
    for (const r of rows) {
        out.push(r);
        for (const f of ['rows', 'options']) {
            if (Array.isArray(r[f])) out.push(...walkAll(r[f]));
        }
    }
    return out;
}

// ------------------------------------------------------------------ dem

/** @returns {['open-group', {name: string, cardinality: string}]|['option', null]|['open-section', {name: string|null}]|['plain', null]} */
function recognizeDem(name, row) {
    const m = PICK_HEADER.exec(name ?? '');
    if (m) return ['open-group', { name: `PICK: ${m[1]}`, cardinality: 'pick-one' }];
    if (name && OPTION_NAME.test(name)) return ['option', null];
    if (MODULE_NAME.test(name ?? '')) return ['plain', null];
    const m2 = SECTION_HEADER.exec(name ?? '');
    if (m2) return ['open-section', { name: m2[1] }];
    if (name === DIVIDER || (name ?? '').startsWith(DIVIDER_PREFIX)) return ['open-section', { name: null }];
    return ['plain', null];
}

function runDemStructural(rows, byid) {
    let /** @type {any} */ group = null;
    let /** @type {any} */ section = null;
    /** @type {any[]} */
    const out = [];
    /** @type {string[]} */
    const notes = [];
    /** @type {string[]} */
    const stray = [];
    const pushLeaf = (row) => (section ? section.rows : out).push(row);
    for (const [row, name] of rowsToNamed(rows, byid)) {
        const [action, payload] = recognizeDem(name, row);
        if (action === 'open-group') {
            closeGroup(group, section ? section.rows : out, notes);
            flushSection(section, out);
            section = null;
            group = new GroupState(row, payload.name, payload.cardinality, true);
        } else if (action === 'option') {
            if (group === null) {
                stray.push(name);
                pushLeaf(row);
            } else {
                group.options.push(row);
            }
        } else if (action === 'open-section') {
            closeGroup(group, section ? section.rows : out, notes);
            group = null;
            flushSection(section, out);
            section = { name: payload.name, header: row.kind !== 'marker' ? row : null, rows: [] };
        } else {
            closeGroup(group, section ? section.rows : out, notes);
            group = null;
            pushLeaf(row);
        }
    }
    closeGroup(group, section ? section.rows : out, notes);
    flushSection(section, out);
    if (stray.length > 0) {
        notes.push(
            `dem: ${stray.length} option row(s) outside any PICK group kept as plain ` +
                `toggles (most are folded into bare-run groups next): ${stray.slice(0, 3).join(', ')}…`,
        );
    }
    return [out, notes];
}

// ------------------------------------------------------------------ nemo

/** Nemo Engine ST macro-comment tag: `{{// @tag value }}`. */
export const NEMO_TAG = /\{\{\/\/\s*@([a-z-]+)(?:\s+([^}]*?))?\s*\}\}/g;

/**
 * Every Nemo tag in `content` -> trimmed value ('' when it has none).
 * @param {any} content
 * @returns {Map<string, string>}
 */
export function nemoTags(content) {
    /** @type {Map<string, string>} */
    const tags = new Map();
    for (const m of String(content ?? '').matchAll(NEMO_TAG)) tags.set(m[1], (m[2] ?? '').trim());
    return tags;
}

function isNemoRow(prompt) {
    const tags = nemoTags(prompt?.content);
    return tags.get('section-header') === 'true' || (tags.get('mutual-exclusive-group') ?? '') !== '';
}

/**
 * Close a Nemo group: >=2 options -> group; 1 option -> plain leaf. Records the run.
 * A group directly after another group takes its first row as heading, because
 * the store's rebuildSeq merges adjacent headerless groups.
 * @param {any} state
 * @param {any[]} container
 * @param {Map<string, any[][]>} runs
 * @param {{ singles: number, groups: number }} counts
 * @param {string[]} notes
 * @param {(row: any) => string} nameOf
 */
function closeNemoGroup(state, container, runs, counts, notes, nameOf) {
    if (state === null) return;
    const list = runs.get(state.name) ?? [];
    list.push(state.options);
    runs.set(state.name, list);
    if (state.options.length >= 2) {
        const prev = container[container.length - 1];
        const headed = prev?.kind === 'group';
        if (headed) {
            notes.push(
                `nemo: group '${state.name}' directly follows group '${prev.name}'; ` +
                    `its first member '${nameOf(state.options[0])}' heads it ` +
                    `(adjacent headerless groups would merge; the heading is a pick-one member)`,
            );
        }
        container.push({
            kind: 'group',
            key: newKey('grp'),
            name: state.name,
            cardinality: 'pick-one',
            guessed: false,
            header: headed ? state.options[0] : null,
            options: headed ? state.options.slice(1) : state.options,
        });
        counts.groups += 1;
    } else {
        container.push(...state.options);
        counts.singles += 1;
    }
}

/**
 * Nemo outline. A header block (`@section-header true`) whose name looks like
 * `=== … ===` opens a section; every other header is a SUB header and never a
 * section. A sub header directly before an `@mutual-exclusive-group T` run
 * heads that run as a pick-one group (a comment-only sub header sitting
 * inside the run is first moved to the run's head; a sub header that sends
 * text and every content block never move). A sub header
 * before a run of plain blocks heads them as a pick-one-or-more group; any
 * other sub header stays a plain leaf. Headerless exclusive runs of >=2 are
 * pick-one groups, runs of 1 stay plain.
 * @param {any[]} rows
 * @param {Map<string, any>} byid
 * @returns {[any[], string[]]}
 */
function runNemo(rows, byid) {
    let /** @type {any} */ section = null;
    let /** @type {any} */ group = null;
    /** @type {any[]} */
    const out = [];
    /** @type {string[]} */
    const notes = [];
    /** @type {Map<string, any[][]>} */
    const runs = new Map();
    const counts = { singles: 0, groups: 0, many: 0 };
    let sections = 0;
    const container = () => (section ? section.rows : out);
    const pushLeaf = (row) => container().push(row);
    const nameOf = (row) => (row.kind === 'ghost' ? '' : (byid.get(row.ref)?.name ?? '')) || '';
    /** @returns {{ type: 'top'|'sub'|'excl'|'plain'|'other', tag: string }} */
    const classify = (row) => {
        if (row.kind !== 'block') return { type: 'other', tag: '' };
        const tags = nemoTags(byid.get(row.ref)?.content);
        if (tags.get('section-header') === 'true') {
            return { type: /^\s*=+.*=+\s*$/.test(nameOf(row)) ? 'top' : 'sub', tag: '' };
        }
        const tag = tags.get('mutual-exclusive-group') ?? '';
        return tag !== '' ? { type: 'excl', tag } : { type: 'plain', tag: '' };
    };

    // Pre-pass: a comment-only sub header (sends no text) inside an exclusive
    // run moves to the run's head; a sub header that sends text never moves.
    const ordered = rows.slice();
    for (let i = 0; i < ordered.length; i++) {
        if (classify(ordered[i]).type !== 'sub' || i + 1 >= ordered.length) continue;
        if (!isCommentOnly(byid.get(ordered[i].ref)?.content)) continue;
        const next = classify(ordered[i + 1]);
        if (next.type !== 'excl') continue;
        let j = i;
        while (j > 0) {
            const c = classify(ordered[j - 1]);
            if (c.type === 'excl' && c.tag === next.tag) j -= 1;
            else break;
        }
        if (j === i || (j > 0 && classify(ordered[j - 1]).type === 'sub')) continue;
        const [header] = ordered.splice(i, 1);
        ordered.splice(j, 0, header);
        notes.push(
            `nemo: moved sub header '${nameOf(header)}' up ${i - j} row(s) to head its '${next.tag}' run ` +
                `(it split the run; the heading sends no text)`,
        );
    }

    for (let i = 0; i < ordered.length; i++) {
        const row = ordered[i];
        const cls = classify(row);
        if (cls.type === 'top') {
            closeNemoGroup(group, container(), runs, counts, notes, nameOf);
            group = null;
            flushSection(section, out);
            section = { name: nameOf(row).trim(), header: row, rows: [] };
            sections += 1;
        } else if (cls.type === 'sub') {
            closeNemoGroup(group, container(), runs, counts, notes, nameOf);
            group = null;
            const next = i + 1 < ordered.length ? classify(ordered[i + 1]) : { type: 'other', tag: '' };
            if (next.type === 'excl') {
                let k = i + 1;
                while (k < ordered.length) {
                    const c = classify(ordered[k]);
                    if (c.type === 'excl' && c.tag === next.tag) k += 1;
                    else break;
                }
                const options = ordered.slice(i + 1, k);
                const list = runs.get(next.tag) ?? [];
                list.push(options);
                runs.set(next.tag, list);
                container().push({
                    kind: 'group',
                    key: newKey('grp'),
                    name: next.tag,
                    cardinality: 'pick-one',
                    guessed: false,
                    header: row,
                    options,
                });
                counts.groups += 1;
                i = k - 1;
            } else if (next.type === 'plain') {
                let k = i + 1;
                while (k < ordered.length && classify(ordered[k]).type === 'plain') k += 1;
                container().push({
                    kind: 'group',
                    key: newKey('grp'),
                    name: nameOf(row).trim(),
                    cardinality: 'pick-one-or-more',
                    guessed: false,
                    header: row,
                    options: ordered.slice(i + 1, k),
                });
                counts.many += 1;
                i = k - 1;
            } else {
                pushLeaf(row);
            }
        } else if (cls.type === 'excl') {
            if (group !== null && group.name === cls.tag) {
                group.options.push(row);
            } else {
                closeNemoGroup(group, container(), runs, counts, notes, nameOf);
                group = new GroupState(null, cls.tag, 'pick-one', false);
                group.options.push(row);
            }
        } else {
            closeNemoGroup(group, container(), runs, counts, notes, nameOf);
            group = null;
            pushLeaf(row);
        }
    }
    closeNemoGroup(group, container(), runs, counts, notes, nameOf);
    flushSection(section, out);
    for (const [name, list] of runs) {
        if (list.length < 2) continue;
        const members = list.flat().map(nameOf).join(', ');
        notes.push(
            `nemo: group '${name}' spans ${list.length} non-contiguous run(s) ` +
                `(kept in prompt order; runs of 1 stay plain): ${members}`,
        );
    }
    notes.push(
        `nemo: ${sections} sections, ${counts.groups} pick-one groups from @mutual-exclusive-group ` +
            `(${counts.singles} single-row runs left plain), ${counts.many} pick-many groups under sub headers`,
    );
    return [out, notes];
}

function groupBareOptionRuns(out, notes, nameByKey) {
    /** Within each section, fold contiguous 「 」 option runs (>=2) into
     * pick-one-or-more groups (the NARRATIVE STYLES pattern). */
    let added = 0;
    for (const hit of walkAll(out)) {
        if (hit.kind !== 'section') continue;
        const rows = hit.rows;
        let i = 0;
        while (i < rows.length) {
            const row = rows[i];
            const m0 = OPTION_NAME.exec(nameByKey.get(row.key) ?? '');
            if (row.kind === 'block' && m0) {
                let j = i;
                /** @type {any[]} */
                const run = [];
                while (j < rows.length) {
                    const r2 = rows[j];
                    const m2 = OPTION_NAME.exec(nameByKey.get(r2.key) ?? '');
                    if (r2.kind === 'block' && m2) {
                        run.push(r2);
                        j += 1;
                    } else break;
                }
                if (run.length >= 2) {
                    const card = 'pick-one-or-more';
                    const label = m0[1];
                    rows.splice(i, j - i, [
                        {
                            kind: 'group',
                            key: newKey('grp'),
                            name: label,
                            cardinality: card,
                            guessed: true,
                            header: null,
                            options: run,
                        },
                    ][0]);
                    notes.push(`dem: bare option run '${label}…' (${run.length} options) -> ${card} (guessed)`);
                    added += 1;
                    i += 1;
                    continue;
                }
            }
            i += 1;
        }
    }
    return added;
}

function runDem(rows, byid) {
    const [out, notes] = runDemStructural(rows, byid);
    const nameByKey = new Map(rowsToNamed(rows, byid).map(([r, n]) => [r.key, n]));
    const added = groupBareOptionRuns(out, notes, nameByKey);
    const nGroups = walkAll(out).filter((r) => r.kind === 'group').length;
    notes.push(`dem: ${nGroups} groups recognized (${added} bare option run(s))`);
    return [out, notes];
}

// ------------------------------------------------------------------ sola

function runSola(rows, byid) {
    /** @type {any[]} */
    const out = [];
    let /** @type {any} */ section = null;
    const named = rowsToNamed(rows, byid);
    /** @type {Map<string, [string, string]>} */
    const famAt = new Map();
    /** @type {string[]} */
    const notes = [];
    let i = 0;
    // pre-pass: contiguous same-family runs of >= 2 tagged rows -> group candidates
    while (i < named.length) {
        const [row, name] = named[i];
        const m = SOLA_TAGGED.exec(name);
        if (m && SOLA_FAMILY_TAGS.includes(m[1]) && m[2].includes(':')) {
            const fam = m[2].split(':')[0].trim();
            /** @type {any[]} */
            const run = [row];
            let j = i + 1;
            while (j < named.length) {
                const [r2, n2] = named[j];
                const m2 = SOLA_TAGGED.exec(n2);
                if (m2 && SOLA_FAMILY_TAGS.includes(m2[1]) && m2[2].includes(':') && m2[2].split(':')[0].trim() === fam) {
                    run.push(r2);
                    j += 1;
                } else break;
            }
            if (run.length >= 2) {
                const enabledCt = run.filter((r) => r.enabled).length;
                const card = enabledCt <= 1 ? 'pick-one' : 'pick-one-or-more';
                for (const r of run) famAt.set(r.key, [fam, card]);
                notes.push(`sola: family run '${fam}' (${run.length} options, ${enabledCt} enabled) -> ${card} (guessed)`);
                i = j;
                continue;
            }
        }
        i += 1;
    }
    i = 0;
    while (i < named.length) {
        const [row, name] = named[i];
        const secMatch = SOLA_SECTION.exec(name);
        if (secMatch) {
            flushSection(section, out);
            section = null;
            section = { name: secMatch[1], header: row.kind !== 'marker' ? row : null, rows: [] };
            i += 1;
            continue;
        }
        const target = section ? section.rows : out;
        if (famAt.has(row.key)) {
            const [fam] = famAt.get(row.key);
            /** @type {any[]} */
            const run = [];
            while (i < named.length && famAt.has(named[i][0].key) && famAt.get(named[i][0].key)[0] === fam) {
                run.push(named[i][0]);
                i += 1;
            }
            target.push({
                kind: 'group',
                key: newKey('grp'),
                name: `${fam} options`,
                cardinality: famAt.get(run[0].key)[1],
                guessed: true,
                header: null,
                options: run,
            });
            continue;
        }
        target.push(row);
        i += 1;
    }
    flushSection(section, out);
    return [out, notes];
}

// ------------------------------------------------------------------ ff5

function runFf5(rows, byid) {
    /** @type {any[]} */
    const out = [];
    /** @type {string[]} */
    const notes = [];
    let /** @type {any} */ group = null;
    for (const [row, name] of rowsToNamed(rows, byid)) {
        if (row.kind === 'marker') {
            // a group ALWAYS ends at a marker
            if (group !== null) {
                group.cardinality = ff5GuessCardinality(group.options);
                closeGroup(group, out, notes);
                group = null;
            }
            out.push(row);
        } else if (isFf5Header(name)) {
            if (group !== null) {
                group.cardinality = ff5GuessCardinality(group.options);
                closeGroup(group, out, notes);
            }
            group = new GroupState(row, name.trim(), ff5GuessCardinality([]), true);
        } else if (group !== null) {
            group.options.push(row);
        } else {
            out.push(row);
        }
    }
    if (group !== null) {
        group.cardinality = ff5GuessCardinality(group.options);
    }
    closeGroup(group, out, notes);
    const nGroups = out.filter((r) => r.kind === 'group').length;
    const nPick1 = out.filter((r) => r.kind === 'group' && r.cardinality === 'pick-one').length;
    notes.push(
        `ff5: ${nGroups} groups recognized at '==' headers ` +
            `(${nPick1} guessed pick-one from enabled bits, rest pick-one-or-more); ` +
            'groups always end at markers; cardinality is a guess — fix in the outline',
    );
    return [out, notes];
}

// ------------------------------------------------------------------ casus

/** @returns {['open-box', {name: string}]|['close-box', null]|['option', null]|['plain', null]} */
function recognizeCasus(name) {
    if (CASUS_BOX_OPEN.test(name ?? '') && /choose|switches start/i.test(name)) {
        return ['open-box', { name: name.replace(/[┌└]/g, '').trim() }];
    }
    if (CASUS_BOX_CLOSE.test(name ?? '')) return ['close-box', null];
    if (CASUS_NUM_OPTION.test(name ?? '')) return ['option', null];
    return ['plain', null];
}

function runCasus(rows, byid) {
    /** @type {any[]} */
    const out = [];
    /** @type {string[]} */
    const notes = [];
    let /** @type {any} */ group = null;
    for (const [row, name] of rowsToNamed(rows, byid)) {
        const [action, payload] = recognizeCasus(name);
        if (action === 'open-box') {
            if (group !== null) {
                group.cardinality = ff5GuessCardinality(group.options);
                closeGroup(group, out, notes);
                group = null;
            }
            group = new GroupState(row, payload.name, 'pick-one-or-more', true);
        } else if (action === 'close-box') {
            if (group !== null) {
                group.name = name.replace(/[┌└]/g, '').trim() || group.name;
                group.options.push(row); // the END row is itself a toggleable prompt
                group.cardinality = ff5GuessCardinality(group.options);
                closeGroup(group, out, notes);
                group = null;
            } else {
                out.push(row);
            }
        } else if (action === 'option') {
            if (group !== null) group.options.push(row);
            else out.push(row);
        } else {
            if (group !== null) group.options.push(row);
            else out.push(row);
        }
    }
    if (group !== null) {
        group.cardinality = ff5GuessCardinality(group.options);
    }
    closeGroup(group, out, notes);
    const nGroups = out.filter((r) => r.kind === 'group').length;
    notes.push(`casus: ${nGroups} box groups recognized (cardinality guessed from enabled bits)`);
    return [out, notes];
}

// ------------------------------------------------------------------ pick + run

/**
 * Pick the recognizer for one sequence's flat rows.
 * @param {any[]} rows
 * @param {Map<string, any>} byid
 */
export function pickRecognizer(rows, byid) {
    const names = rowsToNamed(rows, byid)
        .filter(([r]) => r.kind === 'marker' || r.kind === 'block')
        .map(([, n]) => n);
    if (rows.some((r) => r.kind === 'block' && isNemoRow(byid.get(r.ref)))) return 'nemo';
    if (names.some((n) => PICK_HEADER.test(n))) return 'dem';
    if (names.some((n) => SOLA_SECTION.test(n))) return 'sola';
    if (names.some((n) => isFf5Header(n))) return 'ff5';
    if (names.some((n) => CASUS_BOX_OPEN.test(n))) return 'casus';
    return 'flat';
}

const RECOGNIZERS = {
    nemo: runNemo,
    dem: runDem,
    sola: runSola,
    ff5: runFf5,
    casus: runCasus,
    flat: (rows) => [rows, ['flat: no grouping convention recognized; imported as independent toggles']],
};

/**
 * Assert `data` is shaped like an ST Chat Completion preset (has array
 * prompts/prompt_order). Shared by `importStPreset` and the store's `{st}`
 * import path so both give the exact same 400 message (v1 parity:
 * tools/preset-manager/pmcore/importer.py raises this same message for a
 * non-dict).
 * @param {any} data
 * @param {string} name display name
 */
export function assertStPreset(data, name) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new ImportError(`${name}: not a Chat Completion preset (no prompts/prompt_order)`);
    }
    if (!('prompts' in data) || !('prompt_order' in data)) {
        throw new ImportError(`${name}: not a Chat Completion preset (no prompts/prompt_order)`);
    }
    if (!Array.isArray(data.prompts) || !Array.isArray(data.prompt_order)) {
        throw new ImportError(`${name}: prompts/prompt_order must be arrays`);
    }
}

/**
 * Import an ST Chat Completion preset object into a v2 native document body
 * (everything except id/createdAt/updatedAt/rev, which the store mints).
 * Throws when the input is not a CC preset.
 * @param {any} data ST preset JSON
 * @param {string} name display name
 * @param {{ ulid?: () => string, now?: () => string }} [ids] injectable id/time for tests
 */
export function importStPreset(data, name, ids = {}) {
    assertStPreset(data, name);

    const byid = new Map();
    for (const p of data.prompts ?? []) byid.set(p?.identifier, p);

    const { blocks, markers } = buildBlocksAndMarkers(data);
    /** @type {string[]} */
    const notes = [];
    /** @type {any[]} */
    const sequences = [];
    /** @type {string[]} */
    const picked = [];

    // F-066: ST chat completion reads only 100001 when both 100000 and 100001 exist.
    const orders = data.prompt_order ?? [];
    const dropDefault = orders.some((s) => s?.character_id === 100000) && orders.some((s) => s?.character_id === 100001);
    if (dropDefault) notes.push('dropped prompt_order 100000: ST chat completion reads only 100001 (F-066)');
    for (const seq of dropDefault ? orders.filter((s) => s?.character_id !== 100000) : orders) {
        const kind = `seq${seq?.character_id}`;
        const rows = seqRows(data, seq?.order ?? [], byid, kind);
        const recognizer = pickRecognizer(rows, byid);
        picked.push(recognizer);
        const [structured, seqNotes] = RECOGNIZERS[recognizer](rows, byid);
        notes.push(...seqNotes);
        sequences.push({ character_id: seq?.character_id, rows: structured });
    }
    const presetKind =
        picked.length > 0 && (picked.length === 1 || picked.every((k) => k === picked[0])) ? picked[0] : 'flat';

    return {
        format: 'st-preset-manager/library',
        version: 1,
        name,
        tags: [],
        notes: '',
        source: { importedFrom: 'upload:api', importedAt: ids.now ? ids.now() : null, importDigest: null, recognizer: { kind: presetKind, notes } },
        settings: Object.fromEntries(Object.entries(data).filter(
            ([k]) => k !== 'prompts' && k !== 'prompt_order' && !CONNECTION_KEYS.includes(k),
        )),
        markers,
        blocks,
        sequences,
        loadouts: {},
        activeLoadoutId: null,
        tuningOverrides: {},
    };
}

export class ImportError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
    }
}
