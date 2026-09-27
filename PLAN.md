# Preset Manager v2 — implementation plan

Spec: `docs/roadmap/014-preset-manager-v2.md` (sillysystem), items 1–23, acceptance 1–18.
Owner-settled items are constraints; open items are decided here with a one-line reason
(§ Decisions). All ST line references are to ST **1.19.0**: `~/tools/ST-dev` is on
1.19.0 and the container image `ghcr.io/sillytavern/sillytavern:1.19.0` has the same
files at the same lines (checked for `openai.js:4341/5020/5078/6017`,
`plugin-loader.js:222`, `server-main.js:202/313`, `events.js:30-92`).

**Goal.** Rebuild the preset manager as an ST UI extension + required server plugin + stdio
MCP wrapper, working on ST's *live* Chat Completion preset through one reserved working
slot, with a library that is the source of truth and survives with no tab open.
Out of scope: text-completion/instruct/context templates, a plugin-free fallback, public
release prep, deploying to the live `:8001`, the owner's one-time import of the 20 presets
(the *mechanism* is in scope; the run against `:8001` data is the owner's step).

---

## 1. Architecture

### 1.1 Components and repo layout (`~/projects/sillysystem/st-preset-manager/`, own git)

```
manifest.json          ST extension manifest (display_name, js: index.js, css: style.css)
index.js               extension entry (ES module, loaded by ST as-is)
style.css
package.json           {"type":"module","main":"plugin/index.js"} — ST loads the plugin
                       via package.json main (src/plugin-loader.js:99-111); devDeps: typescript only
jsconfig.json          checkJs + noEmit type-checking of ext/, plugin/, shared/, mcp/
ext/                   extension modules: bridge.js (live bridge), window.js (floating UI),
                       tabs/{library,presets,diff,io,shelf,settings}.js, st.js (ST access layer)
plugin/                index.js (info/init/exit), routes.js, store.js (fs library),
                       events.js (SSE hub), slot.js (desired state + panel routing)
shared/                pure logic used by BOTH sides and tests, zero deps:
                       schema.js, recognizers.js, outline.js, compile.js, diff.js,
                       groups.js, models.js, st-keys.js (TUNING_KEYS/CONNECTION_KEYS)
mcp/server.js          stdio MCP server (Node, zero deps, JSON-RPC over newline-delimited stdio)
test/*.test.js         node --test, runs on the host (node 22)
dev/                   container scripts + fixtures (see §3); dev/config, dev/data,
                       dev/fixtures, dev/chrome-profile are gitignored
PLAN.md, README.md
```

**One repo root is both the extension root and the plugin package root.** It is
bind-mounted twice into the container: at `public/scripts/extensions/third-party/st-preset-manager`
(ST discovers `manifest.json` there and loads `index.js` as `<script type=module>`,
`public/scripts/extensions.js:813-819`) and at `plugins/st-preset-manager` (loader reads
`package.json.main`). Both sides import `../shared/*.js` relatively, so the shared logic
exists once. Plugin id = `st-preset-manager` (valid per `plugin-loader.js:126`).

**Language: JavaScript (ES modules) with JSDoc types, checked by `tsc --checkJs --noEmit` on
the host.** Reason: ST loads extension files directly as ES modules and the plugin via
`import()` from the mount — a TypeScript build would add a `dist/` that must be built
inside or outside the container and kept in sync on every edit → reload; JSDoc + `tsc`
gives the type checking without a second copy of the code. `subagents-sillytavern/` is
plain JS the same way. Runtime dependencies: **none** (plugin, extension, MCP). Test runner:
`node --test` (built in). Tooling runs **on the host** (node 22.23.1): everything under
`shared/`, `plugin/`, `mcp/` is plain ESM that runs identically on the container's node 24;
a separate node container would buy nothing.

### 1.2 Data model (library documents; format `st-preset-manager/library`, version 1)

One JSON file per preset. Real JSON fields, nothing in comments (item 14).

```jsonc
{
  "format": "st-preset-manager/library", "version": 1,
  "id": "p_01J…",                 // stable ULID; REST addresses by id, filename = sanitized name
  "name": "Freaky Frankenstein 5.4 Internal States (2)",
  "tags": ["ff", "nsfw"],
  "notes": "whole-preset personal notes (never compiled)",
  "source": { "importedFrom": "upload:…json", "importedAt": "…", "importDigest": "sha256",
              "recognizer": { "kind": "ff5|dem|sola|casus|flat", "notes": [] } },
  "settings": { /* every ST preset key that is NOT a tuning key, NOT a connection key,
                   NOT prompts/prompt_order — verbatim passthrough (wi_format, extensions, …) */ },
  "markers": [ { "identifier": "chatHistory", "prompt": { /* verbatim ST marker prompt */ } } ],
  "blocks": { "<identifier>": { "identifier", "name", "content", "role",
                                "fields": { /* other ST prompt fields verbatim */ },
                                "notes": "per-block personal notes" } },
  "sequences": [ { "character_id": 100001, "rows": [ /* v1 outline: leaf {kind: marker|block|ghost,
                   ref, key} | section {key,name,header,rows} | group {key,name,cardinality:
                   pick-one|pick-one-or-more, guessed, header, options:[leaf]} — NO enabled bits */ ] } ],
  "loadouts": { "<loadoutId>": {
      "id", "name", "notes",
      "enabled": { "<identifier>": true|false },          // every leaf (blocks, markers, ghosts)
      "overrides": { "<ModelId>": { "enabled": { "<identifier>": true|false } } }  // item 21: only
                                                          // listed identifiers are "controlled"
  } },
  "activeLoadoutId": "l_…",
  "tuningOverrides": { "<ModelId>": { "temperature": 0.8, /* TUNING_KEYS subset */ } },  // item 16
  "createdAt", "updatedAt", "rev": 17                    // per-document revision (int)
}
```

Layer rules (item 15): **blocks** = `blocks`+`markers`+`sequences`+`settings` (the preset's
content and shape); **loadouts** = on/off + group choice (a pick-one group's choice *is*
"the one member whose `enabled` is true"; `shared/groups.js` enforces ≤1 on every write and
on compile — the last one switched on wins, siblings go off); **tunings** = sampler keys,
global per Model in `models.json`, overridable per preset in `tuningOverrides`.

`TUNING_KEYS` (shared/st-keys.js, explicit list): `temperature, frequency_penalty,
presence_penalty, top_p, top_k, top_a, min_p, repetition_penalty, openai_max_context,
openai_max_tokens, max_context_unlocked, stream_openai, seed, n, reasoning_effort,
verbosity, show_thoughts, squash_system_messages, continue_prefill, function_calling,
enable_web_search, request_images`. `CONNECTION_KEYS` = every `settingsToUpdate` entry
whose 4th flag is `true` (`openai.js:305-409`; e.g. `chat_completion_source`, `*_model`,
`custom_url`, `reverse_proxy`, `proxy_password`) — never stored, never compiled (item 19).
Anything else in an ST preset → `settings` passthrough (v1's hedge, README "Known gaps").

**Global files** (all under the plugin's library root):

- `models.json` — `{ "version": 1, "models": { "<ModelId>": { "id": "m_…", "name": "Kimi K3",
  "matches": [ { "source": "custom", "model": "hapuppy/kimi-k3" }, … ],   // (chat_completion_source, model id)
  "profiles": [ "<connection profile id>", … ], "preferredProfile": "<id>",
  "tuning": { /* TUNING_KEYS subset */ } } } }` (item 22). A raw model id is resolved to a
  Model by exact `(source, model)` match first, then by connection-profile id.
- `state.json` — the working-slot desired state: `{ "rev": 123, "presetId", "loadoutId",
  "modelId", "updatedAt", "lastCompiledHash" }`. `rev` is the **global** monotonic counter,
  bumped by every mutation of any file (library, models, state, shelf) so a tab can ask
  "anything since N?".
- `shelf/<blockId>.json` — `{ id, name, content, role, fields, notes, tags, savedFrom:
  {presetId, identifier}, savedAt }`.
- `revisions/<presetId>/<docRev>.json` — full document snapshots (item 17). Written before
  every mutating op on that preset, **coalesced**: if the newest snapshot is < 5 min old and
  has no label, it is replaced instead of a new one being written (slider drags don't create
  50 revisions); `POST …/revisions {label}` always writes one. Pruned to the newest 200.

**On-disk layout** (single-user: `<dataRoot>/default-user/preset-manager/`, from
`request.user.directories.root` (`src/users.js:683-697`, `constants.js:18`) + `preset-manager`;
multi-user keys everything by that root):

```
preset-manager/
  presets/<folder>/<…>/<Name>.json     real folders = library folders (item 1); move = rename
  models.json  state.json  shelf/  revisions/
```

Tags are the `tags` array in each document; the tag list is computed at scan time. Folders
are filesystem directories; the plugin rebuilds an in-memory index (id → path, name, tags,
folder, updatedAt) at init and after every mutation, plus `POST /rescan` for external edits.
All writes are tmp+rename atomic, all mutations run through one promise queue (single
writer). ST's own 20 presets are imported once through `POST /presets` (item 3).

### 1.3 Working-slot compile (`shared/compile.js`, runs in the plugin)

Input: document `D`, loadout `L = D.loadouts[D.activeLoadoutId]`, Model `M` (may be null),
registry `R`, base `B` = ST's own `OpenAI Settings/Default.json` read from the user's dir at
compile time (so missing keys track the running ST version, not a copy in this repo).

1. `out = pick(B, non-connection keys of settingsToUpdate) ⊕ D.settings`  — a preset that
   lacks a key would otherwise leave the previous preset's value in place, because ST only
   applies `preset[key] !== undefined` (`openai.js:5058`).
2. `out ⊕= R.models[M].tuning ⊕ D.tuningOverrides[M]` (global → preset override, item 21).
3. `enabled = L.enabled ⊕ L.overrides[M].enabled`, then `groups.normalize(D, enabled)`
   (pick-one ≤ 1 on: the override's/last change wins).
4. `out.prompts` = markers (verbatim) + every block as an ST prompt `{identifier, name,
   content, role, ...fields, enabled: enabled[id], marker:false, system_prompt:false}` —
   **no `notes`, no group data**; `out.prompt_order` = one entry per sequence, `order` =
   flattened leaf order (outline flatten), each `{identifier, enabled}`; ghosts ride along.
5. Strip every `CONNECTION_KEYS` key. Return `out` and `hash = sha256(canonical JSON)`.

The compiled preset is exactly what `GET /slot` returns and what the tab writes to the
slot. The block → loadout → override order is item 21's; sampler order is global → override.

### 1.4 Live bridge protocol

**Push mechanism: SSE** (`GET /api/plugins/st-preset-manager/events`). Reason: browser-native
auto-reconnect (`EventSource`) and fan-out to N tabs for free; long-poll would need the
reconnect loop and per-tab cursors written by hand. Constraints read in source: ST's
`compression()` middleware (`server-main.js:107`) buffers streams, so the route sets
`Cache-Control: no-cache, no-transform` (compression honours `no-transform`) and calls
`res.flushHeaders()`; GETs are outside CSRF (csrf-sync checks non-GET only), and the
session cookie rides on the `EventSource` request. Verified early by Phase 1 step 3.

Message: `data: {"rev": N, "kind": "slot|preset|models|shelf", "origin": "<clientId>",
"presetId"?: …}`. On connect the server first sends `hello {rev, desired}`.

- **Desired state + revision counter.** `state.json` (§1.2) is what the slot *should* hold.
  Every mutation bumps `rev`, is applied unconditionally (**most-recent-wins = server receipt
  order**; no client timestamps, no optimistic-lock rejects — item 5), and is broadcast.
- **Tab connect reconciliation.** On extension init: `GET /slot` → `{rev, desired, compiled,
  hash}`. If `desired.presetId` is set, the tab **always applies** `compiled` (acceptance 4:
  API state beats `settings.json`), then opens the SSE stream. Every panel edit was already
  pushed to the plugin at save time (below), so nothing a closed tab did is lost.
- **Applying** = `getPresetManager('openai').savePreset(SLOT, compiled)` (exposed on
  `SillyTavern.getContext()`, `st-context.js:288`; `preset-manager.js:473-509` POSTs
  `/api/presets/save` then `updateList` triggers `change` → `onSettingsPresetChange`,
  `openai.js:5020-5081`, which re-renders the prompt manager via `OAI_PRESET_CHANGED_AFTER`,
  `PromptManager.js:818`). The tab then `await getPresetApplicationPromise()` (import from
  `/scripts/openai.js`, exported at `:5015`) and records `appliedHash = hash`,
  `appliedRev = rev`. Slot name: `⟨PM⟩ working`; the tab uses the name ST returns from
  `/api/presets/save` (sanitized) as the canonical slot name from then on.
- **Echo suppression.** Each tab has a `clientId`; events whose `origin === clientId` and
  whose `rev <= appliedRev` are ignored. Any other `slot` event → `GET /slot` → apply if
  `hash !== appliedHash`.
- **Write-back of ST panel edits (item 3, acceptance 2).** Every prompt-manager and sampler
  change funnels into `saveSettingsDebounced` → `/api/settings/save` → `SETTINGS_UPDATED`
  (`PromptManager.js:443-451/1919-1935`, `openai.js:6776-6780`, `script.js:8109-8110`). On
  `SETTINGS_UPDATED`, if `oai_settings.preset_settings_openai === SLOT`: snapshot
  `S = getChatCompletionPreset(oai_settings)` (`openai.js:4582`), drop connection keys,
  hash; if `hash !== appliedHash` → `POST /slot/panel {clientId, snapshot: S}`. The **plugin**
  diffs `S` against its last compiled output and routes each difference:
  - `prompt_order[].enabled` changed for identifier `i` → `L.overrides[M].enabled[i]` if that
    override lists `i`, else `L.enabled[i]` (item 21). If `i` is a pick-one option turned on,
    its siblings are turned off (acceptance 9).
  - `prompt_order` order changed / prompt content, name, role, fields changed / prompt
    added or deleted → **blocks layer** (`sequences` reordered via outline ops, block fields
    updated, block appended/removed).
  - `TUNING_KEYS` changed → `D.tuningOverrides[M]` if that override exists, else
    `R.models[M].tuning` (mirrors item 21's override-if-it-controls rule; the UI's tuning
    panel has an explicit "override for this preset" switch so intent is visible). With no
    Model resolved, → `D.settings` and a warning event.
  - anything else → `D.settings`.
  Response `{rev, compiled, hash}`; the tab re-applies iff `hash !== hash(S)` (this is how
  a pick-one conflict made in ST's panel collapses back to one option). Other tabs get the
  broadcast.
- **Detached mode.** `PRESET_CHANGED` (`events.js:92`) with a name ≠ SLOT means ST moved off
  the slot (user picked another preset, ST's chat-name auto-select, or a profile — §1.5).
  The bridge stops write-back (never writes a foreign preset into the library) and shows a
  "re-attach" button that re-applies `desired`.
- **Model reporting.** On `CHATCOMPLETION_MODEL_CHANGED` and `CONNECTION_PROFILE_LOADED`
  (`events.js:36,81`) the tab resolves `(oai_settings.chat_completion_source,
  getChatCompletionModel())` + selected profile id → Model via `shared/models.js`, and
  `POST /slot/model {modelId, raw:{source, model, profileId}}`. The plugin recompiles and
  pushes; the tab applies. Unresolved ids are reported (`modelId: null`) so the Settings tab
  can offer "add as new Model".
- No generation interceptor is used, so the `type === 'quiet'` re-entry rule does not apply.

### 1.5 Profile guard and `/profile` model switching (items 19–20)

- **Picker.** Toolbar lists Models from `models.json`. Choosing one runs
  `executeSlashCommandsWithOptions('/profile <preferredProfile name>')` (`st-context.js:171`;
  `/profile` selects the profile and resolves on `CONNECTION_PROFILE_LOADED`,
  `connection-manager/index.js:893-947`); ST applies `api`, `api-url`, `model`, `proxy`… in
  order (`:39-52`, `:396-424`). Then the model-reporting path above applies the tuning and
  the loadout override. The selected preset and loadout are never touched (acceptance 7).
- **Guard.** On `CONNECTION_PROFILE_LOADED(name)`: find the profile in
  `extension_settings.connectionManager.profiles`; if `profile.preset` is set and `'preset'`
  ∉ `profile.exclude`, ST has just run `/preset <that>` and left the slot. v2 shows a dialog
  naming the profile with **Unlink** (push `'preset'` onto `profile.exclude`, `delete
  profile.preset` — the shape `index.js:856-865` writes — then `saveSettingsDebounced()`) and
  re-applies `desired`. `bind_preset_to_connection` is forced `false` once with a toast
  explaining the rule (`openai.js:7301-7304` is the checkbox; `oai_settings.bind_preset_to_connection`).
- **Profile tidy** (Settings tab): lists profiles (read via the tab's `extension_settings`,
  also readable by the plugin from `settings.json` for the seed), marks the ones naming a
  preset, offers *unlink all* and *keep selected / delete rest*, after `GET /profiles/backup`
  (plugin writes `preset-manager/backups/profiles-<iso>.json` from `settings.json` — read
  only) — all edits go through the tab (F-052).

### 1.6 REST API (`/api/plugins/st-preset-manager/…`; JSON; all non-GET need cookie + `x-csrf-token`)

| Method | Path | Body → Result |
|---|---|---|
| GET | `/health` | `{version, rev, libraryRoot}` |
| GET | `/library` | `[{id,name,folder,tags,updatedAt,activeLoadoutId,loadouts:[{id,name}],hasOverrides:[ModelId]}]`, `?tag=` filter |
| GET/PUT/DELETE | `/presets/:id` | native doc (PUT validates via `shared/schema.js`, rejects 400 with the path of the bad field) |
| POST | `/presets` | `{st: <ST preset JSON>, name, folder?, tags?}` (runs recognizers) or `{native: doc}`; 409 `{conflict}` on taken name unless `replace: true` |
| POST | `/presets/:id/fork` | `{name, folder?}` → new doc (new id, block identifiers re-minted) |
| POST | `/presets/:id/move` | `{folder?, name?}` |
| PATCH | `/presets/:id/meta` | `{tags?, notes?, blockNotes?: {id: text}}` |
| POST | `/presets/:id/ops` | `{op, ...args}` — `toggle`, `setGroup`, `setCardinality`, `promote`, `demote`, `moveLeaf`, `editBlock`, `addBlock`, `deleteBlock`, `copyBlock {fromPresetId|shelfId, identifier, before}`, `renameBlock`, `setSettings` → `{doc, rev}` |
| POST/PUT/DELETE | `/presets/:id/loadouts[/:lid]` | `{name, from?}` create (copies `from` or current) / rename / delete (not the last) |
| POST | `/presets/:id/loadouts/:lid/activate` | → recompile if this preset is in the slot |
| PUT/DELETE | `/presets/:id/loadouts/:lid/overrides/:modelId` | `{enabled:{…}}` |
| PUT/DELETE | `/presets/:id/tuning-overrides/:modelId` | `{…TUNING_KEYS}` |
| GET/PUT | `/models` | registry; PUT replaces the whole registry (validated) |
| POST | `/models/seed` | `{profiles?}` (default: read from `settings.json`) → `{models, mergeSuggestions:[[ids…]]}` — one Model per distinct raw id, suggestions grouped by normalized tail (lower-case, provider prefix up to the last `/` dropped); nothing merges without the owner (item 22) |
| GET | `/profiles` | cc profiles from `settings.json` (read-only): `{id,name,api,model,preset?,exclude}` |
| GET | `/slot` | `{rev, desired:{presetId,loadoutId,modelId}, compiled, hash}` |
| POST | `/slot/load` | `{presetId, loadoutId?}` → bumps rev, broadcasts `slot` |
| POST | `/slot/model` | `{modelId, raw}` |
| POST | `/slot/panel` | `{clientId, snapshot}` → `{rev, compiled, hash, routed:[{key,layer}]}` |
| GET | `/events` | SSE (§1.4); `?since=N` replays nothing but sets the initial `hello.rev` comparison |
| POST | `/diff` | `{a:{presetId, rev?}, b:{presetId, rev?}}` → `{rows:[{status: same|changed|moved|only-left|only-right, left?, right?, fields:[…]}], settings:[{key,a,b}]}` (v1 `compare.py` matching: identifier, then normalized name) |
| POST | `/diff/blocks` | `{a:{presetId, identifier, rev?}|{text}, b:{…}}` → `{hunks}` line diff (shared/diff.js, LCS) |
| GET | `/presets/:id/revisions[/:rev]` | list `{rev,at,label}` / snapshot |
| POST | `/presets/:id/revisions` | `{label}` |
| POST | `/presets/:id/restore` | `{rev}` (writes a revision first) |
| GET/POST/DELETE | `/shelf[/:id]` | list / `{fromPresetId, identifier}` or `{block}` / remove |
| GET | `/presets/:id/export?format=st|native` | ST JSON (compiled with the active loadout and **no** tuning/override, groups+notes stripped) or the native doc |
| POST | `/rescan` | rebuild index |

Errors: 4xx/5xx with `{error: message}`; the plugin never swallows — route handlers `await`
and forward to `next(err)`.

### 1.7 MCP wrapper (`mcp/server.js`, item 23)

Node, zero deps, MCP stdio transport (newline-delimited JSON-RPC 2.0: `initialize`,
`tools/list`, `tools/call`). Config via env: `ST_URL` (default `http://127.0.0.1:8002`),
`ST_USER`/`ST_PASSWORD` (optional; multi-user login `POST /api/users/login`). Auth: on start
`GET /csrf-token` (session cookie from `Set-Cookie`, token from the JSON — `server-main.js:192`);
send `Cookie` + `x-csrf-token` on every call; on 403 refresh once and retry. Tools map 1:1 to
REST rows: `library_list, preset_get, preset_import, preset_export, preset_op, loadout_list,
loadout_create, loadout_activate, loadout_set_override, models_list, models_set_tuning,
slot_get, slot_load, slot_set_model, diff_presets, diff_blocks, revisions_list,
shelf_list, shelf_add, shelf_remove`. No logic beyond argument → HTTP → result.
Registration for omp: `.omp/mcp.json` entry `{"st-preset-manager": {"command": "node",
"args": ["<repo>/mcp/server.js"], "env": {"ST_URL": "http://127.0.0.1:8002"}}}` (the
orchestrator adds it in Phase 7).

### 1.8 Extension UI

Floating window (own `div`, jQuery UI draggable/resizable — both are global in ST), opened
from a floating icon and a wand-menu (`#extensionsMenu`) entry. Top tabs: **Library,
Presets, Diff, Import/Export, Shelf, Settings** (item 13). Presets tab: second row of tabs,
one per open preset; each shows the outline (sections/groups/rows) with switches (radio for
pick-one, checkbox otherwise, "none" radio), promote/demote/move, content editor with notes,
loadout picker + per-Model override editor, tuning panel (global vs "override for this
preset"), and a **right-hand shelf list** (item 10, toggleable). Drag: jQuery UI sortable on
every row list with `connectWith` across open presets and the shelf (same mechanism ST's
prompt manager uses, `PromptManager.js:1919`; drivable headlessly via mouse events).
Diff tab: **one rendered two-column table in a single scroll container** (rows = matched
pairs or one-sided rows in left order; moved rows carry a "moved from #n" badge); the bottom
row is the line diff of the selected pair; the pickers accept any open/library preset, any
revision, or any single block ("block A vs block B", acceptance 12). Missing plugin:
`GET /health` fails → the window shows only the install notice; nothing else initialises.

---

## 2. Phases

Each phase loops implement → review → run its acceptance in the `st-pm-dev` container
until green. Later phases add to the schema only by adding optional fields; the
document/registry shapes above are final from Phase 1 (loadouts, overrides, tuning
overrides, notes, tags all exist from the start even where the UI to edit them comes later).

Common tooling used by every phase (built in Phase 1): `dev/st-api.sh` (curl with cookie
jar + CSRF: `dev/st-api.sh GET /slot`, `dev/st-api.sh POST /slot/load '{"presetId":…}'`),
`dev/probe.mjs` (drives system Chromium over raw CDP with `--user-data-dir=dev/chrome-profile`,
evaluating in the page's main world via `Runtime.evaluate`, see §3 Browser recipe, and prints
JSON results; subcommands `oai`
(preset name, prompt_order, prompts, temperature), `dom` (prompt-manager rows + toggles as
rendered), `click <selector>`, `set-slider <id> <value>`, `profile <name>`, `generate <text>`),
and `dev/mock-llm.js` (`GET http://127.0.0.1:8099/last` → the last chat-completion request
body ST sent). "Observe ST" below always means these, never a unit test.

### Phase 1 — plugin library + working slot + live bridge (acceptance 1–5)

**Scope.** `shared/schema.js`, `st-keys.js`, `compile.js`, `groups.js`, `outline.js`
(flatten/rebuild only), `recognizers.js` (port of v1 `importer.py` incl. `flat`), plugin
store/routes/events/slot, `POST /presets` import, `/library`, `/presets/:id` GET/PUT,
`/slot/*`, `/events`, extension `index.js` + `ext/st.js` + `ext/bridge.js` + a minimal
window with Library tab (list, tags, "load into slot", loadout select) and the missing-plugin
notice. `dev/` scripts and fixtures (§3). No editor, no diff, no shelf, no Settings UI.

**Checks** (after `dev/up.sh && dev/reset.sh`):
1. `dev/st-api.sh GET /health` → 200 `{rev: 0}`; container log shows
   `Initializing plugin from …/plugins/st-preset-manager/plugin/index.js`.
2. Import: `for f in dev/fixtures/presets/*.json; do dev/st-api.sh POST /presets "{\"st\":$(cat "$f"),\"name\":…}"; done` → 20 docs in `dev/data/default-user/preset-manager/presets/`;
   `GET /library` lists 20; `GET /presets/<id>` for FF 5.4 shows 8 groups.
3. **SSE through compression:** `curl -N --cookie-jar … …/events` prints `data: {"kind":"hello"…}`
   within 1 s (not buffered until close). If it does not, the `no-transform` header is wrong — fix before anything else.
4. **Acceptance 1.** `dev/st-api.sh POST /slot/load '{"presetId":<FF54>}'`; open a tab
   (`dev/probe.mjs oai`) → `preset_settings_openai === "⟨PM⟩ working"`, `prompt_order[0].order`
   equals `GET /slot`.compiled.prompt_order (identifiers + enabled), `dev/probe.mjs dom`
   shows the same rows/toggles; `dev/probe.mjs generate hi` then `curl :8099/last` →
   messages equal the enabled blocks' contents in order (markers expand per ST; compare the
   non-marker system messages). Also visible in Prompt Inspector's popup if mounted.
5. **Acceptance 2.** `dev/probe.mjs click '[data-pm-identifier="<kimi block>"] .prompt-manager-toggle-action'`
   → within 2 s `GET /presets/<id>` shows `loadouts[active].enabled[<kimi>]` flipped and no
   override created; `dev/probe.mjs set-slider temp_openai 0.42` → with no Models defined
   yet (registry is empty until Phase 4 seeds it) the plugin routes it to the doc's
   `settings.temperature` and emits a `warning` event; `GET /slot`.compiled.temperature is
   0.42. The "goes to the current Model's tuning" half of acceptance 2 is re-run in Phase 4 check 3.
6. **Acceptance 3.** Tab open, `POST /slot/load` of Sola → `dev/probe.mjs oai` (no reload)
   shows Sola's rows; `POST /presets/<sola>/ops {op:'toggle',…}` → the toggle appears in the DOM.
7. **Acceptance 4.** Close the tab (probe exits), `POST /slot/load` DEM, then `settings.json`
   still says the previous preset; open a tab → `oai` reports DEM's order and `⟨PM⟩ working`.
8. **Acceptance 5.** Two probe tabs A and B on the same preset: A toggles block X on, then the
   API toggles X off → both `oai` reports show X off; A's toggle after that → both show on.
   Tab + API on `temperature` the same way; the later write is what `GET /slot` and both tabs show.
9. **Acceptance 15** (cheap here): `dev/up.sh --no-plugin` → tab shows the install notice,
   `settings.json` mtime unchanged apart from ST's own load-save, no `⟨PM⟩ working` in `OpenAI Settings/`.
10. Host: `npm test` (compile/groups/recognizer unit tests) and `npm run typecheck` pass.

**Must NOT.** Write `settings.json` or any ST preset file from the plugin; write to the
slot from anything but `getPresetManager('openai').savePreset`; add a generate interceptor;
add runtime dependencies; store connection keys; touch `~/tools/ST-dev` or `:8001`.

### Phase 2 — editor: outline ops, groups, notes, drag, fork (acceptance 6, 9, 14)

**Scope.** Port v1 `outline.py` (promote/demote/moveLeaf with the marker rules and the
`_gmeta/_sname` inverse bookkeeping) and `ops.py`; `/presets/:id/ops`, loadouts CRUD +
activate, `PATCH …/meta`; Presets tab with the outline editor, switches, keyboard shortcuts
(Tab/Shift+Tab/Alt+↑↓), content + notes editors, loadout picker, jQuery UI sortable.

**Checks.**
1. **Acceptance 6.** Create loadout B from A, change 3 toggles + a pick-one choice via the UI;
   activate A → `oai` equals the snapshot taken before; B → the changed one; A again → identical to the first snapshot (byte-compare `prompt_order`).
2. **Acceptance 9.** In ST's own panel turn on a second option of FF's "POV" pick-one group →
   within 2 s `dom` shows exactly one on (the one just clicked); `GET /slot`.compiled contains
   no `notes`/`groups`/`cardinality` strings (`grep -c` on the JSON = 0) and neither does
   `GET …/export?format=st`.
3. **Acceptance 14.** Drag a single row two positions down (probe drives mouse on the sortable
   handle) and a group header with its options → `oai` `prompt_order` shows the new order;
   `smoke` invariant: identifier multiset and enabled bits unchanged (port of v1 smoke (c)).
4. Host: `test/outline.test.js` ports v1 smoke (a)(b)(d)(e): random promote/demote leaves the
   compiled prompts byte-identical; demote∘promote restores identical `sequences`; markers refuse to become heading/option.

**Must NOT.** Change the document schema; put enabled bits back into `sequences`; auto-collapse
a pick-one conflict in the UI (show the ⚠ badge; only the *compile/routing* normalises).

### Phase 3 — import/export, recognizer parity, round trip (acceptance 10, 11)

**Scope.** Import/Export tab (file picker, ST-list import through the tab's
`openai_settings`, drop zone), native export/import, `dev/parity.mjs`.

**Checks.**
1. **Acceptance 10.** `dev/parity.mjs`: for each of `DEUS.EX.MACHINA.V2.5.ST.json`,
   `Sola V2 Flame.json`, `Freaky Frankenstein 5.4 Internal States (2).json` run v1
   `python3 -c "from pmcore.importer import import_preset; …"` (read-only, from
   `tools/preset-manager/`) and the JS recognizer; compare the group list (name, cardinality,
   ordered member identifiers) and section list → identical. Import `FrankenSIM.2.5.Release.1.json`
   and a non-preset JSON (`FF5 Regex 3.0 Suite.json`) → flat doc / clean 400, no crash in the container log.
2. **Acceptance 11.** Export FF 5.4 to ST format; `dev/reset.sh` (clean ST); import the export
   via ST's own preset import (probe drives `#openai_preset_import_file`), select it, `oai` +
   `:8099/last` equal those of the source file selected the same way (same enabled set, order,
   injection positions/depths). Native: `GET export?format=native` → `POST /presets {native}` → the two docs are `deepEqual` apart from `id`/`createdAt`.

**Must NOT.** Change recognizer heuristics to "improve" on v1 in this phase (parity first;
improvements are a separate later change with the owner).

### Phase 4 — Models, tunings, overrides, model switch, profile guard & tidy (acceptance 7, 8, 16, 17; re-run 2)

**Scope.** `models.json` + seed, Settings tab (Models editor with merge suggestions, profile
list/tidy, backup), tuning panel with override switch, per-Model loadout override editor,
toolbar model picker, `/slot/model`, guard dialog, `bind_preset_to_connection` handling.

**Checks** (fixture profiles from §3: `Mock`, `Mock links Default`, `Kimi via hapuppy`,
`Kimi via nanogpt`, all `custom` source against the mock).
1. Seed: `POST /models/seed` → one Model per distinct id in the fixture profiles; `mergeSuggestions`
   contains `[hapuppy/kimi-k3, nanogpt-payg/moonshotai/kimi-k3]`; merge them in the UI → one `Kimi K3` with two matches.
2. **Acceptance 7.** Set `Kimi K3` global temperature 0.3 and the FF preset's override 0.9;
   set `Mock` Model temperature 1.1. Pick `Kimi K3` in v2's toolbar → ST's connection panel
   (`dom` on `#connection_profiles` selected text, `#custom_model_id`, `#chat_completion_source`)
   shows the Kimi profile/model; `oai.temperature === 0.9`; preset and loadout unchanged.
   Pick `Mock` → temperature 1.1; back to Kimi → 0.9. Load a preset without an override → 0.3.
3. **Acceptance 2 (model part).** With Kimi active, `set-slider temp_openai 0.55` → the FF
   preset's `tuningOverrides["Kimi K3"].temperature === 0.55` (override existed); on a preset
   without one → `GET /models` global `0.55`.
4. **Acceptance 16.** Loadout override for Kimi K3: `{enabled: {<kimi block>: true}}`, loadout
   itself has it off. Switch to Kimi → `dom` shows it on; switch to Mock → off;
   `GET /presets/<id>` loadout `enabled[<kimi>]` still `false` throughout. Toggle it in ST's
   panel while Kimi is active → the override changes, not the loadout.
5. **Acceptance 17.** `dev/probe.mjs profile "Kimi via nanogpt"` (ST's own dropdown, not v2) →
   same temperature/override state as via `Kimi via hapuppy`.
6. **Acceptance 8.** `dev/probe.mjs profile "Mock links Default"` → v2's dialog names that
   profile; click Unlink → `extension_settings.connectionManager.profiles[..].exclude` contains
   `preset`, the slot is re-applied (`oai` back on `⟨PM⟩ working`).
7. Tidy: keep 2 profiles, delete the rest → `preset-manager/backups/profiles-*.json` has all
   originals; `settings.json` (after the tab's save) has 2.

**Must NOT.** Write `settings.json` from the plugin; change preset or loadout on model switch;
merge model ids automatically; read `secrets.json`.

### Phase 5 — diff 2×2 and revisions (acceptance 12)

**Scope.** `shared/diff.js` (LCS line diff), port of `compare.py`, `/diff`, `/diff/blocks`,
revisions endpoints + coalescing, Diff tab.

**Checks.**
1. Diff FF 5.4 `Internal States (2)` vs `Hapuppy Forced Reasoning (1)` → the Kimi row is
   `changed` (v1 README's known result); a preset vs itself → all `same`.
2. **Acceptance 12.** UI: both columns are one scroll container (probe: scroll the container,
   read `scrollTop` of the single element; there is no second scrollable); move a block in a
   fork → the pair renders as `moved` with the badge; click a `changed` row → bottom row shows
   the line diff (`dom` reads `.pm-diff-hunk` text). Diff FF vs its revision 3 → rows come
   from the snapshot. Diff block A of DEM vs block B of Sola, and two blocks of the same preset → hunks render.
3. Revisions: 10 rapid toggles create 1 snapshot; a labelled save creates another; `restore` writes a snapshot first and the slot updates.

**Must NOT.** Add a second scroll pane "for now"; add a diff dependency.

### Phase 6 — shelf and cross-preset copy (acceptance 13)

**Scope.** `shelf/` store + endpoints, Shelf tab, right-hand shelf list in the Presets tab,
`copyBlock` from shelf/other preset with a `before` anchor, identifier re-minting, macro
warnings (v1 rules).

**Checks.** **Acceptance 13.** Save DEM's `「 Present 」` to the shelf; open Sola; drag the
shelf item onto the third row → `GET /presets/<sola>` has the new block at index 2 with a fresh
identifier; `oai` shows it there in ST. Copy a whole group from FF to Sola via drag → lands
at the drop point; markers refuse to copy (400 + toast).

**Must NOT.** Transfer markers; reuse identifiers.

### Phase 7 — MCP wrapper (acceptance 18)

**Scope.** `mcp/server.js`, `README` section, `.omp/mcp.json` entry (orchestrator).

**Checks.** **Acceptance 18.** From an omp session with the server registered: `library_list`
equals `GET /library`; `slot_load {presetId, loadoutId}` → `oai` shows it; `diff_blocks` of
two unrelated blocks equals `POST /diff/blocks`. No cookie/CSRF appears in any tool argument.
Also: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize",…}' | node mcp/server.js`
answers with the tool list. If omp rejects the hand-rolled transport, switch to
`@modelcontextprotocol/sdk` for the MCP process only (the one allowed dependency; the plugin stays dep-free).

**Must NOT.** Put logic in the MCP layer; read `settings.json`/cookies from disk.

Coverage map: 1–5 P1 · 15 P1 · 6, 9, 14 P2 · 10, 11 P3 · 2(model), 7, 8, 16, 17 P4 · 12 P5 · 13 P6 · 18 P7.

---

## 3. Environment: the `st-pm-dev` container (owner direction 2026-09-27)

Test target is a podman container from the **same image the owner runs**,
`ghcr.io/sillytavern/sillytavern:1.19.0` (already pulled), on `127.0.0.1:8002`. Never
`:8001`, never `~/tools/ST-dev` (no plugin enabling or symlinks there — those steps are dropped).

How the live container does it (read via `podman inspect sillytavern`, 2026-09-27):
`NetworkMode: host`, no port bindings, entrypoint `tini -- ./docker-entrypoint.sh` which runs
`npm run init` then `exec node server.js --listen`; config has `listen: false`,
`listenAddress.ipv4: 127.0.0.1`, `port: 8001`, `whitelistMode: true`, whitelist
`::1, 127.0.0.1, 100.64.0.0/10, fd7a:…/48`, `whitelistDockerHosts: true`,
`enableServerPlugins: true`, `enableServerPluginsAutoUpdate: true`, `enableUserAccounts: false`,
`disableCsrfProtection: false`. Host networking is why the loopback whitelist works: the
browser's source address is `127.0.0.1` inside the container too. Rootless podman maps
container root to `jon`, so bind-mounted files stay owned by `jon` (checked on `st/data`).

**`dev/up.sh`** (idempotent; `--no-plugin` variant for acceptance 15):
1. `mkdir -p dev/config dev/data dev/chrome-profile`; if `dev/config/config.yaml` is missing,
   copy `~/projects/sillysystem/st/config/config.yaml` (READ ONLY source) and edit the copy:
   `port: 8002`, `enableServerPluginsAutoUpdate: false` (the plugin dir is a git root with no
   upstream; the auto-updater would log a failure every start, `plugin-loader.js:243-262`),
   `enableExtensionsAutoUpdate: false` if present, everything else as live (whitelist,
   `enableServerPlugins: true`, CSRF on).
2. `podman run -d --name st-pm-dev --network host --hostname st-pm-dev --restart no
   -e SILLYTAVERN_HEARTBEATINTERVAL=30
   -v $REPO/dev/config:/home/node/app/config
   -v $REPO/dev/data:/home/node/app/data
   -v $REPO:/home/node/app/plugins/st-preset-manager
   -v $REPO:/home/node/app/public/scripts/extensions/third-party/st-preset-manager
   -v ~/projects/sillysystem/st/extensions/Extension-PromptInspector:/home/node/app/public/scripts/extensions/third-party/Extension-PromptInspector:ro
   ghcr.io/sillytavern/sillytavern:1.19.0`
   (`--no-plugin` omits the `plugins/` mount). `--hostname` changes `os.hostname()` and thus
   the session cookie name `session-<sha256(hostname)[:8]>` (`src/users.js:612-617`), so a
   human browser holding `:8001` and `:8002` tabs does not get the F-050 CSRF collision.
   **Verify in step 4; if podman refuses `--hostname` with host networking, drop it** and rely on
   the separate headless profile.
3. Start `dev/mock-llm.js` on `127.0.0.1:8099` (pid file `dev/mock.pid`): `GET /v1/models` →
   `{data:[{id:"mock"}]}`; `POST /v1/chat/completions` → stores the body, answers a fixed
   completion (streaming SSE when `stream:true`); `GET /last` → the stored body. ST's
   `custom` source needs no API key (`src/endpoints/backends/chat-completions.js:2615`).
4. Wait for `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8002/` = `200`, then
   `curl -si http://127.0.0.1:8002/csrf-token | grep -i set-cookie` (cookie name ≠ live's)
   and `podman logs st-pm-dev | grep -i 'plugin'` shows the plugin initialised (or, with
   `--no-plugin`, nothing).

**`dev/reset.sh`** — `podman stop st-pm-dev`; delete the `dev/data` tree; rebuild:
- `dev/data/default-user/OpenAI Settings/` ← the 20 files from
  `~/projects/sillysystem/st/data/default-user/OpenAI Settings/` (copies) — these are ST's
  dropdown presets *and* the Phase 1 import source (`dev/fixtures/presets/` = the same 20 plus
  `presets/**/*.json` from the sillysystem corpus, copied once by `dev/fixtures.sh`; both dirs gitignored).
- `dev/data/default-user/settings.json` ← generated by `dev/seed-settings.mjs` from a
  **read-only** read of the live `settings.json`: keep everything, strip `proxies`,
  `oai_settings.proxy_password`, `oai_settings.reverse_proxy`, every profile's `secret-id` and
  `proxy`; set `main_api: openai`, `oai_settings.chat_completion_source: custom`,
  `custom_url: http://127.0.0.1:8099/v1`, `custom_model: mock`, `bind_preset_to_connection:
  false`; append four cc profiles: `Mock` (custom, mock, `exclude:['preset']`),
  `Mock links Default` (same but `preset: 'Default'`), `Kimi via hapuppy` (custom, model
  `hapuppy/kimi-k3`, exclude preset) and `Kimi via nanogpt` (custom, model
  `nanogpt-payg/moonshotai/kimi-k3`, exclude preset). The 56 live profiles stay so the seed
  (Phase 4) and tidy run against the real shape. No `secrets.json` is copied.
- `podman start st-pm-dev`. This is acceptance 11's "clean ST".

**`dev/down.sh`** — `podman stop st-pm-dev && podman rm st-pm-dev`; kill the mock. Data stays.

**Browser recipe** (`dev/probe.mjs`, orchestrator correction 2026-09-27): a plain Node script
cannot call omp's `browser` tool, so the probe drives **system Chromium over raw CDP** with
zero deps. It spawns `/usr/bin/chromium-browser --headless=new --window-size=1500,950
--remote-debugging-port=<free port> --user-data-dir=<repo>/dev/chrome-profile[-<tab>]
http://127.0.0.1:8002/`, reads `/json/list`, connects with Node 22's global `WebSocket`, and
uses `Runtime.evaluate` (`awaitPromise`, `returnByValue`). CDP's `Runtime.evaluate` runs in the
page's **main world**, so `SillyTavern.getContext()` is directly reachable. F-051 is an omp
`evaluate` limitation and does not apply. The separate profile dir isolates cookies from any
live tab (F-050); two tabs (acceptance 5) use two profile dirs, or two targets in one
instance. No request blocking is needed, because this instance's `settings.json` is disposable.
The probe must kill Chromium on exit, so acceptance 4's "no tab open" holds (check: `GET
/health` reports the number of open `/events` clients as `clients`).

**Host tooling**: `npm install` (typescript only), `npm test` = `node --test test/`,
`npm run typecheck` = `tsc -p jsconfig.json`. Nothing is built; the container reads the
working tree, so a change is live on tab reload (extension) or `podman restart st-pm-dev`
(plugin — ST imports the plugin once at start, `plugin-loader.js:151`).

---

## 4. Decisions (spec left open → decided here)

| Decision | Alternative rejected | Why |
|---|---|---|
| SSE push | long-poll | native reconnect + fan-out; only cost is the `no-transform` header for ST's compression middleware |
| Server receipt order = "most recent" | client timestamps | one writer, no clock skew, no rejects; item 5 wants last-wins not merge |
| Plugin routes panel edits (tab sends snapshot) | tab computes the layer diff | keeps group/override logic in one place shared by REST/MCP/UI; unit-testable |
| Tab is the only writer of the ST slot file, via `PresetManager.savePreset` | plugin writes `OpenAI Settings/⟨PM⟩ working.json` | a file write changes nothing in an open tab (`openai_settings` is cached in the page, `openai.js:4321-4335`); item 3 names `/api/presets/save` |
| Always apply `desired` on tab connect | compare with `settings.json` first | acceptance 4; every panel edit already reached the plugin at save time |
| Panel sampler edit → preset override if it exists, else global tuning | always global / always override | same rule as item 21 for blocks; visible switch in the tuning panel |
| Compile base = ST's own `Default.json` | copy of `default_settings` in the repo | tracks the running ST version; ST leaves absent keys untouched (`openai.js:5058`) |
| Loadout = one `enabled` map for all leaves; group choice derived | separate `groups` map | one invariant (pick-one ≤ 1) instead of two structures to keep in sync |
| One document per preset, folders = directories, tags = array in doc | index file / DB | real folders were asked for; ~50 files scan in ms; no migration story needed |
| Revisions = full snapshots, coalesced 5 min, labelled always, keep 200 | diffs / per-op log | trivial restore and diff-against-revision; the coalescing keeps slider drags from flooding |
| Repo root = extension root = plugin package root, mounted twice | `extension/` + `plugin/` subdirs | shared code must be reachable from both mounts; one clone installs both for release |
| JS + JSDoc + `tsc --checkJs`, no build | TypeScript with `dist/` | ST loads sources directly; no second copy to forget |
| Zero runtime deps; MCP hand-rolled stdio JSON-RPC | MCP SDK | dependency-free plugin dir mounts as-is; SDK is the fallback for the MCP process only |
| Tooling on host node 22 | node container | pure ESM; nothing version-specific |
| Diff top row = one two-column table in one scroll box | two panes with synced scroll / connector lines | shared scrolling for free; moved rows get a badge; lines add SVG work for little gain |
| Shelf = toggleable right-hand list in the Presets tab + its own tab | tab only | item 10's ask; drop target must be next to the outline |
| jQuery UI sortable everywhere | HTML5 DnD | what ST uses; `connectWith` gives cross-list drops; drivable by mouse events |
| Model seed = one Model per raw id + merge suggestions | auto-merge by normalized id | spec: owner confirms merges |
| Model resolution: `(source, model)` exact, then profile id | model id only | the same id string under two sources are different endpoints; profile id is the owner's own naming |
| Detached mode when ST leaves the slot | force back immediately | a deliberate pick of another ST preset must not be fought; the guard covers the profile case |
| Slot name `⟨PM⟩ working`, canonical = the name ST returns | ASCII name | spec example; `sanitize-filename` keeps it (only `/?<>\:*|"` and controls are stripped), and reading it back avoids depending on that |

Owner's call, not mine: whether the fixture profiles above are the right fakes for "Kimi
K3" (they only need to be two ids under one Model); the merge of the three real Kimi ids
(item 22).

---

## 5. What could go wrong (ranked), and where it shows

1. **`getPresetManager('openai').savePreset` applies but ST's `settingsToUpdate` loop
   skips connection keys and leaves absent keys alone** → a stale value from the previous
   preset survives. Detected in Phase 1 check 6 (load Sola after FF; compare *every*
   compiled key with `oai`). Mitigation is the Default.json base (§1.3).
2. **Write-back echo loop**: apply → `SETTINGS_UPDATED` → snapshot ≠ compiled (ST
   normalises something, e.g. `migrateChatCompletionSettings`, `sanitizeServiceSettings`
   adding identifiers) → `/slot/panel` → recompile → apply → … Detected in Phase 1 check 4:
   `/health.rev` must stop moving within 2 s of a load. Fix = compare after the same
   normalisation, not by widening the ignore list.
3. **SSE buffered by `compression()`** — Phase 1 check 3, before any UI exists.
4. **`--hostname` with `--network host` refused by podman** — `dev/up.sh` step 4; fallback stated.
5. **ST's chat-name auto-select (`preset-manager.js:992`) moves ST off the slot** when a
   character is named like a preset — detached mode covers it; Phase 1 check 4 uses a
   character with no such name; documented in README.
6. **Two tabs write `settings.json` alternately (F-003/F-052)** so the *file* flips; the
   library does not care (plugin state is authoritative) but acceptance 4 reads the *tab*,
   not the file — the check is written that way on purpose.
7. **Recognizer parity drift** (Unicode regex semantics differ between Python `re` and JS):
   Phase 3 check 1 compares against v1's actual output, not the README's prose.
8. **Prompt-manager DOM selectors** (`[data-pm-identifier]`, `.prompt-manager-toggle-action`,
   `PromptManager.js:444/1781`) change in a later ST — probes fail loudly; the extension
   itself never reads the DOM, only `oai_settings`.
9. **`custom` source status check** hits `custom_url/models`; if the mock's shape is
   rejected ST shows "no connection" but still generates? Not established — Phase 1 check 4
   observes `:8099/last`; if ST refuses to generate without status, the mock's `/models`
   answer is the first thing to fix.
10. **MCP transport details** (framing, `initialize` result shape) — Phase 7 has the SDK fallback.
11. **Plugin routes run after `requireLoginMiddleware`** (`server-main.js:251` vs `:313`) so
    `request.user` exists — read in source; if a future ST mounts plugins earlier, `/health`
    500s on the first request (Phase 1 check 1).

---

## 6. Assumptions

Confirmed by reading:
- Plugin router mount and package.json loading: `src/plugin-loader.js:99-111, 222`.
- CSRF global, before plugins; `/csrf-token`; cookie name from hostname: `src/server-main.js:167-202, 313`; `src/users.js:612-617`.
- Body parser and compression precede everything: `server-main.js:106-113`.
- `/api/presets/save` writes `<name>.json` under `directories.openAI_Settings`: `src/endpoints/presets.js:19-53`.
- `settingsToUpdate` shape and the connection flag; preset apply skips `undefined` keys and connection keys when unbound; `OAI_PRESET_CHANGED_AFTER`/`PRESET_CHANGED` order: `openai.js:305-409, 5020-5081`.
- `getChatCompletionPreset`, `getPresetApplicationPromise` exported: `openai.js:4582, 5015`.
- Prompt manager edits go through `saveServiceSettings` → `saveSettingsDebounced` → `SETTINGS_UPDATED`: `PromptManager.js:443-451, 1919-1935`; `openai.js:702-705`; `script.js:8109-8110`.
- `getContext()` exposes `getPresetManager`, `executeSlashCommandsWithOptions`, `chatCompletionSettings`, `extensionSettings`, `eventSource/eventTypes`, `getChatCompletionModel`: `st-context.js:128-289`.
- `PresetManager.savePreset/updateList/selectPreset`: `preset-manager.js:405-509, 610-645`.
- Connection profile fields, `exclude` semantics, `/profile` awaiting `CONNECTION_PROFILE_LOADED`: `connection-manager/index.js:39-52, 215-223, 396-424, 856-865, 893-947`.
- Extensions are loaded as `<script type=module>` from `/scripts/extensions/<name>/<manifest.js>`: `extensions.js:813-819`.
- `custom` chat-completion source needs no key: `chat-completions.js:2615`.
- `request.user.directories.root` exists: `constants.js:18`, `users.js:683-697`.
- Live container run shape: `podman inspect sillytavern` (host network, mounts, entrypoint), image `docker-entrypoint.sh` (always `--listen`).

**Unverified (must be checked at the step named):**
- `compression` honours `Cache-Control: no-transform` for SSE — Phase 1 check 3.
- podman accepts `--hostname` with `--network host` — `dev/up.sh` step 4.
- ST starts cleanly with a pre-seeded `default-user/settings.json` and no other dirs — first `dev/reset.sh`.
- ST generates against the `custom` source without a passing status check — Phase 1 check 4.
- `sanitize-filename` keeps `⟨PM⟩` — Phase 1 check 4 reads the returned name either way.
- jQuery UI sortable is drivable by synthetic mouse events in headless Chromium — Phase 2 check 3 (v1 used HTML5 DnD; if sortable resists, the fallback is HTML5 DnD on v2's own lists, which changes nothing in the data model).
- The omp MCP client accepts the hand-rolled stdio transport — Phase 7.
- Tailscale `serve` passes SSE without buffering (laptop use) — not tested by any phase; noted for the owner.

---

## 7. Not considered

Multi-user ST (the layout keys by user root but nothing is tested that way); ST versions
other than 1.19.0; text-completion presets; per-character `prompt_order` beyond passing
extra `character_id` sequences through; localisation; mobile layout; migration of v1's
`store/` documents (v1 stays; the owner re-imports from ST files — a v1→v2 converter is a
small later add-on if wanted); public-release packaging; what the release install path looks
like for the plugin half (one repo cloned into both `plugins/` and `third-party/` is the
intended story, untested).
