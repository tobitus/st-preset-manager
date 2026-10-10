/**
 * Preset Manager v2 — server plugin (ST loads this via package.json main,
 * src/plugin-loader.js:99-111). Owns the library, the desired state of the
 * working slot, and the SSE hub. Never writes ST's own files: no
 * settings.json, no OpenAI Settings/*.json (roadmap item 3, Phase 1
 * "Must NOT" list).
 */
import { Store } from './store.js';
import { EventHub } from './events.js';
import { registerRoutes } from './routes.js';
import { VERSION } from './version.js';

// ST's plugin-loader requires `info` to be an OBJECT with string
// id/name/description (src/plugin-loader.js:187-196) and `init` a function.
export const info = {
    id: 'st-preset-manager',
    name: 'Preset Manager',
    description: 'Preset library + working slot for Chat Completion presets',
    version: VERSION,
};

/** @param {import('express').Router} router */
export async function init(router) {
    // request.user.directories.root (src/users.js:683-697) keys storage per user.
    router.use((req, _res, next) => {
        const root = req.user?.directories?.root
            ? `${req.user.directories.root}/preset-manager`
            : null;
        if (!root) return next(new Error('st-preset-manager: no user directory on request'));
        req.app.locals.pmStores = req.app.locals.pmStores ?? {};
        if (!req.app.locals.pmStores[root]) {
            const store = new Store(root);
            const hub = new EventHub();
            req.app.locals.pmStores[root] = { store, hub, ready: null };
            // No onMutate broadcast here: every queued operation publishes
            // exactly ONE typed event after its full mutation completes
            // (routes.js). A generic `preset` event per rev bump duplicated
            // every typed event and defeated origin suppression — consumers
            // route `preset` to reconciliation, so half-finished mutations
            // triggered applies of intermediate state.
        }
        req.pm = req.app.locals.pmStores[root];
        next();
    });

    router.use(async (req, res, next) => {
        try {
            req.pm.ready = req.pm.ready ?? req.pm.store.init();
            await req.pm.ready;
            next();
        } catch (err) {
            next(err);
        }
    });

    registerRoutes(router);

    // error forwarder: never swallow (PLAN §1.6)
    router.use((/** @type {any} */ err, _req, res, _next) => {
        const status = err?.status ?? 500;
        if (status >= 500) console.error('[st-preset-manager]', err);
        // structured extras (e.g. the stale 409's slotChangedRev) ride the
        // body; `conflict` keeps its historical shape
        const { status: _s, message, conflict, ...extra } = err ?? {};
        delete extra.status;
        res.status(status).json({
            error: String(message ?? err),
            ...(conflict !== undefined ? { conflict } : {}),
            ...extra,
        });
    });

    console.log('[st-preset-manager] plugin initialized');
}

export default { info, init };
