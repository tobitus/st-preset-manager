#!/usr/bin/env node
/**
 * Phase 2 acceptance (PLAN Phase 2 checks 1–3 = roadmap acceptance 6, 9, 14)
 * as one repeatable real-browser script. It drives the ACTUAL extension UI in
 * a headless Chromium over raw CDP (clicks, real mouse drags on the jQuery UI
 * sortable handle, CDP key events) and observes SillyTavern itself (live
 * `oai` settings, ST's own prompt-manager DOM) — never only the REST API.
 *
 *   node dev/check-phase2.mjs              all checks
 *   node dev/check-phase2.mjs 6 9          subset (live, heading, 6, 9, editor, editor-hold, keys, 14, layout, leak)
 *
 * Checks:
 *   setup   reset + fixtures, FF 5.4 loaded AND opened through the window
 *   live    a switch clicked in the v2 window flips ST's own row within 2 s
 *   6       loadout B created from A in the UI, 3 toggles + a pick-one choice;
 *           activating A/B/A gives byte-equal prompt_order each time
 *   9       ST's own panel: 2nd POV option on → exactly one on within 2 s;
 *           the v2 window follows; compiled has no notes/groups/cardinality
 *           KEYS (the ST-format export is Phase 3 — not checked here)
 *   editor  content edit reaches ST; block notes stay library-only
 *   editor-hold  typing into block/preset notes while their save is held
 *           in the page survives the save's completion and the refresh
 *   keys    Alt+↓/Alt+↑ move, Tab/Shift+Tab promote/demote round-trip
 *   14      mouse drag of a single row (2 down) and of a group header with
 *           its options: ST's prompt_order shows the new order, identifier
 *           multiset and enabled bits unchanged
 * Always last: screenshots of the Presets tab into dev/shots/ (gitignored).
 *
 * Environment: st-pm-dev on 127.0.0.1:8002 with the plugin (dev/up.sh), the
 * mock LLM on :8099. Never touches :8001, the sillytavern container,
 * ~/tools/ST-dev or /home/jon/projects/sillysystem/st.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    FF, Probe, REPO, SLOT_NAME,
    cleanupTabs, createApi, createReporter, sleep, until,
} from './harness.mjs';

const TAB = 'chk2';
const { report, fatal, finish, onExit } = createReporter();
const { api, primeSession } = createApi({ jar: path.join(REPO, 'dev', '.check-phase2.cookies.jar'), onFatal: fatal });
const probe = new Probe(TAB, { onFatal: fatal });
onExit(() => probe.kill());
process.on('exit', () => cleanupTabs([TAB]));

const args = process.argv.slice(2);
const wanted = (/** @type {string} */ name) => args.length === 0 || args.includes(name);
const J = (/** @type {any} */ v) => JSON.stringify(v);

// ------------------------------------------------------------------ page reads

/** ST's live chat-completion state (order entries verbatim for byte compares). */
function oai() {
    return probe.eval(`(() => {
        const o = SillyTavern.getContext().chatCompletionSettings;
        return {
            preset: o.preset_settings_openai,
            order: o.prompt_order?.[0]?.order ?? [],
            prompts: (o.prompts ?? []).map((p) => ({ identifier: p.identifier, content: p.content ?? '' })),
        };
    })()`);
}
/** ST's OWN prompt-manager rows. @returns {Promise<{identifier: string, enabled: boolean}[]>} */
function stDom() {
    return probe.eval(`Array.from(document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')).map((r) => ({
        identifier: r.dataset.pmIdentifier,
        enabled: !!r.querySelector('.prompt-manager-toggle-action.fa-toggle-on'),
    }))`);
}
const uiSwitch = (/** @type {string} */ id) => `#pm-window li.pm-node[data-identifier="${id}"] > .pm-row input.pm-switch`;
const nameOf = (/** @type {string} */ id) => `#pm-window li.pm-node[data-identifier="${id}"] > .pm-row .pm-name`;
/** el.click() in the page; false when the element is missing. */
const click = (/** @type {string} */ sel) => probe.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return false; el.click(); return true; })()`);
const exists = (/** @type {string} */ sel) => probe.eval(`!!document.querySelector(${J(sel)})`);
const checked = (/** @type {string} */ sel) => probe.eval(`document.querySelector(${J(sel)})?.checked ?? null`);
/** Set a form control's value and fire `evt` (input for text, change for select). */
const setValue = (/** @type {string} */ sel, /** @type {string} */ value, evt = 'input') => probe.eval(`(() => {
    const el = document.querySelector(${J(sel)}); if (!el) return false;
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return true; })()`);
/** Click ST's own toggle; false while the bridge's apply overlay is up (retry). */
const clickStToggle = (/** @type {string} */ id) => probe.eval(`(() => { if (document.querySelector('.pm-apply-blocker')) return false; const el = document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="${id}"] .prompt-manager-toggle-action'); if (!el) return false; el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return true; })()`);
/**
 * ST can pop a modal <dialog> in a fresh profile a few seconds after boot; a
 * modal dialog captures all real (CDP) keyboard/mouse input, while scripted
 * el.click() still works. Close any before driving real input; log what it was.
 */
async function dismissPopups() {
    const closed = await probe.eval(`(() => {
        const open = [...document.querySelectorAll('dialog[open]')];
        for (const d of open) (d.querySelector('.popup-button-cancel, .popup-button-close, .popup-button-ok') ?? d).click?.();
        for (const d of open) if (d.open) d.close();
        return open.map((d) => d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
    })()`);
    if (closed.length) console.error(`[check] dismissed ST popup(s): ${J(closed)}`);
}

const getDoc = async () => (await api('GET', `/presets/${ffId}`)).json;
const getSlot = async () => (await api('GET', '/slot')).json;
const ids = (/** @type {any[]} */ order) => order.map((o) => o.identifier);
/** The live order equals the compiled slot order (converged). */
async function converged() {
    const [o, s] = await Promise.all([oai(), getSlot()]);
    return o.preset === SLOT_NAME && J(o.order) === J(s.compiled?.prompt_order?.[0]?.order) ? o : null;
}
/** ms until fn() is truthy (poll 50 ms), or null after `limit` ms. */
async function timeUntil(/** @type {() => any} */ fn, limit = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < limit) {
        try { if (await fn()) return Date.now() - t0; } catch { /* transient */ }
        await sleep(50);
    }
    return null;
}

