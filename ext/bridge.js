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
 * resolved modelId and — unless the tab is detached — enqueues a reconcile
 * so the new desired state lands. No-ops when the raw id is unchanged since
 * the last report. `reattach()` forces the next reconcile to re-apply even
 * when the hash did not change — used after a connection profile moved ST
 * off the working slot and the caller re-attaches without a genuinely new
 * desired state.
 *
 * PER-TAB CONNECTION: every GET /slot call carries the tab's OWN raw
 * connection id (st.js's `slotPath`) instead of a global one; `baseRaw`
 * remembers the raw a reconcile's applied baseline was fetched for. When
 * the tab's current raw drifts from `baseRaw` a reconcile re-applies even
 * at an unchanged hash (ST may have mutated samplers during the switch).
 *
 * DETACHED: `detached` tracks "ST is showing a foreign (non-v2) preset",
 * set by the PRESET_CHANGED watcher. While detached, a reconcile NOT
 * forced by a genuine library load (slotChangedRev advancing) or by
 * `reattach()`/an explicit unlink never re-applies the working slot over
 * the foreign preset — a mere connection or registry change must not steal
 * the tab back.
 *
 * TRANSITION-SAFE FLUSH: flushPanel restores TUNING_KEYS in the snapshot
 * it is about to send from the write-back baseline whenever the tab's
 * current raw differs from `baseRaw` — a connection switch can mutate
 * samplers in ST as a side effect, and that mutation is not a genuine user
 * tuning edit. A controlled switch (bridge.edit) flushes real edits BEFORE
 * the switch, so this never drops one.
 *
 * GENUINE-EDIT-DURING-TRANSITION (Fix A): the restore above would also
 * discard a real tuning edit the user makes AFTER a connection switch but
 * BEFORE the new baseline lands (e.g. while POST /slot/model is in
 * flight). connection.js calls `noteTransition()` synchronously right
 * after ST applies a model/profile switch, capturing what the panel shows
 * then (`_transition`, including any transition mutation ST itself
 * performs, e.g. a temperature clamp — that is NOT a user edit either).
 * flushPanel diffs a later snapshot against `_transition.tuning`: a key
 * that changed since is a genuine edit and is POSTed on top of the old
 * baseline restore, addressed at the NEW connection's Model (raw =
 * currentRaw()) so it survives the reconcile that follows, instead of
 * being silently restored away.
 *
 * DETACH-RACE (Fix B): an in-flight apply (POST /api/presets/save) must
 * never stomp a preset another actor selected while it was running (e.g.
 * a connection profile that loads a foreign preset mid-apply). `_detachGen`
 * counts every PRESET_CHANGED-to-a-foreign-preset; `_reconcileInner`
 * captures it plus the preset name at entry and threads an `abort()`
 * predicate through `apply()` into `applyCompiledToSlot`, which checks it
 * right before the state-changing `pm.updateList()` call and at the top
 * of every poll iteration. An abort throws before any bridge state is
 * mutated, so the tab stays correctly detached on the foreign preset.
 */
