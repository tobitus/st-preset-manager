/**
 * Settings tab (Phase 4, roadmap items 20/22): a Model registry editor
 * (matches, linked connection profiles, per-Model tuning, merge
 * suggestions) and a connection-profile list with unlink/backup/tidy.
 *
 * All profile mutation (unlink a preset, delete profiles) goes through
 * ext/connection.js, which edits ST's own live connectionManager profiles
 * array and lets ST save its own settings.json — this tab never asks the
 * plugin to write a profile. Adding/removing a Model, editing its matches,
 * profiles or tuning go through `bridge.edit(() => api('PUT', '/models',
 * next))` so the slot re-syncs and the SSE `models` event fans out to the
 * toolbar picker; renaming and merging Models are server-side transactions
 * (`POST /models/rename`, `POST /models/merge`) that migrate every document
 * reference, also run through `bridge.edit`.
 *
 * Re-render strategy: `render()` rebuilds the whole pane from `registry` +
 * `lastSlot` + the live ST connection state on every call — simplest given
 * how much of the pane depends on all three. Two bits of UI state must
 * survive a rebuild and are kept in closure state instead of the DOM: which
 * profiles are checked "keep" for tidy (`keepIds`), and which Model/tidy
 * remove buttons are mid-confirm (`armedModelRemove`, `tidyArmed`). The
 * status line is *always* set via `setStatus`, which writes directly to the
 * (possibly just-rebuilt) DOM node, so a render triggered between a write
 * and its status text never clobbers the message.
 */
import { api, currentRaw, connectionProfiles, slotPath } from '../st.js';
import { unlinkProfilePreset, deleteProfilesExcept, linksPreset } from '../connection.js';
import { suggestMerges } from '../../shared/models.js';

function escapeHtml(/** @type {string} */ s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[/** @type {any} */ (c)]);
}

/**
 * @param {HTMLElement} pane .pm-pane[data-pane="settings"]
 * @param {import('../bridge.js').Bridge} bridge
 * @returns {{ refresh(): Promise<void>, destroy(): void }}
 */
