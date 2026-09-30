#!/usr/bin/env node
/**
 * Phase 1 acceptance as one repeatable script (PLAN Phase 1, checks 1–10
 * + 2b rescan + race + race-blocked/race-flush-first/race-409). Deterministic: it sets up its own state
 * (dev/reset.sh + fixture import), holds and kills its own probe tabs,
 * and prints one PASS/FAIL line per check with short evidence. Exit 1 on
 * any FAIL, so it can double as the regression suite in later phases.
 *
 *   node dev/check-phase1.mjs            all checks
 *   node dev/check-phase1.mjs 4 8        subset (accepts "2b", "race")
 *
 * Environment it expects (brings up itself if missing):
 *   - st-pm-dev container WITH the plugin on 127.0.0.1:8002 (dev/up.sh)
 *   - mock LLM on 127.0.0.1:8099 (dev/up.sh starts it)
 * It never touches :8001, the sillytavern container, ~/tools/ST-dev or
 * /home/jon/projects/sillysystem/st (read-only) — same rules as dev/*.
 *
 * Check 4 macro model (ST 1.19.0, experimental_macro_engine=true as seeded):
 *   - balanced-brace single pass per block: {{setvar::n::v}} -> "" (stores v,
 *     nested macros already resolved), {{getvar::n}} -> stored value,
 *     {{trim}} (with surrounding newlines) -> "", {{//…}} -> "",
 *     {{user}}/{{char}} -> seeded persona "Jon"/character "Assistant",
 *     {{roll::x}} -> digit(s), unknown macros stay VERBATIM (e.g.
 *     {{getvar::x::default}} — 2 args, strictArgs → kept raw, exactly what
 *     ST's MacroEngine does with an unmatched/failed macro).
 *   - comparison: whitespace-normalized containment of each enabled
 *     non-marker block's expanded text in the mock-captured prompt.
 */
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
    BASE, CHROME, FF, Probe, REPO, SLOT_NAME, ST_URL,
    cleanupTabs, createApi, createReporter, httpJson, sleep, until,
} from './harness.mjs';

const MOCK = 'http://127.0.0.1:8099';
const TAB_A = 'chk-a';
const TAB_B = 'chk-b';
const PERSONA = 'Jon';       // dev/seed-settings.mjs seeds username: "Jon"
const CHARNAME = 'Assistant'; // dev seed character

// ------------------------------------------------------------------ results

const { report, fatal, finish, onExit } = createReporter();
// every fatal()/finish() path kills both probe chromia before exiting
onExit(stopChrome);
process.on('exit', () => {
    cleanupTabs([TAB_A, TAB_B]);
});
/** @param {string[]} only */
const wanted = (/** @type {string} */ name) => process.argv.slice(2).length === 0 || process.argv.slice(2).includes(name);

// ------------------------------------------------------------------ http api

const { api, apiOnce, primeSession } = createApi({
    jar: path.join(REPO, 'dev', '.check-phase1.cookies.jar'),
    onFatal: fatal,
});

// ------------------------------------------------------------------ probe

const probeA = new Probe(TAB_A, { onFatal: fatal });
// tab B's probe failures are reported under its check name '8' (today's
// startTabB called fatal('8', …), never fatal('probe', …))
const probeB = new Probe(TAB_B, { onFatal: (name, evidence) => fatal(name === 'probe' ? '8' : name, evidence) });

/** Thin wrapper so the 800 lines of checks keep their call sites. */
async function startProbe(tab) {
    if (tab !== TAB_A && tab !== TAB_B) throw new Error(`unknown tab: ${tab}`);
    await (tab === TAB_B ? probeB : probeA).start();
}

/** Evaluate in tab A's ST page. @param {string} expression @returns {Promise<any>} */
async function evalInPage(expression) {
    return probeA.eval(expression);
}

/** Evaluate in tab B's ST page. @param {string} expression @returns {Promise<any>} */
async function evalInPageB(expression) {
    return probeB.eval(expression);
}

/** SIGKILL both probe chromia; every fatal()/finish() path ends here via onExit. */
function stopChrome() {
    probeA.kill();
    probeB.kill();
    cleanupTabs([TAB_A, TAB_B]);
}

// ------------------------------------------------------------------ helpers

/** @param {string} dir @param {string} file */
function mtimeOf(dir, file) {
    const p = path.join(dir, file);
    return fs.statSync(p).mtimeMs;
}

const PM_DIR = path.join(REPO, 'dev', 'data', 'default-user', 'preset-manager');
const USER_DIR = path.join(REPO, 'dev', 'data', 'default-user');
const OPENAI_DIR = path.join(USER_DIR, 'OpenAI Settings');

