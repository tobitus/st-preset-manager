# Preset Markup Convention for SillyTavern Presets — v0.1 draft

Status: DRAFT for owner review. Not implemented anywhere; no code, fixture or UI
in st-preset-manager depends on this document. The convention is versioned:
revisions of this file bump the version in the title and list what changed. A
reader declares which version(s) it implements; v0.1 is the first.

## 1. Purpose and scope

A small public convention for marking up SillyTavern chat-completion presets so
structure-aware tools can read a preset's outline — sections, option groups,
group headings — without a per-family recognizer. The convention is a strict
superset of Nemo Engine's existing ST macro-comment tags: every preset tagged
the Nemo way (`{{// @section-header true }}`, `{{// @mutual-exclusive-group X }}`)
is already conformant and must parse with unchanged meaning.

The vocabulary covers exactly what Preset Manager's (PM) document model can
express (shared/schema.js): flat sections; groups of cardinality pick-one or
pick-one-or-more; one optional heading block per group (a heading is never a
choice; it has its own on/off switch; comment-only headings send no text);
linked groups whose members sit at several positions; prompt order is never
changed by markup.

### Non-goals

Out of scope for v0.1: nested groups beyond section > group; linked groups whose
runs would need different cardinalities; sampler, model or connection settings;
prompt ordering directives; per-Model loadout or override state; grouping of ST
markers (fixed slots are never group members); and any markup that reaches the
model as text.

## 2. Syntax and vocabulary

All structure is carried by ST macro-comment tags inside prompt `content`. The
canonical form is `{{// @key value }}`, one tag per line, at the top of the
content. ST removes `{{// ... }}` before sending (§6), so tags are invisible to
the model and harmless in any ST.

A **tag** is: `{{//` — whitespace — `@` key — optional whitespace + value — `}}`.
Keys are lowercase `a-z` and `-`. Values are free text without `}` (the closing
brace always ends the value), trimmed. Readers scan the whole content, not only
line starts; whitespace inside the braces is insignificant
(`{{//@mutual-exclusive-group X}}` parses).

| Tag | Value | Meaning |
|---|---|---|
| `@section-header` | literal `true` | Heading block. With a block name matching `=…=` it opens a section (§4.1); with any other name it is a group heading for the run that follows (§4.4). Nemo spelling, kept unchanged. |
| `@mutual-exclusive-group` | group key | This block is an option of the pick-one group with that key (§4.2). Nemo spelling, kept unchanged. |
| `@pick-any-group` | group key | This block is an option of the pick-one-or-more group with that key (§4.3). New in v0.1. |
| `@group-header` | group key | This block is the heading of the group with that key, wherever that group's runs sit (§4.5). New in v0.1. |
| `@default-option` | group key | Advisory: the named group's preferred default option. Readers MAY ignore it. New in v0.1. |

Unknown or unrecognized tags are ignored, silently. Real Nemo presets already
carry display metadata the convention does not define — `@category`, `@tooltip`,
`@color`, `@icon`, `@badge`, `@header`, `@exclusive-with-message`, `@source` —
and conformant readers ignore them like any other unknown tag. The convention
neither reserves nor redefines them.

Value rules:

- **Group keys** identify a group and double as its display name. Recommended
  pattern: letters, digits, space, `-`, `_` (real Nemo keys: `Vex-Personality`,
  `Core-Narration`, `Planning-Language`). Keys are matched case-sensitively and
  exactly; writers pick stable keys unique per preset.
- **Multiple tags per block** are allowed. Two tags with the same key on one
  block: the last one wins. Unknown keys on a structural block are ignored.
- **Empty values**: `@section-header` requires the literal `true`; a
  `@mutual-exclusive-group` / `@pick-any-group` with an empty value does not make
  the block a group member; `@group-header` / `@default-option` with an empty
  value fall back to "the group of the next block" (§4.5). Writers SHOULD always
  give the key explicitly.

## 3. Running order

Rows are read in `prompt_order` (per character_id), the only order ST uses.
Kinds of rows: **blocks** (prompts with content), **markers** (fixed ST slots),
and **ghosts** (order entries with no matching prompt). Markers and ghosts never
join or carry structure; encountering one ends every open run.

A **run** is a maximal sequence of consecutive block rows. A **group run** is a
run in which every block carries the same group tag (`@mutual-exclusive-group`
or `@pick-any-group`) with the same non-empty key. A run containing any other
block is not a group run; a group run is ended by a marker, a ghost, a
header block, a plain block, or a block with a different group key.

## 4. Parsing rules (normative)

### 4.1 Sections

