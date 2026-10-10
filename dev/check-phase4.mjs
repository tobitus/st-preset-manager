#!/usr/bin/env node
/**
 * Phase 4 acceptance (roadmap acceptance 2 model half, 7, 8, 16, 17 + tidy)
 * as one repeatable real-browser script: PLAN §2 Phase 4 checks 1–7. Drives
 * the ACTUAL v2 window (Settings tab, toolbar Model picker, tuning panel,
 * loadout override editor, guard dialog) and ST's OWN controls (sampler
 * slider, prompt-manager toggle, connection-profile dropdown) in a headless
 * Chromium over raw CDP, and observes ST's live state, the plugin REST API
 * and the files on disk.
 *
 *   node dev/check-phase4.mjs            all checks (resets dev data first)
 *   CHK_SKIP=5b,6a node dev/check-phase4.mjs   skip checks by id (diagnosis only)
 *
 * Checks:
 *   1  seed from profiles + owner merge in the UI -> one "Kimi K3", 2 matches
 *   2  acceptance 7: toolbar picker switches ST's connection + tuning
 *   3  acceptance 2 (model half): panel temperature -> hot tuning / default tuning
 *   4  acceptance 16: per-Model loadout override on/off by Model
 *   5  acceptance 17: both Kimi profiles (ST's dropdown) -> same state
 *   6  acceptance 8: profile guard names the profile, Unlink works
 *   7  tidy: backup has every original, settings.json keeps 2
 *   8  bind_preset_to_connection forced off once, with a toast
 *
 * Environment: st-pm-dev on 127.0.0.1:8002 with the plugin (dev/up.sh), the
 * mock LLM on :8099. dev/reset.sh runs first (tidy is destructive). Never
 * touches :8001, the sillytavern container, ~/tools/ST-dev or
 * /home/jon/projects/sillysystem/st.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    FF, Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';

const TAB = 'chk4';
const SOLA = 'Sola V2 Flame';
const KIMI = 'Kimi K3';
const HAP = 'hapuppy/kimi-k3';
const NANO = 'nanogpt-payg/moonshotai/kimi-k3';
const SETTINGS_FILE = path.join(REPO, 'dev', 'data', 'default-user', 'settings.json');
const BACKUP_DIR = path.join(REPO, 'dev', 'data', 'default-user', 'preset-manager', 'backups');
const SHOTS = path.join(REPO, 'dev', 'shots');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-phase4.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
/** a second, independent tab (check 5b) */
const probeB = new Probe(`${TAB}b`, { onFatal: fatal });
onExit(() => { probe.kill(); probeB.kill(); });
process.on('exit', () => cleanupTabs([TAB, `${TAB}b`]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { ff: '', sola: '', kimiBlock: '' };
/** profile name -> id (from the tab's live connection manager) */
const prof = /** @type {Record<string, string>} */ ({});
let mockName = '';

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);
const setValue = (/** @type {string} */ sel, /** @type {string} */ value, evt = 'input') => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return true; })()`);
const setChecked = (/** @type {string} */ sel, /** @type {boolean} */ value) => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.checked = ${value ? 'true' : 'false'}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

/** ST's live chat-completion state + connection panel. */
function st(pr = probe) {
    return pr.eval(`(() => {
        const c = SillyTavern.getContext();
        const o = c.chatCompletionSettings;
        const sel = document.getElementById('connection_profiles');
        return {
            preset: o.preset_settings_openai,
            temperature: o.temp_openai,
            order: o.prompt_order?.[0]?.order ?? [],
            source: document.getElementById('chat_completion_source')?.value ?? null,
            model: document.getElementById('custom_model_id')?.value ?? null,
            profile: sel?.selectedOptions?.[0]?.textContent ?? null,
            selectedProfile: c.extensionSettings.connectionManager.selectedProfile ?? null,
            blocker: !!document.querySelector('.pm-apply-blocker'),
            appliedSlotChangedRev: window.__pmStarted?.bridge?.appliedSlotChangedRev ?? -1,
            settled: (() => {
                const b = window.__pmStarted?.bridge;
                if (!b) return false;
                const r = { source: String(o.chat_completion_source ?? ''), model: String(c.getChatCompletionModel?.() ?? ''), profileId: c.extensionSettings.connectionManager.selectedProfile ?? null };
                const same = !b.baseRaw || (b.baseRaw.source === r.source && b.baseRaw.model === r.model && (b.baseRaw.profileId ?? null) === r.profileId);
                return same && !b.applying && !b._reconcileQueued && !b._modelQueued && !b._panelQueued;
            })(),
            raw: { source: String(o.chat_completion_source ?? ''), model: String(c.getChatCompletionModel?.() ?? ''), profileId: c.extensionSettings.connectionManager.selectedProfile ?? null },
        };
    })()`);
}
/** ST's own prompt-manager row state for one identifier (null when not rendered). */
const domOn = (/** @type {string} */ id) => probe.eval(`(() => {
    const r = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${id}"]');
    return r ? !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on') : null; })()`);
const clickStToggle = (/** @type {string} */ id) => probe.eval(`(() => { if (document.querySelector('.pm-apply-blocker')) return false; const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${id}"] .prompt-manager-toggle-action'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`);
/** ST's own sampler slider (dev/probe.mjs set-slider). */
const setSlider = (/** @type {string} */ id, /** @type {number} */ v, pr = probe) => pr.eval(`(() => {
    const el = document.getElementById(${J(id)}); if (!el) return false;
    el.value = ${J(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
/** ST's OWN connection-profile dropdown (not /profile, not v2). */
const pickStProfile = (/** @type {string} */ name, pr = probe) => pr.eval(`(() => {
    const c = SillyTavern.getContext();
    const p = c.extensionSettings.connectionManager.profiles.find((x) => x.name === ${J(name)});
    const sel = document.getElementById('connection_profiles');
    if (!p || !sel) return false;
    sel.value = p.id; sel.dispatchEvent(new Event('change')); return true; })()`);
const liveProfiles = () => probe.eval('JSON.parse(JSON.stringify(SillyTavern.getContext().extensionSettings.connectionManager.profiles))');

/** GET /slot as the given tab sees it (its own connection; per-tab compile). */
const getSlot = async (/** @type {any} */ raw = null) => (await api('GET', raw
    ? `/slot?${new URLSearchParams({ source: raw.source ?? '', model: raw.model ?? '', profileId: raw.profileId ?? '' })}`
    : '/slot')).json;
const getModels = async () => (await api('GET', '/models')).json;
const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;
/** One named tuning of a Model (default: "default"), or undefined. */
const tun = async (/** @type {string} */ m, name = 'default') => (await getModels()).models[m]?.tunings?.[name];
/** The tuning the preset's ACTIVE loadout binds for a Model (null = inherit the Model's default). */
const binding = async (/** @type {string} */ id, /** @type {string} */ m) => { const d = await getDoc(id); return d.loadouts[d.activeLoadoutId].overrides?.[m]?.tuning ?? null; };

async function dismissPopups(pr = probe) {
    const closed = await pr.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

/** ST shows the slot and its order equals the compiled slot (no apply in flight). */
async function converged(pr = probe) {
    const s = await st(pr);
    const slot = await getSlot(s.raw);
    // the tab has also processed the latest desired-slot change (a same-hash
    // reload looks converged before the tab saw it; an edit made then is
    // dropped by the stale-base 409 by design)
    // settled: the tab's baseline was built for its CURRENT connection and no
    // bridge op is queued (a profile switch whose report/reconcile has not run
    // yet looks converged when the compile hash is unchanged)
    return !s.blocker && s.settled && s.preset === SLOT_NAME && s.appliedSlotChangedRev >= (slot.slotChangedRev ?? 0)
        && J(s.order) === J(slot.compiled?.prompt_order?.[0]?.order)
        && s.temperature === slot.compiled?.temperature ? { s, slot } : null;
}

async function showTab(/** @type {string} */ tab) {
    await click(`#pm-window .pm-tab[data-tab="${tab}"]`);
    await until(() => exists(`#pm-window .pm-pane[data-pane="${tab}"]:not([hidden])`), 5000, `${tab} tab shown`);
}

/** Load a library preset into the slot through the Library tab's Load button. */
async function loadViaLibrary(/** @type {string} */ presetId) {
    await showTab('library');
    const row = `#pm-window .pm-library-row[data-preset-id="${presetId}"]`;
    await until(() => exists(row), 10000, 'library row');
    await click(`${row} .pm-load`);
    const res = await until(async () => {
        const c = await converged();
        return c && c.slot.desired.presetId === presetId ? c : null;
    }, 20000, `preset ${presetId} converged in the slot`);
    await dismissPopups();
    return res;
}

/** Open a library preset in the Presets tab and wait for its Model panel. */
async function openInPresets(/** @type {string} */ presetId) {
    await showTab('library');
    const row = `#pm-window .pm-library-row[data-preset-id="${presetId}"]`;
    await until(() => exists(row), 10000, 'library row');
    await click(`${row} .pm-open`);
    await until(() => exists(`#pm-window .pm-preset-view[data-preset-id="${presetId}"] .pm-model-panel .pm-mp-model`), 10000, 'model panel');
}

const panelSel = (/** @type {string} */ presetId) => `#pm-window .pm-preset-view[data-preset-id="${presetId}"] .pm-model-panel`;

/** Choose the Model the tuning panel edits (and wait until it is shown). */
async function panelModel(/** @type {string} */ presetId, /** @type {string} */ name) {
    const p = panelSel(presetId);
    await until(() => probe.eval(`[...(document.querySelector(${J(`${p} .pm-mp-model`)})?.options ?? [])].some((o) => o.value === ${J(name)})`), 8000, `panel lists ${name}`);
    await setValue(`${p} .pm-mp-model`, name, 'change');
    await until(() => probe.eval(`document.querySelector(${J(`${p} .pm-mp-model`)})?.value === ${J(name)}`), 5000, `panel on ${name}`);
}

/** Pick a Model in the v2 toolbar picker. */
async function toolbarPick(/** @type {string} */ name) {
    await until(() => probe.eval(`[...(document.querySelector('#pm-window .pm-model-picker')?.options ?? [])].some((o) => o.value === ${J(name)})`), 8000, `toolbar lists ${name}`);
    return setValue('#pm-window .pm-model-picker', name, 'change');
}

/**
 * Hold the next page fetch whose URL contains `urlPart` (and, if given, whose
 * body contains `bodyPart`) until window.__chkRelease() is called;
 * window.__chkHeld turns true while it is held. Restored by unhold().
 */
const holdFetch = (/** @type {string} */ urlPart, /** @type {string} */ bodyPart = '') => probe.eval(`(() => {
    window.__chkHeld = false;
    window.__chkOrigFetch = window.__chkOrigFetch ?? window.fetch;
    const orig = window.__chkOrigFetch;
    let armed = true;
    window.fetch = async (...args) => {
        const url = String(args[0]?.url ?? args[0]);
        const body = String(args[1]?.body ?? '');
        if (armed && url.includes(${J(urlPart)}) && body.includes(${J(bodyPart)})) {
            armed = false;
            window.__chkHeld = true;
            await new Promise((r) => { window.__chkRelease = r; });
            if (window.__chkFailHeld) { window.__chkFailHeld = false; throw new TypeError('check: held request failed'); }
        }
        return orig(...args);
    };
    return true; })()`);
const unhold = () => probe.eval(`(() => { window.__chkRelease?.(); if (window.__chkOrigFetch) window.fetch = window.__chkOrigFetch; window.__chkOrigFetch = undefined; return true; })()`);

/** Close a guard dialog left open by an earlier (failed) check. */
async function closeGuard() {
    if (await exists('#pm-guard-dialog')) {
        await click('#pm-guard-dialog .pm-guard-close');
        console.error('[check] closed a guard dialog left open by an earlier check');
    }
}

/** Precondition helper: ST on the given Model's connection (via the toolbar when it is not). */
async function ensureModel(/** @type {string} */ name, /** @type {string} */ rawModel) {
    const c = await converged();
    if (c && c.s.model === rawModel && c.slot.desired.modelId === name) return c;
    await toolbarPick(name);
    return until(async () => {
        const x = await converged();
        return x && x.s.model === rawModel && x.slot.desired.modelId === name ? x : null;
    }, 15000, `ST on ${name}`);
}

async function shot(/** @type {string} */ file, /** @type {string} */ scrollSel) {
    try {
        fs.mkdirSync(SHOTS, { recursive: true });
        if (scrollSel) await probe.eval(`document.querySelector(${J(scrollSel)})?.scrollIntoView({ block: 'start' })`);
        await sleep(300);
        const r = await probe.eval(`(() => { const b = document.querySelector('#pm-window').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
        const out = path.join(SHOTS, file);
        fs.writeFileSync(out, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data, 'base64'));
        console.log(`[check] screenshot: ${out}`);
    } catch (err) {
        console.log(`[check] screenshot ${file} failed: ${/** @type {Error} */ (err).message}`);
    }
}

/** Run one check body; a throw is a FAIL with the message as evidence. */
const SKIP = (process.env.CHK_SKIP ?? '').split(',').filter(Boolean);
async function check(/** @type {string} */ name, /** @type {() => Promise<string>} */ body) {
    if (SKIP.includes(name.split(' ')[0])) { console.log(`SKIP ${name}`); return; }
    try {
        report(name, true, await body());
    } catch (err) {
        let diag = '';
        try {
            diag = J(await probe.eval(`(() => { const b = window.__pmStarted?.bridge; const c = SillyTavern.getContext(); return b ? { baseRaw: b.baseRaw, raw: { source: c.chatCompletionSettings.chat_completion_source, model: c.getChatCompletionModel(), profileId: c.extensionSettings.connectionManager.selectedProfile ?? null }, detached: b.detached, appliedRev: b.appliedRev, preset: c.chatCompletionSettings.preset_settings_openai } : null; })()`));
        } catch { /* page gone */ }
        report(name, false, `${/** @type {Error} */ (err).message}${diag ? ` [tab: ${diag}]` : ''}`);
    }
}
const must = (/** @type {any} */ cond, /** @type {string} */ msg) => { if (!cond) throw new Error(msg); };
const readSettingsFile = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
const byId = (/** @type {any[]} */ list) => new Map(list.map((p) => [p.id, p]));

// ------------------------------------------------------------------ main

async function main() {
    let up = false;
    for (let i = 0; i < 2 && !up; i++) {
        try { up = (await api('GET', '/health')).status === 200; } catch { /* down */ }
        if (!up && i === 0) {
            console.error('[check] st-pm-dev not answering; running dev/up.sh');
            execFileSync(path.join(REPO, 'dev', 'up.sh'), { stdio: 'inherit' });
        }
    }
    if (!up) fatal('environment', 'st-pm-dev did not come up');
    console.error('[check] resetting dev data (dev/reset.sh)…');
    execFileSync(path.join(REPO, 'dev', 'reset.sh'), { stdio: 'inherit' });
    await primeSession();
    execFileSync(path.join(REPO, 'dev', 'import-fixtures.sh'), ['^(Freaky Frankenstein 5\\.4 Internal States \\(2\\)|Sola V2 Flame)$'], { stdio: 'pipe' });
    const library = (await api('GET', '/library')).json ?? [];
    ids.ff = library.find((/** @type {any} */ e) => e.name === FF)?.id ?? '';
    ids.sola = library.find((/** @type {any} */ e) => e.name === SOLA)?.id ?? '';
    if (!ids.ff || !ids.sola) fatal('setup', `fixtures missing: ${J(library.map((/** @type {any} */ e) => e.name))}`);
    const ffDoc0 = await getDoc(ids.ff);
    ids.kimiBlock = Object.values(ffDoc0.blocks).find((/** @type {any} */ b) => /^kimi k3$/i.test(b.name ?? ''))?.identifier ?? '';
    if (!ids.kimiBlock) fatal('setup', 'FF has no "Kimi K3" block');
    const models0 = await getModels();
    if (Object.keys(models0.models ?? {}).length !== 0) fatal('setup', `models.json not empty after reset: ${J(models0)}`);

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await dismissPopups();
    try {
        await until(() => exists('#pm-menu-item'), 20000, 'wand menu entry');
        await click('#pm-menu-item');
        await until(() => exists('#pm-window .pm-toolbar .pm-model-picker'), 10000, 'window with the Model picker');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    for (const p of await liveProfiles()) prof[p.name] = p.id;
    for (const n of ['Mock', 'Mock links Default', 'Kimi via hapuppy', 'Kimi via nanogpt']) {
        if (!prof[n]) fatal('setup', `fixture profile "${n}" missing from the tab's connection manager`);
    }
    try {
        await loadViaLibrary(ids.ff);
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, FF + Sola imported, window open, FF in the slot', true,
        `ff=${ids.ff} sola=${ids.sola} kimiBlock=${ids.kimiBlock} profiles=${Object.keys(prof).length}`);

    // ------------------------------------------------------------------ 1
    await check('1 seed from profiles + merge in the UI -> one Kimi K3 with two matches', async () => {
        await showTab('settings');
        await until(() => exists('#pm-window .pm-settings .pm-models-seed'), 8000, 'Models editor');
        const live = await liveProfiles();
        const aliases = /** @type {Record<string, string>} */ ({ oai: 'openai', google: 'makersuite' });
        const keys = [...new Set(live.filter((/** @type {any} */ p) => p.mode === 'cc' && typeof p.model === 'string' && p.model)
            .map((/** @type {any} */ p) => `${aliases[p.api] ?? p.api}\u0000${p.model}`))];
        await click('#pm-window .pm-models-seed');
        const reg = await until(async () => {
            const r = await getModels();
            return Object.keys(r.models).length >= keys.length ? r : null;
        }, 10000, 'seeded registry');
        const all = Object.values(reg.models);
        for (const k of keys) {
            const [source, model] = k.split('\u0000');
            const n = all.filter((/** @type {any} */ m) => m.matches.some((/** @type {any} */ x) => x.source === source && x.model === model)).length;
            must(n === 1, `${source}/${model} matched by ${n} Models`);
        }
        must(all.length === keys.length, `${all.length} Models for ${keys.length} distinct ids`);
        const hapM = all.find((/** @type {any} */ m) => m.matches.some((/** @type {any} */ x) => x.model === HAP));
        const nanoM = all.find((/** @type {any} */ m) => m.matches.some((/** @type {any} */ x) => x.model === NANO));
        must(hapM && nanoM && hapM.name !== nanoM.name, 'seed auto-merged the Kimi ids');

        // owner merge through the suggestion UI: keep only the two fixture ids
        const tagged = await until(() => probe.eval(`(() => {
            const g = [...document.querySelectorAll('#pm-window .pm-merge-group')].find((el) => {
                const picks = [...el.querySelectorAll('.pm-merge-pick')].map((i) => i.value);
                return picks.includes(${J(hapM.name)}) && picks.includes(${J(nanoM.name)});
            });
            if (!g) return null;
            g.dataset.chk = 'kimi';
            return [...g.querySelectorAll('.pm-merge-pick')].map((i) => i.value);
        })()`), 8000, 'merge suggestion with both Kimi ids');
        for (const name of tagged) {
            await setChecked(`#pm-window .pm-merge-group[data-chk="kimi"] .pm-merge-pick[value="${name}"]`, name === hapM.name || name === nanoM.name);
        }
        await setValue('#pm-window .pm-merge-group[data-chk="kimi"] .pm-merge-name', KIMI);
        await click('#pm-window .pm-merge-group[data-chk="kimi"] .pm-merge-apply');
        const merged = await until(async () => {
            const r = await getModels();
            return r.models[KIMI] ? r : null;
        }, 8000, 'Kimi K3 in the registry');
        const k = merged.models[KIMI];
        const matchSet = k.matches.map((/** @type {any} */ m) => `${m.source}/${m.model}`).sort();
        must(J(matchSet) === J([`custom/${HAP}`, `custom/${NANO}`].sort()), `Kimi K3 matches ${J(matchSet)}`);
        must(!merged.models[hapM.name] && !merged.models[nanoM.name], 'the merged Models still exist');
        must(Object.keys(merged.models).length === keys.length - 1, 'other Models changed');
        await until(() => exists(`#pm-window .pm-model-row[data-model="${KIMI}"]`), 5000, 'Kimi K3 row in the editor');

        // switch-via profile = the fixture profile (the editor's preferred select)
        await setValue(`#pm-window .pm-model-row[data-model="${KIMI}"] .pm-model-preferred`, prof['Kimi via hapuppy'], 'change');
        const reg2 = await until(async () => {
            const r = await getModels();
            return r.models[KIMI]?.preferredProfile === prof['Kimi via hapuppy'] ? r : null;
        }, 8000, 'Kimi K3 switches via "Kimi via hapuppy"');
        must(reg2.models[KIMI].profiles.includes(prof['Kimi via nanogpt']), 'Kimi K3 lost the nanogpt profile');
        mockName = Object.values(reg2.models).find((/** @type {any} */ m) => m.matches.some((/** @type {any} */ x) => x.source === 'custom' && x.model === 'mock'))?.name ?? '';
        must(mockName, 'no Model for custom/mock');
        must(reg2.models[mockName].preferredProfile === prof.Mock, `mock Model switches via ${reg2.models[mockName].preferredProfile}, not the connection-only "Mock"`);
        await shot('phase4-settings.png', '#pm-window .pm-model-row[data-model="Kimi K3"]');
        return `${keys.length} distinct ids -> ${keys.length} Models; merged -> ${KIMI} ${J(matchSet)}; mock Model "${mockName}"`;
    });

    // ------------------------------------------------------------------ 2
    await check('2 acceptance 7: toolbar Model picker switches ST connection + tuning; preset/loadout unchanged', async () => {
        must(KIMI in (await getModels()).models && mockName, 'precondition: check 1 registry');
        await openInPresets(ids.ff);
        const p = panelSel(ids.ff);
        // Kimi default tuning 0.3 (FF's active loadout binds no Kimi tuning)
        await panelModel(ids.ff, KIMI);
        must((await probe.eval(`document.querySelector(${J(`${p} .pm-tuning-name`)})?.value`)) === 'default', 'the panel does not start on the default tuning');
        must((await binding(ids.ff, KIMI)) === null, 'FF already binds a Kimi tuning');
        await setValue(`${p} .pm-tuning-input[data-key="temperature"]`, '0.3', 'change');
        await until(async () => (await tun(KIMI))?.temperature === 0.3, 8000, 'Kimi default tuning 0.3');
        // FF hot tuning for Kimi 0.9, bound by FF's active loadout
        await setValue(`${p} .pm-tuning-new-name`, 'hot');
        await click(`${p} .pm-tuning-new`);
        await until(async () => (await tun(KIMI, 'hot')) !== undefined, 8000, 'Kimi hot tuning created');
        await until(() => probe.eval(`document.querySelector(${J(`${p} .pm-tuning-name`)})?.value === 'hot'`), 5000, 'panel edits the hot tuning');
        await setValue(`${p} .pm-tuning-input[data-key="temperature"]`, '0.9', 'change');
        await until(async () => (await tun(KIMI, 'hot'))?.temperature === 0.9, 8000, 'Kimi hot tuning 0.9');
        await setValue(`${p} .pm-ov-tuning`, 'hot', 'change');
        await until(async () => (await binding(ids.ff, KIMI)) === 'hot', 8000, 'FF binds the Kimi hot tuning');
        must((await tun(KIMI)).temperature === 0.3, 'the hot tuning write touched the default tuning');
        await shot('phase4-tuning.png', `${p}`);
        // mock default tuning 1.1
        await panelModel(ids.ff, mockName);
        must((await binding(ids.ff, mockName)) === null, 'FF binds a mock tuning');
        must((await probe.eval(`document.querySelector(${J(`${p} .pm-tuning-name`)})?.value`)) === 'default', 'the panel does not start on the mock default tuning');
        await setValue(`${p} .pm-tuning-input[data-key="temperature"]`, '1.1', 'change');
        await until(async () => (await tun(mockName))?.temperature === 1.1, 8000, 'mock default tuning 1.1');

        // precondition: ST is on the mock connection and shows 1.1
        const before = await until(async () => {
            const c = await converged();
            return c && c.s.temperature === 1.1 && c.slot.desired.modelId === mockName ? c : null;
        }, 10000, 'slot on mock at 1.1');
        const ffBefore = await getDoc(ids.ff);
        const desired0 = before.slot.desired;

        await toolbarPick(KIMI);
        const onKimi = await until(async () => {
            const c = await converged();
            return c && c.s.temperature === 0.9 && c.s.profile === 'Kimi via hapuppy' && c.s.model === HAP && c.s.source === 'custom' ? c : null;
        }, 15000, 'ST on Kimi via hapuppy at 0.9');
        must(onKimi.slot.desired.presetId === desired0.presetId && onKimi.slot.desired.loadoutId === desired0.loadoutId, 'desired preset/loadout changed');
        must(onKimi.slot.desired.modelId === KIMI, `slot Model ${onKimi.slot.desired.modelId}`);
        must(J(onKimi.s.order) === J(before.s.order), 'prompt order/toggles changed on the model switch');
        const ffAfter = await getDoc(ids.ff);
        must(ffAfter.activeLoadoutId === ffBefore.activeLoadoutId && J(ffAfter.loadouts) === J(ffBefore.loadouts), 'FF loadouts changed on the model switch');

        await toolbarPick(mockName);
        const onMock = await until(async () => {
            const c = await converged();
            return c && c.s.temperature === 1.1 && c.s.profile === 'Mock' && c.s.model === 'mock' ? c : null;
        }, 15000, 'ST back on Mock at 1.1');
        await toolbarPick(KIMI);
        await until(async () => {
            const c = await converged();
            return c && c.s.temperature === 0.9 && c.s.model === HAP ? c : null;
        }, 15000, 'Kimi again at 0.9');

        const sola = await loadViaLibrary(ids.sola);
        must((await binding(ids.sola, KIMI)) === null, 'Sola binds a Kimi tuning');
        const onSola = await until(async () => {
            const c = await converged();
            return c && c.slot.desired.presetId === ids.sola && c.s.temperature === 0.3 ? c : null;
        }, 10000, 'Sola at the Kimi default tuning 0.3');
        void sola;
        return `mock 1.1 -> Kimi: profile="${onKimi.s.profile}" source=${onKimi.s.source} model=${onKimi.s.model} temp=${onKimi.s.temperature}; `
            + `-> ${onMock.s.profile} ${onMock.s.temperature}; -> Kimi 0.9; Sola (no Kimi tuning binding) ${onSola.s.temperature}; desired preset/loadout + FF loadouts unchanged`;
    });

    // ------------------------------------------------------------------ 2b
    await check('2b model switch: an unsent ST edit lands on the old Model; ST\'s own transition mutation is never written back', async () => {
        const c0 = await loadViaLibrary(ids.ff);
        must(c0.slot.desired.modelId === KIMI && c0.s.temperature === 0.9, `precondition: FF on Kimi at 0.9 (got ${c0.slot.desired.modelId} ${c0.s.temperature})`);
        const mockT = (await tun(mockName)).temperature;
        // Emulate ST mutating a sampler as part of the switch: openai.js clamps
        // temp_openai for some models while it applies them (5719-5721,
        // before CHATCOMPLETION_MODEL_CHANGED). The custom source used here
        // emits no model-changed event, so a one-shot FIRST listener on
        // CONNECTION_PROFILE_LOADED sets 1: it runs after the profile applied
        // and before any v2 listener, i.e. before v2 can know the Model moved.
        must(await probe.eval(`(() => {
            const c = SillyTavern.getContext();
            window.__chkClamp = 0;
            const fn = () => {
                c.eventSource.removeListener(c.eventTypes.CONNECTION_PROFILE_LOADED, fn);
                c.chatCompletionSettings.temp_openai = 1;
                const el = document.getElementById('temp_openai'); if (el) el.value = 1;
                window.__chkClamp += 1;
            };
            c.eventSource.makeFirst(c.eventTypes.CONNECTION_PROFILE_LOADED, fn);
            return true; })()`), 'could not install the transition emulation');
        // a genuine edit in ST's panel, NOT yet written back, then an immediate switch
        must(await setSlider('temp_openai', 0.95), 'no #temp_openai');
        await toolbarPick(mockName);
        const onMock = await until(async () => {
            const c = await converged();
            return c && c.s.model === 'mock' && c.s.temperature === mockT ? c : null;
        }, 15000, `ST on mock at ${mockT}`);
        must(await probe.eval('window.__chkClamp') === 1, 'precondition: the transition mutation ran during the switch');
        await sleep(1500); // any debounced write-back has landed
        const reg = await getModels();
        must(reg.models[KIMI].tunings.hot?.temperature === 0.95, `Kimi hot tuning ${reg.models[KIMI].tunings.hot?.temperature} (the genuine 0.95 must land on the OLD Model)`);
        must(reg.models[mockName].tunings.default.temperature === mockT, `mock default tuning ${reg.models[mockName].tunings.default.temperature} (the transition value leaked)`);
        must((await binding(ids.ff, mockName)) === null && reg.models[mockName].tunings.hot === undefined, 'FF gained a mock hot tuning');
        await toolbarPick(KIMI);
        const back = await until(async () => {
            const c = await converged();
            return c && c.s.model === HAP && c.s.temperature === 0.95 ? c : null;
        }, 15000, 'Kimi at 0.95 again');
        return `genuine 0.95 -> Kimi hot tuning; transition value 1 ignored; mock shows ${onMock.s.temperature}; back on Kimi ${back.s.temperature}`;
    });

    // ------------------------------------------------------------------ 2c
    await check('2c an ST edit made while the connection switch is still being reported lands on the NEW Model', async () => {
        await loadViaLibrary(ids.ff);
        await ensureModel(KIMI, HAP);
        const mockT = (await tun(mockName)).temperature;
        const kimiOv = (await tun(KIMI, 'hot')).temperature;
        must(mockT !== 1.33 && kimiOv !== 1.33, 'precondition: 1.33 is a fresh value');
        try {
            await holdFetch('/api/plugins/st-preset-manager/slot/model');
            must(await pickStProfile('Mock'), 'dropdown pick failed');
            await until(() => probe.eval('window.__chkHeld === true'), 10000, 'POST /slot/model held (profile applied, report in flight)');
            const mid = await st();
            must(mid.model === 'mock', `precondition: ST already on the new connection (${mid.model})`);
            must(await setSlider('temp_openai', 1.33), 'no #temp_openai');
            await sleep(1500); // ST's debounced save fires while the report is held
        } finally {
            await unhold();
        }
        await until(async () => (await tun(mockName))?.temperature === 1.33, 8000, 'the edit reached the mock default tuning');
        const c = await until(async () => {
            const x = await converged();
            return x && x.s.model === 'mock' && x.s.temperature === 1.33 ? x : null;
        }, 15000, 'ST on mock at 1.33');
        must((await tun(KIMI, 'hot')).temperature === kimiOv, `Kimi hot tuning changed to ${(await tun(KIMI, 'hot')).temperature}`);
        must((await binding(ids.ff, mockName)) === null && (await tun(mockName, 'hot')) === undefined, 'FF gained a mock hot tuning');
        // restore the mock default tuning for the later checks
        must((await api('PATCH', `/models/${encodeURIComponent(mockName)}/tunings/default`, { set: { temperature: mockT } })).status === 200, 'restore mock tuning');
        return `edit 1.33 during the held report -> mock default tuning 1.33, ST ${c.s.temperature}; Kimi hot tuning kept ${kimiOv}; mock restored to ${mockT}`;
    });

    // ------------------------------------------------------------------ 2d
    /**
     * B = Mock's report is held so an ST edit is a transition edit; B's edit
     * POST is held; profile C loads (optionally with an ST-side clamp to 1,
     * so C's recorded transition values differ from B's edit); release.
     */
    const transitionRace = async (/** @type {string} */ cProfile, /** @type {string} */ cModel, /** @type {boolean} */ clamp, /** @type {number} */ V) => {
      try {
        await loadViaLibrary(ids.ff);
        await ensureModel(KIMI, HAP);
        const mockT = (await tun(mockName)).temperature;
        const kimiOv = (await tun(KIMI, 'hot')).temperature;
        must(kimiOv !== V, `precondition: ${V} is a fresh value`);
        if (mockT === V) must((await api('PATCH', `/models/${encodeURIComponent(mockName)}/tunings/default`, { set: { temperature: 1.1 } })).status === 200, 'reset mock tuning');
        await probe.eval(`(() => {
            window.__chkErrors = [];
            window.__chkConsoleError = window.__chkConsoleError ?? console.error;
            console.error = (...a) => { window.__chkErrors.push(a.map((x) => String(x?.stack ?? x)).join(' ')); window.__chkConsoleError(...a); };
            window.addEventListener('unhandledrejection', (e) => window.__chkErrors.push(String(e.reason?.stack ?? e.reason)));
            return true; })()`);
        try {
            // B = Mock: its report is held, so the edit below is a transition edit
            await holdFetch('/api/plugins/st-preset-manager/slot/model');
            must(await pickStProfile('Mock'), 'dropdown pick failed');
            await until(() => probe.eval('window.__chkHeld === true'), 10000, 'report for Mock held');
            must(await setSlider('temp_openai', V), 'no #temp_openai');
            await sleep(1500); // ST's debounced save queues the panel op
            // hold B's genuine-edit POST, then let B's report go
            await probe.eval('(() => { const r = window.__chkRelease; window.__chkRelease = undefined; r?.(); return true; })()');
            await holdFetch('/api/plugins/st-preset-manager/slot/panel', String(V));
            await until(() => probe.eval('window.__chkHeld === true'), 10000, 'B\'s edit POST held');
            // C loads while B's edit is in flight
            if (clamp) {
                await probe.eval(`(() => {
                    const c = SillyTavern.getContext();
                    const fn = () => {
                        c.eventSource.removeListener(c.eventTypes.CONNECTION_PROFILE_LOADED, fn);
                        c.chatCompletionSettings.temp_openai = 1;
                        const el = document.getElementById('temp_openai'); if (el) el.value = 1;
                    };
                    c.eventSource.makeFirst(c.eventTypes.CONNECTION_PROFILE_LOADED, fn);
                    return true; })()`);
            }
            must(await pickStProfile(cProfile), 'dropdown pick failed');
            await until(async () => (await st()).model === cModel, 8000, `ST on ${cProfile} (C)`);
            await sleep(500);
        } finally {
            await unhold();
        }
        await until(async () => (await tun(mockName))?.temperature === V, 8000, 'B\'s edit on the mock default tuning');
        const c = await until(async () => {
            const x = await converged();
            return x && x.s.model === cModel ? x : null;
        }, 15000, `ST settled on ${cProfile}`);
        await sleep(1500);
        const kimiNow = (await tun(KIMI, 'hot')).temperature;
        const c2 = await st();
        must(c2.temperature === kimiOv, `ST on ${cProfile} shows ${c2.temperature}, Kimi hot tuning is now ${kimiNow} (was ${kimiOv})`);
        must(kimiNow === kimiOv, `Kimi hot tuning became ${kimiNow} (B's edit went to C's Model)`);
        must((await tun(KIMI)).temperature !== V, `Kimi default tuning got ${V}`);
        const errs = (await probe.eval('window.__chkErrors')).filter((/** @type {string} */ e) => /TypeError|Cannot (set|read) propert/.test(e));
        await probe.eval('(() => { if (window.__chkConsoleError) console.error = window.__chkConsoleError; return true; })()');
        must(errs.length === 0, `errors: ${errs[0]?.slice(0, 200)}`);
        must((await api('PATCH', `/models/${encodeURIComponent(mockName)}/tunings/default`, { set: { temperature: mockT } })).status === 200, 'restore mock tuning');
        return `B (mock) edit ${V} -> mock default tuning; C (${cProfile}${clamp ? ', ST clamps to 1 on load' : ''}) at the Kimi hot tuning ${c.s.temperature}, hot tuning unchanged; no errors`;
      } finally {
        await api('PATCH', `/models/${encodeURIComponent(mockName)}/tunings/default`, { set: { temperature: 1.1 } });
      }
    };
    await check('2d a transition edit in flight when another profile loads (ST clamps on that load) stays on its own Model', () => transitionRace('Kimi via nanogpt', NANO, true, 1.44));
    await check('2e a transition edit in flight when the tab switches back to its original connection lands without errors', () => transitionRace('Kimi via hapuppy', HAP, false, 1.47));

    // ------------------------------------------------------------------ 2f
    await check('2f return to A while B\'s write-back is held: ST\'s sampler panel is blocked, then an A edit to B\'s value lands on A and stays', async () => {
        const V = 1.52;
        try {
            await loadViaLibrary(ids.ff);
            await ensureModel(KIMI, HAP);
            const kimiOv = (await tun(KIMI, 'hot')).temperature;
            must(kimiOv !== V, 'precondition: fresh value');
            /** is ST's temperature slider covered by v2's blocker (a real click would hit the blocker)? */
            const sliderBlocked = () => probe.eval(`(() => {
                const el = document.getElementById('temp_openai');
                const r = el.getBoundingClientRect();
                if (!r.width) return { visible: false, blocked: !!document.querySelector('#ai_response_configuration .pm-apply-blocker') };
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return { visible: true, blocked: !!hit?.closest?.('.pm-apply-blocker') || getComputedStyle(document.getElementById('ai_response_configuration')).pointerEvents === 'none' };
            })()`);
            let during;
            try {
                await holdFetch('/api/plugins/st-preset-manager/slot/model');
                must(await pickStProfile('Mock'), 'dropdown pick failed');
                await until(() => probe.eval('window.__chkHeld === true'), 10000, 'report for Mock held');
                must(await setSlider('temp_openai', V), 'no #temp_openai');
                await sleep(1500);
                await probe.eval('(() => { const r = window.__chkRelease; window.__chkRelease = undefined; r?.(); return true; })()');
                await holdFetch('/api/plugins/st-preset-manager/slot/panel', String(V));
                await until(() => probe.eval('window.__chkHeld === true'), 10000, 'B\'s edit POST held');
                // back to A while B's write-back is in flight
                must(await pickStProfile('Kimi via hapuppy'), 'dropdown pick failed');
                await until(async () => (await st()).model === HAP, 8000, 'ST back on A (hapuppy)');
                await sleep(300);
                during = await sliderBlocked();
            } finally {
                await unhold();
            }
            must(during.blocked, `ST's sampler panel accepted input while B's write-back was in flight (${J(during)})`);
            await until(async () => (await tun(mockName))?.temperature === V, 8000, 'B\'s edit on the mock default tuning');
            const c1 = await until(async () => { const x = await converged(); return x && x.s.model === HAP && x.s.temperature === kimiOv ? x : null; }, 15000, `A settled at its override ${kimiOv}`);
            const ffMid = (await tun(KIMI, 'hot')).temperature;
            must(ffMid === kimiOv, `A's hot tuning became ${ffMid} (B's value leaked to A)`);
            // now a genuine A edit to exactly B's value
            must(!(await sliderBlocked()).blocked, 'the blocker stayed up after the new baseline');
            must(await setSlider('temp_openai', V), 'no #temp_openai');
            await until(async () => (await tun(KIMI, 'hot'))?.temperature === V, 8000, `A's edit ${V} reached the Kimi hot tuning`);
            await sleep(2500);
            const s2 = await st();
            const ff2 = (await tun(KIMI, 'hot')).temperature;
            must(s2.temperature === V && ff2 === V, `A's edit reverted: ST ${s2.temperature}, hot tuning ${ff2}`);
            return `during the hold ST's slider was blocked (${J(during)}); after release A at ${c1.s.temperature}, B's ${V} on mock; A edit ${V} -> Kimi hot tuning ${ff2}, ST ${s2.temperature} (kept)`;
        } finally {
            await api('PATCH', `/models/${encodeURIComponent(mockName)}/tunings/default`, { set: { temperature: 1.1 } });
        }
    });

    // ------------------------------------------------------------------ 2g
    await check('2g B\'s report failed; v2 picker switch back to A queued while B\'s write-back is held: B\'s value only on B, ST ends on A with A\'s tuning', async () => {
        const V = 1.57;
        try {
            await loadViaLibrary(ids.ff);
            await ensureModel(KIMI, HAP);
            const kimiOv = (await tun(KIMI, 'hot')).temperature;
            const kimiG = (await tun(KIMI)).temperature;
            must(kimiOv !== V, 'precondition: fresh value');
            try {
                await holdFetch('/api/plugins/st-preset-manager/slot/model');
                must(await pickStProfile('Mock'), 'dropdown pick failed');
                await until(() => probe.eval('window.__chkHeld === true'), 10000, 'report for Mock held');
                must(await setSlider('temp_openai', V), 'no #temp_openai');
                await sleep(1500);
                // arm the write-back hold BEFORE the report is released, then
                // let the report FAIL (network error): no reconcile is queued for B
                await probe.eval('(() => { window.__chkReleaseReport = window.__chkRelease; window.__chkRelease = undefined; return true; })()');
                await holdFetch('/api/plugins/st-preset-manager/slot/panel', String(V));
                await probe.eval('(() => { window.__chkFailHeld = true; window.__chkReleaseReport?.(); window.__chkReleaseReport = undefined; return true; })()');
                await until(() => probe.eval('window.__chkHeld === true'), 10000, 'B\'s edit POST held');
                // the v2 toolbar picker queues a switch back to A behind the held op
                await toolbarPick(KIMI);
                await sleep(500);
                const s0 = await st();
                must(s0.model === 'mock', `precondition: the picker switch is queued, not run (ST on ${s0.model})`);
            } finally {
                await unhold();
            }
            await until(async () => (await tun(mockName))?.temperature === V, 8000, 'B\'s edit on the mock default tuning');
            const c = await until(async () => { const x = await converged(); return x && x.s.model === HAP ? x : null; }, 15000, 'ST settled on A (hapuppy)');
            await sleep(2000);
            const reg = await getModels();
            const s2 = await st();
            must(reg.models[KIMI].tunings.hot.temperature === kimiOv, `A's hot tuning became ${reg.models[KIMI].tunings.hot.temperature} (was ${kimiOv})`);
            must(reg.models[KIMI].tunings.default.temperature === kimiG, `A's default tuning became ${reg.models[KIMI].tunings.default.temperature} (was ${kimiG})`);
            must(s2.temperature === kimiOv, `ST on A shows ${s2.temperature}, expected A's ${kimiOv}`);
            return `B (mock) ${V} -> mock default tuning; queued picker switch -> ST on ${c.s.model} at ${s2.temperature}; A hot tuning ${kimiOv} and default tuning ${kimiG} unchanged`;
        } finally {
            await api('PATCH', `/models/${encodeURIComponent(mockName)}/tunings/default`, { set: { temperature: 1.1 } });
        }
    });

    // ------------------------------------------------------------------ 2h
    await check('2h a profile that selects a preset while the transition baseline install is saving wins; the tab stays detached', async () => {
        const V = 1.61;
        try {
            await closeGuard();
            await loadViaLibrary(ids.ff);
            await ensureModel(KIMI, HAP);
            const linked = (await liveProfiles()).find((/** @type {any} */ x) => x.name === 'Mock links Default');
            must(linked.preset === 'Default' && !(linked.exclude ?? []).includes('preset'), 'precondition: profile links Default');
            try {
                await holdFetch('/api/plugins/st-preset-manager/slot/model');
                must(await pickStProfile('Mock'), 'dropdown pick failed');
                await until(() => probe.eval('window.__chkHeld === true'), 10000, 'report for Mock held');
                must(await setSlider('temp_openai', V), 'no #temp_openai');
                await sleep(1500);
                await probe.eval('(() => { window.__chkReleaseReport = window.__chkRelease; window.__chkRelease = undefined; return true; })()');
                await holdFetch('/api/presets/save', 'working');
                await probe.eval('(() => { window.__chkReleaseReport?.(); window.__chkReleaseReport = undefined; return true; })()');
                await until(() => probe.eval('window.__chkHeld === true'), 10000, 'the baseline install\'s slot save held');
                must(await pickStProfile('Mock links Default'), 'dropdown pick failed');
                await until(() => exists('#pm-guard-dialog'), 10000, 'guard dialog');
                await until(async () => (await st()).preset === 'Default', 8000, 'the profile selected Default');
            } finally {
                await unhold();
            }
            await sleep(3000);
            const s1 = await st();
            const detached = await probe.eval('window.__pmStarted.bridge.detached');
            must(s1.preset === 'Default', `after the held install finished ST is on "${s1.preset}" (the install re-selected the slot)`);
            must(detached === true, `bridge.detached=${detached}`);
            must(!(await exists('.pm-apply-blocker')), 'the input blocker is still up on the foreign preset');
            must(await exists('#pm-guard-dialog'), 'the guard dialog disappeared');
            return `install save held while "Mock links Default" loaded Default: ST stayed on ${s1.preset}, detached=${detached}, guard open, no blocker`;
        } finally {
            await closeGuard();
            await api('PATCH', `/models/${encodeURIComponent(mockName)}/tunings/default`, { set: { temperature: 1.1 } });
            await loadViaLibrary(ids.ff);
        }
    });

    // ------------------------------------------------------------------ 2i
    await check('2i the transition baseline install fails and a picker switch back to A is queued: A\'s tuning is unchanged', async () => {
        const V = 1.63;
        try {
            await loadViaLibrary(ids.ff);
            await ensureModel(KIMI, HAP);
            const kimiOv = (await tun(KIMI, 'hot')).temperature;
            const kimiG = (await tun(KIMI)).temperature;
            must(kimiOv !== V, 'precondition: fresh value');
            try {
                await holdFetch('/api/plugins/st-preset-manager/slot/model');
                must(await pickStProfile('Mock'), 'dropdown pick failed');
                await until(() => probe.eval('window.__chkHeld === true'), 10000, 'report for Mock held');
                must(await setSlider('temp_openai', V), 'no #temp_openai');
                await sleep(1500);
                await probe.eval('(() => { window.__chkReleaseReport = window.__chkRelease; window.__chkRelease = undefined; return true; })()');
                await holdFetch('/api/presets/save', 'working');
                // the report fails: no reconcile is queued for B
                await probe.eval('(() => { window.__chkFailHeld = true; window.__chkReleaseReport?.(); window.__chkReleaseReport = undefined; return true; })()');
                await until(() => probe.eval('window.__chkHeld === true'), 10000, 'the baseline install\'s slot save held');
                await toolbarPick(KIMI);
                await sleep(500);
                // the install's save fails
                await probe.eval('(() => { window.__chkFailHeld = true; return true; })()');
            } finally {
                await unhold();
            }
            await until(async () => (await tun(mockName))?.temperature === V, 8000, 'B\'s edit on the mock default tuning');
            const c = await until(async () => { const x = await converged(); return x && x.s.model === HAP ? x : null; }, 20000, 'ST settled on A (hapuppy)');
            await sleep(2000);
            const reg = await getModels();
            const s2 = await st();
            must(reg.models[KIMI].tunings.hot.temperature === kimiOv, `A's hot tuning became ${reg.models[KIMI].tunings.hot.temperature} (was ${kimiOv})`);
            must(reg.models[KIMI].tunings.default.temperature === kimiG, `A's default tuning became ${reg.models[KIMI].tunings.default.temperature} (was ${kimiG})`);
            must(s2.temperature === kimiOv, `ST on A shows ${s2.temperature}, expected ${kimiOv}`);
            return `B (mock) ${V} -> mock default tuning; install save failed; queued picker switch -> ST on ${c.s.model} at ${s2.temperature}; A hot tuning ${kimiOv}, default tuning ${kimiG} unchanged`;
        } finally {
            await api('PATCH', `/models/${encodeURIComponent(mockName)}/tunings/default`, { set: { temperature: 1.1 } });
        }
    });

    // ------------------------------------------------------------------ 3
    await check('3 acceptance 2 (model half): panel temperature -> FF hot tuning, else the Kimi default tuning', async () => {
        await loadViaLibrary(ids.ff);
        const c0 = await ensureModel(KIMI, HAP);
        const ffT = (await tun(KIMI, 'hot'))?.temperature;
        must(c0.slot.desired.modelId === KIMI && c0.s.temperature === ffT, `precondition: FF on Kimi at its hot tuning ${ffT} (got ${c0.slot.desired.modelId} ${c0.s.temperature})`);
        must(await setSlider('temp_openai', 0.55), 'no #temp_openai');
        await until(async () => (await tun(KIMI, 'hot'))?.temperature === 0.55, 8000, 'Kimi hot tuning 0.55');
        const g1 = (await tun(KIMI)).temperature;
        must(g1 === 0.3, `default tuning changed to ${g1} by a hot-tuning-routed edit`);

        const c1 = await loadViaLibrary(ids.sola);
        must(c1.s.temperature === 0.3, `precondition: Sola at the default tuning 0.3 (got ${c1.s.temperature})`);
        const solaSettingsTemp = (await getDoc(ids.sola)).settings?.temperature;
        must(await setSlider('temp_openai', 0.55), 'no #temp_openai');
        await until(async () => (await tun(KIMI))?.temperature === 0.55, 8000, 'Kimi default tuning 0.55');
        const sola = await getDoc(ids.sola);
        must((await binding(ids.sola, KIMI)) === null, 'Sola gained a Kimi tuning binding');
        must(sola.settings?.temperature === solaSettingsTemp, 'Sola settings.temperature changed');
        return `FF (hot tuning) ${ffT} -> 0.55 in models["Kimi K3"].tunings.hot, default tuning stayed 0.3; Sola (no binding) -> GET /models Kimi default tuning 0.55`;
    });

    // ------------------------------------------------------------------ 3b
    await check('3b tuning panel edit right after an unsent ST slider edit: both reach the hot tuning', async () => {
        await loadViaLibrary(ids.ff);
        const c0 = await ensureModel(KIMI, HAP);
        must(c0.slot.desired.modelId === KIMI, 'precondition: Kimi active');
        await openInPresets(ids.ff);
        const p = panelSel(ids.ff);
        await panelModel(ids.ff, KIMI);
        await setValue(`${p} .pm-tuning-name`, 'hot', 'change');
        await until(() => probe.eval(`document.querySelector(${J(`${p} .pm-tuning-name`)})?.value === 'hot'`), 5000, 'precondition: panel on the Kimi hot tuning');
        const dTopP = (await tun(KIMI)).top_p;
        must(await setSlider('temp_openai', 0.66), 'no #temp_openai');
        must(await setValue(`${p} .pm-tuning-input[data-key="top_p"]`, '0.77', 'change'), 'no top_p input');
        await sleep(2500); // the edit op, the debounced ST save and any reconcile
        const o = await tun(KIMI, 'hot');
        must(o.temperature === 0.66 && o.top_p === 0.77, `hot tuning ${J(o)}`);
        must((await tun(KIMI)).top_p === dTopP, `the default tuning top_p changed to ${(await tun(KIMI)).top_p} (was ${dTopP})`);
        const c1 = await until(async () => {
            const c = await converged();
            return c && c.s.temperature === 0.66 ? c : null;
        }, 8000, 'ST shows 0.66');
        return `hot tuning ${J(o)}; default tuning top_p unchanged ${dTopP}; ST ${c1.s.temperature}`;
    });

    // ------------------------------------------------------------------ 4
    await check('4 acceptance 16: Kimi loadout override turns the "Kimi K3" block on only under Kimi', async () => {
        const K = ids.kimiBlock;
        await loadViaLibrary(ids.ff);
        const c0 = await ensureModel(KIMI, HAP);
        must(c0.slot.desired.modelId === KIMI, 'precondition: Kimi active');
        const d0 = await getDoc(ids.ff);
        const lid = d0.activeLoadoutId;
        must(d0.loadouts[lid].enabled[K] === false, 'precondition: loadout has the Kimi block off');
        must(d0.loadouts[lid].overrides?.[KIMI]?.enabled?.[K] === undefined, 'precondition: no Kimi block override yet');
        await until(async () => (await domOn(K)) === false, 5000, 'dom shows the block off');

        await openInPresets(ids.ff);
        const p = panelSel(ids.ff);
        await panelModel(ids.ff, KIMI);
        await until(() => exists(`${p} .pm-ov-row[data-identifier="${K}"] .pm-ov-state`), 5000, 'override editor row');
        await setValue(`${p} .pm-ov-row[data-identifier="${K}"] .pm-ov-state`, 'on', 'change');
        const d1 = await until(async () => {
            const d = await getDoc(ids.ff);
            return d.loadouts[lid].overrides?.[KIMI]?.enabled?.[K] === true ? d : null;
        }, 8000, 'override lists the block on');
        must(d1.loadouts[lid].enabled[K] === false, 'loadout bit changed by the override editor');
        await until(async () => (await domOn(K)) === true && (await converged()), 8000, 'Kimi: dom on');
        const seen = [];
        await toolbarPick(mockName);
        await until(async () => {
            const c = await converged();
            return c && c.s.model === 'mock' && (await domOn(K)) === false;
        }, 15000, 'Mock: dom off');
        seen.push((await getDoc(ids.ff)).loadouts[lid].enabled[K]);
        await toolbarPick(KIMI);
        await until(async () => {
            const c = await converged();
            return c && c.s.model === HAP && (await domOn(K)) === true;
        }, 15000, 'Kimi again: dom on');
        seen.push((await getDoc(ids.ff)).loadouts[lid].enabled[K]);

        // a toggle in ST's own panel while Kimi is active changes the override
        const rev0 = (await getDoc(ids.ff)).rev;
        await until(() => clickStToggle(K), 5000, 'ST toggle clickable');
        const d2 = await until(async () => {
            const d = await getDoc(ids.ff);
            return d.rev > rev0 && d.loadouts[lid].overrides?.[KIMI]?.enabled?.[K] === false ? d : null;
        }, 8000, 'override flipped to off');
        seen.push(d2.loadouts[lid].enabled[K]);
        must(seen.every((v) => v === false), `loadout bit not false throughout: ${J(seen)}`);
        await until(async () => (await domOn(K)) === false && (await converged()), 8000, 'dom off after the ST toggle');
        // leave the override ON for check 5 (ST toggle again)
        await until(() => clickStToggle(K), 5000, 'ST toggle clickable');
        await until(async () => (await getDoc(ids.ff)).loadouts[lid].overrides?.[KIMI]?.enabled?.[K] === true, 8000, 'override back on');
        await until(async () => (await domOn(K)) === true && (await converged()), 8000, 'dom on again');
        return `override on -> Kimi dom on, Mock dom off, Kimi on; ST toggle -> override ${J(d2.loadouts[lid].overrides[KIMI].enabled)}; loadout bit ${J(seen)}`;
    });

    // ------------------------------------------------------------------ 5
    await check('5 acceptance 17: "Kimi via nanogpt" in ST\'s dropdown == "Kimi via hapuppy"', async () => {
        const K = ids.kimiBlock;
        must(await pickStProfile('Kimi via hapuppy'), 'dropdown pick failed');
        const a = await until(async () => {
            const c = await converged();
            return c && c.s.model === HAP && c.s.profile === 'Kimi via hapuppy' ? c : null;
        }, 15000, 'hapuppy selected');
        const aOn = await domOn(K);
        must(await pickStProfile('Kimi via nanogpt'), 'dropdown pick failed');
        const b = await until(async () => {
            const c = await converged();
            return c && c.s.model === NANO && c.s.profile === 'Kimi via nanogpt' && c.s.selectedProfile === prof['Kimi via nanogpt'] ? c : null;
        }, 15000, 'nanogpt selected');
        await sleep(1500); // let the model report + any reconcile settle, then re-read
        const b2 = await until(() => converged(), 8000, 'settled');
        const bOn = await domOn(K);
        must(a.slot.desired.modelId === KIMI && b2.slot.desired.modelId === KIMI, `Models ${a.slot.desired.modelId} / ${b2.slot.desired.modelId}`);
        const ffT = (await tun(KIMI, 'hot')).temperature;
        must(a.s.temperature === b2.s.temperature && a.s.temperature === ffT, `temperatures ${a.s.temperature} / ${b2.s.temperature}`);
        must(aOn === true && bOn === true, `Kimi block ${aOn} / ${bOn}`);
        must(J(a.s.order) === J(b2.s.order) && a.slot.hash === b2.slot.hash, 'compiled slot differs between the two providers');
        void b;
        return `hapuppy: temp ${a.s.temperature}, kimi block ${aOn}; nanogpt (${b2.s.model}): temp ${b2.s.temperature}, kimi block ${bOn}; same slot hash`;
    });

    // ------------------------------------------------------------------ 5b
    await check('5b two tabs on different Models: each shows its own Model\'s tuning and routes its own edits', async () => {
        try {
            const T = (await tun(KIMI, 'hot')).temperature;
            await until(async () => {
                const c = await converged();
                return c && c.s.model === NANO && c.s.temperature === T ? c : null;
            }, 8000, `precondition: tab A on Kimi (nanogpt) at ${T}`);
            await probeB.start();
            await until(async () => {
                await dismissPopups(probeB);
                return converged(probeB);
            }, 30000, 'tab B on the slot');
            must(await pickStProfile('Mock', probeB), 'tab B dropdown');
            const mockT = (await tun(mockName)).temperature;
            await until(async () => {
                await dismissPopups(probeB);
                const c = await converged(probeB);
                return c && c.s.model === 'mock' && c.s.temperature === mockT ? c : null;
            }, 15000, `tab B on mock at ${mockT}`);
            await sleep(2000);
            const a1 = await st();
            must(a1.model === NANO && a1.temperature === T && a1.preset === SLOT_NAME, `tab A changed to ${a1.model} ${a1.temperature} after tab B's switch`);

            must(await setSlider('temp_openai', 0.58), 'tab A slider');
            await until(async () => (await tun(KIMI, 'hot'))?.temperature === 0.58, 8000, 'tab A edit -> Kimi hot tuning');
            must(await setSlider('temp_openai', 1.25, probeB), 'tab B slider');
            await until(async () => (await tun(mockName))?.temperature === 1.25, 8000, 'tab B edit -> mock default tuning');
            await sleep(2000);
            const hotT = (await tun(KIMI, 'hot')).temperature;
            must(hotT === 0.58, `Kimi hot tuning ${hotT} after tab B's edit`);
            must((await binding(ids.ff, mockName)) === null && (await tun(mockName, 'hot')) === undefined, 'tab B\'s edit created a mock hot tuning on FF');
            const a2 = await until(async () => { const c = await converged(); return c && c.s.temperature === 0.58 ? c : null; }, 8000, 'tab A shows 0.58');
            const b2 = await until(async () => { const c = await converged(probeB); return c && c.s.temperature === 1.25 ? c : null; }, 8000, 'tab B shows 1.25');
            return `A (${a2.s.model}) ${T} -> edit 0.58 -> Kimi hot tuning; B (${b2.s.model}) ${mockT} -> edit 1.25 -> mock default tuning; A stayed ${a2.s.temperature}, B ${b2.s.temperature}`;
        } finally {
            probeB.kill();
        }
    });

    // ------------------------------------------------------------------ 6a
    await check('6a guard Close keeps ST detached after a cross-Model profile load; a library load re-attaches', async () => {
        const c0 = await until(async () => { const c = await converged(); return c && c.s.model === NANO ? c : null; }, 10000, 'precondition: on the slot, Kimi (nanogpt)');
        const linked = (await liveProfiles()).find((/** @type {any} */ x) => x.name === 'Mock links Default');
        must(linked.preset === 'Default' && !(linked.exclude ?? []).includes('preset'), 'precondition: profile links Default');
        must(await pickStProfile('Mock links Default'), 'dropdown pick failed');
        await until(() => exists('#pm-guard-dialog'), 10000, 'guard dialog');
        await until(async () => (await st()).preset === 'Default', 8000, 'ST on Default');
        await dismissPopups();
        await click('#pm-guard-dialog .pm-guard-close');
        await sleep(3000);
        const s1 = await st();
        must(!(await exists('#pm-guard-dialog')), 'dialog still open');
        must(s1.preset === 'Default' && s1.model === 'mock', `after Close ST is on "${s1.preset}" / ${s1.model} (the slot was re-applied over the user's choice)`);
        const re = await loadViaLibrary(ids.ff);
        must(re.s.model === 'mock', `re-attached on ${re.s.model}`);
        return `Kimi slot (${c0.s.temperature}) -> "Mock links Default": ST on ${s1.preset} and stays there after Close; library load -> ${re.s.preset} at ${re.s.temperature}`;
    });

    // ------------------------------------------------------------------ 6c
    await check('6c a profile that loads a preset while a slot apply is in flight wins; the apply does not undo it', async () => {
        await closeGuard();
        must(await pickStProfile('Mock'), 'dropdown pick failed');
        await until(async () => { const c = await converged(); return c && c.s.selectedProfile === prof.Mock ? c : null; }, 15000, 'precondition: settled on Mock');
        const linked = (await liveProfiles()).find((/** @type {any} */ x) => x.name === 'Mock links Default');
        must(linked.preset === 'Default' && !(linked.exclude ?? []).includes('preset'), 'precondition: profile links Default');
        let s1;
        try {
            await holdFetch('/api/presets/save', 'working');
            must(await pickStProfile('Kimi via hapuppy'), 'dropdown pick failed');
            await until(() => probe.eval('window.__chkHeld === true'), 10000, 'the slot apply for Kimi is in flight (save held)');
            must(await pickStProfile('Mock links Default'), 'dropdown pick failed');
            await until(() => exists('#pm-guard-dialog'), 10000, 'guard dialog');
            await until(async () => (await st()).preset === 'Default', 8000, 'the profile selected Default');
        } finally {
            await unhold();
        }
        await sleep(3000);
        s1 = await st();
        must(s1.preset === 'Default', `after the held apply finished ST is on "${s1.preset}" (the apply undid the profile's preset)`);
        must(await exists('#pm-guard-dialog'), 'the guard dialog disappeared');
        await dismissPopups();
        await click('#pm-guard-dialog .pm-guard-close');
        const re = await loadViaLibrary(ids.ff);
        return `apply held while "Mock links Default" loaded Default: ST stayed on ${s1.preset}, guard open; library load re-attached (${re.s.preset})`;
    });

    // ------------------------------------------------------------------ 6
    await check('6 acceptance 8: profile guard names "Mock links Default"; Unlink excludes preset and re-attaches', async () => {
        await closeGuard();
        must(await pickStProfile('Mock'), 'dropdown pick failed');
        const mockT = (await tun(mockName)).temperature;
        await until(async () => {
            const c = await converged();
            return c && c.s.model === 'mock' && c.s.temperature === mockT ? c : null;
        }, 15000, `on Mock at ${mockT}`);
        must(!(await exists('#pm-guard-dialog')), 'a guard dialog is already open');
        const linked0 = (await liveProfiles()).find((/** @type {any} */ x) => x.name === 'Mock links Default');
        must(linked0.preset === 'Default' && !(linked0.exclude ?? []).includes('preset'), `precondition: profile links Default (${J(linked0)})`);

        must(await pickStProfile('Mock links Default'), 'dropdown pick failed');
        await until(() => exists('#pm-guard-dialog'), 10000, 'guard dialog');
        const named = await text('#pm-guard-dialog .pm-guard-profile');
        must(named === 'Mock links Default', `dialog names "${named}"`);
        const off = await until(async () => {
            const s = await st();
            return s.preset !== SLOT_NAME ? s : null;
        }, 8000, 'ST moved off the slot');
        await dismissPopups();

        await click('#pm-guard-dialog .pm-guard-unlink');
        const linked1 = await until(async () => {
            const x = (await liveProfiles()).find((/** @type {any} */ y) => y.name === 'Mock links Default');
            return (x.exclude ?? []).includes('preset') && x.preset === undefined ? x : null;
        }, 5000, 'profile unlinked in the tab');
        const back = await until(() => converged(), 15000, 'slot re-applied');
        must(!(await exists('#pm-guard-dialog')), 'dialog still open');
        const disk = await until(() => {
            const x = readSettingsFile().extension_settings.connectionManager.profiles.find((/** @type {any} */ y) => y.name === 'Mock links Default');
            return (x?.exclude ?? []).includes('preset') ? x : null;
        }, 8000, 'settings.json (tab save) has the exclude');
        return `off slot on "${off.preset}"; dialog named "${named}"; after Unlink exclude=${J(linked1.exclude)} (disk ${J(disk.exclude)}), ST on "${back.s.preset}"`;
    });

    // ------------------------------------------------------------------ 6b
    await check('6b toolbar refuses a preset-linked profile, offers Unlink and switch; ST never leaves the slot', async () => {
        const lid = prof['Mock links Default'];
        // test data: re-link the fixture profile (check 6 unlinked it) and give a Model only that profile
        await probe.eval(`(() => { const p = SillyTavern.getContext().extensionSettings.connectionManager.profiles.find((x) => x.id === ${J(lid)}); p.preset = 'Default'; p.exclude = []; return true; })()`);
        await closeGuard();
        must(await pickStProfile('Mock'), 'dropdown pick failed');
        await until(async () => { const c = await converged(); return c && c.s.selectedProfile === prof.Mock ? c : null; }, 15000, 'on Mock');
        must(!(await exists('#pm-guard-dialog')), 'precondition: no guard dialog');
        const reg = await getModels();
        reg.models['Linked Only'] = { id: 'm_linked_only', name: 'Linked Only', matches: [], profiles: [lid], preferredProfile: lid, tunings: { default: {} }, defaultTuning: 'default' };
        must((await api('PUT', '/models', reg)).status === 200, 'PUT /models');
        await toolbarPick('Linked Only');
        await until(() => exists('#pm-window .pm-model-unlink-switch'), 10000, 'refusal with an Unlink offer');
        const msg = await text('#pm-window .pm-model-status');
        const s1 = await st();
        must(s1.preset === SLOT_NAME && s1.selectedProfile === prof.Mock, `ST moved: preset "${s1.preset}", profile ${s1.selectedProfile}`);
        must(!(await exists('#pm-guard-dialog')), 'the guard fired: the picker ran the linked profile');
        const still = (await liveProfiles()).find((/** @type {any} */ x) => x.id === lid);
        must(still.preset === 'Default', 'the profile was unlinked without consent');
        await click('#pm-window .pm-model-unlink-switch');
        const p2 = await until(async () => {
            const x = (await liveProfiles()).find((/** @type {any} */ y) => y.id === lid);
            return (x.exclude ?? []).includes('preset') && !x.preset ? x : null;
        }, 8000, 'profile unlinked');
        const s2 = await until(async () => { const c = await converged(); return c && c.s.selectedProfile === lid ? c : null; }, 15000, 'switched, on the slot');
        must(!(await exists('#pm-guard-dialog')), 'guard dialog after Unlink and switch');
        return `refused: "${(msg ?? '').replace(/\s+/g, ' ').slice(0, 110)}"; ST stayed on ${s1.preset}; Unlink and switch -> exclude=${J(p2.exclude)}, ST on ${s2.s.preset} via ${s2.s.profile}`;
    });

    // ------------------------------------------------------------------ 7a
    await check('7a tidy refuses to delete the active profile, and profiles changed after the backup', async () => {
        // precondition: a connection-only profile that will NOT be kept is active
        must(await pickStProfile('Kimi via nanogpt'), 'dropdown pick failed');
        await until(async () => { const c = await converged(); return c && c.s.selectedProfile === prof['Kimi via nanogpt'] ? c : null; }, 15000, 'on Kimi via nanogpt');
        await showTab('settings');
        const n0 = (await liveProfiles()).length;
        const keep = [prof.Mock, prof['Kimi via hapuppy']];
        const active = (await st()).selectedProfile;
        must(active && !keep.includes(active), `precondition: the active profile (${active}) is not kept`);
        await until(async () => (await probe.eval('document.querySelectorAll("#pm-window .pm-profile-row").length')) === n0, 8000, 'profile list rendered');
        for (const id of keep) must(await setChecked(`#pm-window .pm-profile-row[data-profile-id="${id}"] .pm-profile-keep`, true), `no keep box for ${id}`);
        await click('#pm-window .pm-profiles-tidy');
        await sleep(200);
        await click('#pm-window .pm-profiles-tidy');
        const m1 = await until(async () => { const t = await text('#pm-window .pm-settings-status'); return /active profile/i.test(t ?? '') ? t : null; }, 8000, 'active-profile refusal');
        await sleep(1500);
        must((await liveProfiles()).length === n0, 'profiles were deleted with the active one unkept');

        // (ii) a to-be-deleted profile changes while the backup request is in flight
        must(await pickStProfile('Mock'), 'dropdown pick failed');
        await until(async () => { const c = await converged(); return c && c.s.selectedProfile === prof.Mock ? c : null; }, 15000, 'on Mock');
        await probe.eval(`(() => {
            const profiles = SillyTavern.getContext().extensionSettings.connectionManager.profiles;
            window.__chkFetch = window.fetch;
            window.fetch = async (...args) => {
                const res = await window.__chkFetch(...args);
                if (String(args[0]?.url ?? args[0]).includes('/profiles/backup')) {
                    const p = profiles.find((x) => x.name === 'Kimi via nanogpt');
                    window.__chkOld = p['start-reply-with'];
                    p['start-reply-with'] = 'edited during the backup';
                }
                return res;
            };
            return true; })()`);
        try {
            await showTab('settings');
            for (const id of keep) await setChecked(`#pm-window .pm-profile-row[data-profile-id="${id}"] .pm-profile-keep`, true);
            await click('#pm-window .pm-profiles-tidy');
            await sleep(200);
            await click('#pm-window .pm-profiles-tidy');
            const m2 = await until(async () => { const t = await text('#pm-window .pm-settings-status'); return /changed after the backup/i.test(t ?? '') ? t : null; }, 8000, 'changed-after-backup refusal');
            await sleep(1500);
            must((await liveProfiles()).length === n0, 'profiles were deleted although one changed after the backup');
            return `refused (active): "${m1.slice(0, 80)}"; refused (changed): "${m2.slice(0, 80)}"; ${n0} profiles kept`;
        } finally {
            await probe.eval(`(() => {
                window.fetch = window.__chkFetch ?? window.fetch;
                const p = SillyTavern.getContext().extensionSettings.connectionManager.profiles.find((x) => x.name === 'Kimi via nanogpt');
                if (p && '__chkOld' in window) p['start-reply-with'] = window.__chkOld;
                SillyTavern.getContext().saveSettingsDebounced();
                return true; })()`);
        }
    });

    // ------------------------------------------------------------------ 7
    await check('7 tidy: keep 2 -> backup holds every original, settings.json has 2', async () => {
        await showTab('settings');
        const live = await liveProfiles();
        must(live.length > 2, 'precondition: more than 2 profiles');
        // the tab's latest save reached disk (check 6 changed a profile)
        const disk0 = await until(() => {
            const d = readSettingsFile().extension_settings.connectionManager.profiles;
            const m = byId(d);
            return d.length === live.length && live.every((/** @type {any} */ p) => J(m.get(p.id)) === J(p)) ? d : null;
        }, 8000, 'settings.json == live profiles');
        await until(async () => (await probe.eval('document.querySelectorAll("#pm-window .pm-profile-row").length')) === live.length, 8000, 'profile list rendered');
        const keep = [prof.Mock, prof['Kimi via hapuppy']];
        for (const id of keep) must(await setChecked(`#pm-window .pm-profile-row[data-profile-id="${id}"] .pm-profile-keep`, true), `no keep box for ${id}`);
        const before = new Set(fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : []);
        await click('#pm-window .pm-profiles-tidy'); // arm
        await sleep(200);
        await click('#pm-window .pm-profiles-tidy'); // confirm
        const file = await until(() => {
            const fresh = (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : []).filter((f) => !before.has(f) && /^profiles-.*\.json$/.test(f));
            return fresh[0] ?? null;
        }, 8000, 'new backups/profiles-*.json');
        const backup = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, file), 'utf8')).profiles;
        const bm = byId(backup);
        must(backup.length === disk0.length && disk0.every((/** @type {any} */ p) => J(bm.get(p.id)) === J(p)), `backup has ${backup.length} of ${disk0.length} originals (or differs)`);
        const after = await until(() => {
            const d = readSettingsFile().extension_settings.connectionManager.profiles;
            return d.length === 2 ? d : null;
        }, 10000, 'settings.json with 2 profiles');
        must(J(after.map((/** @type {any} */ p) => p.id).sort()) === J([...keep].sort()), `kept ${J(after.map((/** @type {any} */ p) => p.name))}`);
        const opts = await probe.eval(`[...document.getElementById('connection_profiles').options].map((o) => o.textContent)`);
        must(opts.length === 3, `ST dropdown shows ${J(opts)}`);
        return `backup ${file}: ${backup.length}/${disk0.length} originals verbatim; settings.json now ${J(after.map((/** @type {any} */ p) => p.name))}; ST dropdown ${J(opts)}`;
    });

    // ------------------------------------------------------------------ 7b
    await check('7b renaming a Model in the Settings tab migrates the presets\' hot tuning binding; ST keeps the same state', async () => {
        const d0 = await getDoc(ids.ff);
        const lid = d0.activeLoadoutId;
        const T = (await tun(KIMI, 'hot'))?.temperature;
        must(T !== undefined && d0.loadouts[lid].overrides?.[KIMI]?.tuning === 'hot', 'precondition: FF binds the Kimi hot tuning');
        must(await pickStProfile('Kimi via hapuppy'), 'dropdown pick failed');
        await until(async () => { const c = await converged(); return c && c.s.model === HAP && c.s.temperature === T ? c : null; }, 15000, `on Kimi at ${T}`);
        await showTab('settings');
        await until(() => exists(`#pm-window .pm-model-row[data-model="${KIMI}"] .pm-model-name`), 8000, 'Kimi K3 row');
        await setValue(`#pm-window .pm-model-row[data-model="${KIMI}"] .pm-model-name`, 'Kimi', 'change');
        const d1 = await until(async () => {
            const d = await getDoc(ids.ff);
            const o = d.loadouts[d.activeLoadoutId].overrides ?? {};
            return o.Kimi?.tuning === 'hot' && !o[KIMI] && (await tun('Kimi', 'hot')) !== undefined ? d : null;
        }, 8000, 'FF hot tuning binding re-keyed to "Kimi"');
        must(d1.loadouts[lid].overrides?.Kimi && !d1.loadouts[lid].overrides[KIMI], 'loadout override not re-keyed');
        const reg = await getModels();
        must(reg.models.Kimi && !reg.models[KIMI], 'registry not renamed');
        const c = await until(async () => { const x = await converged(); return x && x.slot.desired.modelId === 'Kimi' ? x : null; }, 10000, 'slot resolves "Kimi"');
        must(c.s.temperature === T, `ST temperature ${c.s.temperature}, expected ${T}`);
        must((await domOn(ids.kimiBlock)) === true, 'the Kimi block override stopped applying');
        return `Kimi K3 -> Kimi: FF loadout overrides ${J(Object.keys(d1.loadouts[lid].overrides))} (Kimi tuning ${d1.loadouts[lid].overrides.Kimi.tuning}), models.Kimi.tunings ${J(Object.keys(reg.models.Kimi.tunings))}; ST ${c.s.temperature}, Kimi block on`;
    });

    // ------------------------------------------------------------------ 8
    await check('8 bind_preset_to_connection is forced off once with a toast', async () => {
        await probe.eval(`(() => { const el = document.getElementById('bind_preset_to_connection'); el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); SillyTavern.getContext().saveSettingsDebounced(); return true; })()`);
        await until(() => readSettingsFile().oai_settings?.bind_preset_to_connection === true, 8000, 'settings.json has bind=true');
        await probe.cdp('Page.reload', { ignoreCache: false });
        await sleep(1000);
        await until(() => probe.eval('(document.getElementById("settings_preset_openai")?.options.length ?? 0) > 1'), 60000, 'ST rebooted');
        const toast = await until(() => probe.eval(`(() => { const t = document.querySelector('#toast-container')?.textContent ?? ''; return /Bind preset to connection/.test(t) ? t : null; })()`), 20000, 'toast');
        const live = await probe.eval(`({ bind: SillyTavern.getContext().chatCompletionSettings.bind_preset_to_connection, box: document.getElementById('bind_preset_to_connection').checked })`);
        must(live.bind === false && live.box === false, `live ${J(live)}`);
        await until(() => readSettingsFile().oai_settings?.bind_preset_to_connection === false, 8000, 'settings.json has bind=false');
        return `after reload: bind=${live.bind}, checkbox=${live.box}, toast "${toast.replace(/\s+/g, ' ').slice(0, 90)}", settings.json false`;
    });

    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
