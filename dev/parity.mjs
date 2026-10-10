#!/usr/bin/env node
/**
 * Phase 3 check 1 / acceptance 10: the JS recognizer (shared/recognizers.js,
 * a port of v1 pmcore/importer.py) must give the same groups and sections as
 * v1's Python importer for three presets. This module is the proof and is
 * also imported by dev/check-phase3.mjs.
 *
 *   node dev/parity.mjs        run the 3-file parity check, exit 0 iff all
 *                              identical
 *
 * v1 is invoked read-only (python3 -B, PYTHONDONTWRITEBYTECODE=1): its tree
 * is never written to.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importStPreset } from '../shared/recognizers.js';
import { flattenSeq, rebuildSeq } from '../shared/outline.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V1_TOOL_DIR = process.env.PM_V1_TOOL_DIR ?? path.join(os.homedir(), 'projects/sillysystem/tools/preset-manager');

export const PARITY_FILES = [
    'DEUS.EX.MACHINA.V2.5.ST.json',
    'Sola V2 Flame.json',
    'Freaky Frankenstein 5.4 Internal States (2).json',
];

export const FIXTURE_DIR = path.join(REPO, 'dev/fixtures/presets');

/**
 * @typedef {{ name: any, cardinality: any, header: string|number|null, members: (string|number|null)[] }} StructureGroup
 * @typedef {{ name: any, header: string|number|null, members: (string|number|null)[] }} StructureSection
 * @typedef {{ character_id: any, groups: StructureGroup[], sections: StructureSection[] }} StructureSequence
 * @typedef {{ kind: string, sequences: StructureSequence[] }} Structure
 */

/**
 * Leaf identity: v1 leaf kinds are component|marker|ghost, v2 are
 * block|marker|ghost; both use `ref` for the first two and `identifier` for
 * ghosts.
 * @param {any} row
 * @returns {string|number|null}
 */
function leafId(row) {
    if (row === null || row === undefined) return null;
    return row.ref ?? row.identifier ?? null;
}

/**
 * Depth-first pre-order over rows, descending through both `rows`
 * (sections) and `options` (groups) — mirrors shared/recognizers.js
 * walkAll, applied identically to v1's raw output and v2's native rows.
 * @param {any[]} rows
 * @returns {any[]}
 */
function walkAll(rows) {
    /** @type {any[]} */
    const out = [];
    for (const r of rows ?? []) {
        out.push(r);
        for (const f of ['rows', 'options']) {
            if (Array.isArray(r[f])) out.push(...walkAll(r[f]));
        }
    }
    return out;
}

/**
 * All leaf ids under `rows` in order: for a group, its header then its
 * options; for a (non-leaf) section, its own leaves recursively; otherwise
 * the row's own leaf id.
 * @param {any[]} rows
 * @returns {(string|number|null)[]}
 */
function collectLeafIds(rows) {
    /** @type {(string|number|null)[]} */
    const out = [];
    for (const r of rows ?? []) {
        if (r.kind === 'group') {
            if (r.header) out.push(leafId(r.header));
            for (const o of r.options ?? []) out.push(leafId(o));
        } else if (r.kind === 'section') {
            if (r.header) out.push(leafId(r.header));
            out.push(...collectLeafIds(r.rows));
        } else {
            out.push(leafId(r));
        }
    }
    return out;
}

/**
 * Build one sequence's Structure entry from its (nested) rows, shared by
 * both v1's raw JSON and v2's native document rows.
 * @param {any} character_id
 * @param {any[]} rows
 * @returns {StructureSequence}
 */
function structureSeq(character_id, rows) {
    const nodes = walkAll(rows);
    /** @type {StructureGroup[]} */
    const groups = nodes
        .filter((r) => r.kind === 'group')
        .map((r) => ({
            name: r.name,
            cardinality: r.cardinality,
            header: leafId(r.header),
            members: (r.options ?? []).map(leafId),
        }));
    /** @type {StructureSection[]} */
    const sections = nodes
        .filter((r) => r.kind === 'section')
        .map((r) => ({
            name: r.name,
            header: leafId(r.header),
            members: collectLeafIds(r.rows),
        }));
    return { character_id, groups, sections };
}

/**
 * v1 reference: run v1's importer read-only against `absFile`, return its
 * Structure.
 * @param {string} absFile
 * @returns {Structure}
 */
