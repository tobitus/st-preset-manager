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
index.js             extension entry: plugin check, bridge, wand entry + floating button
ext/st.js            the only module that touches ST internals
ext/bridge.js        SSE push, tab reconciliation, panel write-back
ext/window.js        floating window (Library tab, remembered rect)
ext/layout.js        pure clamp of saved rects/positions onto the screen
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
- **Loadouts inherit** (round 2): a ROOT loadout holds every block's on/off; a
  PLAYSTYLE names one root as its parent and stores only the bits you set
  explicitly (everything else follows the root live). A per-Model override
  sits inside one loadout (root or playstyle) and is never inherited by
  children. `preset_op` toggles take `loadoutId`; `resetInherit` /
  `resetAllInherit` drop a playstyle's explicit bits. ST panel ticks go to the
  override when it lists the block, else to the desired loadout's own layer —
  never into a playstyle's root.
- **Named tunings**: each Model has `tunings` (≥ 1, by name) and a
  `defaultTuning`; a loadout override may bind a tuning by name (`tuning`,
  null = the default). ST panel sampler edits go to the tuning in effect.
  Per-preset `tuningOverrides` are gone: old documents and `models.json`
  convert on load (the first save keeps the old bytes in a revision).
  (The Presets-tab tuning panel and loadout UI move to this model in B3.)
- **Profile guard**: a profile that still loads a preset shows a dialog naming
  it; *Unlink* adds `preset` to its `exclude` (in the tab, ST saves it) and
  re-applies the slot. `bind_preset_to_connection` is forced off once at
  start with a toast.
- **Tidy** (Settings tab): tick the profiles to keep, *Keep selected, delete
  the rest* writes `preset-manager/backups/profiles-<iso>.json` first, then
  deletes in the tab. *Backup profiles* writes the same file on its own.
- REST added: `PUT /models`, `PUT|PATCH|DELETE /models/:modelId/tunings/:name`,
  `POST /models/:modelId/tunings/rename {from,to}`, `PUT
  /models/:modelId/default-tuning {name}`, `POST
  /models/rename {from,to}`, `POST /models/merge {names,name}`, `POST
  /models/seed {profiles?}`, `POST /profiles/backup {profiles?}` and `PATCH
  /presets/:id/loadouts/:lid/overrides/:modelId` (`{set?, unset?, tuning?}`).
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
  pairs that kept their relative order, where ST markers present on both
  sides (`chatHistory`, `main`, …) are fixed anchors: a block moved across
  one is moved even if the block-only order is unchanged. Only the block that
  actually moved gets the `moved from #n` badge (v1 marked every shifted
  block). Markers are anchors only, never rows.
- **Line diff** (`shared/diff.js`): zero-dependency LCS over lines interned
  to integers, with the common prefix/suffix trimmed; unified-diff hunks with
  3 lines of context. It runs inside ST's own process, so a request is
  refused with 413 when the trimmed table exceeds 4 M cells or the input
  exceeds 2 M characters; the worst allowed case takes ~25 ms. `POST /diff`
  refuses a preset with more than 5,000 leaves (413); the worst allowed
  compare takes ~30 ms.
- **Diff tab races**: every picker change and every Compare invalidates
  pending results; headers come from the request that rendered the rows.
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

## Phase 6: Block shelf and cross-preset copy

- **Shelf** (`shelf/<id>.json`, held in memory and published through the
  store queue with the global rev): a library of reusable blocks. Presets
  tab → select a block → *Save to shelf*. The **Shelf tab** lists the items
  (name, source preset), and renames them, keeps notes on them and deletes
  them.
- **Shelf list** in the Presets tab (*Shelf ▸* toggles it, on the right).
  Its source is the shelf or any other open preset (groups show as one row
  plus their options). Drag a row into the outline: jQuery UI sortable
  `connectWith` puts the drop between two rows. The drop becomes ONE
  `copyBlock` op anchored at the row below the drop point (`before`). A
  block dropped among a group's options joins that group. A block dropped
  above a group or section heading lands above it. A whole group lands as
  heading plus options, with its name and cardinality, and snaps above a
  group it was dropped into (it never splits one). A drop at the end of a
  nested list lands after that container. A drop right before a group
  without a heading lands above that group, not in it (`outsideGroup`).
  Copies publish through the store's `_commit`: a failed write leaves the
  document, the index and the rev as they were.
