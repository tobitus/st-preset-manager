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
 *
 * Checks:
 *   1  seed from profiles + owner merge in the UI -> one "Kimi K3", 2 matches
 *   2  acceptance 7: toolbar picker switches ST's connection + tuning
 *   3  acceptance 2 (model half): panel temperature -> override / global
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
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

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
function st() {
    return probe.eval(`(() => {
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
        };
    })()`);
}
/** ST's own prompt-manager row state for one identifier (null when not rendered). */
const domOn = (/** @type {string} */ id) => probe.eval(`(() => {
    const r = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${id}"]');
    return r ? !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on') : null; })()`);
const clickStToggle = (/** @type {string} */ id) => probe.eval(`(() => { if (document.querySelector('.pm-apply-blocker')) return false; const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${id}"] .prompt-manager-toggle-action'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`);
/** ST's own sampler slider (dev/probe.mjs set-slider). */
const setSlider = (/** @type {string} */ id, /** @type {number} */ v) => probe.eval(`(() => {
    const el = document.getElementById(${J(id)}); if (!el) return false;
    el.value = ${J(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
/** ST's OWN connection-profile dropdown (not /profile, not v2). */
const pickStProfile = (/** @type {string} */ name) => probe.eval(`(() => {
    const c = SillyTavern.getContext();
    const p = c.extensionSettings.connectionManager.profiles.find((x) => x.name === ${J(name)});
    const sel = document.getElementById('connection_profiles');
    if (!p || !sel) return false;
    sel.value = p.id; sel.dispatchEvent(new Event('change')); return true; })()`);
const liveProfiles = () => probe.eval('JSON.parse(JSON.stringify(SillyTavern.getContext().extensionSettings.connectionManager.profiles))');

const getSlot = async () => (await api('GET', '/slot')).json;
const getModels = async () => (await api('GET', '/models')).json;
const getDoc = async (/** @type {string} */ id) => (await api('GET', `/presets/${id}`)).json;

async function dismissPopups() {
    const closed = await probe.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

/** ST shows the slot and its order equals the compiled slot (no apply in flight). */
async function converged() {
    const [s, slot] = await Promise.all([st(), getSlot()]);
    return !s.blocker && s.preset === SLOT_NAME && J(s.order) === J(slot.compiled?.prompt_order?.[0]?.order)
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
async function check(/** @type {string} */ name, /** @type {() => Promise<string>} */ body) {
    try {
        report(name, true, await body());
    } catch (err) {
        report(name, false, /** @type {Error} */ (err).message);
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
        // Kimi global 0.3 (override switch OFF)
        await panelModel(ids.ff, KIMI);
        must(!(await probe.eval(`document.querySelector(${J(`${p} .pm-tuning-override`)})?.checked`)), 'FF already has a Kimi override');
        await setValue(`${p} .pm-tuning-input[data-key="temperature"]`, '0.3', 'change');
        await until(async () => (await getModels()).models[KIMI].tuning.temperature === 0.3, 8000, 'Kimi global 0.3');
        // FF override for Kimi 0.9 (switch ON)
        await setChecked(`${p} .pm-tuning-override`, true);
        await until(async () => (await getDoc(ids.ff)).tuningOverrides?.[KIMI] !== undefined, 8000, 'FF override created');
        await until(() => probe.eval(`document.querySelector(${J(`${p} .pm-tuning-override`)})?.checked === true`), 5000, 'switch shows the override');
        await setValue(`${p} .pm-tuning-input[data-key="temperature"]`, '0.9', 'change');
        await until(async () => (await getDoc(ids.ff)).tuningOverrides?.[KIMI]?.temperature === 0.9, 8000, 'FF override 0.9');
        must((await getModels()).models[KIMI].tuning.temperature === 0.3, 'the override write touched the global');
        await shot('phase4-tuning.png', `${p}`);
        // mock global 1.1
        await panelModel(ids.ff, mockName);
        must(!(await probe.eval(`document.querySelector(${J(`${p} .pm-tuning-override`)})?.checked`)), 'FF has a mock override');
        await setValue(`${p} .pm-tuning-input[data-key="temperature"]`, '1.1', 'change');
        await until(async () => (await getModels()).models[mockName].tuning.temperature === 1.1, 8000, 'mock global 1.1');

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
        must((await getDoc(ids.sola)).tuningOverrides?.[KIMI] === undefined, 'Sola has a Kimi override');
        const onSola = await until(async () => {
            const c = await converged();
            return c && c.slot.desired.presetId === ids.sola && c.s.temperature === 0.3 ? c : null;
        }, 10000, 'Sola at the Kimi global 0.3');
        void sola;
        return `mock 1.1 -> Kimi: profile="${onKimi.s.profile}" source=${onKimi.s.source} model=${onKimi.s.model} temp=${onKimi.s.temperature}; `
            + `-> ${onMock.s.profile} ${onMock.s.temperature}; -> Kimi 0.9; Sola (no override) ${onSola.s.temperature}; desired preset/loadout + FF loadouts unchanged`;
    });

    // ------------------------------------------------------------------ 3
    await check('3 acceptance 2 (model half): panel temperature -> FF override, else the Kimi global', async () => {
        const c0 = await loadViaLibrary(ids.ff);
        must(c0.slot.desired.modelId === KIMI && c0.s.temperature === 0.9, `precondition: FF on Kimi at 0.9 (got ${c0.slot.desired.modelId} ${c0.s.temperature})`);
        must(await setSlider('temp_openai', 0.55), 'no #temp_openai');
        await until(async () => (await getDoc(ids.ff)).tuningOverrides?.[KIMI]?.temperature === 0.55, 8000, 'FF override 0.55');
        const g1 = (await getModels()).models[KIMI].tuning.temperature;
        must(g1 === 0.3, `global changed to ${g1} by an override-routed edit`);

        const c1 = await loadViaLibrary(ids.sola);
        must(c1.s.temperature === 0.3, `precondition: Sola at the global 0.3 (got ${c1.s.temperature})`);
        const solaSettingsTemp = (await getDoc(ids.sola)).settings?.temperature;
        must(await setSlider('temp_openai', 0.55), 'no #temp_openai');
        await until(async () => (await getModels()).models[KIMI].tuning.temperature === 0.55, 8000, 'Kimi global 0.55');
        const sola = await getDoc(ids.sola);
        must(sola.tuningOverrides?.[KIMI] === undefined, 'Sola gained a Kimi override');
        must(sola.settings?.temperature === solaSettingsTemp, 'Sola settings.temperature changed');
        return 'FF (override) 0.9 -> 0.55 in tuningOverrides["Kimi K3"], global stayed 0.3; Sola (no override) -> GET /models Kimi global 0.55';
    });

    // ------------------------------------------------------------------ 4
    await check('4 acceptance 16: Kimi loadout override turns the "Kimi K3" block on only under Kimi', async () => {
        const K = ids.kimiBlock;
        const c0 = await loadViaLibrary(ids.ff);
        must(c0.slot.desired.modelId === KIMI, 'precondition: Kimi active');
        const d0 = await getDoc(ids.ff);
        const lid = d0.activeLoadoutId;
        must(d0.loadouts[lid].enabled[K] === false, 'precondition: loadout has the Kimi block off');
        must(!d0.loadouts[lid].overrides?.[KIMI], 'precondition: no Kimi override yet');
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
        must(a.s.temperature === b2.s.temperature && a.s.temperature === 0.55, `temperatures ${a.s.temperature} / ${b2.s.temperature}`);
        must(aOn === true && bOn === true, `Kimi block ${aOn} / ${bOn}`);
        must(J(a.s.order) === J(b2.s.order) && a.slot.hash === b2.slot.hash, 'compiled slot differs between the two providers');
        void b;
        return `hapuppy: temp ${a.s.temperature}, kimi block ${aOn}; nanogpt (${b2.s.model}): temp ${b2.s.temperature}, kimi block ${bOn}; same slot hash`;
    });

    // ------------------------------------------------------------------ 6
    await check('6 acceptance 8: profile guard names "Mock links Default"; Unlink excludes preset and re-attaches', async () => {
        must(await pickStProfile('Mock'), 'dropdown pick failed');
        await until(async () => {
            const c = await converged();
            return c && c.s.model === 'mock' && c.s.temperature === 1.1 ? c : null;
        }, 15000, 'on Mock at 1.1');
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
