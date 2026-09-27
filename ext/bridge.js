/**
 * Live bridge (PLAN §1.4): SSE push + tab reconciliation + panel write-back.
 *
 * On extension init: GET /slot -> if desired.presetId is set the tab ALWAYS
 * applies `compiled` (acceptance 4: API state beats settings.json), then
 * opens the SSE stream. Echo suppression: events whose origin === clientId
 * and whose rev <= appliedRev are ignored. Panel edits: on SETTINGS_UPDATED
 * while the slot is selected, snapshot -> POST /slot/panel -> re-apply iff
 * the plugin's collapsed hash differs from the snapshot's.
 */
import { api, ctx, clientId, applyCompiledToSlot, snapshotPanel, currentPresetName, SLOT_NAME, PLUGIN_BASE } from './st.js';

export class Bridge {
    constructor() {
        this.appliedHash = null;
        this.appliedRev = 0;
        this.attached = false;
        this.es = null;
        /** @type {Set<(state: any) => void>} */
        this.listeners = new Set();
        this.reconciling = false;
        this.lastPanelPost = Promise.resolve();
    }

    /** @param {(state: any) => void} fn */
    onUpdate(fn) {
        this.listeners.add(fn);
    }

    /** @param {any} state */
    emit(state) {
        for (const fn of this.listeners) {
            try { fn(state); } catch { /* listener error */ }
        }
    }

    /** Extension init: reconcile then stream. */
    async start() {
        await this.reconcile();
        this.openStream();
        this.watchPanel();
    }

    /** GET /slot and apply desired if one is set (acceptance 4). */
    async reconcile() {
        const slot = await api('GET', '/slot');
        if (slot.desired?.presetId && slot.compiled) {
            await this.apply(slot);
        } else {
            this.attached = currentPresetName() === SLOT_NAME;
        }
        this.emit({ slot, attached: this.attached });
        return slot;
    }

    /**
     * Apply a slot view into ST. Returns true when the page state changed.
     * @param {{ compiled: any, hash: string, rev: number }} slot
     */
    async apply(slot) {
        if (this.reconciling) return false;
        this.reconciling = true;
        try {
            const before = snapshotPanel();
            await applyCompiledToSlot(slot.compiled);
            this.appliedHash = slot.hash;
            this.appliedRev = slot.rev;
            this.attached = true;
            const after = snapshotPanel();
            // If ST normalised something (it does for a few keys), report the
            // normalisation to the plugin once via the panel path, but do not
            // loop: the plugin stores what ST reports.
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                await this.postPanel(true);
            }
            return true;
        } finally {
            this.reconciling = false;
        }
    }

    openStream() {
        if (this.es) this.es.close();
        const url = `${PLUGIN_BASE}/events?clientId=${encodeURIComponent(clientId())}`;
        const es = new EventSource(url, { withCredentials: true });
        this.es = es;
        es.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.kind === 'hello') {
                if (msg.rev > this.appliedRev) {
                    // a change happened before we connected: re-check desired
                    void this.reconcile();
                }
                return;
            }
            // echo suppression (PLAN §1.4)
            if (msg.origin === clientId() && msg.rev <= this.appliedRev) return;
            if (msg.kind === 'slot' || msg.kind === 'preset') {
                void this.reconcile();
            } else {
                this.emit({ event: msg });
            }
        };
        es.onerror = () => {
            // EventSource retries automatically; nothing to do
        };
    }

    /**
     * Panel write-back: snapshot ST, POST /slot/panel, re-apply if the
     * plugin's normalized output differs from the snapshot (this is how a
     * pick-one conflict collapses back to one option).
     * @param {boolean} [force] skip the unchanged check (used right after apply)
     */
    async postPanel(force = false) {
        const snapshot = snapshotPanel();
        if (!snapshot) return;
        if (!force && this.appliedHash && this.hashOf(snapshot) === this.appliedHash) return;
        if (currentPresetName() !== SLOT_NAME) return; // detached: never write a foreign preset
        // serialize concurrent panel events; only the last one matters
        const run = this.lastPanelPost.then(async () => {
            try {
                const res = await api('POST', '/slot/panel', { clientId: clientId(), snapshot });
                this.appliedHash = res.hash;
                this.appliedRev = res.rev;
                if (this.hashOf(res.compiled) !== this.hashOf(snapshot)) {
                    await this.apply({ compiled: res.compiled, hash: res.hash, rev: res.rev });
                }
                this.emit({ slot: { rev: res.rev, desired: null, compiled: res.compiled, hash: res.hash }, attached: true });
            } catch (err) {
                console.error('[preset-manager] panel write-back failed', err);
            }
        });
        this.lastPanelPost = run;
        await run;
    }

    /** @param {any} obj */
    hashOf(obj) {
        // same canonicalisation as the plugin (shared/util canonicalHash)
        return this._canonical(obj);
    }

    _canonical(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
        if (Array.isArray(value)) return '[' + value.map((v) => this._canonical(v)).join(',') + ']';
        const keys = Object.keys(value).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + this._canonical(value[k])).join(',') + '}';
    }

    /** Subscribe to ST's save path: every prompt-manager / sampler change
     * funnels into saveSettingsDebounced -> SETTINGS_UPDATED. */
    watchPanel() {
        const c = ctx();
        const handler = () => {
            if (currentPresetName() === SLOT_NAME) void this.postPanel();
        };
        c.eventSource.on(c.eventTypes.SETTINGS_UPDATED, handler);
        // detached mode: ST moved off the slot
        c.eventSource.on(c.eventTypes.PRESET_CHANGED, (/** @type {any} */ data) => {
            const name = typeof data === 'object' && data !== null ? data.name : data;
            if (name && name !== SLOT_NAME) {
                this.attached = false;
                this.emit({ attached: false });
            } else if (name === SLOT_NAME) {
                this.attached = true;
                this.emit({ attached: true });
            }
        });
    }

    stop() {
        this.es?.close();
        this.es = null;
    }
}
