/**
 * Preset Manager v2 — server plugin (ST loads this via package.json main,
 * src/plugin-loader.js:99-111). Owns the library, the desired state of the
 * working slot, and the SSE hub. Never writes ST's own files: no
 * settings.json, no OpenAI Settings/*.json (roadmap item 3, Phase 1
 * "Must NOT" list).
 */
import { Store } from './store.js';
import { EventHub } from './events.js';
import { makeRouter } from './routes.js';

export function info() {
    return {
        id: 'st-preset-manager',
        name: 'Preset Manager',
        description: 'Preset library + working slot for Chat Completion presets',
        version: '2.0.0',
    };
}

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
            store.onMutate = () => {
                hub.broadcast({ rev: store.rev, kind: 'preset' });
            };
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

    router.use('/', makeRouter());

    // error forwarder: never swallow (PLAN §1.6)
    router.use((/** @type {any} */ err, _req, res, _next) => {
        const status = err?.status ?? 500;
        if (status >= 500) console.error('[st-preset-manager]', err);
        res.status(status).json({
            error: String(err?.message ?? err),
            ...(err?.conflict ? { conflict: err.conflict } : {}),
        });
    });

    console.log('[st-preset-manager] plugin initialized');
}

export default { info, init };
