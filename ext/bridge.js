/**
 * Live bridge (PLAN §1.4): SSE push + tab reconciliation + panel write-back.
 *
 * One serial op queue (a promise chain) carries EVERYTHING that reads or
 * writes ST's preset state: `reconcile` ops, `panel` ops, and `edit` ops
 * (one UI write per edit op: flush unsent panel edits, run the write, then
 * enqueue a reconcile so the live slot converges). No op ever
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
 *
 * Reconcile ops flush unsent panel edits FIRST (flushPanel), so a user edit
 * made while a slot update was in flight reaches the server before the
 * incoming state is applied over it — server receipt order stays
 * most-recent-wins and the live edit is never lost. A failed flush aborts
 * the reconcile (it re-throws); the op fails, the queue survives, and the
 * next SETTINGS_UPDATED or SSE event retries. A flush rejected with 409
 * (stale base) throws nothing: flushPanel drops the baseline, forces a
 * re-apply and lets the op continue to GET /slot — the tab converges on
 * the new desired state, discarding the stale edit.
 *
 * While an apply runs the bridge blocks panel input (transparent overlay on
 * the prompt manager + sampler panel), so user edits cannot interleave with
 * an apply and no timing-based sampling heuristic is needed.
 *
 * model op (enqueueModelReport / modelReportOp): reports the tab's current
 * raw connection id (source/model/profileId) to the plugin so it can
 * resolve the Model and desired loadout for that connection. Flushes
 * unsent panel edits first when attached (a Model switch can move ST onto
 * a different desired slot state), POSTs /slot/model, records the plugin's
 * resolved modelId and enqueues a reconcile so the new desired state lands.
 * No-ops when the raw id is unchanged since the last report. `reattach()`
 * forces the next reconcile to re-apply even when the hash did not
 * change — used after a connection profile moved ST off the working slot
 * and the caller re-attaches without a genuinely new desired state.
 */
import { api, ctx, clientId, applyCompiledToSlot, snapshotPanel, currentPresetName, currentRaw, SLOT_NAME, PLUGIN_BASE } from './st.js';

/**
 * Surfaces the user edits a chat-completion preset from, covered by the
 * apply overlay (ST 1.19.0):
 *  - '#completion_prompt_manager' — the prompt manager root
 *    (public/index.html:2274), wired as PromptManager's container
 *    (public/scripts/openai.js:686); its list is drag-sortable and toggle-
 *    clickable (public/scripts/PromptManager.js:1921 sortable on the list).
 *  - '#completion_prompt_manager_popup' — the prompt edit form drawer
 *    (public/index.html:7276).
 *  - '#ai_response_configuration' — the AI Response Configuration drawer
 *    body (public/index.html:89): every sampler slider / checkbox binds
 *    input/change -> saveSettingsDebounced (public/scripts/openai.js:6776+).
 * @type {string[]}
 */
const APPLY_OVERLAY_SELECTORS = [
    '#completion_prompt_manager',
    '#completion_prompt_manager_popup',
    '#ai_response_configuration',
];
const APPLY_OVERLAY_CLASS = 'pm-apply-blocker';

export class Bridge {
    constructor() {
        this.appliedHash = null;
        this.appliedRev = 0;
        /** Global plugin rev at which the state we last mirrored into ST
         * became the desired slot state (GET /slot slotChangedRev). Equals
         * appliedRev when the last event we applied was itself a slot
         * change; when panel write-backs advance only `rev`, this stays
         * behind, which is what lets reconcileOp tell "same state, newer
         * revision counter" apart from a genuinely new desired state. */
        this.appliedSlotChangedRev = 0;
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
        /** Last flushPanel hit 409 (stale): the panel op follows with a reconcile. */
        this._flushStale = false;
        /** @type {boolean} a model op is queued but NOT yet started */
        this._modelQueued = false;
        /** Plugin-resolved Model name for the tab's current raw connection id
         * (null when unresolved). */
        this.modelId = null;
        /** Last raw connection id reported to /slot/model (hash-compared to
         * skip redundant reports). */
        this._reportedRaw = null;
    }

