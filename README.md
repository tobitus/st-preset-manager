# Preset Manager v2 (Phase 1)

An ST **UI extension + required server plugin** that manages SillyTavern's live
Chat Completion preset through one reserved working slot (`⟨PM⟩ working`).
The library on the plugin side is the source of truth and survives with no
tab open (roadmap 014, acceptance 4).

Phase 1 scope: plugin library (import via recognizers, REST, revisions),
working-slot compile, SSE live bridge, a minimal Library window, and the
`dev/` tooling. No editor, diff, shelf or Settings UI yet (Phases 2–5).

## Layout

```
manifest.json        ST extension manifest (loads index.js as a module)
index.js             extension entry: plugin check, bridge, window
ext/st.js            the only module that touches ST internals
ext/bridge.js        SSE push, tab reconciliation, panel write-back
ext/window.js        floating window (Library tab)
plugin/index.js      plugin entry (package.json main); routes, store, hub
plugin/store.js      fs library: presets/, models.json, state.json, shelf/, revisions/
plugin/routes.js     REST under /api/plugins/st-preset-manager
plugin/events.js     SSE hub (no-transform for ST's compression())
plugin/slot.js       desired state + panel-diff layer routing
shared/              pure logic used by plugin, extension and tests:
                     schema, recognizers (v1 port), outline, compile, groups,
                     models, st-keys, compare (v1 port), diff (LCS), util
                     (node-only) and canonical (browser-safe)
test/                node --test unit tests (host, node 22)
dev/                 container scripts + fixtures (gitignored: config, data,
                     fixtures, chrome-profile*, *.pid)
```

The repo root is **both** the extension root and the plugin package root; the
dev container bind-mounts it twice
(`plugins/st-preset-manager` + `public/scripts/extensions/third-party/st-preset-manager`).

## Running the dev environment

```
npm install                 # typescript (+ @types) only, for typecheck
dev/fixtures.sh             # copy the 20 ST presets + corpus into dev/fixtures/presets
dev/up.sh                   # st-pm-dev container on 127.0.0.1:8002 + mock LLM on :8099
dev/reset.sh                # clean dev/data (ST presets + seeded settings.json), restart
dev/up.sh --no-plugin       # acceptance-15 mode (extension shows install notice)
dev/down.sh                 # stop + remove container and mock; data stays
```

API helper (cookie jar + CSRF): `dev/st-api.sh GET /slot`,
`dev/st-api.sh POST /slot/load '{"presetId":"…"}'`.

Browser probe (raw CDP over system Chromium, zero deps): `dev/probe.mjs oai`,
`dev/probe.mjs dom`, `dev/probe.mjs click <selector>`, `dev/probe.mjs
set-slider <id> <value>`, `dev/probe.mjs generate hi`, `dev/probe.mjs hold`,
`dev/probe.mjs stop`.

## REST (Phase 1 subset)

`GET /health` · `GET /library` · `POST /rescan` · `POST /presets` (`{st,name}`
import running the recognizers, or `{native}`) · `GET/PUT/DELETE
/presets/:id` · `GET /presets/:id/revisions[/:rev]` · `GET /slot` ·
`POST /slot/load` · `POST /slot/model` · `POST /slot/panel` · `GET /events`
(SSE) · `GET /models` · `GET /profiles` · `GET/POST/DELETE /shelf[/:id]`.

All non-GET need the session cookie + `x-csrf-token` (as ST requires).
Errors: 4xx/5xx `{error: message}`.

## Tests

```
npm test                    # compile/groups/outline/recognizers/store/slot-routing
npm run typecheck           # tsc --checkJs over ext/, plugin/, shared/, test/
```

## Known gaps (Phase 1 by design)

- No editor/diff/shelf/Settings UI; the window is Library-only.
- Panel edits in ST (toggle/sampler) write back through `/slot/panel` — the
  full routing incl. per-model loadout overrides is exercised in Phase 4.
- Model registry is read-only in Phase 1 (`GET /models`); seeding is Phase 4.
- The plugin never writes `settings.json` or any ST preset file; the tab
  writes the slot via ST's own `getPresetManager('openai').savePreset`.

## Dev-environment notes

- `dev/up.sh` runs the container with `--security-opt label=disable`: this
  host runs SELinux, and the bind-mounted config file is unreadable inside a
  default podman run (EACCES on `config.yaml`), while the live `sillytavern`
  container was started before the label mattered. Verified 2026-09-27.
- The mock LLM answers `/v1/chat/completions` (SSE when `stream:true`) and
  keeps the last request body at `GET :8099/last`.

## Phase 4: Models, tunings, model switching, profile guard and tidy

- **Models** (`models.json`, keyed by Model name): Settings tab → *Seed from
  profiles* adds one Model per distinct `(source, model)` in the tab's
  connection profiles; *Merge suggestions* group ids with the same tail
  (lower-case, provider prefix dropped). Nothing merges until you tick the
  ids, name the Model and click *Merge*. Each Model lists its ids, its
  profiles and the profile it switches through (*Switch via*).
