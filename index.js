/**
 * Preset Manager v2 — extension entry. ST loads this file as
 * <script type=module> (extensions.js:813-819).
 *
 * Surface: a wand-menu entry (#pm-menu-item) plus a draggable floating
 * button (#pm-float-btn, position remembered in localStorage
 * pm.floatBtn.pos) that both open the main window (Library tab, Presets
 * tab) and — when the plugin is missing — the install notice instead
 * (acceptance 15).
 */
import { pluginHealth, ctx } from './ext/st.js';
import { Bridge } from './ext/bridge.js';
import { installConnectionHooks } from './ext/connection.js';
import { openWindow, openMainWindow } from './ext/window.js';
import { clampPoint } from './ext/layout.js';

const NOTICE_HTML = `
<div class="pm-install-notice" style="padding:16px;max-width:420px;line-height:1.5">
    <h3 style="margin-top:0">Preset Manager: server plugin not found</h3>
    <p>The UI extension is loaded, but the required server plugin
    <code>st-preset-manager</code> is not running on this SillyTavern
    instance, so there is no preset library to talk to.</p>
    <p>To install: copy this repository into <code>plugins/st-preset-manager</code>
    (it is the same folder as this extension — ST mounts the repo at both
    paths) and make sure <code>enableServerPlugins: true</code> is set in
    config.yaml, then restart SillyTavern.</p>
</div>`;

/** Module-level singleton so double init (dev hot reload) does not stack. */
const win = /** @type {any} */ (globalThis);
if (win.__pmStarted) {
    win.__pmStarted.stop?.();
}

async function start() {
    const bridge = new Bridge();
    const healthy = await pluginHealth();
    if (!healthy) {
        // acceptance 15: with the plugin absent show ONLY the install notice;
        // nothing else initialises (no bridge, no panel hooks).
        registerMenu(() => openWindow({ title: 'Preset Manager', content: NOTICE_HTML }));
        win.__pmStarted = { stop() {} };
        return;
    }

    await bridge.start();
    installConnectionHooks(bridge);
    registerMenu(() => openMainWindow(bridge));

    win.__pmStarted = { bridge, stop: () => bridge.stop() };
}

function registerMenu(/** @type {() => void} */ open) {
    const c = ctx();
    // wand menu entry
    const menu = document.querySelector('#extensionsMenu');
    if (menu) {
        const item = document.createElement('div');
        item.id = 'pm-menu-item';
        item.className = 'list-group-item flex-container flexAlCenter interactable';
        item.title = 'Preset Manager';
        item.innerHTML = '<i class="fa-solid fa-folder-tree"></i><span>Preset Manager</span>';
        item.addEventListener('click', open);
        menu.appendChild(item);
    }

    // floating draggable button (fix round 1, item 10)
    document.querySelector('#pm-float-btn')?.remove();
    const btn = document.createElement('div');
    btn.id = 'pm-float-btn';
    btn.title = 'Preset Manager';
    btn.setAttribute('role', 'button');
    btn.innerHTML = '<i class="fa-solid fa-folder-tree"></i>';
    document.body.appendChild(btn);

    const SIZE = { width: 40, height: 40 };
    /** @returns {{ width: number, height: number }} */
    const viewportNow = () => ({ width: window.innerWidth, height: window.innerHeight });

    /** @type {{ left: number, top: number }|null} */
    let saved = null;
    try {
        saved = JSON.parse(/** @type {string} */ (localStorage.getItem('pm.floatBtn.pos')));
    } catch {
        saved = null;
    }
    const fallback = { left: window.innerWidth - 40 - 16, top: window.innerHeight - 40 - 140 };
    let pos = clampPoint(saved, SIZE, viewportNow()) ?? clampPoint(fallback, SIZE, viewportNow());
    if (pos) {
        btn.style.left = `${pos.left}px`;
        btn.style.top = `${pos.top}px`;
    }

    let dragging = false;
    let suppressClick = false;
    let pressed = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    btn.addEventListener('pointerdown', (/** @type {PointerEvent} */ ev) => {
        if (ev.button !== 0) return;
        pressed = true;
        dragging = false;
        startX = ev.clientX;
        startY = ev.clientY;
        startLeft = pos.left;
        startTop = pos.top;
        try {
            btn.setPointerCapture(ev.pointerId);
        } catch {
            // ignore
        }
    });

    btn.addEventListener('pointermove', (/** @type {PointerEvent} */ ev) => {
        if (!pressed) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) > 4) {
            dragging = true;
            btn.classList.add('pm-dragging');
        }
        if (dragging) {
            const next = clampPoint({ left: startLeft + dx, top: startTop + dy }, SIZE, viewportNow());
            if (next) {
                pos = next;
                btn.style.left = `${pos.left}px`;
                btn.style.top = `${pos.top}px`;
            }
        }
    });

    const endPress = () => {
        if (dragging) {
            try {
                localStorage.setItem('pm.floatBtn.pos', JSON.stringify({ left: pos.left, top: pos.top }));
            } catch {
                // ignore
            }
            btn.classList.remove('pm-dragging');
            // swallow the click that follows this drag's pointerup, and only
            // that one: a pointercancel (no click) must not eat the next click
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 0);
        }
        pressed = false;
        dragging = false;
    };
    btn.addEventListener('pointerup', endPress);
    btn.addEventListener('pointercancel', endPress);

    btn.addEventListener('click', () => {
        if (suppressClick) {
            suppressClick = false;
            return;
        }
        open();
    });

    window.addEventListener('resize', () => {
        const next = clampPoint(pos, SIZE, viewportNow());
        if (next) {
            pos = next;
            btn.style.left = `${pos.left}px`;
            btn.style.top = `${pos.top}px`;
        }
    });
}

export async function init() {
    await start();
}

// ST loads the file as a module in the BROWSER only. Guard against the
// plugin-loader's package.json-main fallback ever executing this file inside
// the Node server (that must crash loudly, not touch the DOM — PLAN risk 3):
if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error(
        'st-preset-manager/index.js is the BROWSER extension entry. The server '
        + 'plugin must load plugin/index.js (package.json main). Do not import '
        + 'the repo root from Node.',
    );
}

// ST loads the file as a module. At module-evaluation time script.js has not
// finished booting (getSettings() runs after extensions are discovered), so
// wait for SETTINGS_LOADED before reconciling: the prompt manager exists, the
// preset select is filled and settings saves from the panel will flow.
// (Found by Phase 1 check 5: an init that ran early left panel write-back dead
// because saveServiceSettings/SETTINGS_UPDATED only exist post-boot.)
// ST exposes `eventTypes` on the CONTEXT, not on eventSource (the eventSource
// is a bare EventEmitter; testing the wrong spot always took the immediate
// branch and reintroduced the pre-boot init).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const c0 = ctx();
    if (c0.eventTypes?.SETTINGS_LOADED) {
        void c0.eventSource.once(c0.eventTypes.SETTINGS_LOADED, () => { void init(); });
    } else {
        void init();
    }
}
