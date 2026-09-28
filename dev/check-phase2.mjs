#!/usr/bin/env node
/**
 * Phase 2 acceptance (PLAN Phase 2 checks 1–3 = roadmap acceptance 6, 9, 14)
 * as one repeatable real-browser script. It drives the ACTUAL extension UI in
 * a headless Chromium over raw CDP (clicks, real mouse drags on the jQuery UI
 * sortable handle, CDP key events) and observes SillyTavern itself (live
 * `oai` settings, ST's own prompt-manager DOM) — never only the REST API.
 *
 *   node dev/check-phase2.mjs              all checks
 *   node dev/check-phase2.mjs 6 9          subset (live, 6, 9, editor, keys, 14)
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

    // ------------------------------------------------------------------ 6
    if (wanted('6')) {
        try {
            const A = (await getDoc()).activeLoadoutId;
            const snapA = J((await until(converged, 10000, 'converged before 6')).order);
            await setValue('#pm-window .pm-loadout-picker', A, 'change');
            await setValue('#pm-window .pm-loadout-name', 'B');
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
            const before = (await stDom()).filter((r) => povIds.includes(r.identifier) && r.enabled).map((r) => r.identifier);
            await until(() => clickStToggle(target), 5000, 'ST toggle clickable');
            const t0 = Date.now();
            let onList = [];
            const ms = await timeUntil(async () => {
                const pov = (await stDom()).filter((r) => povIds.includes(r.identifier));
                onList = pov.filter((r) => r.enabled).map((r) => r.identifier);
                // all four rows rendered (a mid-render list must not count)
                return pov.length === povIds.length && onList.length === 1 && onList[0] === target;
            }, 5000);
            report('9 pick-one collapse in ST panel', ms !== null && ms <= 2000,
                `${ms ?? `>${Date.now() - t0}`} ms, POV on before=${before.length} after=${J(onList.map((i) => povIds.indexOf(i)))} (target=option 0)`);
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
        await click(nameOf(optIds(g.pov)[0]));
        await api('POST', `/presets/${ffId}/ops`, { op: 'setCardinality', key: g.color.key, cardinality: 'pick-one' });
        await until(() => exists('#pm-window .pm-conflict'), 8000, 'conflict badge');
        await probe.eval(`document.querySelector('#pm-window li.pm-node[data-node-key="${g.pov.key}"]').scrollIntoView({ block: 'start' })`);
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
}

main().catch((err) => {
    report('crashed', false, err?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(err));
    finish();
}).then(() => finish());
