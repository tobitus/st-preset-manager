#!/usr/bin/env node
/**
 * Compile dry run: proves, on a COPY of a real library, that the current
 * shared/ code compiles every preset byte-identically to an older checkout
 * and loads (upgradeDoc) every document to the same bytes as the older code.
 *
 *   node dev/compile-dryrun.mjs <lib-copy-dir> <old-tree-dir>
 *
 * Read-only against <lib-copy-dir>. Exit 1 when any order/text difference,
 * an upgradeDoc result that differs from the old tree's, a non-idempotent
 * upgrade or a rebuild difference is found. Documents the OLD code upgrades
 * too (e.g. stored before a stamp was added) are counted and listed as
 * information: loading changes them either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from '../shared/compile.js';
import { upgradeDoc } from '../shared/schema.js';
import { flattenSeq, rebuildSeq } from '../shared/outline.js';
import { normName } from '../shared/compare.js';

const [libDir, oldTree] = process.argv.slice(2);
if (!libDir || !oldTree) {
    console.error('usage: node dev/compile-dryrun.mjs <lib-copy-dir> <old-tree-dir>');
    process.exit(2);
}

/** @param {string} file */
const importOld = (file) => import(pathToFileURL(path.resolve(oldTree, file)).href);
const oldCompile = (await importOld('shared/compile.js')).compile;
const oldOutline = await importOld('shared/outline.js');
const oldUpgradeDoc = (await importOld('shared/schema.js')).upgradeDoc;

/**
 * @param {string} dir
 * @returns {string[]} every file below dir, sorted
 */
function walk(dir) {
    /** @type {string[]} */
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walk(p));
        else out.push(p);
    }
    return out.sort();
}

/**
 * Model entries the way Store._loadModels reads models.json:
 * `{ version: 1, models: { <name>: entry } }`.
 * @returns {any[]}
 */
function loadModels() {
    const file = path.join(libDir, 'models.json');
    if (!fs.existsSync(file)) return [];
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.entries(reg?.models ?? {}).map(([name, m]) => ({ ...(/** @type {any} */ (m)), name: /** @type {any} */ (m)?.name ?? name }));
}

/**
 * Run a compile, capturing a thrown error's message.
 * @param {Function} fn
 * @param {any} doc
 * @param {any} model
 * @param {string} lid
 * @returns {{ ok: true, compiled: any } | { ok: false, message: string }}
 */
function run(fn, doc, model, lid) {
    try {
        return { ok: true, compiled: fn(structuredClone(doc), model === null ? null : structuredClone(model), {}, lid).compiled };
    } catch (err) {
        return { ok: false, message: String(/** @type {any} */ (err)?.message ?? err) };
    }
}

/**
 * Order (`identifier:enabled`) and enabled-prompt texts of a compiled preset.
 * @param {any} compiled
 * @returns {{ order: string[], texts: string[] }}
 */
function shape(compiled) {
    const byId = new Map((compiled.prompts ?? []).map((/** @type {any} */ p) => [p.identifier, p]));
    /** @type {string[]} */
    const order = [];
    /** @type {string[]} */
    const texts = [];
    for (const entry of compiled.prompt_order ?? []) {
        for (const o of entry.order ?? []) {
            order.push(`${o.identifier}:${o.enabled}`);
            if (o.enabled) texts.push(byId.get(o.identifier)?.content ?? '');
        }
    }
    return { order, texts };
}

/** @param {any} s */
const trunc = (s) => (s === undefined ? '(none)' : JSON.stringify(String(s).length > 80 ? `${String(s).slice(0, 80)}…` : String(s)));

/**
 * @param {string} kind
 * @param {string} rel
 * @param {string} lid
 * @param {string} modelName
 * @param {string[]} a old
 * @param {string[]} b new
 */
function reportDiff(kind, rel, lid, modelName, a, b) {
    if (printed >= 20) return;
    printed++;
    let i = 0;
    while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
    console.log(`DIFF ${kind} ${rel} loadout ${lid} model ${modelName} at #${i}: old ${trunc(a[i])} new ${trunc(b[i])}`);
}

/**
 * Leaves (block/marker/ghost) of a sequence, nested rows flattened in order.
 * @param {any[]} rows
 * @returns {any[]}
 */
const leavesOf = (rows) => flattenSeq(rows).map((e) => e.leaf);

/**
 * Every group row at any depth (walks sections).
 * @param {any[]} rows
 * @param {any[]} [out]
 * @returns {any[]}
 */
function groupsOf(rows, out = []) {
    for (const row of rows ?? []) {
        if (row?.kind === 'group') out.push(row);
        else if (row?.kind === 'section') groupsOf(row.rows ?? [], out);
    }
    return out;
}

const models = loadModels();
const files = fs.existsSync(path.join(libDir, 'presets'))
    ? walk(path.join(libDir, 'presets')).filter((f) => f.endsWith('.json'))
    : [];

let printed = 0;
let presets = 0;
let skipped = 0;
let combos = 0;
let bothThrow = 0;
let orderDiffs = 0;
let textDiffs = 0;
let changed = 0;
let changedByThisCode = 0;
let notIdempotent = 0;
let rebuildDiffs = 0;
let linkSites = 0;
let overlapDocs = 0;
/** @type {string[]} */
const overlapIds = [];