export function createSettingsTab(pane, bridge) {
    /** @type {any} last GET /models result */
    let registry = { version: 1, models: {} };
    /** @type {any} last GET /slot result */
    let lastSlot = null;
    /** @type {Set<string>} profile ids checked "keep" for tidy — survives re-render */
    const keepIds = new Set();
    /** @type {Map<string, any>} Model name -> armed-remove timeout id */
    const armedModelRemove = new Map();
    /** @type {Map<string, { picks: Map<string, boolean>, name: string }>} merge-group UI state, keyed by JSON.stringify(group names) — survives re-render so an unsaved pick/rename isn't lost to a background refresh */
    const mergeGroupState = new Map();
    /** @type {Map<string, { source: string, model: string }>} typed-but-unsaved match-id inputs, keyed by Model name — survives re-render */
    const matchInputState = new Map();
    /** typed-but-unsaved "new Model name" text — survives re-render */
    let newModelNameInput = '';
    let tidyArmed = false;
    /** @type {any} */
    let tidyTimer = null;
    /** @type {any} */
    let debounceTimer = null;
    let statusText = '';
    let statusIsError = false;

    /** @param {unknown} err @returns {string} */
    function errText(err) {
        return /** @type {any} */ (err)?.body?.error ?? (err instanceof Error ? err.message : String(err));
    }

    /** @param {string} text @param {boolean} [isError] */
    function setStatus(text, isError = false) {
        statusText = text;
        statusIsError = isError;
        const el = pane.querySelector('.pm-settings-status');
        if (el) {
            el.textContent = text;
            el.classList.toggle('pm-error', isError);
        }
    }

    /** @param {string} name */
    function uniqueId(name) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const existing = new Set(Object.values(registry.models ?? {}).map((/** @type {any} */ m) => m.id));
        let id = `m_${slug}`;
        let n = 2;
        while (existing.has(id)) {
            id = `m_${slug}-${n}`;
            n += 1;
        }
        return id;
    }

    /** PUT the whole registry through the bridge, refresh, then set `okText`. */
    async function writeRegistry(/** @type {any} */ next, /** @type {string} */ okText) {
        try {
            await bridge.edit(() => api('PUT', '/models', next));
            await refresh();
            setStatus(okText, false);
        } catch (err) {
            setStatus(errText(err), true);
        }
    }

    /** @param {string[]} names @returns {{ picks: Map<string, boolean>, name: string }} */
    function mergeGroupStateFor(names) {
        const key = JSON.stringify(names);
        let s = mergeGroupState.get(key);
        if (!s) {
            s = { picks: new Map(names.map((n) => [n, true])), name: names[0] };
            mergeGroupState.set(key, s);
        }
        return s;
    }

    /** @param {string[]} names */
    function mergeGroupHtml(names) {
        const state = mergeGroupStateFor(names);
        const checkboxes = names
            .map((n) => `<label><input type="checkbox" class="pm-merge-pick" value="${escapeHtml(n)}"${state.picks.get(n) !== false ? ' checked' : ''}> ${escapeHtml(n)}</label>`)
            .join('');
        return `
            <div class="pm-merge-group" data-names='${escapeHtml(JSON.stringify(names))}'>
                ${checkboxes}
                <input type="text" class="pm-merge-name text_pole" value="${escapeHtml(state.name)}">
                <button type="button" class="pm-merge-apply menu_button">Merge</button>
            </div>`;
    }

    /** @param {HTMLElement} groupEl @param {string[]} names */
    function wireMergeGroup(groupEl, names) {
        const state = mergeGroupStateFor(names);
        const nameInput = /** @type {HTMLInputElement} */ (groupEl.querySelector('.pm-merge-name'));
        nameInput.addEventListener('input', () => { state.name = nameInput.value; });
        for (const cb of Array.from(groupEl.querySelectorAll('.pm-merge-pick'))) {
            cb.addEventListener('change', () => {
                state.picks.set(/** @type {HTMLInputElement} */ (cb).value, /** @type {HTMLInputElement} */ (cb).checked);
            });
        }
        groupEl.querySelector('.pm-merge-apply')?.addEventListener('click', () => {
            const checked = Array.from(groupEl.querySelectorAll('.pm-merge-pick'))
                .filter((cb) => /** @type {HTMLInputElement} */ (cb).checked)
                .map((cb) => /** @type {HTMLInputElement} */ (cb).value);
            if (checked.length < 2) {
                setStatus('Select at least two Models to merge', true);
                return;
            }
            const newName = nameInput.value.trim();
            if (!newName) {
                setStatus('Enter a name for the merged Model', true);
                return;
            }
            mergeGroupState.delete(JSON.stringify(names));
            void (async () => {
                try {
                    const res = await bridge.edit(() => api('POST', '/models/merge', { names: checked, name: newName }));
                    await refresh();
                    setStatus(`Merged ${checked.length} Models into ${newName} (${res.migrated.length} preset(s) migrated)`, false);
                } catch (err) {
                    setStatus(errText(err), true);
                }
            })();
        });
    }

    /**
     * @param {string} name
     * @param {any} model
     * @param {any[]} profiles live connectionProfiles()
     */
    function modelRowHtml(name, model, profiles) {
        const matchesHtml = (model.matches ?? [])
            .map((/** @type {any} */ m, /** @type {number} */ i) =>
                `<span class="pm-model-match">${escapeHtml(m.source)} / ${escapeHtml(m.model)} <button type="button" class="pm-model-match-remove" data-index="${i}">×</button></span>`)
            .join('');
        const profilesHtml = (model.profiles ?? [])
            .map((/** @type {string} */ id) => {
                const p = profiles.find((/** @type {any} */ pp) => pp.id === id);
                const label = p ? p.name : `${id} (missing)`;
                return `<span class="pm-model-profile">${escapeHtml(label)} <button type="button" class="pm-model-profile-remove" data-id="${escapeHtml(id)}">×</button></span>`;
            })
            .join('');
        const pickOptionsHtml = profiles
            .filter((/** @type {any} */ p) => p.mode === 'cc')
            .map((/** @type {any} */ p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
            .join('');
        const preferredOptionsHtml = (model.profiles ?? [])
            .map((/** @type {string} */ id) => {
                const p = profiles.find((/** @type {any} */ pp) => pp.id === id);
                const label = p ? p.name : `${id} (missing)`;
                const sel = model.preferredProfile === id ? ' selected' : '';
                return `<option value="${escapeHtml(id)}"${sel}>${escapeHtml(label)}</option>`;
            })
            .join('');
        const tuningEntries = Object.entries(model.tuning ?? {});
        const tuningText = tuningEntries.length
            ? tuningEntries.map(([k, v]) => `${k} ${v}`).join(', ')
            : 'no global tuning';
        const armed = armedModelRemove.has(name);
        return `
            <div class="pm-model-row" data-model="${escapeHtml(name)}">
                <input type="text" class="pm-model-name text_pole" value="${escapeHtml(name)}" title="Renaming migrates every document reference to this Model (tuning overrides, loadout overrides) to the new name.">
                <div class="pm-model-matches">
                    ${matchesHtml}
                    <input type="text" class="pm-model-match-source" placeholder="source" value="${escapeHtml((matchInputState.get(name) ?? { source: 'custom', model: '' }).source)}">
                    <input type="text" class="pm-model-match-model" placeholder="model id" value="${escapeHtml((matchInputState.get(name) ?? { source: 'custom', model: '' }).model)}">
                    <button type="button" class="pm-model-match-add menu_button">Add id</button>
                </div>
                <div class="pm-model-profiles">
                    ${profilesHtml}
                    <select class="pm-model-profile-pick">${pickOptionsHtml}</select>
                    <button type="button" class="pm-model-profile-add menu_button">Add profile</button>
                </div>
                <label>Switch via <select class="pm-model-preferred">${preferredOptionsHtml}</select></label>
                <span class="pm-model-tuning">${escapeHtml(tuningText)}</span>
                <button type="button" class="pm-model-remove menu_button">${armed ? 'Confirm remove' : 'Remove'}</button>
            </div>`;
    }

    /** @param {HTMLElement} rowEl @param {string} name */
    function wireModelRow(rowEl, name) {
        const nameInput = /** @type {HTMLInputElement} */ (rowEl.querySelector('.pm-model-name'));
        nameInput.addEventListener('change', () => {
            const newName = nameInput.value.trim();
            if (!newName || newName === name) {
                nameInput.value = name;
                return;
            }
            if (registry.models[newName]) {
                setStatus(`"${newName}" already exists`, true);
                nameInput.value = name;
                return;
            }
            void (async () => {
                try {
                    const res = await bridge.edit(() => api('POST', '/models/rename', { from: name, to: newName }));
                    await refresh();
                    setStatus(`Renamed "${name}" to "${newName}" (${res.migrated.length} preset(s) migrated)`, false);
                } catch (err) {
                    setStatus(errText(err), true);
                    nameInput.value = name;
                }
            })();
        });

        for (const btn of Array.from(rowEl.querySelectorAll('.pm-model-match-remove'))) {
            btn.addEventListener('click', () => {
                const idx = Number(/** @type {HTMLElement} */ (btn).dataset.index);
                const next = structuredClone(registry);
                next.models[name].matches.splice(idx, 1);
                void writeRegistry(next, `Removed match from "${name}"`);
            });
        }
        const matchSource = /** @type {HTMLInputElement} */ (rowEl.querySelector('.pm-model-match-source'));
        const matchModel = /** @type {HTMLInputElement} */ (rowEl.querySelector('.pm-model-match-model'));
        const matchState = () => matchInputState.get(name) ?? (() => {
            const s = { source: 'custom', model: '' };
            matchInputState.set(name, s);
            return s;
        })();
        matchSource.addEventListener('input', () => { matchState().source = matchSource.value; });
        matchModel.addEventListener('input', () => { matchState().model = matchModel.value; });
        rowEl.querySelector('.pm-model-match-add')?.addEventListener('click', () => {
            const source = matchSource.value.trim() || 'custom';
            const model = matchModel.value.trim();
            if (!model) {
                setStatus('Enter a model id to match', true);
                return;
            }
            const next = structuredClone(registry);
            (next.models[name].matches ??= []).push({ source, model });
            matchInputState.delete(name);
            void writeRegistry(next, `Added match to "${name}"`);
        });

        for (const btn of Array.from(rowEl.querySelectorAll('.pm-model-profile-remove'))) {
            btn.addEventListener('click', () => {
                const id = /** @type {HTMLElement} */ (btn).dataset.id;
                const next = structuredClone(registry);
                const m = next.models[name];
                m.profiles = (m.profiles ?? []).filter((/** @type {string} */ p) => p !== id);
                if (m.preferredProfile === id) m.preferredProfile = null;
                void writeRegistry(next, `Removed profile from "${name}"`);
            });
        }
        const profilePick = /** @type {HTMLSelectElement} */ (rowEl.querySelector('.pm-model-profile-pick'));
        rowEl.querySelector('.pm-model-profile-add')?.addEventListener('click', () => {
            const id = profilePick.value;
            if (!id) return;
            const next = structuredClone(registry);
            const m = next.models[name];
            m.profiles ??= [];
            if (!m.profiles.includes(id)) m.profiles.push(id);
            void writeRegistry(next, `Added profile to "${name}"`);
        });

        const preferredSelect = /** @type {HTMLSelectElement} */ (rowEl.querySelector('.pm-model-preferred'));
        preferredSelect.addEventListener('change', () => {
            const next = structuredClone(registry);
            next.models[name].preferredProfile = preferredSelect.value || null;
            void writeRegistry(next, `Set preferred profile for "${name}"`);
        });

        const removeBtn = /** @type {HTMLButtonElement} */ (rowEl.querySelector('.pm-model-remove'));
        removeBtn.addEventListener('click', () => {
            if (armedModelRemove.has(name)) {
                clearTimeout(armedModelRemove.get(name));
                armedModelRemove.delete(name);
                const next = structuredClone(registry);
                delete next.models[name];
                render();
                void writeRegistry(next, `Removed Model "${name}"`);
                return;
            }
            const t = setTimeout(() => {
                armedModelRemove.delete(name);
                render();
            }, 4000);
            armedModelRemove.set(name, t);
            render();
        });
    }

    /** @param {any} profile */
    function profileRowHtml(profile) {
        const linked = linksPreset(profile);
        const keep = keepIds.has(profile.id);
        return `
            <div class="pm-profile-row" data-profile-id="${escapeHtml(profile.id)}">
                <input type="checkbox" class="pm-profile-keep"${keep ? ' checked' : ''}>
                <span class="pm-profile-name">${escapeHtml(profile.name)}</span>
                <span class="pm-profile-conn">${escapeHtml(profile.api)} / ${escapeHtml(profile.model)}</span>
                ${linked ? `<span class="pm-profile-links">links preset: ${escapeHtml(profile.preset)}</span><button type="button" class="pm-profile-unlink menu_button">Unlink</button>` : ''}
            </div>`;
    }

    /** @param {HTMLElement} rowEl @param {any} profile */
    function wireProfileRow(rowEl, profile) {
        const keepBox = /** @type {HTMLInputElement} */ (rowEl.querySelector('.pm-profile-keep'));
        keepBox.addEventListener('change', () => {
            if (keepBox.checked) keepIds.add(profile.id);
            else keepIds.delete(profile.id);
        });
        rowEl.querySelector('.pm-profile-unlink')?.addEventListener('click', () => {
            unlinkProfilePreset(profile);
            render();
        });
    }

    function render() {
        const raw = currentRaw();
        const profiles = connectionProfiles();
        const modelId = lastSlot?.desired?.modelId ?? null;
        const currentProfile = raw.profileId ? profiles.find((/** @type {any} */ p) => p.id === raw.profileId) : null;
        const modelNames = Object.keys(registry.models ?? {});
        const suggestions = suggestMerges(registry);
        const linkedCount = profiles.filter((/** @type {any} */ p) => linksPreset(p)).length;
        const toDelete = profiles.filter((/** @type {any} */ p) => !keepIds.has(p.id)).length;

        pane.innerHTML = `
            <div class="pm-settings">
                <div class="pm-settings-current">
                    Current connection: ${escapeHtml(raw.source)} / ${escapeHtml(raw.model)} (profile ${escapeHtml(currentProfile ? currentProfile.name : 'none')}) → Model: ${escapeHtml(modelId ?? 'none')}
                    ${modelId === null ? '<button type="button" class="pm-add-current-model menu_button">Add as new Model</button>' : ''}
                </div>
                <section class="pm-models">
                    <h4>Models</h4>
                    <div class="pm-models-toolbar">
                        <button type="button" class="pm-models-seed menu_button">Seed from profiles</button>
                        <input type="text" class="pm-model-new-name text_pole" placeholder="new Model name" value="${escapeHtml(newModelNameInput)}">
                        <button type="button" class="pm-model-add menu_button">Add Model</button>
                    </div>
                    <div class="pm-merge-suggestions">
                        ${suggestions.length ? '<h5>Merge suggestions</h5>' : ''}
                        ${suggestions.map((/** @type {string[]} */ g) => mergeGroupHtml(g)).join('')}
                    </div>
                    <div class="pm-model-list">
                        ${modelNames.map((n) => modelRowHtml(n, registry.models[n], profiles)).join('')}
                    </div>
                </section>
                <section class="pm-profiles">
                    <h4>Connection profiles</h4>
                    <div class="pm-profiles-toolbar">
                        <button type="button" class="pm-profiles-backup menu_button">Backup profiles</button>
                        <button type="button" class="pm-profiles-unlink-all menu_button">Unlink all presets</button>
                        <button type="button" class="pm-profiles-tidy menu_button">${tidyArmed ? `Confirm: delete ${toDelete} profile(s)` : 'Keep selected, delete the rest'}</button>
                    </div>
                    <div class="pm-profiles-summary">${profiles.length} profiles, ${linkedCount} link a preset</div>
                    <div class="pm-profile-list">
                        ${profiles.map((/** @type {any} */ p) => profileRowHtml(p)).join('')}
                    </div>
                </section>
                <div class="pm-settings-status${statusIsError ? ' pm-error' : ''}">${escapeHtml(statusText)}</div>
            </div>`;

        pane.querySelector('.pm-add-current-model')?.addEventListener('click', () => {
            const c = currentRaw();
            const newName = c.model;
            if (!newName) return;
            if (registry.models[newName]) {
                setStatus(`"${newName}" already exists`, true);
                return;
            }
            const next = structuredClone(registry);
            next.models[newName] = {
                id: uniqueId(newName),
                name: newName,
                matches: [{ source: c.source, model: c.model }],
                profiles: c.profileId ? [c.profileId] : [],
                preferredProfile: c.profileId ?? null,
                tuning: {},
            };
            void writeRegistry(next, `Added Model "${newName}"`);
        });

        pane.querySelector('.pm-models-seed')?.addEventListener('click', () => {
            void (async () => {
                try {
                    const res = await bridge.edit(() => api('POST', '/models/seed', { profiles: connectionProfiles() }));
                    await refresh();
                    setStatus(`Seeded ${res.added.length} new Model(s)`, false);
                } catch (err) {
                    setStatus(errText(err), true);
                }
            })();
        });

        const newNameInput = /** @type {HTMLInputElement} */ (pane.querySelector('.pm-model-new-name'));
        newNameInput?.addEventListener('input', () => { newModelNameInput = newNameInput.value; });
        pane.querySelector('.pm-model-add')?.addEventListener('click', () => {
            const newName = newNameInput.value.trim();
            if (!newName) {
                setStatus('Enter a Model name', true);
                return;
            }
            if (registry.models[newName]) {
                setStatus(`"${newName}" already exists`, true);
                return;
            }
            const next = structuredClone(registry);
            next.models[newName] = { id: uniqueId(newName), name: newName, matches: [], profiles: [], preferredProfile: null, tuning: {} };
            newModelNameInput = '';
            void writeRegistry(next, `Added Model "${newName}"`);
        });

        const groupEls = Array.from(pane.querySelectorAll('.pm-merge-group'));
        groupEls.forEach((groupEl, i) => wireMergeGroup(/** @type {HTMLElement} */ (groupEl), suggestions[i]));

        const rowEls = Array.from(pane.querySelectorAll('.pm-model-row'));
        rowEls.forEach((rowEl, i) => wireModelRow(/** @type {HTMLElement} */ (rowEl), modelNames[i]));

        pane.querySelector('.pm-profiles-backup')?.addEventListener('click', () => {
            void (async () => {
                try {
                    const r = await api('POST', '/profiles/backup', { profiles: connectionProfiles() });
                    setStatus(`Backup written: ${r.file} (${r.count} profiles)`, false);
                } catch (err) {
                    setStatus(errText(err), true);
                }
            })();
        });

        pane.querySelector('.pm-profiles-unlink-all')?.addEventListener('click', () => {
            void (async () => {
                const linked = connectionProfiles().filter((/** @type {any} */ p) => linksPreset(p));
                for (const p of linked) await unlinkProfilePreset(p);
                setStatus(`Unlinked ${linked.length} profile(s)`, false);
                render();
            })();
        });

        const tidyBtn = /** @type {HTMLButtonElement} */ (pane.querySelector('.pm-profiles-tidy'));
        tidyBtn?.addEventListener('click', () => {
            if (keepIds.size === 0) {
                setStatus('Select the profiles to keep first', true);
                return;
            }
            if (!tidyArmed) {
                tidyArmed = true;
                if (tidyTimer) clearTimeout(tidyTimer);
                tidyTimer = setTimeout(() => {
                    tidyArmed = false;
                    render();
                }, 5000);
                render();
                return;
            }
            clearTimeout(tidyTimer);
            tidyArmed = false;
            void (async () => {
                const profiles = structuredClone(connectionProfiles());
                const activeId = currentRaw().profileId;
                if (activeId && !keepIds.has(activeId)) {
                    const active = profiles.find((/** @type {any} */ p) => p.id === activeId);
                    setStatus(`Keep the active profile “${active ? active.name : activeId}” or switch away first. Nothing deleted.`, true);
                    return;
                }
                /** @type {any} */
                let r;
                try {
                    r = await api('POST', '/profiles/backup', { profiles });
                } catch (err) {
                    setStatus(`Backup failed, nothing deleted: ${errText(err)}`, true);
                    render();
                    return;
                }
                const kept = keepIds.size;
                try {
                    const deleted = await deleteProfilesExcept([...keepIds], profiles);
                    keepIds.clear();
                    setStatus(`Backup: ${r.file}. Deleted ${deleted.length}, kept ${kept}.`, false);
                    await refresh();
                } catch (err) {
                    setStatus(errText(err), true);
                    await refresh();
                }
            })();
        });

        const profileRowEls = Array.from(pane.querySelectorAll('.pm-profile-row'));
        profileRowEls.forEach((rowEl, i) => wireProfileRow(/** @type {HTMLElement} */ (rowEl), profiles[i]));
    }

    async function refresh() {
        try {
            const [reg, slot] = await Promise.all([api('GET', '/models'), api('GET', slotPath())]);
            registry = reg;
            lastSlot = slot;
            render();
        } catch (err) {
            setStatus(errText(err), true);
        }
    }

    const unsubscribe = bridge.onUpdate((/** @type {any} */ s) => {
        if (!pane.isConnected) return;
        if (s.model || s.event?.kind === 'models') {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                void refresh();
            }, 150);
        }
    });

    return {
        refresh,
        destroy() {
            unsubscribe();
            if (debounceTimer) clearTimeout(debounceTimer);
            if (tidyTimer) clearTimeout(tidyTimer);
            for (const t of armedModelRemove.values()) clearTimeout(t);
            armedModelRemove.clear();
        },
    };
}