export function v1Structure(absFile) {
    const PY = "import json,sys; from pathlib import Path; from pmcore.importer import import_preset; " +
        "d = import_preset(Path(sys.argv[1]), 'x'); " +
        "print(json.dumps({'kind': d['recognizer']['preset_kind'], 'sequences': d['sequences']}, ensure_ascii=False))";
    const raw = execFileSync('python3', ['-B', '-c', PY, absFile], {
        cwd: V1_TOOL_DIR,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);
    return {
        kind: parsed.kind,
        sequences: parsed.sequences.map((s) => structureSeq(s.character_id, s.rows)),
    };
}

/**
 * Structure of a v2 native document (either the offline JS import or a doc
 * fetched from the plugin).
 * @param {any} doc
 * @returns {Structure}
 */
export function jsStructure(doc) {
    return {
        kind: doc.source.recognizer.kind,
        sequences: doc.sequences.map((s) => structureSeq(s.character_id, s.rows)),
    };
}

/**
 * Offline JS import exactly like Store.importPreset does it: recognize,
 * then flatten+rebuild every sequence (what store.importPreset adds on top
 * of the recognizer, per outline.test.js).
 * @param {string} absFile
 * @returns {any}
 */
export function jsImport(absFile) {
    const st = JSON.parse(fs.readFileSync(absFile, 'utf8'));
    const doc = importStPreset(st, path.basename(absFile, '.json'));
    for (const seq of doc.sequences) seq.rows = rebuildSeq(flattenSeq(seq.rows));
    return doc;
}

/**
 * Multiset difference: elements of `a` with no matching element left in
 * `b` (each `b` element consumed at most once).
 * @param {any[]} a
 * @param {any[]} b
 */
function multisetDiff(a, b) {
    const remaining = [...b];
    /** @type {any[]} */
    const only = [];
    for (const x of a) {
        const i = remaining.findIndex((y) => JSON.stringify(y) === JSON.stringify(x));
        if (i === -1) only.push(x);
        else remaining.splice(i, 1);
    }
    return only;
}

/**
 * @param {string[]} msgs
 * @param {number} seqIdx
 * @param {'groups'|'sections'} kind
 * @param {any[]} listA
 * @param {any[]} listB
 * @param {string[]} fields
 */
function diffList(msgs, seqIdx, kind, listA, listB, fields) {
    if (listA.length !== listB.length) {
        const namesA = listA.map((x) => x.name);
        const namesB = listB.map((x) => x.name);
        const onlyV1 = multisetDiff(namesA, namesB);
        const onlyJs = multisetDiff(namesB, namesA);
        msgs.push(
            `seq[${seqIdx}] ${kind}: length v1=${listA.length} js=${listB.length}; ` +
                `only-in-v1=${JSON.stringify(onlyV1)} only-in-js=${JSON.stringify(onlyJs)}`,
        );
        return;
    }
    for (let j = 0; j < listA.length; j++) {
        const label = `seq[${seqIdx}] ${kind}[${j}] (${JSON.stringify(listA[j].name)})`;
        for (const f of fields) {
            const va = listA[j][f];
            const vb = listB[j][f];
            if (JSON.stringify(va) !== JSON.stringify(vb)) {
                msgs.push(`${label} ${f}: v1=${JSON.stringify(va)} js=${JSON.stringify(vb)}`);
            }
        }
    }
}

/**
 * Human-readable differences between a v1 and a js Structure, [] when
 * identical.
 * @param {Structure} a v1 reference
 * @param {Structure} b js candidate
 * @returns {string[]}
 */
export function structureDiff(a, b) {
    /** @type {string[]} */
    const msgs = [];
    if (a.kind !== b.kind) msgs.push(`kind: v1=${a.kind} js=${b.kind}`);
    if (a.sequences.length !== b.sequences.length) {
        msgs.push(`sequences: length v1=${a.sequences.length} js=${b.sequences.length}`);
        return msgs;
    }
    for (let i = 0; i < a.sequences.length; i++) {
        const sa = a.sequences[i];
        const sb = b.sequences[i];
        if (sa.character_id !== sb.character_id) {
            msgs.push(`seq[${i}] character_id: v1=${sa.character_id} js=${sb.character_id}`);
        }
        diffList(msgs, i, 'groups', sa.groups, sb.groups, ['name', 'cardinality', 'header', 'members']);
        diffList(msgs, i, 'sections', sa.sections, sb.sections, ['name', 'header', 'members']);
    }
    return msgs;
}

function countGroupsSections(structure) {
    let groups = 0;
    let sections = 0;
    for (const s of structure.sequences) {
        groups += s.groups.length;
        sections += s.sections.length;
    }
    return { groups, sections };
}

function main() {
    let okCount = 0;
    for (const file of PARITY_FILES) {
        const absFile = path.join(FIXTURE_DIR, file);
        if (!fs.existsSync(absFile)) {
            console.log(`DIFF ${file}`);
            console.log(`    fixture not found: ${absFile}`);
            continue;
        }
        const v1 = v1Structure(absFile);
        const js = jsStructure(jsImport(absFile));
        const diffs = structureDiff(v1, js);
        if (diffs.length === 0) {
            const { groups, sections } = countGroupsSections(js);
            console.log(`IDENTICAL ${file} — kind=${js.kind}, ${groups} groups, ${sections} sections`);
            okCount += 1;
        } else {
            console.log(`DIFF ${file}`);
            for (const d of diffs) console.log(`    ${d}`);
        }
    }
    console.log(`parity: ${okCount}/${PARITY_FILES.length} identical`);
    process.exit(okCount === PARITY_FILES.length ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main();
}