for (const file of files) {
    const rel = path.relative(libDir, file);
    /** @type {any} */
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        skipped++;
        continue;
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sequences)) {
        skipped++;
        continue;
    }
    presets++;

    // (1) upgrade check: the new upgradeDoc must give the old one's bytes;
    // a doc the old code upgrades too is pending an earlier upgrade (info)
    const a = JSON.stringify(doc);
    const u1 = upgradeDoc(structuredClone(doc));
    const u2 = upgradeDoc(structuredClone(u1));
    const uOld = JSON.stringify(oldUpgradeDoc(structuredClone(doc)));
    if (JSON.stringify(u1) !== uOld) {
        changedByThisCode++;
        console.log(`UPGRADE DIFFERS FROM OLD TREE ${rel}`);
    }
    if (JSON.stringify(u1) !== a) {
        changed++;
        console.log(`UPGRADE CHANGED ${rel}${uOld === JSON.stringify(u1) ? ' (the old tree upgrades it identically: pending earlier upgrade)' : ''}`);
    }
    if (JSON.stringify(u2) !== JSON.stringify(u1)) {
        notIdempotent++;
        console.log(`UPGRADE NOT IDEMPOTENT ${rel}`);
    }

    // (2) rebuild canary
    let rebuildDiffers = false;
    for (const seq of doc.sequences) {
        const rows = seq.rows ?? [];
        const n = JSON.stringify(rebuildSeq(flattenSeq(structuredClone(rows))));
        const o = JSON.stringify(oldOutline.rebuildSeq(oldOutline.flattenSeq(structuredClone(rows))));
        if (n !== o) rebuildDiffers = true;
    }
    if (rebuildDiffers) {
        rebuildDiffs++;
        console.log(`REBUILD DIFFERS ${rel}`);
    }

    // (3) compile comparison on the upgraded doc
    for (const lid of Object.keys(u1.loadouts ?? {})) {
        for (const model of [null, ...models]) {
            combos++;
            const modelName = model === null ? '(none)' : model.name;
            const o = run(oldCompile, u1, model, lid);
            const n = run(compile, u1, model, lid);
            if (!o.ok || !n.ok) {
                if (!o.ok && !n.ok && o.message === n.message) {
                    bothThrow++;
                } else {
                    orderDiffs++;
                    textDiffs++;
                    if (printed < 20) {
                        printed++;
                        console.log(`DIFF throw ${rel} loadout ${lid} model ${modelName}: old ${o.ok ? 'ok' : JSON.stringify(o.message)} new ${n.ok ? 'ok' : JSON.stringify(n.message)}`);
                    }
                }
                continue;
            }
            const so = shape(o.compiled);
            const sn = shape(n.compiled);
            if (JSON.stringify(so.order) !== JSON.stringify(sn.order)) {
                orderDiffs++;
                reportDiff('order', rel, lid, modelName, so.order, sn.order);
            }
            if (JSON.stringify(so.texts) !== JSON.stringify(sn.texts)) {
                textDiffs++;
                reportDiff('text', rel, lid, modelName, so.texts, sn.texts);
            }
        }
    }

    // (4) candidate link sites (information only)
    for (const seq of u1.sequences) {
        const leaves = leavesOf(seq.rows ?? []);
        /** @type {Map<string, number[]>} */
        const byName = new Map();
        leaves.forEach((leaf, i) => {
            if (leaf.kind !== 'block') return;
            const block = u1.blocks?.[leaf.ref ?? leaf.identifier];
            const nn = normName(block?.name);
            if (!nn) return;
            if (!byName.has(nn)) byName.set(nn, []);
            /** @type {number[]} */ (byName.get(nn)).push(i + 1);
        });
        for (const [nn, pos] of byName) {
            if (pos.length < 2) continue;
            linkSites++;
            console.log(`${rel} seq ${seq.character_id}: '${nn}' at ${pos.map((p) => `#${p}`).join(', ')}`);
        }
    }

    // (5) cross-sequence option overlap (information only)
    /** @type {Set<string>[]} */
    const optionSets = u1.sequences.map((/** @type {any} */ seq) => {
        /** @type {Set<string>} */
        const s = new Set();
        for (const g of groupsOf(seq.rows ?? [])) {
            for (const opt of g.options ?? []) s.add(opt.ref ?? opt.identifier);
        }
        return s;
    });
    /** @type {Set<string>} */
    const overlap = new Set();
    optionSets.forEach((s, i) => {
        optionSets.forEach((t, j) => {
            if (i === j) return;
            for (const id of s) if (t.has(id)) overlap.add(id);
        });
    });
    if (overlap.size > 0) {
        overlapDocs++;
        for (const id of overlap) if (overlapIds.length < 10 && !overlapIds.includes(id)) overlapIds.push(id);
    }
}

if (overlapIds.length > 0) console.log(`cross-sequence option overlap, first identifiers: ${overlapIds.join(', ')}`);

console.log(`presets: ${presets} (skipped ${skipped})`);
console.log(`combinations compiled: ${combos} (both threw: ${bothThrow})`);
console.log(`order differences: ${orderDiffs}`);
console.log(`text differences: ${textDiffs}`);
console.log(`docs changed by upgradeDoc: ${changed} (differently from the old tree: ${changedByThisCode})`);
console.log(`upgradeDoc not idempotent: ${notIdempotent}`);
console.log(`rebuild round-trip differs from old tree: ${rebuildDiffs}`);
console.log(`candidate link sites: ${linkSites}`);
console.log(`docs with cross-sequence option overlap: ${overlapDocs}`);

process.exit(orderDiffs || textDiffs || changedByThisCode || notIdempotent || rebuildDiffs ? 1 : 0);