- **Copy rules**: every copied block gets a freshly minted identifier (two
  copies of one shelf item never share one). Copied blocks start off in
  every loadout. `fields.marker` is forced false. Markers never transfer:
  the shelf and `copyBlock` answer 400, and the UI shows the error as a
  toast. A group's marker and ghost members are skipped.
- **Macro warnings** (v1 `token_warnings`): a copied block's `{{…}}` or
  `{word…}` tokens that appear in no other block of the target (content or
  name) produce a warning toast. `{{// comments}}` never warn, and neither
  do `{{char}}`/`{{user}}`. v1's `rstrip("}")` made that last check dead
  code; v2 implements its stated intent.
- REST added: `POST /presets/:id/ops {op: 'copyBlock', shelfId |
  fromPresetId + (identifier | group), before, outsideGroup?}` → `{doc, rev, warnings,
  identifiers, keys, group}`; `GET /shelf/:id`; `PATCH /shelf/:id {name?,
  notes?, tags?}`; `POST /shelf {fromPresetId, identifier} | {block}` accepts
  `name?`, `notes?` and `tags?`.
- Known gaps: sections copy only block by block (no whole-section copy). A
  drop at the very end of a second sequence appends to the first. Dragging
  from the outline into the shelf list is not supported (use *Save to
  shelf*).
- Check: `node dev/check-phase6.mjs` (resets dev data).

## Phase 7: MCP wrapper

