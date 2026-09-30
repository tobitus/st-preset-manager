#!/usr/bin/env node
/**
 * "Active in SillyTavern" indicator acceptance. Drives the ACTUAL v2 window
 * in a headless Chromium over raw CDP and observes the plugin REST API.
 *
 *   node dev/check-active.mjs               all checks (resets dev data first)
 *   CHK_SKIP=a4 node dev/check-active.mjs   skip checks by id (diagnosis only)
 *
 * Setup: DEM and FF imported; DEM renamed to `<i>DEM</i> & "Co"` and its
 * active loadout to `<u>Main</u>` (HTML characters); DEM loaded into the
 * slot; clean pm.* localStorage; window opened on the Library tab.
 *
 * Checks:
 *   a1 header `.pm-active-status` reads exactly
 *      `Active in SillyTavern: <DEM name> · <DEM loadout>` as TEXT (no <i>/<u>
 *      element anywhere in the window; the Library name renders as text
 *      too); the DEM Library row alone carries a visible `.pm-active-marker`
 *      "● Active" in the accent colour; the auto-opened DEM preset tab
 *      carries the marker and its view shows no notice. Opening FF from the
 *      Library: FF tab has no marker, its view shows `.pm-not-active`
 *      "Not active in SillyTavern" + a `.pm-make-active` button
 *   a2 Library Load on the FF row: within 5 s the header names FF + its
 *      loadout, the Library marker and the tab marker move to FF (DEM
 *      loses both), GET /slot desired.presetId is FF, FF's notice is gone,
 *      and ST converges on FF
 *   a3 DEM tab now shows the notice; its Make active button: GET /slot
 *      names DEM with DEM's active loadout, the notice disappears, the
 *      header returns to DEM, the tab marker moves back, ST converges on DEM
 *   a4 DEM loaded with a NON-active loadout `Alt <b>x</b>` (REST, the same
 *      /slot/load as the Library row's loadout select): the header names
 *      that loadout, DEM's tab keeps the marker, and its notice reads
 *      `Active in SillyTavern with loadout Alt <b>x</b>` (as text); Make
 *      active restores DEM's active loadout in the slot and hides it
 *   a5 with DEM in the slot, an ST prompt-manager toggle (write-back still
 *      debounced, i.e. unsent) and FF's Make active click in ONE page task:
 *      the slot moves to FF and the toggle lands in DEM's doc (the load runs
 *      as a bridge.edit op, which flushes the panel first; a bare POST lost it)
 * Screenshots (dev/shots/): active-header.png (header + active markers),
 * active-not-active-notice.png (the notice on a non-active tab).
 *
 * Environment: the dev container st-pm-dev on 127.0.0.1:8002 with the plugin
 * (dev/up.sh); NEVER :8001. It RESETS the dev data (dev/reset.sh) first.
 * Never touches the sillytavern container, ~/tools/ST-dev or
 * /home/jon/projects/sillysystem/st.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    FF, Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';

const TAB = 'chkact';
const DEM = 'DEUS.EX.MACHINA.V2.5.ST';
const DEM_NAME = '<i>DEM</i> & "Co"';
const DEM_LOADOUT = '<u>Main</u>';
const ALT_LOADOUT = 'Alt <b>x</b>';
const SHOTS = path.join(REPO, 'dev', 'shots');

const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-active.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const J = (/** @type {any} */ v) => JSON.stringify(v);
const ids = { dem: '', ff: '', demLid: '', ffLid: '', altLid: '' };
let ffLoadoutName = '';

// ------------------------------------------------------------------ page helpers

const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const text = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.textContent ?? null`);

async function dismissPopups() {
    const closed = await probe.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

/** ST's live chat-completion prompt state. */
const st = () => probe.eval(`(() => {
    const o = SillyTavern.getContext().chatCompletionSettings;
    const b = window.__pmStarted?.bridge;
    return {
        preset: o.preset_settings_openai,
        order: o.prompt_order?.[0]?.order ?? [],
        blocker: !!document.querySelector('.pm-apply-blocker'),
        idle: !!b && !b.applying && !b._reconcileQueued && !b._panelQueued,
    };
})()`);

/** ST shows the slot and its order equals the compiled slot. */
async function converged() {
    const s = await st();
    const slot = (await api('GET', '/slot')).json;
    return !s.blocker && s.idle && s.preset === SLOT_NAME
        && J(s.order) === J(slot.compiled?.prompt_order?.[0]?.order) ? { s, slot } : null;
}
const convergedOn = (/** @type {string} */ presetId, /** @type {string} */ label) => until(async () => {
    const c = await converged();
    return c && c.slot.desired?.presetId === presetId ? c : null;
}, 20000, label);

async function showTab(/** @type {string} */ tab) {
    await click(`#pm-window .pm-tab[data-tab="${tab}"]`);
    await until(() => exists(`#pm-window .pm-pane[data-pane="${tab}"]:not([hidden])`), 5000, `${tab} tab shown`);
}

