/**
 * Connection-manager glue (PLAN §1.4/roadmap 19): switching to a Model via
 * its connection profile, keeping presets off profiles (presets never hold
 * the connection — only a loadout does), and re-rendering ST's own profile
 * `<select>` after we delete profiles out from under it.
 *
 * The "profile guard": ST connection profiles MAY themselves link a preset
 * (`profile.preset` set and not excluded). If the user still has such a
 * profile selected, loading it moves ST off the v2 working slot the moment
 * CONNECTION_PROFILE_LOADED fires. installConnectionHooks reports the new
 * raw connection id to the bridge either way, then — only when the loaded
 * profile links a preset — shows a small dialog offering to unlink it (so
 * future loads stay on the slot) or just re-attach this once.
 */
import { ctx, connectionProfiles } from './st.js';

function escapeHtml(/** @type {string} */ s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[/** @type {any} */ (c)]);
}

/**
 * Does this ST connection profile also link (load) a preset?
 * @param {any} profile
 * @returns {boolean}
 */
export function linksPreset(profile) {
    return !!profile?.preset && !(profile.exclude ?? []).includes('preset');
}

/** @param {string} name @returns {string} slash-command argument for `name` */
function slashArg(name) {
    return /^[^|"{}\\]+$/.test(name) ? name : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Switch ST's active connection to `model`'s preferred (or first available)
 * connection profile. Never touches the preset or loadout.
 * @param {any} model registry entry (Model, has .name/.preferredProfile/.profiles)
 * @returns {Promise<string>} the connection profile name switched to
 */
export async function switchToModel(model) {
    const profiles = connectionProfiles();
    const candidateIds = [model.preferredProfile, ...(model.profiles ?? [])].filter((id) => id != null);
    const profile = candidateIds.map((id) => profiles.find((p) => p.id === id)).find((p) => p);
    if (!profile) throw new Error(`Model "${model.name}" has no connection profile in this SillyTavern`);
    await ctx().executeSlashCommandsWithOptions('/profile ' + slashArg(profile.name));
    if (ctx().extensionSettings?.connectionManager?.selectedProfile !== profile.id) {
        throw new Error('SillyTavern did not switch to profile "' + profile.name + '"');
    }
    return profile.name;
}

/**
 * Unlink a connection profile from the preset it loads, mutating the LIVE
 * profile object (the tab owns settings.json — F-052).
 * @param {any} profile
 */
export function unlinkProfilePreset(profile) {
    if (!Array.isArray(profile.exclude)) profile.exclude = [];
    if (!profile.exclude.includes('preset')) profile.exclude.push('preset');
    delete profile.preset;
    ctx().saveSettingsDebounced();
}

/**
 * Rebuild ST's `#connection_profiles` select exactly as ST's own renderer
 * does (connection-manager/index.js:440), without reordering the live
 * profiles array. No-op if the select is not mounted.
 */
export function rerenderProfileSelect() {
    const select = /** @type {any} */ (document).querySelector('#connection_profiles');
    if (!select) return;
    const selectedProfile = ctx().extensionSettings?.connectionManager?.selectedProfile;
    const sorted = [...connectionProfiles()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    select.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '<None>';
    none.selected = !selectedProfile;
    select.appendChild(none);
    for (const profile of sorted) {
        const opt = document.createElement('option');
        opt.value = profile.id;
        opt.textContent = profile.name;
        opt.selected = profile.id === selectedProfile;
        select.appendChild(opt);
    }
}

/**
 * Delete every connection profile NOT in `keepIds`, in place (preserving
 * order of the survivors), clear `selectedProfile` if it was deleted,
 * re-render the select and notify ST of each deletion.
 * @param {string[]} keepIds
 * @returns {Promise<any[]>} the deleted profile objects
 */
export async function deleteProfilesExcept(keepIds) {
    const keep = new Set(keepIds);
    if (keep.size === 0) throw new Error('deleteProfilesExcept: keepIds must not be empty');
    const profiles = connectionProfiles();
    const deleted = profiles.filter((p) => !keep.has(p.id));
    const survivors = profiles.filter((p) => keep.has(p.id));
    profiles.length = 0;
    profiles.push(...survivors);
    const cm = ctx().extensionSettings?.connectionManager;
    if (cm && deleted.some((p) => p.id === cm.selectedProfile)) cm.selectedProfile = null;
    ctx().saveSettingsDebounced();
    rerenderProfileSelect();
    const c = ctx();
    if (c.eventTypes?.CONNECTION_PROFILE_DELETED) {
        for (const profile of deleted) {
            await c.eventSource.emit(c.eventTypes.CONNECTION_PROFILE_DELETED, profile);
        }
    }
    return deleted;
}

/** Remove any existing guard dialog. */
function closeGuardDialog() {
    document.querySelector('#pm-guard-dialog')?.remove();
}

/**
 * Show the profile-guard dialog: `profile` linked `preset` and just moved
 * ST off the working slot.
 * @param {any} bridge
 * @param {any} profile
 * @param {string} presetName
 */
function showGuardDialog(bridge, profile, presetName) {
    closeGuardDialog();
    const dialog = document.createElement('div');
    dialog.id = 'pm-guard-dialog';
    dialog.className = 'pm-guard';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.dataset.profileId = profile.id;
    dialog.style.cssText = 'position:fixed; top:20%; left:50%; transform:translateX(-50%); z-index:10050; '
        + 'max-width:520px; padding:16px; background:var(--SmartThemeBlurTintColor, #222); '
        + 'color:var(--SmartThemeBodyColor, #ddd); border:1px solid var(--SmartThemeBorderColor, #555); '
        + 'border-radius:8px; box-shadow:0 4px 24px rgba(0,0,0,.5)';
    dialog.innerHTML = `
        <h4 style="margin-top:0">Preset Manager: profile guard</h4>
        <p class="pm-guard-text">Connection profile “<b class="pm-guard-profile">${escapeHtml(profile.name)}</b>” also
        loads the preset “<b class="pm-guard-preset">${escapeHtml(presetName)}</b>”, which moved SillyTavern off the
        working slot. Profiles should hold the connection only.</p>
        <div class="pm-guard-buttons" style="display:flex; gap:8px; justify-content:flex-end">
            <div class="menu_button pm-guard-unlink">Unlink the preset from this profile</div>
            <div class="menu_button pm-guard-reattach">Re-attach only</div>
            <div class="menu_button pm-guard-close">Close</div>
        </div>`;
    dialog.querySelector('.pm-guard-unlink')?.addEventListener('click', () => {
        unlinkProfilePreset(profile);
        closeGuardDialog();
        void bridge.reattach().catch((/** @type {any} */ err) => console.error('[preset-manager] reattach failed', err));
    });
    dialog.querySelector('.pm-guard-reattach')?.addEventListener('click', () => {
        closeGuardDialog();
        void bridge.reattach().catch((/** @type {any} */ err) => console.error('[preset-manager] reattach failed', err));
    });
    dialog.querySelector('.pm-guard-close')?.addEventListener('click', () => {
        closeGuardDialog();
    });
    document.body.appendChild(dialog);
}

/**
 * Wire the connection-manager hooks: force "bind preset to connection" off
 * once (presets never hold the connection in v2), report every model /
 * profile change to the bridge, and show the profile guard when a loaded
 * profile links a preset.
 * @param {any} bridge
 */
export function installConnectionHooks(bridge) {
    const c = ctx();
    if (c.chatCompletionSettings.bind_preset_to_connection) {
        c.chatCompletionSettings.bind_preset_to_connection = false;
        const checkbox = /** @type {any} */ (document).querySelector('#bind_preset_to_connection');
        if (checkbox) checkbox.checked = false;
        c.saveSettingsDebounced();
        /** @type {any} */ (globalThis).toastr?.info(
            'Preset Manager turned off "Bind preset to connection": presets never carry the connection; '
            + 'pick the connection with a profile (or v2\'s Model picker) and the preset in v2.',
            'Preset Manager',
            { timeOut: 10000 },
        );
    }

    const reportModel = () => {
        void bridge.enqueueModelReport().catch((/** @type {any} */ err) => console.error('[preset-manager] model report failed', err));
    };

    c.eventSource.on(c.eventTypes.CHATCOMPLETION_MODEL_CHANGED, reportModel);

    c.eventSource.on(c.eventTypes.CONNECTION_PROFILE_LOADED, (/** @type {string} */ name) => {
        reportModel();
        const selectedProfile = ctx().extensionSettings?.connectionManager?.selectedProfile;
        const candidates = connectionProfiles().filter((p) => p.name === name);
        const profile = candidates.find((p) => p.id === selectedProfile) ?? candidates[0];
        if (profile && linksPreset(profile)) {
            showGuardDialog(bridge, profile, String(profile.preset));
        }
    });

    reportModel();
}
