/**
 * Preset Manager v2 — extension entry. ST loads this file as
 * <script type=module> (extensions.js:813-819).
 *
 * Phase 1 surface: a floating wand-menu entry + icon opening a minimal
 * window with a Library tab (list, tags, "load into slot", loadout select)
 * and — when the plugin is missing — only the install notice (acceptance 15).
 */
import { pluginHealth, api, ctx } from './ext/st.js';
import { Bridge } from './ext/bridge.js';
import { openWindow, renderLibrary } from './ext/window.js';

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
    registerMenu(() => {
        const w = openWindow({ title: 'Preset Manager', content: '<div class="pm-root"></div>' });
        renderLibrary(/** @type {HTMLElement} */ (w.body), bridge);
        void refreshLibrary(w.body, bridge);
    });

    win.__pmStarted = { stop: () => bridge.stop() };
}

/**
 * @param {HTMLElement} root
 * @param {Bridge} bridge
 */
async function refreshLibrary(root, bridge) {
    try {
        const items = await api('GET', '/library');
        const slot = await api('GET', '/slot');
        renderLibrary(root, bridge, { items, desired: slot.desired });
    } catch (err) {
        root.querySelector('.pm-library')?.replaceChildren(errorDiv(/** @type {Error} */ (err)));
    }
}

function errorDiv(/** @type {Error} */ err) {
    const div = document.createElement('div');
    div.className = 'pm-error';
    div.textContent = `Preset Manager: ${err.message}`;
    return div;
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
}

export async function init() {
    await start();
}

// ST loads the file as a module; run immediately (no exported init contract).
void init();
