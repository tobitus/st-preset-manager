/**
 * Live bridge (PLAN §1.4): SSE push + tab reconciliation + panel write-back.
 *
 * One serial op queue (a promise chain) carries EVERYTHING that reads or
 * writes ST's preset state: `reconcile` ops and `panel` ops. No op ever
 * calls another op directly — ops only ENQUEUE follow-ups — so an op can
 * never observe a half-applied preset, and a queued follow-up always
 * re-reads the latest state instead of replaying a stale view.
 *
 * reconcile op: GET /slot; if slot.hash !== appliedHash, apply it, then
 * re-snapshot the panel as the new write-back baseline. Idempotent: running
 * it any number of times converges on the latest server state.
 *
 * panel op: snapshot ST; if it is unchanged from the baseline, nothing
 * happened (this also absorbs the SETTINGS_UPDATED our own apply fires);
 * otherwise POST /slot/panel {baseRev, base, snapshot} — the server routes
 * only the user's delta, so concurrent API writes to other fields survive.
 */
import { api, ctx, clientId, applyCompiledToSlot, snapshotPanel, currentPresetName, SLOT_NAME, PLUGIN_BASE } from './st.js';

export class Bridge {
    constructor() {
        this.appliedHash = null;
        this.appliedRev = 0;
        /** Panel projection of the last applied state: the write-back
         * baseline. panel ops POST only when the snapshot differs from it. */
        this.baseSnapshot = null;
        this.attached = false;
        this.es = null;
        /** @type {Set<(state: any) => void>} */
        this.listeners = new Set();
        /** @type {Promise<any>} tail of the serial op queue */
        this._queue = Promise.resolve();
        /** @type {boolean} a reconcile op is queued but NOT yet started */
        this._reconcileQueued = false;
        /** @type {boolean} a panel op is queued but NOT yet started */
        this._panelQueued = false;
    }

    /**
     * Enqueue `op` on the serial queue. Coalescing: callers that only want
     * "this kind of op happens next" pass `key`; while a same-keyed op is
     * queued but not yet started, a new enqueue replaces the flag instead of
     * stacking another op (repeated SSE events collapse into one re-read).
     * @template T
     * @param {() => Promise<T>} op
     * @param {{key?: 'reconcile'|'panel'}} [opts]
     * @returns {Promise<T>} this op's completion (a coalesced-away caller
     *   gets the queued op's completion instead — same converged state)
     */
    _enqueue(op, { key } = {}) {
        const coalescing = key === 'reconcile' ? this._reconcileQueued : key === 'panel' ? this._panelQueued : false;
        if (coalescing) return this._queue;
        if (key === 'reconcile') this._reconcileQueued = true;
        if (key === 'panel') this._panelQueued = true;
        const run = this._queue.then(async () => {
            if (key === 'reconcile') this._reconcileQueued = false;
            if (key === 'panel') this._panelQueued = false;
            try {
                return await op();
            } finally {
                // a request that arrived while this op ran already set the
                // flag: it rides the next link instead of being lost
            }
        });
        // keep the chain alive after rejections
        this._queue = run.then(() => undefined, () => undefined);
        return run;
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
        await this.enqueueReconcile();
        this.openStream();
        this.watchPanel();
    }

    /** Queue a reconcile op (coalesced with any not-yet-started one). */
    enqueueReconcile() {
        return this._enqueue(() => this.reconcileOp(), { key: 'reconcile' });
    }

    /** Queue a panel op (coalesced with any not-yet-started one). */
    enqueuePanel() {
        return this._enqueue(() => this.panelOp(), { key: 'panel' });
    }

    /**
     * reconcile op: GET /slot; apply desired if the tab does not already
     * show that exact compiled state. Idempotent — always fetches fresh, so
     * any number of queued runs converge on the latest server state.
     */
    async reconcileOp() {
        const slot = await api('GET', '/slot');
        if (slot.desired?.presetId && slot.compiled && slot.hash !== this.appliedHash) {
            await this.apply(slot);
        } else if (!slot.desired?.presetId) {
            this.attached = currentPresetName() === SLOT_NAME;
        }
        this.emit({ slot, attached: this.attached });
        return slot;
    }

    /**
     * Apply a slot view into ST, then re-baseline the panel projection.
     * Only ever called from reconcileOp — the queue serializes applies, so
     * an op can never snapshot a half-applied preset.
     * @param {{ compiled: any, hash: string, rev: number }} slot
     */
    async apply(slot) {
        await applyCompiledToSlot(slot.compiled);
        this.appliedHash = slot.hash;
        this.appliedRev = Math.max(this.appliedRev, slot.rev);
        this.attached = true;
        // the projection ST actually shows is the honest write-back baseline:
        // the SETTINGS_UPDATED our apply triggers must compare equal to it
        this.baseSnapshot = await snapshotPanel();
        return true;
    }

    openStream() {
        if (this.es) this.es.close();
        const url = `${PLUGIN_BASE}/events?clientId=${encodeURIComponent(clientId())}`;
        const es = new EventSource(url, { withCredentials: true });
        this.es = es;
        es.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.kind === 'hello' || msg.kind === 'slot' || msg.kind === 'preset') {
                // no origin checks: the queue + hash gate make our own echo a
                // cheap no-op (re-GET returns the hash we already applied)
                if (msg.rev > this.appliedRev) this.enqueueReconcile();
            } else {
                this.emit({ event: msg });
            }
        };
        es.onerror = () => {
            // EventSource retries automatically; nothing to do
        };
    }

    /**
     * panel op: snapshot ST; if it differs from the baseline, POST the delta
     * (base + snapshot) and let the plugin route only what the user changed.
     */
    async panelOp() {
        if (currentPresetName() !== SLOT_NAME) return null; // detached: never write a foreign preset
        const snapshot = await snapshotPanel();
        if (!snapshot) return null;
        if (this.baseSnapshot && this.hashOf(snapshot) === this.hashOf(this.baseSnapshot)) return null;
        try {
            const res = await api('POST', '/slot/panel', {
                clientId: clientId(),
                baseRev: this.appliedRev,
                base: this.baseSnapshot,
                snapshot,
            });
            this.appliedHash = res.hash;
            this.appliedRev = Math.max(this.appliedRev, res.rev);
            this.baseSnapshot = snapshot;
            // pick-one collapse and friends: the stored projection differs
            // from what the panel shows — converge via the queue, never by
            // applying inline (an op does not call another op).
            if (this.hashOf(res.compiled) !== this.hashOf(snapshot)) {
                this.appliedHash = null;
                this.enqueueReconcile();
            }
            this.emit({ slot: { rev: res.rev, desired: null, compiled: res.compiled, hash: res.hash }, attached: true });
        } catch (err) {
            if (err?.status === 409) {
                // stale (desired changed under us, or no base): drop this
                // snapshot, re-read the server state and re-base
                this.enqueueReconcile();
            } else {
                console.error('[preset-manager] panel write-back failed', err);
            }
        }
        return snapshot;
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
            if (currentPresetName() === SLOT_NAME) this.enqueuePanel();
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