A block tagged `@section-header true` whose **name** matches `=…=` (leading and
trailing `=` runs, Nemo's top-header shape, e.g. `=== 🎭 Vex Personality ===`)
opens a section. The section contains the rows that follow until the next top
header or the end of the order; sections are flat. Rows before the first top
header sit outside every section. A `@section-header true` block with any other
name is a **sub header** and never opens a section (§4.4).

### 4.2 Pick-one groups

Every group run of `@mutual-exclusive-group K` is (part of) the pick-one group
keyed `K`; members keep prompt order. Runs of the same key at different
positions form one linked group (§4.6). If the group ends up with fewer than two
members overall, it is not a group: the blocks stay plain. This mirrors current
Nemo/PM behaviour, where single-row runs stay plain blocks.

### 4.3 Pick-any groups

Same rules with `@pick-any-group K`, cardinality pick-one-or-more. Readers that
do not know `@pick-any-group` treat those blocks as plain content (unknown-tag
rule): degradation is graceful, structure is lost but text is not.

### 4.4 Sub headers (Nemo-compatible group headings)

A sub header (`@section-header true`, name not `=…=`) heads the run that follows:

- the next rows are a `@mutual-exclusive-group K` run: the sub header becomes
  that pick-one group's heading; the group's name is the key `K`.
- the next rows are a plain run (no group tag) of one or more blocks: they
  become a pick-one-or-more group named after the sub header's **name**.
- anything else follows: the sub header stays a plain block.

A comment-only sub header that sits inside an exclusive run (splitting it)
moves to the run's head before grouping, so the whole run is its options; a sub
header that sends text never moves. (This is PM's Nemo reader behaviour; it
changes row order only for comment-only blocks that send no text.)

New writers SHOULD prefer `@group-header` (§4.5) over the sub-header shapes; the
sub-header rules exist so today's Nemo presets parse without edits.

### 4.5 Explicit group headings

A block tagged `@group-header K` is the heading of the group keyed `K`. With an
empty value it binds to the group of the next block. If several runs share the
key (a linked group), the heading binds at the topmost run. Headings are never
counted as options; a heading block may be comment-only (canonical:
`{{// @group-header Personas }}{{trim}}`) or carry real text.

### 4.6 Linked groups (displaced runs)

Runs sharing one group key form ONE group regardless of distance, and across
section boundaries: same key = same group. Members are listed in prompt order;
rows between runs are not members and stay where they are. This is motivated by
real presets (roadmap 016, 2026-10-14): FF's CoT copies at different positions,
and Sola V3 Flame's two `Story Grounding [PICK 1: GROUNDING]` blocks 69 rows
apart. **Deviation note:** current readers (PM's Nemo recognizer) import such
split runs as separate groups with a span note (`nemo: group 'X' spans N
non-contiguous run(s) …`) until linked-group support ships; a conformant v0.1
reader fuses them. See §9, open question 1.

### 4.7 Precedence and conflicts

One block, several tags — resolve by first match:

1. `@section-header true` wins: the block is a section header or sub header,
   never a group member, whatever group tags it also carries.
2. `@group-header K` wins: the block is a heading; group tags on it are ignored.
3. Both group tags present: `@mutual-exclusive-group` wins (pick-one is the
   stricter reading; see §9, open question 3).
4. Otherwise the block is plain content, whatever unknown tags it carries.

## 5. Annex — Sola V3 name hints (informative, non-normative)

Sola V3 presets carry structure in visible block names: a name ending in a `═`
run opens a section, and a `[PICK 1: T]` suffix marks an option of pick-one
group `T` (plus `↓`/`↑` pair rows). Readers MAY use these hints; PM's `sola3`
recognizer does (recognizer order nemo → dem → sola3 → sola → ff5 → casus →
flat). Writers SHOULD emit §2 tags instead of, or in addition to, name hints.
Conformance never requires recognising the annex forms.

## 6. Behaviour in plain SillyTavern

ST's macro engine removes `{{// ... }}` comments before a prompt is sent: the
official macro documentation says "Use the comment macro to add notes that
won't appear in the output: `{{// This is a comment and will be removed}}`"
(SillyTavern-Docs, Usage/macros.md; checked 2026-10-15). Tags therefore never
reach the model. Unverified from primary sources: version-to-version
differences in which fields get macro processing, and ST's exact comment
regex; readers MUST therefore parse tags from the raw stored JSON and never
rely on ST having stripped (or kept) them. Related macro behaviour PM already
tolerates: comment-only headings may carry `{{trim}}`.

## 7. Conformance

A conformant **reader**:

- MUST extract tags per §2, ignore unknown tags, and parse structure per §4;
- MUST NOT reorder prompts, drop content, or treat markers as group members;
- MUST parse every existing Nemo-tagged preset to the structure its tags
  describe (superset guarantee);
- MAY additionally use the §5 name hints and MAY synthesise default headings
  for groups that lack one (PM does);
- on a preset with no recognised tags, MUST import it flat — no groups
  invented — and MAY fall back to family-specific recognisers.

A conformant **writer**:

- MUST emit keys lowercase, exactly as in §2, with non-empty group keys;
- MUST NOT put structural meaning in block names (the §5 hints are optional);
- SHOULD keep group runs contiguous when the order allows it, name section
  headers `=== … ===`, and make group headings comment-only;
- MUST NOT depend on ST stripping comments for the tooling to work.

## 8. Worked examples

Nemo-style snippet (block names and contents, as in Nemo Engine presets):

```text
name: "=== 🎭 Vex Personality ==="
content: "{{// @section-header true }}\n{{trim}}"
name: "📋 Default: Vex"
content: "{{// @mutual-exclusive-group Vex-Personality }}\n<default persona text>"
name: "<Vex Personas>"
content: "{{// @section-header true }}\n{{// @header <Vex Personas> }}{{trim}}"
name: "🎭 Brooding Vex"
content: "{{// @mutual-exclusive-group Vex-Personality }}\n<brooding persona text>"
name: "🎭 Bubbly Vex"
content: "{{// @mutual-exclusive-group Vex-Personality }}\n<bubbly persona text>"
```

Parse: section `=== 🎭 Vex Personality ===`; `📋 Default: Vex` + the two persona
blocks form pick-one group `Vex-Personality` (the comment-only sub header
`<Vex Personas>` splits the run, so it moves to the run's head and becomes the
group heading — §4.4). Unknown tags (`@category`, `@tooltip`, …) are ignored.

The same structure as a minimal tagged ST preset JSON fragment (ST stores more
fields per prompt — `role`, `injection_position`, `marker`, … — omitted here),
including the new tags, a pick-any group with an explicit heading, and a linked
pick-one group across a plain block:

```json
{
  "prompts": [
    { "identifier": "sec-core", "name": "=== 📁 Core ===",
      "content": "{{// @section-header true }}\n{{// @header === 📁 Core === }}{{trim}}\n" },
    { "identifier": "style-head", "name": "<Style>",
      "content": "{{// @group-header Style }}\n{{trim}}\n" },
    { "identifier": "style-quiet", "name": "🎨 Style: Quiet",
      "content": "{{// @pick-any-group Style }}\nQuiet, unhurried prose." },
    { "identifier": "style-noir", "name": "🎨 Style: Noir",
      "content": "{{// @pick-any-group Style }}\nHard-boiled prose." },
    { "identifier": "lang-en", "name": "🌐 Language: EN",
      "content": "{{// @mutual-exclusive-group Language }}\n{{setvar::Language::English}}{{trim}}\n" },
    { "identifier": "ground-a", "name": "🌍 Grounding: before history",
      "content": "{{// @mutual-exclusive-group Grounding }}\nGrounding text A" },
    { "identifier": "history", "name": "📜 Chat History",
      "content": "Plain block between the two Grounding runs." },
    { "identifier": "ground-b", "name": "🌍 Grounding: after history",
      "content": "{{// @mutual-exclusive-group Grounding }}\nGrounding text B" }
  ],
  "prompt_order": [
    { "character_id": 100001, "order": [
      { "identifier": "sec-core", "enabled": true },
      { "identifier": "style-head", "enabled": true },
      { "identifier": "style-quiet", "enabled": true },
      { "identifier": "style-noir", "enabled": false },
      { "identifier": "lang-en", "enabled": true },
      { "identifier": "ground-a", "enabled": true },
      { "identifier": "history", "enabled": true },
      { "identifier": "ground-b", "enabled": false }
    ] }
  ]
}
```

Parse: section `=== 📁 Core ===`; pick-one-or-more group `Style` headed by
`<Style>` (which sends nothing); pick-one group `Language` (headerless,
2 contiguous members); pick-one group `Grounding` linking the two displaced
runs around the plain `history` block (§4.6). Under PM's current Nemo reader,
`ground-a` and `ground-b` would import as two separate single-row runs — i.e.
plain blocks — with a span note, until linked groups ship.

## 9. Open questions for the owner

1. **Linked groups vs Nemo compatibility.** §4.6 changes the meaning of
   existing Nemo presets that reuse one `@mutual-exclusive-group` key across
   split runs (today: separate groups + span note; v0.1: one fused group).
   Fuse for all Nemo presets once linked groups ship, or keep the
   separate-import behaviour for `nemo` and apply §4.6 only to explicit v0.1
   tagging?
2. **`@default-option`**: PM has no field for a default. Drop the tag from
   v0.1, or define it as an import side effect (initial `enabled` state) or a
   note?
3. **Dual group-tag conflict** (§4.7 rule 3): is "pick-one wins" the intended
   reading, or should the block be treated as ambiguous and stay plain?
4. **Nemo's foreign tags** (`@header`, `@category`, …): the draft leaves them
   undefined and ignored. Should the convention explicitly reserve a namespace
   (e.g. `@pm-*`) for future structural keys instead?
5. **Write-back**: when a tool renames or dissolves a group, should it rewrite
   tags in block content? Out of scope here, but it decides how much of §2 a
   writer-side implementation needs.
6. **Name-shape rule**: §4.1 inherits Nemo's quirk that `=…=` in the block
   *name* decides section vs sub header. Keep it for parity, or add a name
   independent tag (e.g. `@section true`) in v0.2?