const view = (/** @type {string} */ id) => `#pm-window .pm-preset-view[data-preset-id="${id}"]`;
const libRow = (/** @type {string} */ id) => `#pm-window .pm-library-row[data-preset-id="${id}"]`;
const presetTab = (/** @type {string} */ id) => `#pm-window .pm-preset-tab[data-preset-id="${id}"]`;

async function reloadPage() {
    await probe.cdp('Page.reload', { ignoreCache: false });
    await sleep(1500);
    await until(() => probe.eval('(document.getElementById("settings_preset_openai")?.options.length ?? 0) > 1').catch(() => false), 60000, 'ST booted after reload');
    await until(() => exists('#pm-float-btn').catch(() => false), 30000, 'floating button after reload');
    // ST's #preloader overlay fades out after boot; a screenshot under it comes out blank
    await until(async () => !(await exists('#preloader')), 30000, "ST's #preloader gone");
    await dismissPopups();
}

async function openWindow() {
    if (!(await click('#pm-float-btn'))) throw new Error('no #pm-float-btn');
    await until(() => exists('#pm-window .pm-tab[data-tab="presets"]'), 10000, 'window opened');
}

async function shot(/** @type {string} */ file) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await sleep(300);
    const r = await probe.eval(`(() => { const b = document.querySelector('#pm-window').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    const out = path.join(SHOTS, file);
    fs.writeFileSync(out, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data, 'base64'));
    console.log(`[check] screenshot: ${out}`);
    return out;
}

const SKIP = (process.env.CHK_SKIP ?? '').split(',').filter(Boolean);
async function check(/** @type {string} */ name, /** @type {() => Promise<string>} */ body) {
    if (SKIP.includes(name.split(' ')[0])) { console.log(`SKIP ${name}`); return; }
    try {
        report(name, true, await body());
    } catch (err) {
        report(name, false, /** @type {Error} */ (err).message);
    }
}
const must = (/** @type {any} */ cond, /** @type {string} */ msg) => { if (!cond) throw new Error(msg); };

// ------------------------------------------------------------------ indicator readouts

const headerText = () => text('#pm-window .pm-active-status');
const expectHeader = (/** @type {string} */ name, /** @type {string} */ loadout) => `Active in SillyTavern: ${name} · ${loadout}`;
/** Preset ids of Library rows carrying the marker. */
const libMarked = () => probe.eval(`[...document.querySelectorAll('#pm-window .pm-library-row')].filter((r) => r.querySelector('.pm-active-marker')).map((r) => r.dataset.presetId)`);
/** Preset ids of preset tabs carrying the marker. */
const tabMarked = () => probe.eval(`[...document.querySelectorAll('#pm-window .pm-preset-tab')].filter((t) => t.querySelector('.pm-active-marker')).map((t) => t.dataset.presetId)`);
/** Elements inside the name-bearing nodes: HTML-looking names rendered as HTML would create some. */
const injected = () => probe.eval(`document.querySelectorAll('#pm-window .pm-active-status *, #pm-window .pm-library-row .pm-name *, #pm-window .pm-preset-tab-name *, #pm-window .pm-not-active-text *, #pm-window .pm-loadout-select option *').length`);
/** The notice of a preset view: null when hidden, else its text. */
const notice = (/** @type {string} */ id) => probe.eval(`(() => {
    const n = document.querySelector(${J(`${view(id)} > .pm-not-active`)});
    if (!n) return { missing: true };
    return n.hidden ? null : { text: n.querySelector('.pm-not-active-text')?.textContent ?? null, button: n.querySelector('.pm-make-active')?.textContent?.trim() ?? null, first: n === n.parentElement.firstElementChild };
})()`);

async function openFromLibrary(/** @type {string} */ id) {
    await showTab('library');
    await until(() => exists(libRow(id)), 10000, 'library row');
    if (!(await click(`${libRow(id)} .pm-open`))) throw new Error(`no .pm-open on row ${id}`);
    await until(() => exists(`${view(id)} .pm-outline li.pm-node`), 20000, `preset ${id} outline rendered`);
}

// ------------------------------------------------------------------ main

async function main() {
    const t0 = Date.now();
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
    execFileSync(path.join(REPO, 'dev', 'import-fixtures.sh'),
        ['^(Freaky Frankenstein 5\\.4 Internal States \\(2\\)|DEUS\\.EX\\.MACHINA\\.V2\\.5\\.ST)$'],
        { stdio: 'pipe' });
    const library = (await api('GET', '/library')).json ?? [];
    const byName = (/** @type {string} */ n) => library.find((/** @type {any} */ e) => e.name === n);
    const demItem = byName(DEM);
    const ffItem = byName(FF);
    if (!demItem || !ffItem) fatal('setup', `fixtures missing: ${J(library.map((/** @type {any} */ e) => e.name))}`);
    ids.dem = demItem.id; ids.ff = ffItem.id;
    ids.demLid = demItem.activeLoadoutId; ids.ffLid = ffItem.activeLoadoutId;
    ffLoadoutName = ffItem.loadouts.find((/** @type {any} */ l) => l.id === ids.ffLid)?.name ?? '';
    if (!ids.demLid || !ffLoadoutName) fatal('setup', `active loadouts missing: ${J({ demItem, ffItem })}`);
    const renamed = [
        await api('PATCH', `/presets/${ids.dem}/meta`, { name: DEM_NAME }),
        await api('PATCH', `/presets/${ids.dem}/loadouts/${ids.demLid}`, { name: DEM_LOADOUT }),
    ];
    if (renamed.some((r) => r.status !== 200)) fatal('setup', `renames failed: ${J(renamed.map((r) => [r.status, r.text.slice(0, 120)]))}`);
    if ((await api('POST', '/slot/load', { presetId: ids.dem })).status !== 200) fatal('setup', 'slot/load DEM failed');

    await probe.start();
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
        await probe.eval(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('pm.')) localStorage.removeItem(k); return true; })()`);
        await reloadPage();
        await convergedOn(ids.dem, 'DEM converged in the slot');
        await openWindow();
        await showTab('library');
        await until(() => exists(libRow(ids.dem)), 10000, 'DEM library row');
        await until(() => exists(libRow(ids.ff)), 10000, 'FF library row');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: reset, DEM + FF imported, DEM renamed with HTML characters and loaded, window open on the Library tab', true,
        `dem=${ids.dem} ff=${ids.ff}`);

    // ------------------------------------------------------------------ a1
    await check('a1 header names the slot preset + loadout as text; DEM row and tab carry "● Active"; FF tab shows the not-active notice + Make active', async () => {
        const want = expectHeader(DEM_NAME, DEM_LOADOUT);
        await until(async () => (await headerText()) === want, 8000, `header reads ${J(want)}`);
        const hdr = await probe.eval(`(() => {
            const h = document.querySelector('#pm-window .pm-active-status');
            const r = h.getBoundingClientRect();
            const tb = document.querySelector('#pm-window .pm-toolbar').getBoundingClientRect();
            return { presetId: h.dataset.presetId, children: h.querySelectorAll('*').length, visible: r.height > 0 && r.width > 0, first: h === h.parentElement.firstElementChild, aboveToolbar: r.bottom <= tb.top + 1 };
        })()`);
        must(hdr.presetId === ids.dem, `header data-preset-id is ${J(hdr.presetId)}, want DEM`);
        must(hdr.visible && hdr.first && hdr.aboveToolbar, `header not visible as the first line of the window body: ${J(hdr)}`);
        must((await text(`${libRow(ids.dem)} .pm-name`)) === DEM_NAME, `DEM Library name is not the literal text: ${J(await text(`${libRow(ids.dem)} .pm-name`))}`);
        await until(async () => J(await libMarked()) === J([ids.dem]), 8000, 'Library marker on DEM only');
        const mk = await probe.eval(`(() => {
            const m = document.querySelector(${J(`${libRow(ids.dem)} .pm-active-marker`)});
            const cs = getComputedStyle(m);
            const r = m.getBoundingClientRect();
            return { text: m.textContent, bg: cs.backgroundColor, w: r.width, h: r.height, opacity: cs.opacity };
        })()`);
        must(mk.text === '● Active', `Library marker text ${J(mk.text)}, want "● Active"`);
        must(mk.w > 20 && mk.h > 10 && Number(mk.opacity) === 1 && !/rgba\(.*, 0(\.\d+)?\)$/.test(mk.bg) && mk.bg !== 'transparent', `marker not clearly visible: ${J(mk)}`);
        must(!(await exists('#pm-window .pm-slot-badge')), 'an old .pm-slot-badge is still rendered');

        await showTab('presets');
        await until(async () => J(await tabMarked()) === J([ids.dem]), 10000, 'DEM tab auto-opened with the marker');
        must((await text(`${presetTab(ids.dem)} .pm-active-marker`)) === '● Active', 'DEM tab marker text is not "● Active"');
        await until(() => exists(`${view(ids.dem)} .pm-outline li.pm-node`), 15000, 'DEM outline');
        await until(async () => (await notice(ids.dem)) === null, 5000, 'DEM view shows no notice');
        must((await text(`${presetTab(ids.dem)} .pm-preset-tab-name`)) === DEM_NAME, 'DEM tab name is not the literal text');
        must((await injected()) === 0, `names rendered as HTML: ${await injected()} <i>/<u>/<b> elements in the window`);
        await showTab('library');
        await shot('active-header.png');

        await openFromLibrary(ids.ff);
        must(J(await tabMarked()) === J([ids.dem]), `tab markers ${J(await tabMarked())}, want DEM only`);
        const n = await until(() => notice(ids.ff), 5000, 'FF notice shown');
        must(n.text === 'Not active in SillyTavern' && n.button === 'Make active' && n.first, `FF notice ${J(n)}`);
        await shot('active-not-active-notice.png');
        return `header ${J(want)} (data-preset-id DEM, no injected elements); Library + tab marker "● Active" on DEM (bg ${mk.bg}, ${Math.round(mk.w)}x${Math.round(mk.h)}); FF notice ${J(n)}`;
    });

    // ------------------------------------------------------------------ a2
    await check('a2 Library Load on FF: header, Library marker and tab marker move to FF within 5 s; FF notice gone; ST converges', async () => {
        await showTab('library');
        const t = Date.now();
        must(await click(`${libRow(ids.ff)} .pm-load`), 'FF Load click failed');
        const want = expectHeader(FF, ffLoadoutName);
        await until(async () => (await headerText()) === want && J(await libMarked()) === J([ids.ff]), 5000, `header ${J(want)} + Library marker on FF`);
        const libMs = Date.now() - t;
        const slot = (await api('GET', '/slot')).json;
        must(slot.desired?.presetId === ids.ff, `GET /slot desired.presetId ${J(slot.desired?.presetId)}, want FF`);
        await showTab('presets');
        await until(async () => J(await tabMarked()) === J([ids.ff]), 5000, 'tab marker moved to FF');
        const tabMs = Date.now() - t;
        await until(async () => (await notice(ids.ff)) === null, 5000, 'FF notice hidden');
        await convergedOn(ids.ff, 'FF converged in the slot');
        return `header ${J(want)} + Library marker after ${libMs} ms, tab marker after ${tabMs} ms; slot desired ${J(slot.desired)}; ST converged`;
    });

    // ------------------------------------------------------------------ a3
    await check('a3 DEM tab: notice + Make active -> GET /slot names DEM with its active loadout, notice gone, header + markers back on DEM', async () => {
        await showTab('presets');
        must(await click(presetTab(ids.dem)), 'DEM tab click failed');
        await until(() => exists(`${view(ids.dem)} .pm-outline li.pm-node`), 15000, 'DEM view');
        const n = await until(() => notice(ids.dem), 5000, 'DEM notice shown');
        must(n.text === 'Not active in SillyTavern', `DEM notice ${J(n)}`);
        must(await click(`${view(ids.dem)} .pm-make-active`), 'Make active click failed');
        const slot = await until(async () => {
            const s = (await api('GET', '/slot')).json;
            return s.desired?.presetId === ids.dem ? s : null;
        }, 5000, 'GET /slot names DEM');
        must(slot.desired.loadoutId === ids.demLid, `slot loadout ${J(slot.desired.loadoutId)}, want DEM's active ${ids.demLid}`);
        await until(async () => (await notice(ids.dem)) === null, 5000, 'DEM notice hidden');
        const want = expectHeader(DEM_NAME, DEM_LOADOUT);
        await until(async () => (await headerText()) === want, 5000, `header ${J(want)}`);
        await until(async () => J(await tabMarked()) === J([ids.dem]), 5000, 'tab marker back on DEM');
        await convergedOn(ids.dem, 'DEM converged in the slot');
        await showTab('library');
        await until(async () => J(await libMarked()) === J([ids.dem]), 5000, 'Library marker back on DEM');
        return `notice ${J(n.text)} -> Make active -> slot ${J(slot.desired)}; notice hidden; header ${J(want)}; markers on DEM; ST converged`;
    });

    // ------------------------------------------------------------------ a4
    await check('a4 DEM in the slot with a non-active loadout: notice names it (as text), header too; Make active restores the active loadout', async () => {
        const created = await api('POST', `/presets/${ids.dem}/loadouts`, { name: ALT_LOADOUT, from: ids.demLid });
        must(created.status === 200 || created.status === 201, `create loadout ${created.status} ${created.text.slice(0, 120)}`);
        ids.altLid = Object.values(created.json.doc.loadouts).find((/** @type {any} */ l) => l.name === ALT_LOADOUT)?.id ?? '';
        must(ids.altLid, 'new loadout id not found');
        must((await api('GET', `/presets/${ids.dem}`)).json.activeLoadoutId === ids.demLid, 'precondition: creating a loadout changed the active loadout');
        must((await api('POST', '/slot/load', { presetId: ids.dem, loadoutId: ids.altLid })).status === 200, 'slot/load DEM alt failed');
        await showTab('presets');
        const want = `Active in SillyTavern with loadout ${ALT_LOADOUT}`;
        const n = await until(async () => {
            const x = await notice(ids.dem);
            return x?.text === want ? x : null;
        }, 5000, `DEM notice ${J(want)}`);
        const hdr = expectHeader(DEM_NAME, ALT_LOADOUT);
        await until(async () => (await headerText()) === hdr, 5000, `header ${J(hdr)}`);
        must(J(await tabMarked()) === J([ids.dem]), `tab markers ${J(await tabMarked())}, want DEM`);
        must((await injected()) === 0, 'loadout name rendered as HTML');
        must(await click(`${view(ids.dem)} .pm-make-active`), 'Make active click failed');
        const slot = await until(async () => {
            const s = (await api('GET', '/slot')).json;
            return s.desired?.presetId === ids.dem && s.desired?.loadoutId === ids.demLid ? s : null;
        }, 5000, 'slot back on DEM active loadout');
        await until(async () => (await notice(ids.dem)) === null, 5000, 'DEM notice hidden');
        await until(async () => (await headerText()) === expectHeader(DEM_NAME, DEM_LOADOUT), 5000, 'header back on DEM active loadout');
        await convergedOn(ids.dem, 'DEM converged in the slot');
        return `notice ${J(n.text)}, header ${J(hdr)}; Make active -> slot ${J(slot.desired)}; notice hidden`;
    });

    // ------------------------------------------------------------------ a5
    await check('a5 an unsent ST panel toggle followed at once by Make active lands in the OLD slot preset (the load runs as a bridge.edit op)', async () => {
        await convergedOn(ids.dem, 'precondition: DEM converged in the slot');
        const dem = (await api('GET', `/presets/${ids.dem}`)).json;
        const enabled = dem.loadouts[dem.activeLoadoutId].enabled ?? {};
        const rows = await probe.eval(`[...document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')].map((r) => r.dataset.pmIdentifier)`);
        const ident = Object.keys(enabled).find((k) => enabled[k] === true && dem.blocks[k] && rows.includes(k));
        must(ident, 'no enabled DEM block shown in ST\'s prompt manager');
        await showTab('presets');
        must(await click(presetTab(ids.ff)), 'FF tab click failed');
        const n = await until(() => notice(ids.ff), 8000, 'FF notice shown');
        must(n.text === 'Not active in SillyTavern', `FF notice ${J(n)}`);
        // ONE synchronous page task: ST's own toggle handler flips the panel bit
        // (write-back still debounced, i.e. unsent), then Make active is clicked
        const fired = await probe.eval(`(() => {
            if (document.querySelector('.pm-apply-blocker')) return 'blocker';
            const t = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${ident}"] .prompt-manager-toggle-action');
            const b = document.querySelector(${J(`${view(ids.ff)} .pm-make-active`)});
            if (!t || !b) return 'missing';
            t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            b.click();
            return 'ok';
        })()`);
        must(fired === 'ok', `toggle + Make active not fired: ${fired}`);
        await convergedOn(ids.ff, 'FF converged in the slot');
        await sleep(1500); // any late debounced write-back has landed
        const after = (await api('GET', `/presets/${ids.dem}`)).json;
        const bit = after.loadouts[after.activeLoadoutId].enabled?.[ident];
        must(bit === false, `DEM ${ident} is ${J(bit)} after the load: the unsent panel toggle was lost (want false)`);
        return `ST toggle of DEM ${ident} + Make active on FF in one task -> slot FF, DEM doc enabled[${ident}] = false (edit kept)`;
    });

    console.log(`[check] wall ${Math.round((Date.now() - t0) / 1000)} s`);
    finish();
}

main().catch((err) => fatal('uncaught', /** @type {Error} */ (err).stack ?? String(err)));