// ------------------------------------------------------------------ CDP input

/** Real mouse drag (the path jQuery UI sortable listens to). */
async function mouseDrag(/** @type {{x:number,y:number}} */ from, /** @type {{x:number,y:number}} */ to) {
    const m = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, extra = {}) => probe.cdp('Input.dispatchMouseEvent', { type, x, y, ...extra });
    await m('mouseMoved', from.x, from.y);
    await m('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 });
    await m('mouseMoved', from.x, from.y + 6, { button: 'left', buttons: 1 });
    for (let i = 1; i <= 25; i++) {
        await m('mouseMoved', from.x + (to.x - from.x) * i / 25, from.y + (to.y - from.y) * i / 25, { button: 'left', buttons: 1 });
        await sleep(15);
    }
    await sleep(150);
    await m('mouseMoved', to.x, to.y, { button: 'left', buttons: 1 });
    await sleep(150);
    await m('mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 });
}
const KEYS = { Tab: 9, ArrowUp: 38, ArrowDown: 40 };
/** CDP key press to the focused element. modifiers: Alt=1, Shift=8. */
async function key(/** @type {'Tab'|'ArrowUp'|'ArrowDown'} */ k, modifiers = 0) {
    const base = { key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k], modifiers };
    await probe.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await probe.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// ===========================================================================

/** @type {string} */
let ffId = '';

async function main() {
    // ---------------------------------------------------------- environment
    let up = false;
    for (let i = 0; i < 2 && !up; i++) {
        try { up = (await api('GET', '/health')).status === 200; } catch { /* down */ }
        if (!up && i === 0) {
            console.error('[check] st-pm-dev not answering; running dev/up.sh');
            execFileSync(path.join(REPO, 'dev', 'up.sh'), { stdio: 'inherit' });
        }
    }
    if (!up) fatal('environment', 'st-pm-dev did not come up');
    await primeSession();
    console.error('[check] resetting dev data (dev/reset.sh)…');
    execFileSync(path.join(REPO, 'dev', 'reset.sh'), { stdio: 'inherit' });
    await primeSession();
    console.error('[check] importing fixtures (dev/import-fixtures.sh)…');
    execFileSync(path.join(REPO, 'dev', 'import-fixtures.sh'), { stdio: 'pipe' });
    const library = (await api('GET', '/library')).json ?? [];
    ffId = library.find((/** @type {any} */ e) => e.name === FF)?.id ?? '';
    if (!ffId) fatal('setup', `fixture ${FF} missing from the library`);

    // ------------------------------------------ setup: load + open via the UI
    console.error('[check] starting probe tab…');
    await probe.start();
    // input events (drag, keys) need a focused page in headless chromium
    await probe.cdp('Page.bringToFront');
    await probe.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
        await until(() => exists('#pm-menu-item'), 20000, 'wand menu entry');
        await click('#pm-menu-item');
        await until(() => exists('#pm-window .pm-tabs'), 10000, 'window');
        const row = `#pm-window .pm-library-row[data-preset-id="${ffId}"]`;
        await until(() => exists(row), 10000, 'library row');
        await click(`${row} .pm-load`);
        await until(async () => {
            const o = await converged();
            return o && (await stDom()).length === o.order.length;
        }, 15000, 'FF applied to the slot');
        await click(`${row} .pm-open`);
        await until(() => probe.eval(`!document.querySelector('#pm-window .pm-pane[data-pane="presets"]').hidden
            && !!document.querySelector('#pm-window .pm-preset-view[data-preset-id="${ffId}"] .pm-outline li.pm-node')`), 10000, 'presets tab open');
    } catch (err) {
        fatal('setup', /** @type {Error} */ (err).message);
    }
    report('setup: FF loaded + opened via the UI', true, `ffId=${ffId}`);

    const doc0 = await getDoc();
    const rows = doc0.sequences[0].rows;
    const grp = (/** @type {RegExp} */ re) => rows.find((/** @type {any} */ r) => r.kind === 'group' && re.test(r.name));
    const g = { prose: grp(/Prose/), pov: grp(/POV/), nsfw: grp(/NSFW/), echo: grp(/echo/), custom: grp(/custom toggles/), color: grp(/Color Option/) };
    for (const [k, v] of Object.entries(g)) if (!v) fatal('setup', `group ${k} not found`);
    const mainId = rows[0].ref;
    const tpKey = rows[1].key;
    const tpId = rows[1].ref;
    const optIds = (/** @type {any} */ gr) => gr.options.map((/** @type {any} */ o) => o.ref ?? o.identifier);

    // -------------------------------------------------------------- live
    if (wanted('live')) {
        const was = (await stDom()).find((r) => r.identifier === mainId)?.enabled;
        const t0 = Date.now();
        await click(uiSwitch(mainId));
        const ms = await timeUntil(async () => (await stDom()).find((r) => r.identifier === mainId)?.enabled === !was, 5000);
        const after = (await stDom()).find((r) => r.identifier === mainId)?.enabled;
        report('live UI → ST toggle', ms !== null && ms <= 2000, `${ms ?? `>${Date.now() - t0}`} ms, before=${was} after=${after}`);
        await click(uiSwitch(mainId));
        await timeUntil(async () => (await stDom()).find((r) => r.identifier === mainId)?.enabled === was, 5000);
        await until(converged, 10000, 'converged after live');
    }

    // ----------------------------------------------------------- heading
    // A pick-one group's HEADING is never a choice (round 3): a heading gets an
    // ordinary checkbox unless it is comment-only, and FF's POV heading is
    // comment-only, so its row renders no switch. Clicking anywhere on the
    // heading row never changes which option is chosen, in the library or in ST.
    if (wanted('heading')) {
        const name = 'heading: clicking a pick-one heading row never changes the chosen option';
        try {
            const hdr = g.pov.header?.ref ?? g.pov.header?.identifier;
            if (!hdr) throw new Error('POV group has no heading');
            await until(converged, 10000, 'converged before heading');
            const d0 = await getDoc();
            const en0 = d0.loadouts[d0.activeLoadoutId].enabled;
            const members = [hdr, ...optIds(g.pov)];
            const before = members.map((id) => !!en0[id]);
            const chosen = optIds(g.pov).filter((id) => en0[id]);
            if (chosen.length !== 1) throw new Error(`precondition: exactly one POV option on (got ${J(chosen)})`);
            const rowSel = `#pm-window li.pm-node[data-identifier="${hdr}"] > .pm-row`;
            if (!(await exists(rowSel))) throw new Error('heading row not rendered');
            const switches = await probe.eval(`document.querySelectorAll(${J(`${rowSel} input:not(.pm-none)`)}).length`);
            // click the heading's switch if one is rendered (the bug), else the row itself
            await probe.eval(`(() => { const r = document.querySelector(${J(rowSel)}); const el = r.querySelector('input:not(.pm-none)') ?? r.querySelector('.pm-name') ?? r; el.click(); return true; })()`);
            await sleep(2000);
            await until(converged, 10000, 'converged after the click');
            const d1 = await getDoc();
            const en1 = d1.loadouts[d1.activeLoadoutId].enabled;
            const after = members.map((id) => !!en1[id]);
            const dom = await stDom();
            const stChosen = dom.filter((r) => optIds(g.pov).includes(r.identifier) && r.enabled).map((r) => r.identifier);
            report(name, switches === 0 && J(after) === J(before) && J(stChosen) === J(chosen),
                `switches on heading=${switches}; library heading+options ${J(before)} -> ${J(after)}; ST chosen ${J(stChosen)} (was ${J(chosen)})`);
        } catch (err) {
            report(name, false, /** @type {Error} */ (err).message);
        }
    }

    // ------------------------------------------------------------------ 6
    if (wanted('6')) {
        try {
            const A = (await getDoc()).activeLoadoutId;
            const snapA = J((await until(converged, 10000, 'converged before 6')).order);
            await setValue('#pm-window .pm-loadout-picker', A, 'change');
            await setValue('#pm-window .pm-loadout-name', 'B');
            await setValue('#pm-window .pm-loadout-kind', 'root', 'change');
            await click('#pm-window .pm-loadout-new');
            const B = await until(async () => {
                const d = await getDoc();
                const b = Object.values(d.loadouts).find((/** @type {any} */ l) => l.name === 'B');
                return b && await exists(`#pm-window .pm-loadout-picker option[value="${/** @type {any} */ (b).id}"]`) ? /** @type {any} */ (b).id : null;
            }, 10000, 'loadout B created');
            await setValue('#pm-window .pm-loadout-picker', B, 'change');
            await click('#pm-window .pm-loadout-activate');
            await until(async () => (await getSlot()).desired?.loadoutId === B && (await getDoc()).activeLoadoutId === B, 10000, 'B active');
            await until(converged, 10000, 'converged on B');
            const custom = optIds(g.custom).slice(0, 3);
            for (const id of custom) {
                const was = (await getDoc()).loadouts[B].enabled[id];
                await until(() => exists(uiSwitch(id)), 5000, 'switch rendered');
                await click(uiSwitch(id));
                await until(async () => (await getDoc()).loadouts[B].enabled[id] === !was, 8000, `toggle ${id}`);
            }
            const [pov0, , , pov3] = optIds(g.pov);
            await click(uiSwitch(pov0));
            await until(async () => {
                const en = (await getDoc()).loadouts[B].enabled;
                return en[pov0] === true && en[pov3] === false;
            }, 8000, 'POV 3rd person chosen');
            const snapB = J((await until(converged, 10000, 'converged after B edits')).order);
            const a = JSON.parse(snapA);
            const b = JSON.parse(snapB);
            const diff = a.filter((/** @type {any} */ e, /** @type {number} */ i) => b[i]?.enabled !== e.enabled).map((/** @type {any} */ e) => e.identifier).sort();
            const expected = [...custom, pov0, pov3].sort();
            const sameOrder = J(ids(a)) === J(ids(b));
            const activate = async (/** @type {string} */ lid, /** @type {string} */ snap) => {
                await setValue('#pm-window .pm-loadout-picker', lid, 'change');
                await click('#pm-window .pm-loadout-activate');
                try {
                    await until(async () => J((await oai()).order) === snap, 10000, `activate ${lid}`);
                    return true;
                } catch { return false; }
            };
            const p1 = await activate(A, snapA);
            const p2 = await activate(B, snapB);
            const p3 = await activate(A, snapA);
            const pass = snapB !== snapA && J(diff) === J(expected) && sameOrder && p1 && p2 && p3;
            report('6 loadouts: A/B/A byte-equal', pass,
                `created B=${B}, ${diff.length} bits differ${J(diff) === J(expected) ? '' : ` (expected ${expected.length}: ${J(expected)} got ${J(diff)})`}, order same=${sameOrder}, A=${p1} B=${p2} A=${p3}`);
        } catch (err) {
            report('6 loadouts: A/B/A byte-equal', false, /** @type {Error} */ (err).message);
        }
    }

    // ------------------------------------------------------------------ 9
    if (wanted('9')) {
        const povIds = optIds(g.pov);
        const target = povIds[0];
        const hybrid = povIds[3];
        try {
            await until(converged, 10000, 'converged before 9');
            /** POV on-lists in ST's live settings and in ST's own panel DOM. */
            const povState = async () => {
                const live = (await oai()).order.filter((e) => povIds.includes(e.identifier));
                const dom = (await stDom()).filter((r) => povIds.includes(r.identifier));
                return {
                    live: live.filter((e) => e.enabled).map((e) => e.identifier),
                    dom: dom.filter((r) => r.enabled).map((r) => r.identifier),
                    complete: live.length === povIds.length && dom.length === povIds.length,
                };
            };
            const only = (/** @type {string[]} */ l, /** @type {string} */ id) => l.length === 1 && l[0] === id;
            // precondition in BOTH live state and DOM: Hybrid is the one on,
            // the target is off (a stale DOM from an earlier loadout can't pass)
            const pre = await until(async () => {
                const s = await povState();
                return s.complete && only(s.live, hybrid) && only(s.dom, hybrid) ? s : null;
            }, 8000, 'precondition: Hybrid on, target off (live + DOM)');
            const t0 = Date.now();
            await until(() => clickStToggle(target), 5000, 'ST toggle clickable');
            // the click must really land: the previously-off target is seen ON
            // (ST's handleToggle flips the live bit synchronously — a transient
            // two-on state before write-back normalises it)
            let sawTargetOn = false;
            let transient = '';
            let last = pre;
            let ms = null;
            while (Date.now() - t0 < 5000) {
                last = await povState();
                if (!sawTargetOn && (last.live.includes(target) || last.dom.includes(target))) {
                    sawTargetOn = true;
                    transient = `live=${last.live.length} dom=${last.dom.length} on at +${Date.now() - t0} ms`;
                }
                if (sawTargetOn && last.complete && only(last.live, target) && only(last.dom, target)) {
                    ms = Date.now() - t0;
                    break;
                }
                await sleep(25);
            }
            report('9 pick-one collapse in ST panel', sawTargetOn && ms !== null && ms <= 2000,
                `${ms ?? `>${Date.now() - t0}`} ms from click (target-only in live AND DOM); click landed=${sawTargetOn}${transient ? ` (${transient})` : ''}; final live=${J(last.live.map((i) => povIds.indexOf(i)))} dom=${J(last.dom.map((i) => povIds.indexOf(i)))} (target=option 0)`);
        } catch (err) {
            report('9 pick-one collapse in ST panel', false, /** @type {Error} */ (err).message);
        }
        try {
            await until(async () => (await checked(uiSwitch(target))) === true && (await checked(uiSwitch(hybrid))) === false, 3000, 'window follows');
            report('9 ST → v2 window', true, 'target radio checked, Hybrid unchecked');
        } catch (err) {
            report('9 ST → v2 window', false, /** @type {Error} */ (err).message);
        }
        const compiled = (await getSlot()).compiled;
        /** @type {string[]} */
        const bad = [];
        let scanned = 0;
        const walk = (/** @type {any} */ v, /** @type {string} */ at) => {
            if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
            else if (v && typeof v === 'object') {
                for (const [k, x] of Object.entries(v)) {
                    scanned++;
                    if (['notes', 'groups', 'cardinality'].includes(k)) bad.push(`${at}.${k}`);
                    walk(x, `${at}.${k}`);
                }
            }
        };
        walk(compiled, 'compiled');
        report('9 compiled has no notes/groups/cardinality keys', !!compiled && bad.length === 0,
            `${scanned} keys scanned${bad.length ? `, found ${bad.slice(0, 3).join(' ')}` : ''}; export ?format=st: Phase 3 endpoint, not checked here`);
    }

    // ------------------------------------------------------------- editor
    if (wanted('editor')) {
        const name = 'editor: content reaches ST, notes stay library-only';
        try {
            const original = (await getDoc()).blocks[mainId].content;
            await click(nameOf(mainId));
            await until(() => probe.eval(`document.querySelector('#pm-window textarea.pm-block-content')?.value === ${J(original)}`), 5000, 'editor shows Main Prompt');
            const edited = `${original}\n[chk2 edit]`;
            await setValue('#pm-window textarea.pm-block-content', edited);
            await click('#pm-window .pm-block-save');
            const ms = await timeUntil(async () => (await oai()).prompts.find((p) => p.identifier === mainId)?.content === edited, 5000);
            await setValue('#pm-window textarea.pm-block-notes', 'chk2 private note');
            await click('#pm-window .pm-block-notes-save');
            await until(async () => (await getDoc()).blocks[mainId].notes === 'chk2 private note', 5000, 'block notes stored');
            const slotText = (await api('GET', '/slot')).text;
            const leaked = slotText.includes('chk2 private note');
            report(name, ms !== null && !leaked, `content in ST after ${ms ?? '>5000'} ms, notes in doc=true, notes in /slot=${leaked}`);
        } catch (err) {
            report(name, false, /** @type {Error} */ (err).message);
        }
    }

    // ------------------------------------------------------------- layout
    // The Presets pane is bounded: real mouse-wheel scrolling (no
    // scrollIntoView) reaches the last outline row and both notes editors,
    // all inside the window's visible box (review finding 1).
    if (wanted('layout')) {
        const name = 'layout: wheel reaches last outline row and both notes editors';
        try {
            await dismissPopups();
            await click(nameOf(mainId));
            await until(() => exists('#pm-window textarea.pm-block-notes'), 5000, 'editor shows Main Prompt');
            const box = (/** @type {string} */ sel) => probe.eval(`(() => { const r = document.querySelector(${J(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 20), top: r.top, bottom: r.bottom }; })()`);
            const win = await box('#pm-window');
            const inWin = (/** @type {any} */ b) => b.top >= win.top - 1 && b.bottom <= win.bottom + 1;
            /** wheel over `areaSel` until `targetSel` is fully inside the window (or 60 notches). */
            const wheelTo = async (/** @type {string} */ areaSel, /** @type {string} */ targetSel) => {
                const a = await box(areaSel);
                for (let i = 0; i < 60; i++) {
                    if (inWin(await box(targetSel))) return true;
                    await probe.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: a.x, y: a.y, deltaX: 0, deltaY: 200 });
                    await sleep(40);
                }
                return inWin(await box(targetSel));
            };
            const lastLeaf = await probe.eval(`(() => { const all = document.querySelectorAll('#pm-window .pm-outline .pm-row'); all[all.length - 1].id = 'pm-chk-last'; return all[all.length - 1].textContent.trim().slice(0, 30); })()`);
            const outlineOk = await wheelTo('#pm-window .pm-outline', '#pm-chk-last');
            const notesOk = await wheelTo('#pm-window .pm-side', '#pm-window .pm-block-notes-save');
            const presetOk = await wheelTo('#pm-window .pm-side', '#pm-window .pm-preset-notes-save');
            const heights = await probe.eval(`(() => { const h = (s) => Math.round(document.querySelector(s).getBoundingClientRect().height); return { win: h('#pm-window'), outline: h('#pm-window .pm-outline'), side: h('#pm-window .pm-side'), outlineScroll: document.querySelector('#pm-window .pm-outline').scrollHeight }; })()`);
            report(name, outlineOk && notesOk && presetOk,
                `last row (${J(lastLeaf)}) visible=${outlineOk}, block notes save visible=${notesOk}, preset notes save visible=${presetOk}; heights ${J(heights)}`);
        } catch (err) {
            report(name, false, /** @type {Error} */ (err).message);
        }
    }

    // -------------------------------------------------------- editor-hold
    // Typing while a save is still pending must survive that save's
    // completion and the refresh that follows (review finding 3): the
    // plugin write is HELD in the page (fetch hook), the user types more,
    // then the hold is released.
    if (wanted('editor-hold')) {
        const name = 'editor-hold: typing during a pending save is not overwritten';
        const HOLD = `(() => {
            if (window.__pmRealFetch2) return true;
            const real = window.fetch.bind(window);
            window.__pmRealFetch2 = real;
            window.__pmHold2 = new Promise((r) => { window.__pmRelease2 = r; });
            window.fetch = (u, init) => {
                const url = String(u);
                const hold = (init?.method === 'POST' && /\\/presets\\/[^/]+\\/ops$/.test(url)) || (init?.method === 'PATCH' && /\\/meta$/.test(url));
                return hold ? window.__pmHold2.then(() => real(u, init)) : real(u, init);
            };
            return true; })()`;
        const UNHOLD = `(() => { window.__pmRelease2?.(); if (window.__pmRealFetch2) { window.fetch = window.__pmRealFetch2; window.__pmRealFetch2 = null; } return true; })()`;
        try {
            await until(converged, 10000, 'converged before editor-hold');
            await click(nameOf(mainId));
            await until(() => exists('#pm-window textarea.pm-block-notes'), 5000, 'editor shows Main Prompt');
            await probe.eval(HOLD);
            // block notes: save 'v1' (held), keep typing
            await setValue('#pm-window textarea.pm-block-notes', 'hold v1');
            await click('#pm-window .pm-block-notes-save');
            await setValue('#pm-window .pm-preset-notes', 'preset hold v1');
            await click('#pm-window .pm-preset-notes-save');
            await sleep(300);
            await setValue('#pm-window textarea.pm-block-notes', 'hold v2 typed while saving');
            await setValue('#pm-window .pm-preset-notes', 'preset v2 typed while saving');
            await probe.eval(UNHOLD);
            await until(async () => {
                const d = await getDoc();
                return d.blocks[mainId].notes === 'hold v1' && d.notes === 'preset hold v1';
            }, 8000, 'held saves stored');
            // let the save completions, the reconcile and the SSE-driven refresh run
            await sleep(2500);
            const ui = await probe.eval(`({ block: document.querySelector('#pm-window textarea.pm-block-notes').value, preset: document.querySelector('#pm-window .pm-preset-notes').value })`);
            const pass = ui.block === 'hold v2 typed while saving' && ui.preset === 'preset v2 typed while saving';
            report(name, pass, `doc has v1 for both; textareas after completion+refresh: block=${J(ui.block)} preset=${J(ui.preset)}`);
        } catch (err) {
            await probe.eval(UNHOLD).catch(() => {});
            report(name, false, /** @type {Error} */ (err).message);
        }
    }

    // --------------------------------------------------------------- keys
    if (wanted('keys')) {
        const name = 'keys: Alt+↓/Alt+↑ move, Tab/Shift+Tab promote/demote round-trip';
        try {
            await until(converged, 10000, 'converged before keys');
            const seq0 = J((await getDoc()).sequences);
            const orderIds = ids((await oai()).order);
            const [, p1, p2] = g.pov.options;
            const id1 = p1.ref;
            const id2 = p2.ref;
            const swapped = orderIds.map((id) => (id === id1 ? id2 : id === id2 ? id1 : id));
            await click(nameOf(id1));
            await until(() => exists(`#pm-window li.pm-node[data-key="${p1.key}"] > .pm-row.pm-selected`), 5000, 'row selected');
            await dismissPopups();
            await probe.eval(`document.querySelector('#pm-window .pm-outline').focus()`);
            await key('ArrowDown', 1);
            await until(async () => J(ids((await oai()).order)) === J(swapped), 5000, 'Alt+Down reached ST');
            await key('ArrowUp', 1);
            await until(async () => J(ids((await oai()).order)) === J(orderIds), 5000, 'Alt+Up reached ST');
            await key('Tab');
            await until(async () => {
                const d = await getDoc();
                const pov = d.sequences[0].rows.find((/** @type {any} */ r) => r.kind === 'group' && r.header?.key === g.pov.header.key);
                return pov && !pov.options.some((/** @type {any} */ o) => o.key === p1.key);
            }, 5000, 'Tab promoted the option out of POV');
            await key('Tab', 8);
            await until(async () => J((await getDoc()).sequences) === seq0, 5000, 'Shift+Tab restored the sequences');
            report(name, true, 'order swapped and restored in ST; promote/demote round-trip byte-identical sequences');
        } catch (err) {
            const ui = await probe.eval(`({ status: document.querySelector('#pm-window .pm-status')?.textContent ?? '', active: document.activeElement?.className ?? '', sel: document.querySelector('#pm-window .pm-row.pm-selected .pm-name')?.textContent ?? '' })`).catch(() => ({}));
            report(name, false, `${/** @type {Error} */ (err).message}; ui=${J(ui)}`);
        }
    }

    // ----------------------------------------------------------------- 14
    if (wanted('14')) {
        /**
         * Drag `li`'s own handle down past the sibling blocks `passSels`
         * (the pointer travels exactly their combined height — where the
         * handle sits after the move) and check ST's prompt_order against
         * `expected(beforeIds)`. The row is centred in the outline first so
         * neither end of the gesture is inside sortable's 20 px auto-scroll
         * band (a start at the very top edge scrolled the list mid-drag and
         * overshot a group drag by one block).
         * @param {string} name @param {string} liSel @param {string[]} passSels
         * @param {(before: string[]) => string[]} expected @param {string[]} moved
         */
        const dragCheck = async (name, liSel, passSels, expected, moved) => {
            try {
                const before = (await until(converged, 10000, `converged before ${name}`)).order;
                await dismissPopups();
                const want = expected(ids(before));
                const geo = await probe.eval(`(() => {
                    const li = document.querySelector(${J(liSel)});
                    li.scrollIntoView({ block: 'center' });
                    const h = li.querySelector(':scope > .pm-row > .pm-drag-handle').getBoundingClientRect();
                    const dy = ${J(passSels)}.reduce((s, sel) => s + document.querySelector(sel).getBoundingClientRect().height, 0);
                    return { from: { x: h.x + h.width / 2, y: h.y + h.height / 2 }, toY: h.y + h.height / 2 + dy };
                })()`);
                await mouseDrag(geo.from, { x: geo.from.x, y: geo.toY });
                let after = null;
                const ms = await timeUntil(async () => {
                    after = (await oai()).order;
                    return J(ids(after)) === J(want);
                }, 5000);
                if (ms === null) {
                    const got = ids(after ?? []);
                    const at = got.indexOf(moved[0]);
                    report(name, false, `order did not change as expected within 5 s; ${moved[0].slice(0, 8)}… at ${at} (want ${want.indexOf(moved[0])}); around: ${J(got.slice(Math.max(0, at - 2), at + 3).map((i) => i.slice(0, 8)))}`);
                    return;
                }
                const sameSet = J([...ids(before)].sort()) === J([...ids(after)].sort());
                const wasOn = new Map(before.map((/** @type {any} */ e) => [e.identifier, !!e.enabled]));
                const flipped = after.filter((/** @type {any} */ e) => wasOn.get(e.identifier) !== !!e.enabled).map((/** @type {any} */ e) => e.identifier);
                const sameEnabled = flipped.length === 0;
                report(name, sameSet && sameEnabled,
                    `${ms} ms; moved ${moved.length} id(s) ${ids(before).indexOf(moved[0])}→${ids(after).indexOf(moved[0])}; multiset=${sameSet ? 'same' : 'CHANGED'} enabled=${sameEnabled ? 'same' : `CHANGED ${J(flipped.map((i) => i.slice(0, 8)))}`}`);
            } catch (err) {
                report(name, false, /** @type {Error} */ (err).message);
            }
        };
        const node = (/** @type {string} */ attr, /** @type {string} */ v) => `#pm-window li.pm-node[${attr}="${v}"]`;
        const povIds = optIds(g.pov);
        await dragCheck('14 drag single row 2 down', node('data-key', tpKey), [node('data-node-key', g.prose.key), node('data-node-key', g.pov.key)], (b) => {
            const rest = b.filter((i) => i !== tpId);
            rest.splice(rest.indexOf(povIds.at(-1)) + 1, 0, tpId);
            return rest;
        }, [tpId]);
        const nsfwIds = [g.nsfw.header.ref, ...optIds(g.nsfw)];
        const echoIds = optIds(g.echo);
        await dragCheck('14 drag group header + options', node('data-node-key', g.nsfw.key), [node('data-node-key', g.echo.key)], (b) => {
            const rest = b.filter((i) => !nsfwIds.includes(i));
            rest.splice(rest.indexOf(echoIds.at(-1)) + 1, 0, ...nsfwIds);
            return rest;
        }, nsfwIds);
    }

    // ------------------------------------------------------ screenshots
    try {
        // a pick-one CONFLICT (Color: 2 on) with its ⚠ badge and radios,
        // one of its options selected, the side scrolled to the notes editor
        await api('POST', `/presets/${ffId}/ops`, { op: 'setCardinality', key: g.color.key, cardinality: 'pick-one' });
        await until(() => exists('#pm-window .pm-conflict'), 8000, 'conflict badge');
        await click(nameOf(optIds(g.color)[1]));
        await until(() => exists('#pm-window textarea.pm-block-notes'), 5000, 'editor shows the Color option');
        await setValue('#pm-window textarea.pm-block-notes', 'why this option: screenshot note');
        await click('#pm-window .pm-block-notes-save');
        await until(async () => (await getDoc()).blocks[optIds(g.color)[1]].notes === 'why this option: screenshot note', 5000, 'notes saved');
        await sleep(800);
        // scroll ONLY the inner panes (the loadout bar and tabs stay in frame)
        await probe.eval(`(() => { const o = document.querySelector('#pm-window .pm-outline'); const li = document.querySelector('#pm-window li.pm-node[data-node-key="${g.color.key}"]');
            o.scrollTop += li.getBoundingClientRect().top - o.getBoundingClientRect().top - 60;
            const s = document.querySelector('#pm-window .pm-side'); const b = document.querySelector('#pm-window .pm-block-save');
            s.scrollTop += b.getBoundingClientRect().top - s.getBoundingClientRect().top - 120;
            for (const el of document.querySelectorAll('#pm-window .pm-body, #pm-window .pm-pane, #pm-window .pm-preset-view')) el.scrollTop = 0; })()`);
        await dismissPopups();
        await sleep(500);
        const dir = path.join(REPO, 'dev', 'shots');
        fs.mkdirSync(dir, { recursive: true });
        const full = path.join(dir, 'phase2-presets-tab.png');
        const win = path.join(dir, 'phase2-window.png');
        fs.writeFileSync(full, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        const r = await probe.eval(`(() => { const b = document.querySelector('#pm-window').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
        fs.writeFileSync(win, Buffer.from((await probe.cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data, 'base64'));
        console.log(`[check] screenshots: ${full} ${win}`);
    } catch (err) {
        console.log(`[check] screenshots failed: ${/** @type {Error} */ (err).message}`);
    }

    // --------------------------------------------------------------- leak
    // (after the screenshots: it closes and reopens the window) Reopening
    // or closing the window releases every bridge listener the old window
    // owned (review finding 4; since Phase 4 the window owns several: the
    // Presets tab, each open preset's Model panel, the Settings tab and the
    // toolbar picker). Nothing outside the window subscribes, so a closed
    // window leaves 0, and a replaced window holds exactly what a fresh one
    // holds (a fresh window has no preset open, hence <= the first count).
    if (wanted('leak')) {
        const name = 'leak: close/reopen releases the window\'s listeners';
        try {
            const size = () => probe.eval('window.__pmStarted.bridge.listeners.size');
            // fix round 1: a window restores its saved open tabs (and the slot
            // preset) asynchronously after opening; read the listener count
            // only once that restore has settled (tab strip == saved ids and,
            // with any tab open, the active view built)
            const settled = () => until(() => probe.eval(`(() => {
                const saved = JSON.parse(localStorage.getItem('pm.presets.open') ?? '{"ids":[]}').ids ?? [];
                const shown = [...document.querySelectorAll('#pm-window .pm-preset-tab')].map((t) => t.dataset.presetId);
                return JSON.stringify(saved) === JSON.stringify(shown)
                    && (shown.length === 0 || !!document.querySelector('#pm-window .pm-preset-view'));
            })()`), 10000, 'window tab restore settled');
            const n0 = await size();
            for (let i = 0; i < 3; i++) await click('#pm-menu-item'); // replace ×3
            await settled();
            const nReplace = await size();
            await click('#pm-window .pm-close');
            const nClosed = await size();
            await click('#pm-menu-item');
            await settled();
            const nReopen = await size();
            report(name, n0 > 0 && nReplace > 0 && nReplace <= n0 && nClosed === 0 && nReopen === nReplace,
                `listeners open=${n0} after 3 replacements=${nReplace} closed=${nClosed} reopened=${nReopen}`);
        } catch (err) {
            report(name, false, /** @type {Error} */ (err).message);
        }
    }
}

main().catch((err) => {
    report('crashed', false, err?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(err));
    finish();
}).then(() => finish());