- **Toolbar Model picker** runs `/profile <Switch via profile>`; the preset
  and loadout never change. The tab reports every model/profile change
  (`POST /slot/model {raw}`); the plugin resolves the Model and recompiles.
- **Tuning panel** (Presets tab): per Model, global tuning or, with
  *Override for this preset*, the preset's `tuningOverrides[Model]`. ST panel
  sampler edits go to the override when one exists, else the global.
- **Loadout override editor** (Presets tab): per loadout × Model, each block
  inherit/on/off. ST panel toggles go to the override only for blocks it
  lists; a pick-one option switched on turns its siblings off in the override.
- **Profile guard**: a profile that still loads a preset shows a dialog naming
  it; *Unlink* adds `preset` to its `exclude` (in the tab, ST saves it) and
  re-applies the slot. `bind_preset_to_connection` is forced off once at
  start with a toast.
- **Tidy** (Settings tab): tick the profiles to keep, *Keep selected, delete
  the rest* writes `preset-manager/backups/profiles-<iso>.json` first, then
  deletes in the tab. *Backup profiles* writes the same file on its own.
- REST added: `PUT /models`, `PUT|PATCH /models/:modelId/tuning`, `POST
  /models/rename {from,to}`, `POST /models/merge {names,name}`, `POST
  /models/seed {profiles?}`, `POST /profiles/backup {profiles?}`, `PATCH
  /presets/:id/tuning-overrides/:modelId` and `PATCH
  /presets/:id/loadouts/:lid/overrides/:modelId` (`{set?, unset?}`).
  `GET /slot?source&model&profileId` and `POST /slot/panel {…, raw}` compile and
  route for that connection (each tab sends its own; two tabs can sit on
  different Models); `POST /slot/model {raw}` only records the default used
  when a client sends none.
- Renaming or merging a Model re-keys every preset's tuning and loadout
  overrides (a merge keeps the first-listed Model's values; the old values stay
  in a labelled revision).
- While ST is on a foreign preset (detached), connection and registry changes
  never pull it back to the slot; a library load, Re-attach or Unlink does.
- Known gaps: `POST /slot/model` needs `raw`; selecting a Model by name alone
  (for MCP) is not supported yet. The seed maps profile `api` to source with a
  two-alias table (`oai`, `google`) rather than ST's `CONNECT_API_MAP`.
- Check: `node dev/check-phase4.mjs` (resets dev data; tidy is destructive).

## Phase 5: Diff and revisions

- **Diff tab**: side A and side B each pick a preset (open presets first, then
  the whole library), a revision (`current` or any `#n`), and optionally one
  block. *Compare* with no block on either side diffs the two presets: ONE
  two-column table in ONE scroll container (rows = matched pairs or one-sided
  rows, in A's order; a right-only row sits after its right-hand
  predecessor), then a table of differing top-level settings. Click a row to
  see its line diff in the bottom row. A block on both sides diffs just those
  two blocks (any two: other preset families, or two blocks of one preset).
- **Matching** (`shared/compare.js`, port of v1 `compare.py`): identifier
  first, then normalized name (emoji, whitespace and case folded; duplicate
  names pair in order, so a fork with re-minted identifiers still matches).
  `changed` = content, role, injection position/depth/order or the active
  loadout's on/off differ. `moved` = equal, but outside the longest run of
  pairs that kept their relative order; only the block that actually moved
  gets the `moved from #n` badge (v1 marked every shifted block).
- **Line diff** (`shared/diff.js`): zero-dependency LCS with the common
  prefix/suffix trimmed; unified-diff hunks with 3 lines of context. A middle
  over 25 M table cells is refused with 413 instead of allocating.
- **Revisions**: every mutation snapshots the pre-edit document, coalesced:
  while the newest snapshot is unlabelled and under 5 minutes old, later
  edits write none, so a burst of edits leaves ONE snapshot holding the state
  from before the burst. A labelled snapshot (`POST
  /presets/:id/revisions {label}`) always writes and is never coalesced into.
  Whole-document swaps (import with `replace`, restore) snapshot the current
  document under a label first. `POST /presets/:id/restore {rev}` restores
  that revision's content (id, name and folder stay current); when the preset
  is in the slot, the slot recompiles and ST shows the restored state.
- REST added: `POST /diff {a:{presetId, rev?}, b}`, `POST /diff/blocks {a:
  {presetId, identifier, rev?}|{text}, b, context?}`, `POST
  /presets/:id/revisions {label}`, `POST /presets/:id/restore {rev}`.
- Known gaps: the Diff tab has no restore/label button (REST only); the
  bottom row is a unified diff, not two side-by-side columns.
- Check: `node dev/check-phase5.mjs` (resets dev data).