    /**
     * Enqueue `op` on the serial queue. Coalescing: callers that only want
     * "this kind of op happens next" pass `key`; while a same-keyed op is
     * queued but not yet started, a new enqueue replaces the flag instead of
     * stacking another op (repeated SSE events collapse into one re-read).
     * @template T
     * @param {() => Promise<T>} op
     * @param {{key?: 'reconcile'|'panel'|'model'}} [opts]
     * @returns {Promise<T>} this op's completion (a coalesced-away caller
     *   gets the queued op's completion instead — same converged state)
     */
    _enqueue(op, { key } = {}) {
        const coalescing = key === 'reconcile' ? this._reconcileQueued : key === 'panel' ? this._panelQueued : key === 'model' ? this._modelQueued : false;
        if (coalescing) return this._queue;
        if (key === 'reconcile') this._reconcileQueued = true;
        if (key === 'panel') this._panelQueued = true;
        if (key === 'model') this._modelQueued = true;
        const run = this._queue.then(async () => {
            if (key === 'reconcile') this._reconcileQueued = false;
            if (key === 'panel') this._panelQueued = false;
            if (key === 'model') this._modelQueued = false;
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

    /**
     * Register a listener for bridge state updates.
     * @param {(state: any) => void} fn
     * @returns {() => void} unsubscribe
     */
    onUpdate(fn) {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }

    /** @param {any} state */
    emit(state) {
        for (const fn of this.listeners) {
            try { fn(state); } catch { /* listener error */ }
        }
    }

    /** Extension init: reconcile then stream. */
    async start() {
        // a failed first reconcile must not leave the tab without a bridge:
        // the stream's hello and later events re-enqueue it
        await this.enqueueReconcile().catch((err) => console.error('[preset-manager] initial reconcile failed', err));
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

    /** Queue a model report op (coalesced with any not-yet-started one). */
    enqueueModelReport() {
        return this._enqueue(() => this.modelReportOp(), { key: 'model' });
    }

    /**
     * Report the tab's current raw connection id to the plugin so it can
     * resolve the Model and desired loadout for that connection. No-op
     * when the raw id is unchanged since the last report. Flushes unsent
     * panel edits first when attached (a Model switch can move the desired
     * slot state), then POSTs /slot/model, records the resolved modelId,
     * emits it and enqueues a reconcile so the new desired state lands.
     * @returns {Promise<any|null>} the slot view, or null when unchanged
     */
    async modelReportOp() {
        const raw = currentRaw();
        if (this._reportedRaw && this.hashOf(raw) === this.hashOf(this._reportedRaw)) return null;
        if (currentPresetName() === SLOT_NAME && this.baseSnapshot) await this.flushPanel();
        const view = await api('POST', '/slot/model', { raw });
        this._reportedRaw = raw;
        this.modelId = view?.desired?.modelId ?? null;
        this.emit({ model: { raw, modelId: this.modelId } });
        this.enqueueReconcile();
        return view;
    }

    /**
     * Force the next reconcile to re-apply the desired slot state even
     * when the compiled hash did not change (e.g. after a connection
     * profile moved ST onto another preset and the caller re-attaches
     * without a genuinely new desired state). NOT coalesced: every call
     * runs its own reconcile.
     * @returns {Promise<any>} the reconcile op's slot view
     */
    reattach() {
        return this._enqueue(() => {
            this.appliedHash = null;
            return this.reconcileOp();
        });
    }

    /**
     * Run a UI write as ONE op on the serial op queue (PLAN §1.4: one
     * serial op queue). Unsent ST-panel edits are flushed first so the
     * server receipt order stays most-recent-wins, and the apply overlay is
     * up for the whole op so no panel edit can interleave. A reconcile is
     * enqueued afterwards (success or failure) so the live slot converges
     * even before the SSE echo. NOT coalesced: no `key`, every UI write
     * runs.
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>} `fn()`'s result; errors propagate to the caller
     */
    edit(fn) {
        return this._enqueue(async () => {
            this._setApplyOverlay(true);
            try {
                if (currentPresetName() === SLOT_NAME && this.baseSnapshot) await this.flushPanel();
                return await fn();
            } finally {
                this._setApplyOverlay(false);
                this.enqueueReconcile();
            }
        });
    }

    /**
     * reconcile op: flush any unsent panel edits FIRST (so a user edit made
     * while an update was in flight reaches the server before incoming
     * state is applied over it — server receipt order = most recent wins),
     * then GET /slot. Apply desired state when the tab does not already
     * show that exact compiled state; advance the applied base without
     * applying when it does. Idempotent — always fetches fresh, so any
     * number of queued runs converge on the latest server state.
     */
    async reconcileOp() {
        // The input blocker covers the WHOLE op, not just apply(): an edit
        // made after the flush below but before apply (e.g. during GET /slot)
        // would be neither flushed nor blocked, and the apply would overwrite
        // it. Mounted synchronously first, so every earlier edit is caught by
        // the flush and no later edit can land until the op finishes.
        this._setApplyOverlay(true);
        try {
            return await this._reconcileInner();
        } finally {
            this._setApplyOverlay(false);
        }
    }

    async _reconcileInner() {
        if (currentPresetName() === SLOT_NAME && this.baseSnapshot) {
            // A failed flush means unsent user edits would be overwritten by
            // the apply below — abort this op entirely (Finding: "Abort
            // reconciliation when flushing fails"). flushPanel re-throws
            // non-409 failures; a 409 (stale base) does NOT throw: it clears
            // baseSnapshot, so the apply below lands the NEW desired state
            // over the stale edit (dropped by design) and rebuilds the
            // baseline from what the panel then shows. This op's rejection
            // on a non-409 failure is the retry signal (next
            // SETTINGS_UPDATED or SSE event enqueues a fresh reconcile that
            // re-reads /slot).
            await this.flushPanel();
        }
        const slot = /** @type {{rev: number, slotChangedRev?: number, desired: any, compiled: any, hash: string}} */ (await api('GET', '/slot'));
        const slotChangedRev = slot.slotChangedRev ?? 0;
        if (slot.desired?.presetId && slot.compiled) {
            if (slot.hash !== this.appliedHash) {
                await this.apply(slot);
                this.appliedSlotChangedRev = slotChangedRev;
            } else {
                // Same compiled hash. Three sub-cases (Finding: "Advance the
                // panel base after a same-hash slot change"):
                // - a slot change (load / model swap) that compiles to the
                //   same hash: no apply is needed, but appliedRev must
                //   advance, or every later panel post uses an old baseRev
                //   and 409s forever while this op keeps being re-queued as
                //   a hash no-op;
                // - a mere rev bump (panel write-back echo, save of the
                //   same content): re-baseline too — the panel below is
                //   compared against baseSnapshot either way;
                // - genuinely nothing new (SSE echo of our own write): skip.
                const revAdvanced = slot.rev > this.appliedRev || slotChangedRev > this.appliedSlotChangedRev;
                if (revAdvanced) {
                    const panel = await snapshotPanel();
                    if (!panel || this.hashOf(panel) !== this.hashOf(this.baseSnapshot)) {
                        // The panel drifted from our baseline while the hash
                        // stayed the server truth: it may carry unsent user
                        // edits (flushPanel above returned null) — send them
                        // before re-baselining.
                        await this.flushPanel(panel);
                    }
                    this.appliedRev = Math.max(this.appliedRev, slot.rev);
                    this.appliedSlotChangedRev = slotChangedRev;
                }
            }
        } else {
            this.attached = currentPresetName() === SLOT_NAME;
        }
        this.emit({ slot, attached: this.attached });
        return slot;
    }

    /**
     * Apply a slot view into ST, then re-baseline the panel projection.
     * Only ever called from reconcileOp — the queue serializes applies, so
     * an op can never snapshot a half-applied preset.
     *
     * Edit-interleave policy (replaces the old fixed-interval sampler):
     * edits are PREVENTED, not sampled. reconcileOp mounts a transparent
     * input blocker over the surfaces the user edits a chat-completion
     * preset from (APPLY_OVERLAY_SELECTORS below, with the ST source lines
     * that justify each) for the whole op, flush → GET → apply, and removes
     * it in `finally`. Edits made before the op are sent by its flush; none
     * can land after it, so no timing heuristic decides what counts as a
     * user edit.
     * @param {{ compiled: any, hash: string, rev: number }} slot
     */
    async apply(slot) {
        if (this.applying) throw new Error('bridge: overlapping apply (queue invariant violated)');
        this.applying = true;
        try {
            await applyCompiledToSlot(slot.compiled);
            this.appliedHash = slot.hash;
            this.appliedRev = Math.max(this.appliedRev, slot.rev);
            this.attached = true;
            // the projection ST actually shows is the honest write-back
            // baseline: the SETTINGS_UPDATED our apply triggers must
            // compare equal to it
            this.baseSnapshot = await snapshotPanel();
        } finally {
            this.applying = false;
        }
        return true;
    }

    /**
     * Transparent input blocker over the editable preset surfaces for the
     * duration of an apply. `pointer-events: none` stops clicks / sliders /
     * drag-sort (PromptManager's sortable starts on pointerdown);
     * capture-phase keydown stopImmediatePropagation stops keyboard
     * shortcuts and global hotkeys from reaching anything while the blocker
     * is up.
     * The overlay is inert (aria-hidden, transparent) and does not affect
     * elements OUTSIDE the surfaces covered by APPLY_OVERLAY_SELECTORS.
     * @param {boolean} on
     */
    _setApplyOverlay(on) {
        for (const selector of APPLY_OVERLAY_SELECTORS) {
            const el = /** @type {any} */ (document).querySelector(selector);
            if (!el) continue;
            if (on) {
                const blocker = /** @type {any} */ (document).createElement('div');
                blocker.className = APPLY_OVERLAY_CLASS;
                blocker.setAttribute('aria-hidden', 'true');
                blocker.style.position = 'fixed';
                blocker.style.inset = '0';
                blocker.style.zIndex = '9999';
                blocker.style.background = 'transparent';
                blocker.style.pointerEvents = 'auto';
                blocker.style.cursor = 'wait';
                blocker.__pmKeydown = (/** @type {any} */ ev) => {
                    // the v2 window's own shortcuts are queued edit ops (bridge.edit):
                    // they never interleave an apply, so they are not blocked
                    if (ev.target?.closest?.('#pm-window')) return;
                    ev.stopImmediatePropagation();
                };
                el.style.pointerEvents = 'none';
                el.appendChild(blocker);
                // capture phase: block BEFORE ST's own key handlers see it
                document.addEventListener('keydown', blocker.__pmKeydown, true);
                blocker.__pmCovered = el;
            } else {
                const blocker = /** @type {any} */ (el.querySelector(`:scope > .${APPLY_OVERLAY_CLASS}`));
                if (blocker) {
                    document.removeEventListener('keydown', blocker.__pmKeydown, true);
                    blocker.remove();
                }
                el.style.pointerEvents = '';
            }
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
            if (msg.kind === 'hello' || msg.kind === 'slot' || msg.kind === 'preset') {
                // no origin checks: the queue + hash gate make our own echo a
                // cheap no-op (re-GET returns the hash we already applied)
                if (msg.rev > this.appliedRev) this.enqueueReconcile();
                // also surface the event (e.g. the Presets tab re-fetches
                // docs changed elsewhere)
                this.emit({ event: msg });
            } else {
                this.emit({ event: msg });
            }
        };
        es.onerror = () => {
            // EventSource retries automatically; nothing to do
        };
    }

    /**
     * panel op: flush unsent panel edits (see flushPanel), then — if the
     * flush collapsed a pick-one choice or similar (appliedHash cleared) or
     * went stale (409) — enqueue a reconcile so the tab converges on the
     * stored projection. A non-409 failure re-throws out of flushPanel: the
     * op fails while the queue survives, and the unsent snapshot stays
     * pending as the next delta.
     */
    async panelOp() {
        this._flushStale = false;
        try {
            await this.flushPanel();
        } finally {
            if (this.appliedHash === null || this._flushStale) this.enqueueReconcile();
        }
        return null;
    }

    /**
     * The actual panel write-back, callable inline from BOTH ops (panel ops
     * and reconcile ops — a user edit made while an update was in flight
     * must reach the server before that update is applied over it). It is
     * safe to call from within a queued op because it enqueues nothing.
     * Snapshot ST (or use `given`) ; if it differs from the baseline, POST
     * the delta (base + snapshot) and let the plugin route only what the
     * user changed.
     * @param {any} [given] a snapshot taken earlier; skips the fresh
     *   snapshot when provided
     * @returns {Promise<any>} the snapshot sent, or null if nothing was sent
     * @throws any non-409 POST failure (network down, 5xx, plugin restart):
     *   the unsent snapshot is NOT dropped — baseSnapshot still names it as
     *   the next delta — and callers must abort rather than proceed over
     *   the still-unsent edit (Finding: "Abort reconciliation when flushing
     *   a panel edit fails"). A 409 does NOT throw: the baseline was stale
     *   (desired state changed under it), the edit is dropped by design and
     *   the caller proceeds to re-read /slot and re-apply (see the catch
     *   above).
     */
    async flushPanel(given = undefined) {
        if (currentPresetName() !== SLOT_NAME) return null; // detached: never write a foreign preset
        const snapshot = given ?? await snapshotPanel();
        if (!snapshot) return null;
        const sameBase = this.baseSnapshot && this.hashOf(snapshot) === this.hashOf(this.baseSnapshot);
        if (sameBase) return null;
        let res;
        try {
            res = await api('POST', '/slot/panel', {
                clientId: clientId(),
                baseRev: this.appliedRev,
                base: this.baseSnapshot,
                snapshot,
            });
        } catch (err) {
            if (/** @type {Error & {status?: number}} */ (err)?.status !== 409) throw err;
            // 409 — stale base: the desired preset/loadout changed after this
            // baseline was taken (the server's slotChangedRev guard). The
            // user's stale edit is dropped BY DESIGN: replaying the old
            // preset's delta onto the new document would pour its state into
            // a preset the tab is no longer showing. Drop the stale baseline
            // and force a re-apply, then RETURN (never rethrow):
            // - baseSnapshot = null → a reconcile op's flush precondition
            //   (`... && this.baseSnapshot`) is false, so it proceeds to
            //   GET /slot and applies the new desired state (apply() rebuilds
            //   the baseline from the applied projection);
            // - appliedHash = null → even a same-hash view re-applies and
            //   re-baselines instead of advancing a dead base in place;
            // - _flushStale = true → panelOp's finally enqueues the reconcile
            //   that converges the tab.
            this.baseSnapshot = null;
            this.appliedHash = null;
            this._flushStale = true;
            return null;
        }
        this.appliedHash = res.hash;
        this.appliedRev = Math.max(this.appliedRev, res.rev);
        this.baseSnapshot = snapshot;
        // pick-one collapse and friends: the stored projection differs from
        // what the panel shows — let the caller converge via the queue
        // (panelOp enqueues the reconcile; never apply inline).
        if (this.hashOf(res.compiled) !== this.hashOf(snapshot)) {
            this.appliedHash = null;
        }
        this.emit({ slot: { rev: res.rev, desired: null, compiled: res.compiled, hash: res.hash }, attached: true });
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