`mcp/server.js` is a zero-dependency Node MCP server (stdio transport:
newline-delimited JSON-RPC 2.0 — `initialize`, `notifications/initialized`,
`ping`, `tools/list`, `tools/call`). It supports protocol `2025-06-18`;
another version negotiates to that version, and malformed initialization
parameters are rejected. Each tool is one REST row: the
arguments become the path parameters, the query string and the JSON body of
one request, and the JSON response is the result (`content: [{type: 'text',
text: <JSON>}]`). Empty and dot-segment path arguments are rejected before
HTTP. An HTTP error is a result with `isError: true` and the text `{status,
error, …}` (the plugin's own error body). There is no logic in the wrapper:
every rule lives in the plugin, so a tool behaves exactly like the UI and
the REST call.

- **Config** (env): `ST_URL` (default `http://127.0.0.1:8002`); `ST_USER` and
  `ST_PASSWORD` for a multi-user ST (`POST /api/users/login`).
- **Session**: at start (and lazily when that failed) `GET /csrf-token` gives
  the session and the request token. Both are sent on every call and kept
  in memory only. On a 403 the server fetches a fresh session once and
  retries once; staggered failures from the same old session share the
  completed refresh. The server never reads `settings.json` or any cookie
  file, and no session value appears in a tool argument, a result or a log
  line. Logs go to stderr; stdout carries only JSON-RPC and is drained before
  the process exits on stdin EOF.
- **Register in omp** (`.omp/mcp.json`):
  `{"st-preset-manager": {"command": "node", "args": ["<repo>/mcp/server.js"], "env": {"ST_URL": "http://127.0.0.1:8002"}}}`.
- **Smoke**: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' | node mcp/server.js`.

| Tool | REST |
|---|---|
| `health` | `GET /health` |
| `library_list` `{tag?}` · `library_rescan` | `GET /library` · `POST /rescan` |
| `preset_get` · `preset_export {format?}` | `GET /presets/:id` · `GET /presets/:id/export` |
| `preset_import` · `preset_save {doc}` · `preset_delete` | `POST /presets` · `PUT /presets/:id` · `DELETE /presets/:id` |
| `preset_fork` · `preset_move` · `preset_set_meta` | `POST …/fork` · `POST …/move` · `PATCH …/meta` |
| `preset_op {op, …op args}` | `POST /presets/:id/ops` (every op, `copyBlock` included) |
| `loadout_create {name, kind, from?, parent?}` · `loadout_update {name?, notes?, parent?, kind?}` · `loadout_delete` · `loadout_activate` | `POST/PATCH/DELETE /presets/:id/loadouts[/:lid]`, `POST …/activate` |
| `loadout_set_override {enabled, tuning?}` · `loadout_patch_override {set?, unset?, tuning?}` · `loadout_delete_override` | `PUT/PATCH/DELETE …/loadouts/:lid/overrides/:modelId` |
| `models_list` · `models_replace {registry}` | `GET /models` · `PUT /models` |
| `models_set_tuning {name, tuning}` · `models_patch_tuning {name, set?, unset?}` · `models_delete_tuning {name}` | `PUT/PATCH/DELETE /models/:modelId/tunings/:name` |
| `models_rename_tuning {from, to}` · `models_set_default_tuning {name}` | `POST /models/:modelId/tunings/rename` · `PUT /models/:modelId/default-tuning` |
| `models_rename` · `models_merge` · `models_seed` | `POST /models/rename` · `/merge` · `/seed` |
| `profiles_list` · `profiles_backup` | `GET /profiles` · `POST /profiles/backup` |
| `slot_get` · `slot_load` · `slot_set_model` | `GET /slot` · `POST /slot/load` · `POST /slot/model` |
| `diff_presets` · `diff_blocks` | `POST /diff` · `POST /diff/blocks` |
| `revisions_list` · `revision_get` · `revision_create` · `revision_restore` | `GET/POST /presets/:id/revisions[/:rev]` · `POST /presets/:id/restore` |
| `shelf_list` · `shelf_get` · `shelf_add` · `shelf_update` · `shelf_remove` | `GET/POST/PATCH/DELETE /shelf[/:id]` |

Path parameters are named `presetId`, `loadoutId`, `modelId`, `rev` and
`shelfId`. Tools whose REST body is a whole object take it as one argument
(`doc`, `registry`, `tuning`).

**Left out, on purpose:**

- `GET /events`: a Server-Sent Events stream for the ST tab, not a request
  with a result.
- `POST /slot/panel`: the tab's write-back protocol. Its body is a projection
  of ST's live panel (`clientId`, `baseRev`, `base`, `snapshot`) that only the
  tab can produce; a hand-made call would bypass the bridge.
- `loadout_list` (named in PLAN §1.7): no REST row lists loadouts. The loadouts
  are in `library_list` (`loadouts: [{id, name}]`) and in `preset_get`, and
  adding a projection here would be logic in the wrapper.

Tests: `test/mcp.test.js` (framing, error codes, the argument → HTTP map,
and the session flow against a fake ST). Check: `node dev/check-phase7.mjs`
(resets dev data; spawns the server behind a recording proxy and a headless
Chromium on ST).

## Fix round 1 (owner review, 2026-09-29)

- **Opening**: a draggable floating button (`#pm-float-btn`, bottom right by
  default; position in localStorage `pm.floatBtn.pos`) opens the window, as
  does the wand-menu entry. It is also there when the plugin is missing (the
  install notice opens).
- **Window memory** (per browser, localStorage): the rect (`pm.window.rect`,
  saved on drag/resize end, clamped back on screen) and the open preset tabs
  plus the active one (`pm.presets.open`; ids no longer in the library are
  dropped silently). On open, the preset in ST's working slot auto-opens and
  is activated only if nothing else was. Its tab and its Library row carry the
  `● Active` marker (see *Active in SillyTavern* below).
- **Presets tab edit bar**: *Insert ▾ → Section heading* asks for a name
  (default `New section`, stored as `== <Name> ==`) and runs ONE `addSection`
  op: an empty heading, ON in the active loadout, whose section takes the rows
  below it up to the next section heading. *Insert ▾ → Block* adds an empty
  block; *Duplicate* copies the selected block directly below it (`copyBlock`
  from the same preset, fresh identifier); *Delete* needs a second click on
  the SAME row. Markers and order-only rows refuse both (toast).
- **Collapse**: section AND group rows (headerless "(options)" groups too)
  have a caret; the state is display-only, per preset
  (`pm.collapsed.<presetId>`). A collapsed section or group moves as one unit
  and no shelf drop lands inside it. Every row keeps the same leading caret
  column (plain rows get an empty spacer), so a heading's handle, switch and
  name line up with its sibling rows, and children indent past the caret
  column (`calc(1.2em + 6px + 12px)`): a child's handle starts right of its
  heading's name.
- **Make / Unmake heading** (rank bar): *Make section heading* (Alt+S) turns
  the selected plain row into a section heading directly (one `makeSection`
  op; the rows below it up to the next section heading become its children)
  and *Unmake section heading* reverses it exactly (`unmakeSection`). *Make
  group heading* (Alt+G) is the item→group promote, *Unmake group heading*
  the demote back. Content, name and switch are untouched (an empty heading
  is still left out of the slot). Options and the other kind of heading are
  refused with a toast ("make it a plain row first"), as are markers and
  order-only rows.
- **Container names**: a section's or group's name IS its heading block's
  name (outline, shelf list, copies). Renaming the heading block (*Save
  content*, `editBlock`/`renameBlock`, or a rename in ST's panel) or a headed
  group (`renameGroup`, which renames the heading block) keeps the stored
  name in sync; a headerless group keeps its own name.
- **Row numbers and multi-select**: every row with a block shows its 1-based
  position in the flat prompt order (headings counted, the same numbers in
  every view of the preset). Ctrl/Cmd-click adds or removes a row from the
  selection, Shift-click selects the visible range; with 2+ rows selected
  Promote / Demote send ONE op carrying all keys (`{keys}`, applied in
  document order, all-or-nothing).
- **Group card**: clicking a group row (headerless "(options)" groups too)
  shows the group in the editor pane: rename it (`renameGroup`), switch
  1 ↔ N (`setCardinality`) and *Dissolve* it (`dissolveGroup`: heading and
  options become plain rows in place; order, switches and loadouts are kept).
- **Undo / Redo** (edit bar; Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z in the
  outline): server-side, per preset, whole-document snapshots, newest 100.
  Every change to a document counts (ops, loadout/override/meta edits, ticks
  made in ST's own prompt panel, copies); an import with replace, a revision
  restore and a Model rename/merge clear the history. The history lives in
  memory only: it is lost when SillyTavern (the plugin) restarts. REST
  `POST /presets/:id/undo|redo`, `GET /presets/:id/history`; MCP
  `preset_undo`, `preset_redo`, `preset_history`.
- **Search**: names + content, case-insensitive, client-side over the loaded
  document; a match count, Enter / Shift+Enter walk the matches (the editor
  follows), *Filter* keeps only matches and their ancestor headings, and a
  collapsed section or group holding a match opens while the search is active.
- **Empty headings are not sent**: a section/group heading whose content is
  empty or whitespace-only is left out of the working-slot compile (ST's
  prompt list and `prompt_order`); its switch is library-only. Headings with
  content still compile and show ⓘ in the outline. The ST export keeps every
  block.
- **Diff tab**: the block line diff has an *Interleaved* / *Side by side*
  toggle (remembered in `pm.diff.view`).

Tests: `test/fix1-*.test.js`. Check: `node dev/check-fix1.mjs` (resets dev
data; real headless Chromium on ST).

## ST-panel reorder keeps the outline (owner decision 2026-09-29)

A drag in SillyTavern's own prompt-manager panel is written back to the
library without flattening it: only the rows that actually moved (the rows
outside the heaviest in-order chain) are re-placed, each directly above its
new neighbour with v2's drop rules. Rows that did not move keep their
section, group, rank and group settings. Dropped strictly inside a group, a
row becomes its option; at a group's edge it stays in only if it was already
a member. A group or section heading dragged on its own takes its whole
group or section with it (the library order then differs from ST's, and the
tab re-applies once, so ST shows the library order). Invisible empty
headings stay on the row they were above. Rules: PLAN §1.4.

Tests: `test/reorder-writeback.test.js`. Check: `node dev/check-reorder.mjs`
(resets dev data; real mouse drags in ST's panel on DEM).

## Group cardinality toggle (temporary)

The `1`/`N` badge on every group row is a click control: it flips the group
between pick-one and pick-one-or-more (`setCardinality`). Switching to
pick-one is refused, with an ST popup showing the server's text, while two or
more members (the heading counts) are on in any loadout or per-Model
override; nothing is ever switched off.

Tests: `test/cardinality.test.js`. Check: `node dev/check-cardinality.mjs`
(resets dev data; real mouse clicks on the badges in the v2 window).

## Library Delete

Each Library row has a **Delete** button. It asks for confirmation in an ST
popup, then removes the preset file and its revision history. If the preset
is in the working slot, the slot becomes empty (ST keeps the prompts it is
showing; nothing is re-applied). An open Presets tab for it closes.

Check: `node dev/check-nemo-delete.mjs` (resets dev data; covers Delete
cancel/confirm and the Nemo import in the v2 window).

## Active in SillyTavern

The window's first line always says what ST is running:
`Active in SillyTavern: <preset> · <loadout>` (or `Active in SillyTavern:
none`), read from the working slot (`GET /slot` desired preset + loadout,
a null loadout meaning the preset's active one) and updated live on slot
events and on edits to that preset. The running preset's Library row and its
Presets tab carry an accent-coloured `● Active` marker.

A Presets tab whose preset is not the running one opens with the notice
*Not active in SillyTavern* and a **Make active** button: exactly the Library
**Load** action (`POST /slot/load`) with the preset's active loadout. When the
preset is running but with a different loadout than its active one (loaded
through the Library row's loadout select), the notice reads *Active in
SillyTavern with loadout <X>* and Make active switches the slot to the active
loadout. Names are always rendered as text. Library Load, the Library loadout
select and Make active all run the load as one `bridge.edit` op, so an ST
panel edit not yet written back is flushed to the previous preset first
instead of being dropped.

Tests: `test/active.test.js`. Check: `node dev/check-active.mjs` (resets dev
data; Library Load, Make active and HTML-character names in the v2 window;
screenshots `dev/shots/active-header.png`, `dev/shots/active-not-active-notice.png`).

## Nemo recognizer

Presets whose blocks carry ST macro-comment tags `{{// @section-header true }}`
or `{{// @mutual-exclusive-group X }}` are recognized as Nemo (checked before
dem/sola/ff5/casus). Nemo has two heading levels, both tagged
`@section-header true`:

- A TOP header (block name `=== … ===`, e.g. `=== 🎭 Vex Personality ===`)
  opens a section (flat, no nesting).
- Every other header is a SUB header (`<Vex Personas>`, `<Core: Speech>`,
  `<Action & Adventure Authors>`) and never becomes a section. It heads the
  run directly after it: an exclusive run (`@mutual-exclusive-group T`)
  becomes a pick-one group named `T` headed by it; a run of plain blocks
  becomes a pick-one-or-more group named after it (both `guessed:false`);
  anything else (a header, a marker, the end) leaves it a plain block. When
  the blocks directly before it carry the same `T` (the run is split by the
  sub header, e.g. `📋 Default: Vex` above `<Vex Personas>`), the sub header
  moves up to the start of that run so the whole run is its options. Only a
  comment-only sub header moves (it sends no text); a sub header that sends
  text and every content block stay put (it then heads the run after it), and
  the import notes list every move
  (`nemo: moved sub header '<Vex Personas>' up 1 row(s) …`).

Everything after a headed run stays in the enclosing section: each other
contiguous run (2 or more) of one mutual-exclusive-group value becomes a
headerless pick-one group named by the tag value (`guessed:false`); a run of
1 stays a plain block. Apart from moved sub headers prompt order never
changes, so a group split into several runs is listed in the import notes
(`nemo: group 'X' spans N non-contiguous run(s) ...`). Other tags are
ignored. `source.recognizer.kind` is reported when every sequence picked the
same recognizer.

A group that directly follows another group is headed by its own first member
(two adjacent headerless groups would merge in the outline model); the import
notes say `nemo: group 'X' directly follows group 'Y'; ...`.

Comment-only headings: a section/group heading whose content is only
`{{// … }}` comments and `{{trim}}` (every Nemo heading) sends no text. It is
no pick-one member (normalize, the per-Model override merge, the ⚠ conflict
and the 1/N refusal ignore it, and "none" leaves it alone) and its heading
row shows no switch. Blank headings keep the older rules; the slot compile
and the ST export are unchanged.

In the outline of a Nemo-imported preset (`source.recognizer.kind` is
`nemo`), a pick-one group heading whose block sends text shows its own radio:
it is a pick-one member, so choosing it turns the options off, and 'none'
clears it. Empty headings and pick-many headings have no switch. Other
presets (FF/DEM/Sola) keep switchless headings: their content headings are
informational text. This is a contained, temporary rule until roadmap 16
replaces the outline's group model.

Tests: `test/nemo.test.js`, `test/group-heading-switch.test.js`.