/** Podman logs of the dev container. @returns {string} */
function containerLogs() {
    try {
        return execSync('podman logs st-pm-dev 2>&1', { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    } catch { return ''; }
}

/**
 * ST macro engine subset (ST 1.19.0, experimental_macro_engine) — see file
 * header. One balanced-brace pass, unknown macros stay verbatim.
 * Variable state is SHARED across blocks (ST keeps chat_metadata.variables
 * for the whole prompt build): process blocks in prompt_order.
 * @param {string} content
 * @param {Map<string,string>} vars
 */
function expandMacros(content, vars) {
    /** Balanced parse of one {{…}} group starting at i (content[i..i+1] === '{{'). */
    function findClose(s, i) {
        let depth = 0;
        for (let j = i; j < s.length - 1; j++) {
            if (s[j] === '{' && s[j + 1] === '{') { depth++; j++; continue; }
            if (s[j] === '}' && s[j + 1] === '}') { depth--; j++; if (depth === 0) return j + 1; }
        }
        return -1;
    }
    let out = '';
    let i = 0;
    while (i < content.length) {
        if (content[i] === '{' && content[i + 1] === '{') {
            const end = findClose(content, i);
            if (end > 0) {
                const raw = content.slice(i + 2, end - 2);
                // {{// comment }} — consumed wholesale (ST postEnv macro)
                if (raw.startsWith('//')) { out += ''; i = end; continue; }
                const m = raw.match(/^([\w/-]+)\s*(?:::([\s\S]*))?$/);
                const name = m?.[1]?.trim().toLowerCase();
                const argstr = m?.[2];
                /** @type {string[]} */
                const args = [];
                if (argstr !== undefined && argstr !== '') {
                    // split top-level :: args (nested {{}} respected)
                    let depth = 0, cur = '';
                    for (let k = 0; k < argstr.length; k++) {
                        if (argstr[k] === '{' && argstr[k + 1] === '{') { depth++; cur += '{{'; k++; continue; }
                        if (argstr[k] === '}' && argstr[k + 1] === '}') { depth--; cur += '}}'; k++; continue; }
                        if (argstr[k] === ':' && argstr[k + 1] === ':' && depth === 0) { args.push(cur); cur = ''; k++; continue; }
                        cur += argstr[k];
                    }
                    args.push(cur);
                }
                const value = (/** @returns {string} */ () => {
                    switch (name) {
                        case 'setvar': vars.set(args[0]?.trim(), args[1] ?? ''); return '';
                        case 'addvar': vars.set(args[0]?.trim(), (vars.get(args[0]?.trim()) ?? '') + (args[1] ?? '')); return '';
                        case 'incvar': case 'decvar': {
                            const n = Number(vars.get(args[0]?.trim()) ?? 0) + (name === 'incvar' ? 1 : -1);
                            vars.set(args[0]?.trim(), String(n)); return '';
                        }
                        case 'getvar': {
                            if (args.length !== 1) return `{{${raw}}}`; // strictArgs: kept verbatim (ST behavior)
                            const v = vars.get(args[0]?.trim()) ?? '';
                            return v;
                        }
                        case 'trim': return '';
                        case '//': return ''; // {{// comment }} — consumed
                        case 'user': return PERSONA;
                        case 'char': return CHARNAME;
                        case 'roll': return String(1 + Math.floor(Math.random() * 20));
                        case 'newline': return '\n';
                        case 'noop': return '';
                        default: return `{{${raw}}}`; // unknown -> verbatim (ST keeps raw)
                    }
                })();
                out += value;
                i = end;
                continue;
            }
        }
        out += content[i];
        i++;
    }
    // {{trim}} eats surrounding newlines: apply that as a post-pass (ST's legacy
    // regex did (?:\r?\n)* around it; the new engine trims scoped content —
    // either way leading/trailing newlines around a consumed trim vanish).
    out = out.replace(/(?:\r?\n)*(?:\r?\n)*/g, (s, off, whole) => s); // no-op guard, real pass below
    out = out.replace(/\n{3,}/g, '\n\n');
    return out;
}

const flat = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim();

/**
 * Read the tab's live oai state + rendered DOM rows in one evaluate.
 * @returns {Promise<any>}
 */
async function probeAll() {
    return evalInPage(`(() => {
        const ctx = SillyTavern.getContext();
        const oai = ctx.chatCompletionSettings;
        const rows = Array.from(document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')).map(r => ({
            identifier: r.dataset.pmIdentifier,
            enabled: !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on'),
        }));
        return {
            preset: oai.preset_settings_openai,
            temperature: oai.temp_openai,
            prompt_order: oai.prompt_order?.[0]?.order ?? [],
            prompts: (oai.prompts ?? []).map(p => ({ identifier: p.identifier, name: p.name ?? null, content: p.content ?? '', role: p.role ?? null, enabled: !!p.enabled, injection_position: p.injection_position, injection_depth: p.injection_depth, marker: !!p.marker, system_prompt: !!p.system_prompt })),
            dom: rows,
        };
    })()`);
}

// ===========================================================================

async function main() {
    // ---------------------------------------------------------- environment
    let health = null;
    for (let i = 0; i < 2; i++) {
        try {
            const res = await api('GET', '/health');
            if (res.status === 200) { health = res.json; break; }
        } catch { /* down or restarting */ }
        if (i === 0) {
            console.error('[check] st-pm-dev not answering; run dev/up.sh (starts it with the plugin + mock LLM)');
            execFileSync(path.join(REPO, 'dev', 'up.sh'), { stdio: 'inherit' });
        }
    }
    if (!health) fatal('environment', 'st-pm-dev did not come up');
    await primeSession();

    // ------------------------------------------------- setup: reset + import
    console.error('[check] resetting dev data (dev/reset.sh)…');
    execFileSync(path.join(REPO, 'dev', 'reset.sh'), { stdio: 'inherit' });
    await primeSession();
    console.error('[check] importing fixtures (dev/import-fixtures.sh)…');
    execFileSync(path.join(REPO, 'dev', 'import-fixtures.sh'), { stdio: 'pipe' });

    const library = (await api('GET', '/library')).json ?? [];
    const byName = new Map(library.map((/** @type {any} */ e) => [e.name, e.id]));
    const ffId = byName.get(FF);
    const solaId = byName.get('Sola V2 Flame');
    const demId = byName.get('DEUS.EX.MACHINA.V2.5.ST');
    if (!ffId || !solaId || !demId) fatal('setup', `fixtures missing from library: FF=${ffId} Sola=${solaId} DEM=${demId}`);
    // Shared pristine DEM snapshot for the race checks + check 8 restore
    // baselines (the fixture state, before any probe applies anything)
    const demDoc0 = (await api('GET', `/presets/${demId}`)).json;

    // Probe tab: one held tab drives checks 3–8; killed at the end.
    console.error('[check] starting probe tab…');
    await startProbe(TAB_A);

    // ------------------------------------------------------------------ 1
    {
        const h = (await api('GET', '/health')).json;
        const log = containerLogs();
        const pass = h?.version === '2.0.0-phase1' && typeof h?.rev === 'number'
            && log.includes('Initializing plugin from') && log.includes('plugins/st-preset-manager/plugin/index.js')
            && log.includes('[st-preset-manager] plugin initialized');
        report('1 health+plugin', !!pass, `version=${h?.version} rev=${h?.rev} log lines found`);
    }

    // ------------------------------------------------------------------ 2
    {
        const lib = (await api('GET', '/library')).json ?? [];
        const ffDoc = (await api('GET', `/presets/${ffId}`)).json;
        const groups = [];
        const walk = (/** @type {any[]} */ rows) => { for (const r of rows ?? []) { if (r.kind === 'group') groups.push(r); walk(r.options); walk(r.rows); } };
        for (const seq of ffDoc.sequences ?? []) walk(seq.rows);
        const pick1 = groups.filter((g) => g.cardinality === 'pick-one').length;
        const conns = Object.keys(ffDoc.settings ?? {}).filter((k) =>
            ['chat_completion_source', 'openai_model', 'custom_url', 'proxy_password', 'reverse_proxy', 'claude_model'].includes(k));
        const onDisk = fs.readdirSync(path.join(PM_DIR, 'presets')).filter((f) => f.endsWith('.json')).length;
        // 4+4 pick-one/pick-one-or-more: import collapses the guessed echo
        // pairs (recognizer parity 7+1 is locked by test/recognizers.test.js)
        // every Chat Completion preset among the fixtures imports (27 before
        // the Nemo fixtures were added; derived so new fixtures don't break it)
        const fixDir = path.join(REPO, 'dev', 'fixtures', 'presets');
        const expected = fs.readdirSync(fixDir).filter((f) => {
            if (!f.endsWith('.json')) return false;
            const d = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
            return Array.isArray(d?.prompts) && Array.isArray(d?.prompt_order);
        }).length;
        const pass = lib.length === expected && groups.length === 8 && pick1 === 4 && conns.length === 0 && onDisk === expected;
        report('2 import+groups', !!pass, `library=${lib.length}/${expected} groups=${groups.length} (pick-one=${pick1}) connKeys=${conns.length} files=${onDisk}`);
    }

    // ------------------------------------------------------------------ 2b
    {
        // a preset imported into a subfolder survives POST /rescan (finding 5)
        const src = (await api('GET', `/presets/${ffId}`)).json;
        const body = { native: src, name: 'ChkRescan Survivor', folder: 'deep/nest' };
        const imp = await api('POST', '/presets', body);
        const id = imp.json?.id;
        let after = null, err = '';
        if (id) {
            const resc = await api('POST', '/rescan', {});
            const lib = (await api('GET', '/library')).json ?? [];
            after = lib.find((/** @type {any} */ e) => e.id === id);
            const doc = (await api('GET', `/presets/${id}`)).json;
            const gone = doc?.error || doc?.format !== 'st-preset-manager/library';
            // cleanup regardless of verdict
            await api('DELETE', `/presets/${id}`);
            await api('POST', '/rescan', {});
            if (!after) err = `lost after rescan (${resc.json?.count ?? '?'} indexed)`;
            else if (gone) err = 'reindexed but unreadable';
        } else err = `import failed: ${imp.text.slice(0, 120)}`;
        report('2b rescan keeps subfolder import', !!after && !err, err || `folder=${after?.folder} id=${id} survived POST /rescan`);
    }

    // ------------------------------------------------------------------ 3
    {
        // SSE hello arrives unbuffered (compression must not sit on it)
        const got = await new Promise((resolve) => {
            const chunks = [];
            const req = http.request(`${BASE}/events`, { method: 'GET', host: '127.0.0.1', port: 8002, headers: { cookie: fs.readFileSync(path.join(REPO, 'dev', '.check-phase1.cookies.jar'), 'utf8').trim() } }, (res) => {
                res.on('data', (c) => chunks.push(c));
            });
            req.on('error', () => resolve(null));
            const t = setTimeout(() => { req.destroy(); resolve(Buffer.concat(chunks).toString()); }, 4000);
            void t;
            req.end();
        });
        const ok = !!got && /data: .*"kind"\s*:\s*"hello"/.test(got.replace(/\s+/g, ' '));
        report('3 sse hello unbuffered', ok, got ? got.split('\n')[0].slice(0, 80) : 'nothing within 4s');
    }

    // --------------------------------------------------------------- 4 (+1a)
    {
        const load = await api('POST', '/slot/load', { presetId: ffId });
        if (load.status !== 200) fatal('4', `slot/load failed: ${load.text.slice(0, 120)}`);
        // apply broadcast → tab converges without reload: wait until oai AND
        // the rendered DOM both match the compiled order (render lags oai)
        const view = (await api('GET', '/slot')).json;
        await until(async () => {
            const t = await probeAll();
            return t.preset === SLOT_NAME
                && JSON.stringify(t.prompt_order) === JSON.stringify(view.compiled.prompt_order[0].order)
                && t.dom.length === view.compiled.prompt_order[0].order.length;
        }, 15000, 'tab applies slot (oai+DOM)');
        const tab = await probeAll();

        const orderEq = JSON.stringify(tab.prompt_order) === JSON.stringify(view.compiled.prompt_order[0].order);
        const tabPrompts = new Map(tab.prompts.map((/** @type {any} */ p) => [p.identifier, p]));
        let contentEq = true, mismatch = '';
        for (const cp of view.compiled.prompts) {
            const tp = tabPrompts.get(cp.identifier);
            if (!tp) { contentEq = false; mismatch = `tab missing prompt ${cp.identifier}`; break; }
            if ((tp.content ?? '') !== (cp.content ?? '') || (tp.role ?? null) !== (cp.role ?? null) || (tp.name ?? null) !== (cp.name ?? null)
                || tp.injection_position !== cp.injection_position || tp.injection_depth !== cp.injection_depth) {
                contentEq = false; mismatch = `prompt ${cp.identifier} differs (content/role/name/injection)`; break;
            }
        }
        const domEq = JSON.stringify(tab.dom) === JSON.stringify(view.compiled.prompt_order[0].order.map((/** @type {any} */ o) => ({ identifier: o.identifier, enabled: o.enabled })));
        const pass = orderEq && contentEq && domEq;
        report('4 slot apply: oai+DOM == GET /slot compiled', !!pass,
            `order=${orderEq} prompts=${contentEq}${mismatch ? ` (${mismatch})` : ''} domRows=${tab.dom.length}/${view.compiled.prompt_order[0].order.length}`);

        // generation → mock capture contains every enabled non-marker block,
        // macro-expanded exactly the way ST expands it
        evalInPage(`(() => { document.querySelector('#send_textarea').value = 'phase1 check'; document.querySelector('#send_but').dispatchEvent(new MouseEvent('click', {bubbles:true})); return true; })()`);
        await sleep(6500);
        const last = await new Promise((resolve, reject) => {
            http.get(`${MOCK}/last`, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
        });
        const captured = flat((last?.messages ?? []).map((/** @type {any} */ m) => m.content ?? '').join('\u0000'));
        const markers = new Set(['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'personaDescription', 'scenario', 'dialogueExamples', 'chatHistory']);
        const enabledBlocks = view.compiled.prompt_order[0].order.filter((/** @type {any} */ o) => o.enabled && !markers.has(o.identifier));
        // ST expands each enabled block once, in prompt_order, with variable
        // state shared across the build (setvar in main feeds getvar later)
        const macroVars = new Map();
        const expandedById = new Map();
        for (const o of view.compiled.prompt_order[0].order.filter((/** @type {any} */ x) => !markers.has(x.identifier))) {
            const cp = view.compiled.prompts.find((/** @type {any} */ p) => p.identifier === o.identifier);
            if (!cp || !o.enabled) continue;
            expandedById.set(o.identifier, expandMacros(cp.content ?? '', macroVars));
        }
        /** @type {string[]} */
        const missing = [];
        for (const o of enabledBlocks) {
            const cp = view.compiled.prompts.find((/** @type {any} */ p) => p.identifier === o.identifier);
            const want = flat(expandedById.get(o.identifier) ?? '');
            // roll values differ per generation — normalize seeded rolls
            const have = /Seed\d+:/.test(want) || /DnD Rolls/.test(want)
                ? captured.replace(/(Seed\d+:|User:|NPC:)\s+\d+/g, '$1 N')
                : captured;
            const probe = want.replace(/(Seed\d+:|User:|NPC:)\s+\d+/g, '$1 N').slice(0, 400);
            if (probe && !have.includes(probe)) missing.push(cp?.name ?? o.identifier);
        }
        report('4a mock capture carries all enabled blocks (macro-aware)', missing.length === 0,
            missing.length ? `missing: ${missing.slice(0, 4).join(' | ')}` : `${enabledBlocks.length}/${enabledBlocks.length} blocks present in capture (ST macro model applied)`);
    }

    {
        // panel toggle + slider write back into the doc
        const before = (await api('GET', `/presets/${ffId}`)).json;
        const target = before.loadouts[before.activeLoadoutId].enabled;
        const ident = Object.keys(target).find((k) => target[k] === true && before.blocks[k]);
        if (!ident) fatal('5', 'no enabled block to toggle');
        const clicked = await evalInPage(`(() => { const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${ident}"] .prompt-manager-toggle-action'); if (!el) return { ident: '${ident}', found: false }; el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return { ident: '${ident}', found: true }; })()`);
        if (!clicked?.found) fatal('5', `toggle control not found for ${ident}`);
        await until(async () => {
            const doc = (await api('GET', `/presets/${ffId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[ident] === false;
        }, 8000, 'toggle write-back');
        const afterToggle = (await api('GET', `/presets/${ffId}`)).json;
        const noOverride = Object.keys(afterToggle.loadouts[afterToggle.activeLoadoutId].overrides ?? {}).length === 0;
        // slider → settings.temperature (registry empty in Phase 1)
        evalInPage(`(() => { const el = document.getElementById('temp_openai'); el.value = 0.42; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
        await until(async () => {
            const slot = (await api('GET', '/slot')).json;
            return slot.compiled?.temperature === 0.42;
        }, 8000, 'temperature write-back');
        const docT = (await api('GET', `/presets/${ffId}`)).json;
        const tempRouted = docT.settings?.temperature === 0.42;
        const pass = noOverride && tempRouted;
        report('5 panel toggle+slider write back', !!pass,
            `toggle ${ident.slice(0, 8)}… → false, overrides=${noOverride ? 0 : 'CREATED'}, temperature routed to doc.settings=${tempRouted}`);
        // restore
        evalInPage(`(() => { const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${ident}"] .prompt-manager-toggle-action'); el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`);
        await until(async () => {
            const doc = (await api('GET', `/presets/${ffId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[ident] === true;
        }, 8000, 'toggle restore');
        evalInPage(`(() => { const el = document.getElementById('temp_openai'); el.value = 0.66; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
        await until(async () => ((await api('GET', '/slot')).json).compiled?.temperature === 0.66, 8000, 'temperature restore');
    }

    // ------------------------------------------------------------------ 6
    {
        // same tab: /slot/load Sola switches rows without reload; ops toggle reaches DOM
        const solaView0 = (await api('POST', '/slot/load', { presetId: solaId })).json;
        await until(async () => {
            const t = await probeAll();
            return t.preset === SLOT_NAME
                && JSON.stringify(t.prompt_order) === JSON.stringify(solaView0.compiled.prompt_order[0].order)
                && t.dom.length === solaView0.compiled.prompt_order[0].order.length
                ? true : { preset: t.preset, order: t.prompt_order.length, dom: t.dom.length, want: solaView0.compiled.prompt_order[0].order.length };
        }, 20000, 'tab switched to Sola');
        // settle: a late panel write-back from check 5 can flap the tab;
        // require the Sola view to hold steady for 2 consecutive seconds
        const solaDoc = (await api('GET', `/presets/${solaId}`)).json;
        const viewS = (await api('GET', '/slot')).json;
        await until(async () => {
            const a = await probeAll();
            if (a.prompt_order.length !== solaView0.compiled.prompt_order[0].order.length) return false;
            await sleep(1000);
            const b = await probeAll();
            return b.prompt_order.length === solaView0.compiled.prompt_order[0].order.length
                && JSON.stringify(b.prompt_order) === JSON.stringify(viewS.compiled.prompt_order[0].order)
                ? true : { flapped: a.prompt_order.length, then: b.prompt_order.length };
        }, 20000, 'Sola view settles');
        const tabS = await probeAll();
        const solaRows = tabS.prompt_order.length === viewS.compiled.prompt_order[0].order.length;
        const isSola = tabS.prompt_order.some((/** @type {any} */ o) => {
            const p = solaDoc.blocks?.[o.identifier] ?? solaDoc.markers?.find((/** @type {any} */ m) => m.identifier === o.identifier);
            return !!p;
        }) && tabS.prompts.length === viewS.compiled.prompts.length;
        // ops toggle → DOM shows it (leaf must sit in compiled prompt_order,
        // not an orphan block that renders no row)
        const ord = solaDoc.loadouts[solaDoc.activeLoadoutId].enabled;
        const orderIds = new Set(viewS.compiled.prompt_order[0].order.map((/** @type {any} */ o) => o.identifier));
        const leaf = Object.keys(ord).find((k) => solaDoc.blocks[k] && orderIds.has(k));
        const before = ord[leaf];
        const ops = await api('POST', `/presets/${solaId}/ops`, { op: 'toggle', identifier: leaf });
        if (ops.status !== 200) fatal('6', `ops toggle failed: ${ops.text.slice(0, 120)}`);
        await until(async () => {
            const t = await probeAll();
            const row = t.dom.find((/** @type {any} */ r) => r.identifier === leaf);
            return row && row.enabled === !before ? true : { found: !!row, rowEnabled: row?.enabled, want: !before };
        }, 10000, 'ops toggle in DOM');
        const pass = solaRows && isSola;
        report('6 slot/load no-reload + ops toggle reaches DOM', !!pass,
            `rows ${57}→${tabS.prompt_order.length} sola=${isSola} opsToggle visible`);
        // toggle back for a clean state
        await api('POST', `/presets/${solaId}/ops`, { op: 'toggle', identifier: leaf, value: before });
        await until(async () => {
            const doc = (await api('GET', `/presets/${solaId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[leaf] === before;
        }, 8000, 'sola toggle restore');
    }

    // ------------------------------------------------------------------ race
    {
        // finding 3: mutation while an apply is mid-flight must converge to
        // the latest rev. Fire two rapid /slot/load calls (A wins) and then,
        // while the tab is still applying, an ops toggle; the tab must end
        // on the latest rev with the toggled state visible.
        await api('POST', '/slot/load', { presetId: solaId });       // first target
        const p1 = api('POST', '/slot/load', { presetId: demId });   // race: switch again immediately
        await sleep(30);                                             // land mid-apply window
        const demDoc = (await api('GET', `/presets/${demId}`)).json;
        const ord = demDoc.loadouts[demDoc.activeLoadoutId].enabled;
        const leaf = Object.keys(ord).find((k) => demDoc.blocks[k]);
        const ops = api('POST', `/presets/${demId}/ops`, { op: 'toggle', identifier: leaf, value: !ord[leaf] });
        await Promise.all([p1, ops]);
        // convergence: the tab shows the DEM order WITH the toggle applied
        const view = await until(async () => {
            const v = (await api('GET', '/slot')).json;
            const t = await probeAll();
            const orderEq = JSON.stringify(t.prompt_order) === JSON.stringify(v.compiled.prompt_order[0].order);
            const row = t.dom.find((/** @type {any} */ r) => r.identifier === leaf);
            return orderEq && row?.enabled === !ord[leaf] ? v : null;
        }, 15000, 'race convergence');
        const pass = !!view && view.desired.presetId === demId && view.rev >= (ops.status === 200 ? 0 : 1);
        // settle doc back
        await api('POST', `/presets/${demId}/ops`, { op: 'toggle', identifier: leaf, value: ord[leaf] });
        await until(async () => {
            const doc = (await api('GET', `/presets/${demId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[leaf] === ord[leaf];
        }, 8000, 'race doc restore');
        report('race mid-apply mutation converges', !!pass,
            pass ? `tab on ${view.desired.presetId === demId ? 'DEM' : '?'} rev=${view.rev} with toggled row visible` : 'tab did not converge to latest rev');
    }

    // ------------------------------------------------------ race-blocked
    {
        // finding 7 (observed panel edit during an apply): the reconcile op's
        // input blocker is not decorative. Hold the op's GET /slot with a
        // page-side fetch hook, trigger a reconcile from an API ops write,
        // and observe that user-like edits are REFUSED while held (no silent
        // queuing, no lost edit): clickToggle returns false through the
        // overlay, and a slider set races the flush instead of landing.
        // Releasing then converges everything on the API's value. No sleeps
        // as correctness conditions: the hold itself is the clock. No idle
        // pre-gate either: arming the hold before firing the ops write
        // guarantees the next reconcile parks on its GET (an SSE rev is only
        // ignored once consumed, and consuming it takes a reconcile), and a
        // busy queue only means the blocker is up for that reason too.
        await evalInPage(HOLD_INSTALL);
        const doc = (await api('GET', `/presets/${demId}`)).json;
        const enabled = doc.loadouts[doc.activeLoadoutId].enabled;
        const heldLeaf = Object.keys(enabled).find((k) => demDoc0.blocks[k]);
        if (!heldLeaf) fatal('race-blocked', 'no leaf block to toggle on DEM');
        const heldBefore = enabled[heldLeaf];
        try {
            // API write: the SSE 'preset' event enqueues the reconcile whose
            // GET the hook then holds after the op's flush. A leftover queued
            // op from the earlier checks can consume the hold with an EMPTY
            // flush first; that is retryable (release, drain, re-arm), not a
            // failure — bounded retries, each condition observable state.
            let parked = null;
            let ops = null;
            for (let attempt = 1; attempt <= 4 && !parked; attempt++) {
                await evalInPage(HOLD_BEGIN);
                ops = api('POST', `/presets/${demId}/ops`, { op: 'toggle', identifier: heldLeaf, value: !heldBefore });
                const deadline = Date.now() + 8000;
                while (!parked && Date.now() < deadline) {
                    if (await evalInPage(`!!document.querySelector('.pm-apply-blocker')`)) parked = true;
                    else await sleep(250);
                }
                if (!parked) {
                    await evalInPage(HOLD_RELEASE);
                    await until(async () => (await evalInPage(`!!document.querySelector('.pm-apply-blocker')`)) === false, 15000, 'queue drains between race-blocked attempts');
                }
            }
            if (!parked) throw new Error('race-blocked: no reconcile mounted the blocker under the hold in 4 attempts');
            // parked mid-op: user-like edits must be REFUSED while held. The
            // refused click is dispatched in the SAME page turn that re-reads
            // the blocker: JS is single-threaded, so overlay-seen + click is
            // atomic — a transient (non-parking) op cannot make a real toggle
            // slip through a gap between two separate page turns (a false
            // PASS in an earlier run: overlay gone by click time, the real
            // toggle flipped, restore logic then "restored" the same value
            // and nothing failed). Retry until a turn genuinely sees it.
            let click = null;
            let seenInTurn = false;
            for (let attempt = 1; attempt <= 4 && !seenInTurn; attempt++) {
                click = await evalInPage(`(() => {
                    if (!document.querySelector('.pm-apply-blocker')) return { seen: false, click: null };
                    return { seen: true, click: ${clickToggle(heldLeaf)} };
                })()`);
                seenInTurn = click?.seen === true;
                if (!seenInTurn) await sleep(250);
            }
            if (!seenInTurn) throw new Error('race-blocked: overlay was gone by click time in 4 attempts (reconcile not parked)');
            const slider = await evalInPage(`(() => { const el = document.getElementById('temp_openai'); el.value = 0.42; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
            const stillHeld = await evalInPage(`!!window.__pmHold`);
            if (!stillHeld) throw new Error('hold released early');
            const opsStatus = (await ops).status;
            const pass = click.click === false && slider === true && stillHeld && opsStatus === 200;
            report('race-blocked: edits refused while reconcile holds', !!pass,
                `click refused=${click.click === false} (overlay present=${seenInTurn}) slider raced=${slider === true} ops=${opsStatus}`);
            // release: the parked GET completes, the apply lands the API state
            await evalInPage(HOLD_RELEASE);
            const slot = await until(async () => {
                const s = (await api('GET', '/slot')).json;
                const t = await probeAll();
                const want = JSON.stringify(s.compiled.prompt_order[0].order);
                return s.compiled !== null
                    && JSON.stringify(t.prompt_order) === want
                    && (t.dom.find((/** @type {any} */ r) => r.identifier === heldLeaf) ?? {}).enabled === !heldBefore
                    ? s : null;
            }, 15000, 'race-blocked convergence');
            report('race-blocked: release converges to API state', !!slot,
                `slot on ${slot?.desired?.presetId === demId ? 'DEM' : '?'} rev=${slot?.rev} row ${heldLeaf.slice(0, 10)}…=${!heldBefore} in tab+slot, blocker gone`);
        } finally {
            await releaseHold();
            // restore the doc so later checks start from the fixture state
            await api('POST', `/presets/${demId}/ops`, { op: 'toggle', identifier: heldLeaf, value: heldBefore });
            await until(async () => {
                const d = (await api('GET', `/presets/${demId}`)).json;
                return d.loadouts[d.activeLoadoutId].enabled[heldLeaf] === heldBefore;
            }, 8000, 'race-blocked doc restore');
        }
    }

    // -------------------------------------------------- race-flush-first
    {
        // finding 7, lost-edit direction: a user slider edit made while a
        // slot update is in flight must reach the server BEFORE the incoming
        // state is applied over it (reconcileOp flushes first). 0.77 is set
        // like a user, and the API write is fired in the SAME page turn so
        // it cannot depend on debounce timing; the held GET then freezes the
        // op deterministically between its flush and its GET. The op's
        // flush posts 0.77, so 0.77 — the user's edit — is the last write
        // everywhere. No idle pre-gate: a leftover queued op can consume
        // the hold with an empty flush, which is retryable (release, drain,
        // re-arm); the real proof is observing 0.77 land in the doc WHILE
        // the hold is still armed.
        await evalInPage(HOLD_INSTALL);
        let tab = null;
        try {
            let attempt = 1;
            for (; attempt <= 4 && !tab; attempt++) {
                // user edit + API write in ONE page-side evaluate: the
                // slider events fire first, then the API setSettings is
                // posted from the page (same session, same CSRF path as the
                // bridge's own calls)
                const fired = await evalInPage(`(async () => {
                    const el = document.getElementById('temp_openai');
                    el.value = 0.77;
                    el.dispatchEvent(new Event('input',{bubbles:true}));
                    el.dispatchEvent(new Event('change',{bubbles:true}));
                    const csrf = (await (await fetch('/csrf-token', { credentials: 'include' })).json()).token;
                    const res = await fetch('/api/plugins/st-preset-manager/presets/${demId}/ops', {
                        method: 'POST', credentials: 'include',
                        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
                        body: JSON.stringify({ op: 'setSettings', settings: { temperature: 0.31 } }),
                    });
                    return res.status;
                })()`);
                if (fired !== 200) fatal('race-flush-first', `page-side API write failed: ${fired}`);
                await evalInPage(HOLD_BEGIN);
                // flush-first, observed: 0.77 must reach the doc while the
                // GET is still parked — before any incoming state could be
                // applied over it. If a straggler parked with an empty
                // flush instead, nothing lands under the hold: release,
                // drain, re-arm, try again.
                const deadline = Date.now() + 8000;
                while (!tab && Date.now() < deadline) {
                    const docT = (await api('GET', `/presets/${demId}`)).json;
                    if (docT.settings?.temperature === 0.77) {
                        const holdStill = await evalInPage(`!!window.__pmHold`);
                        if (!holdStill) throw new Error('hold released early');
                        const stillHeld = await evalInPage(`!!document.querySelector('.pm-apply-blocker')`);
                        report('race-flush-first: user edit flushed before held GET', true,
                            `doc=0.77 while blocker=${stillHeld} and GET still held (user 0.77 beat the incoming 0.31)`);
                        // release: the parked GET returns the 0.77 slot and
                        // applies it; everything converges with no straggler
                        await evalInPage(HOLD_RELEASE);
                        tab = await until(async () => {
                            const t = await probeAll();
                            const slotT = (await api('GET', '/slot')).json;
                            return slotT.compiled?.temperature === 0.77 && t.temperature === 0.77
                                ? { slot: slotT, tab: t } : null;
                        }, 15000, 'race-flush-first 0.77 in slot+tab');
                        break;
                    }
                    await sleep(250);
                }
                if (!tab) {
                    await evalInPage(HOLD_RELEASE);
                    await until(async () => (await evalInPage(`!!document.querySelector('.pm-apply-blocker')`)) === false, 15000, 'queue drains between flush-first attempts');
                }
            }
            report('race-flush-first: user edit wins everywhere', !!tab,
                tab ? `slot=${tab.slot.compiled.temperature} tab=${tab.tab.temperature} (flush reached the server before the GET)` : '0.77 never landed under the hold in 4 attempts');
        } finally {
            await releaseHold();
            // restore: API write is the latest, converges everywhere
            await api('POST', `/presets/${demId}/ops`, { op: 'setSettings', settings: { temperature: demDoc0.settings?.temperature ?? 1 } });
            await until(async () => {
                const { slot, a } = await (async () => ({ slot: (await api('GET', '/slot')).json, a: await probeAll() }))();
                return slot.compiled?.temperature === (demDoc0.settings?.temperature ?? 1) && a.temperature === (demDoc0.settings?.temperature ?? 1);
            }, 8000, 'race-flush-first restore');
        }
    }

    // ---------------------------------------------------------- race-409
    {
        // finding 7, stale-base direction, THROUGH THE BRIDGE (Review 3):
        // the bridge's own flushPanel() computed against the tab's OLD base
        // must receive the 409 after a slot/load (slotChangedRev guard) and
        // CONSUME it — drop the stale baseline (baseSnapshot=null), force a
        // re-apply (appliedHash=null), set _flushStale — without throwing,
        // leaving preset X's document untouched (no cross-preset delta pour
        // into preset Y) and converging the tab onto Y after release.
        // Deterministic shape: arm the hold, load Y (rev+slotChangedRev bump
        // is committed when the POST returns), then flip a toggle with ST's
        // OWN handler — clickToggle refuses under the overlay, so per the
        // fix spec the live panel is mutated and bridge.flushPanel() is
        // called directly: it enqueues nothing, so it runs NOW, snapshots
        // the mutated panel and POSTs the delta with the PRE-LOAD baseRev —
        // the 409 lands inside the flushPanel call we await. No sleeps as
        // correctness conditions: the hold is the clock; the short settle
        // below only lets ST's synchronous toggle handler reach the live
        // settings before the snapshot (a missed flip fails the check
        // loudly instead of passing silently).
        await evalInPage(HOLD_INSTALL);
        // tab is attached to DEM (X); capture its live base + rev BEFORE the
        // try so the finally cannot touch a half-captured leaf
        const xDoc = (await api('GET', `/presets/${demId}`)).json;
        const enabled = xDoc.loadouts[xDoc.activeLoadoutId].enabled;
        const soloLeaf = Object.keys(enabled).find((k) => demDoc0.blocks[k]);
        const soloBefore = enabled[soloLeaf];
        try {
            await evalInPage(HOLD_BEGIN);
            // Y's load bumps rev; slotChangedRev = rev parks ABOVE the tab's baseRev
            const loadY = await api('POST', '/slot/load', { presetId: solaId });
            if (loadY.status !== 200) fatal('race-409', `slot/load Sola failed: ${loadY.text.slice(0, 100)}`);
            const outcome = await evalInPage(`(async () => {
                const b = globalThis.__pmStarted.bridge;
                const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${soloLeaf}"] .prompt-manager-toggle-action');
                if (!el) return { error: 'toggle control not found for ${soloLeaf}' };
                // ST's own toggle handler (same dispatch check 5 uses):
                // flips the live panel bit, then saveSettingsDebounced
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                await new Promise((r) => setTimeout(r, 120));
                let flushErr = null;
                try { await b.flushPanel(); } catch (e) { flushErr = String((e && e.message) || e); }
                return {
                    flushErr,
                    flushStale: b._flushStale === true,
                    baseDropped: b.baseSnapshot === null,
                    hashDropped: b.appliedHash === null,
                    held: !!window.__pmHold,
                };
            })()`);
            if (outcome?.error) fatal('race-409', outcome.error);
            const xAfter = (await api('GET', `/presets/${demId}`)).json;
            const untouched = xAfter.loadouts[xAfter.activeLoadoutId].enabled[soloLeaf] === soloBefore;
            const pass = !outcome.flushErr && outcome.flushStale && outcome.baseDropped && outcome.hashDropped && untouched && outcome.held;
            report('race-409: bridge flush 409 consumed (stale base dropped, re-apply forced)', !!pass,
                `flushStale=${outcome.flushStale} baseSnapshot=null=${outcome.baseDropped} appliedHash=null=${outcome.hashDropped} throw=${outcome.flushErr ?? 'no'} held=${outcome.held}, DEM ${soloLeaf.slice(0, 10)}… still ${soloBefore} (no cross-preset pour)`);
            await evalInPage(HOLD_RELEASE);
            // the parked reconcile now completes: the new desired state (Y)
            // applies over the dropped stale edit and the tab converges onto Y
            const yView = await until(async () => {
                const s = (await api('GET', '/slot')).json;
                const t = await probeAll();
                return s.desired?.presetId === solaId
                    && JSON.stringify(t.prompt_order) === JSON.stringify(s.compiled.prompt_order[0].order)
                    ? s : null;
            }, 20000, 'race-409 tab converges to Sola');
            report('race-409: released tab converges to loaded preset Y', !!yView,
                yView ? `tab on ${yView.desired.presetId === solaId ? 'Sola' : '?'} rev=${yView.rev}` : 'tab did not reach Sola after release');
        } finally {
            await releaseHold();
        }
    }

    // ------------------------------------------------------------------ 7
    {
        // cold tab: kill probe, load DEM, settings.json untouched, fresh tab applies desired
        stopChrome();
        const stBefore = mtimeOf(USER_DIR, 'settings.json');
        const slotFile = path.join(OPENAI_DIR, `${SLOT_NAME}.json`);
        const slotBefore = fs.existsSync(slotFile) ? fs.statSync(slotFile).mtimeMs : 0;
        await api('POST', '/slot/load', { presetId: demId });
        await sleep(2000);
        const stAfter = mtimeOf(USER_DIR, 'settings.json');
        const slotAfter = fs.existsSync(slotFile) ? fs.statSync(slotFile).mtimeMs : 0;
        const untouched = stBefore === stAfter && slotBefore === slotAfter;
        await startProbe(TAB_A);
        // cold boot: extension init (SETTINGS_LOADED) + bridge apply land
        // after the preset select fills, so wait for convergence the same
        // way check 4 does instead of probing immediately
        const view = (await api('GET', '/slot')).json;
        await until(async () => {
            const t = await probeAll();
            return t.preset === SLOT_NAME
                && JSON.stringify(t.prompt_order) === JSON.stringify(view.compiled.prompt_order[0].order);
        }, 20000, 'cold tab applies slot');
        const t = await probeAll();
        const applied = t.preset === SLOT_NAME
            && JSON.stringify(t.prompt_order) === JSON.stringify(view.compiled.prompt_order[0].order);
        const pass = untouched && applied;
        report('7 cold tab applies desired; plugin wrote no ST files', !!pass,
            `settings.json+slot mtime unchanged=${untouched}, fresh tab applied=${applied}`);
    }

    // ------------------------------------------------------------------ 8
    {
        // two tabs + API: latest write wins everywhere
        // (startTabB launches tab B's chromium itself; calling startProbe
        // here would cleanupTabs() tab A away and kill its live CDP ws)
        await startTabB();
        await until(async () => (await probeAllB()).prompt_order.length > 0, 20000, 'tab B up');
        const demDoc = (await api('GET', `/presets/${demId}`)).json;
        const enabledMap = demDoc.loadouts[demDoc.activeLoadoutId].enabled;
        const leaf = Object.keys(enabledMap).find((k) => demDoc.blocks[k]);
        // A user cannot edit through the bridge's apply overlay: check the
        // blocker and set the slider in ONE synchronous page turn (the overlay
        // mounts in a different task), retrying while an apply is running.
        const setTemp = async (/** @type {number} */ v, /** @type {string} */ which) => {
            await until(async () => (await evalInPage(`(() => { if (document.querySelector('.pm-apply-blocker')) return false; const el = document.getElementById('temp_openai'); el.value = ${v}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`)) === true, 10000, `set temperature ${v} on ${which}`);
        };
        /** @param {string} tab which tab to click on (A|B) — the probe chrome is shared; tab B runs in the same page (same profile? no) */
        // NOTE: TAB_B is a separate chromium; drive it by switching cdp ws targets.
        const readAll = async () => {
            const slot = (await api('GET', '/slot')).json;
            const a = await probeAll();
            const b = await probeAllB();
            return { slot, a, b };
        };
        let evidence = '';
        let pass = true;
        // API wins over A's click. A's click reaches the doc through the
        // bridge's panel write-back (base->snapshot delta), so it lands a
        // beat later than the click itself; firing the API toggle first
        // would race the echo. Let the click land, then fire the API write
        // — it is then genuinely the latest write and must win everywhere.
        await until(async () => (await evalInPage(clickToggle(leaf))) === true, 10000, `click ${leaf} on A`);
        await until(async () => {
            const doc = (await api('GET', `/presets/${demId}`)).json;
            return doc.loadouts[doc.activeLoadoutId].enabled[leaf] === false;
        }, 10000, 'A click write-back lands');
        await api('POST', `/presets/${demId}/ops`, { op: 'toggle', identifier: leaf, value: true });
        await until(async () => {
            const { a, b } = await readAll();
            return rowOf(a, leaf) === true && rowOf(b, leaf) === true;
        }, 10000, 'API-on settles in A+B');
        // A's slider vs API. A's slider reaches the doc via panel write-back
        // (a beat after the input event), so settle it first; the API write
        // is then genuinely the latest and must win.
        await setTemp(0.42, 'A');
        await until(async () => {
            const doc = (await api('GET', `/presets/${demId}`)).json;
            return doc.settings?.temperature === 0.42;
        }, 10000, 'A 0.42 write-back lands');
        await api('POST', `/presets/${demId}/ops`, { op: 'setSettings', settings: { temperature: 0.9 } });
        await until(async () => {
            const { slot, a, b } = await readAll();
            return slot.compiled.temperature === 0.9 && a.temperature === 0.9 && b.temperature === 0.9;
        }, 10000, 'latest temperature wins');
        const { slot: s2 } = await readAll();
        pass = s2.compiled.temperature === 0.9;
        evidence = `latest write (0.9) in slot+A+B`;
        // and the reverse order: API first, A's slider last. The API write
        // must land in the doc BEFORE A's slider fires, otherwise the panel
        // echo and the reconcile it triggers can interleave (same race as
        // phase 1); settled first, A's slider is genuinely the latest write.
        await api('POST', `/presets/${demId}/ops`, { op: 'setSettings', settings: { temperature: 0.42 } });
        await until(async () => {
            const slot = (await api('GET', '/slot')).json;
            return slot.compiled.temperature === 0.42;
        }, 10000, 'API 0.42 lands');
        await setTemp(0.66, 'A');
        let lastT = null;
        await until(async () => {
            const { slot, a, b } = await readAll();
            lastT = { slot: slot.compiled.temperature, a: a.temperature, b: b.temperature };
            return slot.compiled.temperature === 0.66 && a.temperature === 0.66 && b.temperature === 0.66;
        }, 10000, 'A-last wins').catch((e) => { throw new Error(`${e.message} ${JSON.stringify(lastT)}`); });
        report('8 two tabs + API latest-write-wins', pass, evidence + ' (both orders)');
        // cleanup: restore FF's temperature routing state
        await api('POST', `/presets/${demId}/ops`, { op: 'setSettings', settings: { temperature: demDoc.settings?.temperature ?? 1 } });
    }

    // ------------------------------------------------------------------ 9
    {
        // --no-plugin: notice only, no writes (needs container restart)
        stopChrome();
        execFileSync(path.join(REPO, 'dev', 'down.sh'), { stdio: 'pipe' });
        execFileSync(path.join(REPO, 'dev', 'up.sh'), ['--no-plugin'], { stdio: 'pipe' });
        const health404 = (await api('GET', '/health')).status === 404;
        await startProbe(TAB_A);
        // wait for ST's own boot-time settings save to flush FIRST: the
        // guarantee under test is "no EXTENSION-driven writes", so the
        // measured window must start after the browser's first boot save
        await sleep(2500);
        const stBefore = mtimeOf(USER_DIR, 'settings.json');
        const slotFile = path.join(OPENAI_DIR, `${SLOT_NAME}.json`);
        const slotBefore = fs.existsSync(slotFile) ? fs.statSync(slotFile).mtimeMs : 0;
        // the extension module initializes some beats after the preset select
        // fills (SETTINGS_LOADED -> init -> pluginHealth round-trip); wait for
        // the menu item instead of clicking into the void
        let clickRes = null;
        for (let i = 0; i < 40; i++) {
            clickRes = await evalInPage(`(() => {
                const m = document.getElementById('pm-menu-item');
                if (!m) return { ok: false };
                m.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return { ok: true };
            })()`);
            if (clickRes?.ok) break;
            await sleep(500);
        }
        await sleep(1000);
        const notice = await evalInPage(`!!document.querySelector('.pm-install-notice')`);
        const stAfter = mtimeOf(USER_DIR, 'settings.json');
        const slotAfter = fs.existsSync(slotFile) ? fs.statSync(slotFile).mtimeMs : 0;
        const logs = containerLogs();
        const notInit = !logs.includes('[st-preset-manager] plugin initialized');
        const pass = health404 && clickRes?.ok && notice && stBefore === stAfter && slotBefore === slotAfter && notInit;
        report('9 --no-plugin: install notice only', !!pass,
            `health=${health404 ? 404 : 'up?'}, notice=${notice}, pluginInLog=${!notInit}, files unchanged=${stBefore === stAfter && slotBefore === slotAfter}`);
        // back to plugin mode
        stopChrome();
        execFileSync(path.join(REPO, 'dev', 'down.sh'), { stdio: 'pipe' });
        execFileSync(path.join(REPO, 'dev', 'up.sh'), { stdio: 'pipe' });
        await primeSession();
    }

    // ------------------------------------------------------------------ 10
    {
        execFileSync('npm', ['test'], { cwd: REPO, stdio: 'pipe' });
        execFileSync('npm', ['run', 'typecheck'], { cwd: REPO, stdio: 'pipe' });
        report('10 npm test + typecheck', true, 'node --test all green, tsc clean');
    }

    stopChrome();
    finish();
}

/** click helper string for a leaf toggle in the prompt manager list. Like a
 * user, it cannot click through the bridge's apply overlay or on a row ST has
 * not rendered yet: returns false then, and the caller retries. */
function clickToggle(/** @type {string} */ ident) {
    return `(() => { if (document.querySelector('.pm-apply-blocker')) return false; const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${ident}"] .prompt-manager-toggle-action'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`;
}
/** @param {any} probeView @param {string} ident */
function rowOf(probeView, ident) {
    const row = probeView.dom.find((/** @type {any} */ r) => r.identifier === ident);
    return row ? row.enabled : null;
}

// ------------------------------------------------------------------ race helpers

/**
 * Page-side fetch hook for the deterministic race windows (finding 7):
 * HOLD_INSTALL wraps window.fetch so a GET …/st-preset-manager/slot is held
 * until HOLD_RELEASE resolves window.__pmHold — the bridge's reconcile op
 * then freezes mid-flight, after its flushPanel and BEFORE its GET. The
 * panel POST (/slot/panel) and everything else pass through untouched
 * (method gate); EventSource does not use fetch at all. Each check wraps
 * its body in try/finally { releaseHold() } so a failure cannot leak the
 * hook into the next check.
 */
const HOLD_INSTALL = `(() => {
    if (window.__pmRealFetch) return false;
    const real = window.fetch.bind(window);
    window.__pmRealFetch = real;
    window.__pmHold = null;
    window.__pmRelease = null;
    window.__pmHeld = 0;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        if (window.__pmHold && method === 'GET' && url.includes('/st-preset-manager/slot')) {
            window.__pmHeld += 1;
            const p = window.__pmHold.then(() => real(input, init));
            p.finally(() => { window.__pmHold = null; });
            return p;
        }
        return real(input, init);
    };
    return true;
})()`;
const HOLD_BEGIN = `(() => { window.__pmHold = new Promise((r) => { window.__pmRelease = r; }); return true; })()`;
const HOLD_RELEASE = `(() => { const r = window.__pmRelease; window.__pmRelease = null; if (r) r(); return !!r; })()`;
const HOLD_UNINSTALL = `(() => {
    window.__pmHold = null;
    window.__pmRelease = null;
    if (window.__pmRealFetch) { window.fetch = window.__pmRealFetch; window.__pmRealFetch = null; }
    return true;
})()`;

/** Release + remove the fetch hold hook, however the check ended. */
async function releaseHold() {
    try { await evalInPage(HOLD_RELEASE); } catch { /* page gone */ }
    try { await evalInPage(HOLD_UNINSTALL); } catch { /* page gone */ }
}

// ------------------------------------------------------------------ tab B

/**
 * Launch tab B's chromium via its own Probe. Tab-B-specific behaviour kept
 * from startTabB: its cleanup is scoped to [TAB_B] only (Probe.start does
 * that per tab — never tab A's live chrome), the fatal name is '8', the
 * boot wait swallows per-try errors while ST is still booting, and its
 * fatal message on timeout is tab-B's own wording.
 */
async function startTabB() {
    // no bootCheck: tab B's boot wait tolerates per-try eval errors while
    // ST is still booting (Probe.start's strict loop would surface the
    // first error instead of retrying), so the wait stays here
    await probeB.start({ bootCheck: false });
    // wait for ST boot
    for (let i = 0; i < 240; i++) {
        try {
            const ready = await evalInPageB('(document.getElementById("settings_preset_openai")?.options.length ?? 0) > 1');
            if (ready) return;
        } catch { /* booting */ }
        await sleep(500);
    }
    fatal('8', 'tab B SillyTavern never finished booting');
}

/** @returns {Promise<any>} */
async function probeAllB() {
    if (!probeB.ws) throw new Error('tab B not started');
    return evalInPageB(`(() => {
        const ctx = SillyTavern.getContext();
        const oai = ctx.chatCompletionSettings;
        return {
            preset: oai.preset_settings_openai,
            temperature: oai.temp_openai,
            prompt_order: oai.prompt_order?.[0]?.order ?? [],
            dom: Array.from(document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')).map(r => ({
                identifier: r.dataset.pmIdentifier,
                enabled: !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on'),
            })),
        };
    })()`);
}

// tab B's evalInPageB/evalInPage wrappers live in the probe section above.

main().catch((err) => {
    console.error('[check] crashed:', err?.stack ?? err);
    report('crashed', false, String(err?.message ?? err).slice(0, 200));
    stopChrome();
    finish();
});