import { api, ctx, clientId, applyCompiledToSlot, snapshotPanel, currentPresetName, currentRaw, slotPath, panelTuningNow, SLOT_NAME, PLUGIN_BASE } from './st.js';
import { TUNING_KEYS } from '../shared/st-keys.js';

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
        /** Raw connection id (source/model/profileId) the applied
         * compile/baseline was fetched for — used to detect a connection
         * change under an unchanged compiled hash. */
        this.baseRaw = null;
        /** Panel tuning captured by noteTransition() right after ST
         * applied a new connection (a model switch or profile load), while
         * `baseRaw` still names the OLD connection — `{raw, tuning}`.
         * flushPanel diffs a later snapshot against `tuning` to tell a
         * genuine user tuning edit made during the transition apart from
         * ST's own transition mutation. Null when no transition is
         * pending, cleared on every successful apply. */
        this._transition = null;
        this.attached = false;
        /** ST is currently showing a foreign (non-v2) preset. While true, a
         * reconcile not forced by a genuine library load or reattach()
         * never re-applies the working slot over it. */
        this.detached = false;
        /** Bumped every time the PRESET_CHANGED watcher moves ST onto a
         * foreign (non-slot) preset. `_reconcileInner` captures this at
         * entry and threads an abort() through apply() so an in-flight
         * apply notices a detach that happened mid-flight and stops before
         * it steals the tab back from whatever the user/profile just
         * selected. */
        this._detachGen = 0;
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
     * Record what the panel shows right after ST finished applying a new
     * connection (a model or profile switch). Called by connection.js
     * SYNCHRONOUSLY, right after the switch, BEFORE reportModel() —
     * capturing the state ST left behind (including any transition
     * mutation ST performs itself, e.g. a temperature clamp — that is not
     * a genuine user edit either). No-op (clears any stale transition)
     * when the panel does not actually differ from `baseRaw`'s baseline
     * (nothing to protect). flushPanel later diffs a snapshot against
     * `_transition.tuning` to tell a genuine user tuning edit made during
     * the switch apart from ST's own mutation.
     * @returns {void}
     */
    noteTransition() {
        const raw = currentRaw();
        if (this.baseRaw && this.hashOf(raw) !== this.hashOf(this.baseRaw)) {
            this._transition = { raw, tuning: panelTuningNow() };
        } else {
            this._transition = null;
        }
    }

    /**
     * Report the tab's current raw connection id to the plugin so it can
     * resolve the Model and desired loadout for that connection. No-op
     * when the raw id is unchanged since the last report. Flushes unsent
     * panel edits first when attached (a Model switch can move the desired
     * slot state), then POSTs /slot/model, records the resolved modelId,
     * emits it and — unless the tab is detached — enqueues a reconcile so
     * the new desired state lands.
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
        if (!this.detached) this.enqueueReconcile();
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
            return this.reconcileOp(true);
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
     * then GET /slot for the tab's OWN raw connection id. While `detached`
     * and not `force`d, a reconcile that is not itself a library load
     * (slotChangedRev unchanged) never re-applies over the foreign preset.
     * Otherwise apply desired state when the tab does not already show
     * that exact compiled state for that raw; advance the applied base
     * without applying when it does. Idempotent — always fetches fresh, so
     * any number of queued runs converge on the latest server state.
     * @param {boolean} [force] re-apply even at an unchanged compiled hash
     *   (e.g. after reattach())
     */
    async reconcileOp(force = false) {
        // The input blocker covers the WHOLE op, not just apply(): an edit
        // made after the flush below but before apply (e.g. during GET /slot)
        // would be neither flushed nor blocked, and the apply would overwrite
        // it. Mounted synchronously first, so every earlier edit is caught by
        // the flush and no later edit can land until the op finishes.
        this._setApplyOverlay(true);
        try {
            return await this._reconcileInner(force);
        } finally {
            this._setApplyOverlay(false);
        }
    }

    async _reconcileInner(force) {
        // Fix B: an in-flight apply must never stomp a preset another
        // actor (user click, connection profile) selected while it was
        // running. Capture the detach generation and preset name NOW, at
        // entry — a change to either by the time apply() gets to the
        // point of no return means this op's own idea of "what to apply
        // over" is stale.
        const gen = this._detachGen;
        const startName = currentPresetName();
        const abort = () => this._detachGen !== gen || (currentPresetName() !== startName && currentPresetName() !== SLOT_NAME);
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
        const raw = currentRaw();
        const slot = /** @type {{rev: number, slotChangedRev?: number, desired: any, compiled: any, hash: string}} */ (await api('GET', slotPath(raw)));
        const slotChangedRev = slot.slotChangedRev ?? 0;
        const rawChanged = this.baseRaw !== null && this.hashOf(raw) !== this.hashOf(this.baseRaw);
        if (this.detached && !force && !(slotChangedRev > this.appliedSlotChangedRev)) {
            // Detached: ST is showing a foreign preset. A connection or
            // registry change alone (this reconcile) must not steal it back
            // — only a genuine library load (slotChangedRev advances),
            // reattach() (force) or an unlink re-applies.
            this.emit({ slot, attached: false });
            return slot;
        }
        if (slot.desired?.presetId && slot.compiled) {
            if (slot.hash !== this.appliedHash || rawChanged || force) {
                // A changed connection always re-applies even at an
                // unchanged compiled hash: ST may have mutated samplers
                // itself while switching.
                await this.apply(slot, abort);
                this.appliedSlotChangedRev = slotChangedRev;
                this.baseRaw = raw;
                this.detached = false;
                this._transition = null;
            } else {
                // Same compiled hash, same connection. Three sub-cases
                // (Finding: "Advance the panel base after a same-hash slot
                // change"):
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
                this.baseRaw = raw;
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
     *
     * Fix B: `abort` is threaded through into applyCompiledToSlot, which
     * checks it right before the state-changing pm.updateList() call and
     * at the top of every poll iteration. When it fires, applyCompiledToSlot
     * throws BEFORE this method's success path runs, so appliedHash /
     * appliedRev / attached / baseSnapshot are left untouched — the caller
     * (`_reconcileInner`) also skips its own baseRaw/detached update
     * because the `await this.apply(...)` above it throws too.
     * @param {{ compiled: any, hash: string, rev: number }} slot
     * @param {() => boolean} [abort] see _reconcileInner
     */
    async apply(slot, abort) {
        if (this.applying) throw new Error('bridge: overlapping apply (queue invariant violated)');
        this.applying = true;
        try {
            await applyCompiledToSlot(slot.compiled, { abort });
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
     * Snapshot ST (or use `given`); if the tab's current raw connection id
     * differs from `baseRaw`, ST may have mutated samplers as a side effect
     * of the switch — restore TUNING_KEYS in the snapshot from the baseline
     * before treating it as a user edit (a genuine tuning edit made during
     * a controlled switch is protected because bridge.edit flushes it
     * FIRST, before the switch runs). Then, if the (possibly restored)
     * snapshot differs from the baseline, POST the delta (base + snapshot)
     * and let the plugin route only what the user changed.
     *
     * Fix A: the restore above would also discard a GENUINE tuning edit
     * made after the switch but before the new baseline lands. Diff the
     * fresh (unrestored) snapshot against `_transition.tuning` (what the
     * panel showed right after the switch, captured by noteTransition())
     * — a TUNING_KEYS value that changed since is a real user edit, not
     * ST's own transition mutation. Any such edits are POSTed in a SECOND
     * request, on top of the restore, addressed at the NEW connection
     * (raw = the raw the edit was diffed against) so they land on the new
     * Model instead of being silently restored away, and are then folded
     * into `_transition.tuning` — but only if `_transition` still IS that
     * same object: `currentRaw()` and `this._transition` are read ONCE at
     * flush start (`liveRaw`/`tr`) and reused for the whole flush, because
     * either can change out from under an in-flight await (a second
     * transition superseding the one this flush diffed against). Without
     * this, the second POST could address the wrong raw, or the fold could
     * write a stale genuine edit into an unrelated newer transition (and
     * make its own untouched value look genuine later), or the fold could
     * throw against a `_transition` the connection switch already nulled.
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
        let snapshot = given ?? await snapshotPanel();
        if (!snapshot) return null;
        const liveRaw = currentRaw();
        const tr = this._transition;
        /** @type {Record<string, any>|null} genuine tuning edits made since the transition (null: no transition to diff against) */
        let genuine = null;
        /** @type {Record<string, any>|null} tr.tuning, only when it still names the CURRENT raw */
        let transitionTuning = null;
        if (this.baseRaw && this.hashOf(liveRaw) !== this.hashOf(this.baseRaw)) {
            const S = snapshot;
            transitionTuning = tr && this.hashOf(tr.raw) === this.hashOf(liveRaw) ? tr.tuning : null;
            genuine = {};
            if (transitionTuning) {
                for (const key of TUNING_KEYS) {
                    if (Object.prototype.hasOwnProperty.call(S, key) && this.hashOf(S[key]) !== this.hashOf(transitionTuning[key])) {
                        genuine[key] = S[key];
                    }
                }
            }
            const restored = { ...S };
            for (const key of TUNING_KEYS) {
                if (this.baseSnapshot && Object.prototype.hasOwnProperty.call(this.baseSnapshot, key)) {
                    restored[key] = this.baseSnapshot[key];
                } else {
                    delete restored[key];
                }
            }
            snapshot = restored;
        }
        const sameBase = this.baseSnapshot && this.hashOf(snapshot) === this.hashOf(this.baseSnapshot);
        if (!sameBase) {
            let res;
            try {
                res = await api('POST', '/slot/panel', {
                    clientId: clientId(),
                    baseRev: this.appliedRev,
                    base: this.baseSnapshot,
                    snapshot,
                    raw: this.baseRaw ?? liveRaw,
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
        }
        if (genuine && Object.keys(genuine).length > 0) {
            // A real tuning edit made during the transition: send it on top
            // of the (possibly just-posted) old-connection restore,
            // addressed at the NEW connection so it survives the reconcile
            // this forces (appliedHash = null below) instead of being
            // overwritten by it.
            const B2 = { ...snapshot };
            for (const key of TUNING_KEYS) {
                if (Object.prototype.hasOwnProperty.call(transitionTuning, key)) {
                    B2[key] = transitionTuning[key];
                } else {
                    delete B2[key];
                }
            }
            const S2 = { ...B2, ...genuine };
            let res2;
            try {
                res2 = await api('POST', '/slot/panel', {
                    clientId: clientId(),
                    baseRev: this.appliedRev,
                    base: B2,
                    snapshot: S2,
                    raw: tr.raw,
                });
            } catch (err) {
                if (/** @type {Error & {status?: number}} */ (err)?.status !== 409) throw err;
                this.baseSnapshot = null;
                this.appliedHash = null;
                this._flushStale = true;
                return null;
            }
            this.appliedRev = Math.max(this.appliedRev, res2.rev);
            // forces the reconcile that follows to re-apply the new Model's
            // compile instead of comparing a hash taken against the old one
            this.appliedHash = null;
            // never resend: fold the sent edits into the transition tuning —
            // unless a newer transition has since replaced this one (a
            // replaced or cleared `_transition` is left alone, never thrown on)
            if (this._transition === tr) {
                for (const key of Object.keys(genuine)) tr.tuning[key] = genuine[key];
            }
            // the sent values are accounted for: if the tab returns to its
            // baseline connection before the next apply, the panel still
            // shows them, and they must not be re-read as an edit made under
            // that connection (they belong to tr.raw's Model)
            if (this.baseSnapshot) {
                for (const key of Object.keys(genuine)) this.baseSnapshot[key] = genuine[key];
            }
            this.emit({ slot: { rev: res2.rev, desired: null, compiled: res2.compiled, hash: res2.hash }, attached: true });
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
                this.detached = true;
                this._detachGen++;
                this.emit({ attached: false });
            } else if (name === SLOT_NAME) {
                this.attached = true;
                this.detached = false;
                this.emit({ attached: true });
            }
        });
    }

    stop() {
        this.es?.close();
        this.es = null;
    }
}
