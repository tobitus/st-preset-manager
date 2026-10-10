#!/usr/bin/env node
/**
 * Generate dev/data/default-user/settings.json from a READ-ONLY read of the
 * live :8001 settings.json (PLAN §3 dev/reset.sh). Keeps everything, strips
 * proxies/secrets, sets the mock connection, appends the four fixture
 * profiles. Never writes outside dev/data.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const LIVE = path.join(process.env.PM_LIVE_DATA ?? path.join(os.homedir(), 'projects/sillysystem/st/data/default-user'), 'settings.json');
const OUT = process.argv[2] ?? new URL('../dev/data/default-user/settings.json', import.meta.url).pathname;

const settings = JSON.parse(fs.readFileSync(LIVE, 'utf8'));

// strip proxies + secrets
delete settings.proxies;
delete settings.secret_state;
if (settings.oai_settings) {
    delete settings.oai_settings.proxy_password;
    delete settings.oai_settings.reverse_proxy;
    settings.oai_settings.chat_completion_source = 'custom';
    settings.oai_settings.custom_url = 'http://127.0.0.1:8099/v1';
    settings.oai_settings.custom_model = 'mock';
    settings.oai_settings.bind_preset_to_connection = false;
}
// image generation: the live set may point at a local backend (e.g. ComfyUI
// on :8190) that the dev ST pings server-side on every page load; when that
// backend is down the container log fills with FetchError stacks
// (check-phase3 #10). 'extras' only talks to the browser-side Extras URL.
if (settings.extension_settings?.sd) settings.extension_settings.sd.source = 'extras';
// sanitize existing profiles: no secret ids, no proxy references
const cm = settings.extension_settings?.connectionManager;
if (cm?.profiles) {
    for (const p of cm.profiles) {
        delete p['secret-id'];
        delete p.proxy;
    }
    // the four fixture profiles (replace any same-named ones from the live set)
    const fixtures = [
        { name: 'Mock', api: 'custom', model: 'mock', 'api-url': 'http://127.0.0.1:8099/v1', exclude: ['preset'], preset: undefined },
        { name: 'Mock links Default', api: 'custom', model: 'mock', 'api-url': 'http://127.0.0.1:8099/v1', exclude: [], preset: 'Default' },
        { name: 'Kimi via hapuppy', api: 'custom', model: 'hapuppy/kimi-k3', 'api-url': 'http://127.0.0.1:8099/v1', exclude: ['preset'], preset: undefined },
        { name: 'Kimi via nanogpt', api: 'custom', model: 'nanogpt-payg/moonshotai/kimi-k3', 'api-url': 'http://127.0.0.1:8099/v1', exclude: ['preset'], preset: undefined },
    ];
    for (const fx of fixtures) {
        cm.profiles = cm.profiles.filter((/** @type {any} */ p) => p.name !== fx.name);
        cm.profiles.push({
            id: crypto.randomUUID(),
            name: fx.name,
            mode: 'cc',
            exclude: [...fx.exclude],
            api: fx.api,
            ...(fx.preset ? { preset: fx.preset } : {}),
            'api-url': fx['api-url'],
            model: fx.model,
            proxy: 'None',
            'stop-strings': '[]',
            'start-reply-with': '',
            'reasoning-template': '',
            'prompt-post-processing': '',
        });
    }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(settings, null, 4));
console.log(`[seed-settings] wrote ${OUT} (${cm?.profiles?.length ?? 0} cc profiles, fixtures appended)`);
