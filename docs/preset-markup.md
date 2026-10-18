# Preset Markup Convention for SillyTavern Presets — v0.2 draft

Status: DRAFT for owner review. Not implemented anywhere; no code, fixture or UI
in st-preset-manager depends on this document. The convention is versioned:
revisions of this file bump the version in the title; a reader declares which
version(s) it implements. What changed from v0.1 and why is §9's decision log.

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

Out of scope for v0.2: nested groups beyond section > group; links that cross
prompt orders (a `@link-group` binds inside the order it appears in); sampler,
model or connection settings; prompt ordering directives; per-Model loadout or
override state; grouping of ST markers (fixed slots are never group members);
and any markup that reaches the model as text.

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
| `@section` | literal `true` | Opens a section whatever the block's name (§4.1). New in v0.2; new writers use it. |
| `@section-header` | literal `true` | Heading block. With a block name matching `=…=` it opens a section (§4.1); with any other name it is a group heading for the run that follows (§4.3). Nemo spelling, kept unchanged. |
| `@mutual-exclusive-group` | group key | This block is an option of the pick-one group keyed so, formed by the block's own run (§4.2). Nemo spelling, kept unchanged. |
| `@pick-any-group` | group key | Same, for a pick-one-or-more group (§4.2). New in v0.1. |
| `@group-header` | group key | This block is the heading of the named group, wherever that group's run sits (§4.4). New in v0.1. |
| `@default-option` | group key | Sits on an option block: on import that option starts enabled (§4.7); nothing is stored. New in v0.1, meaning fixed in v0.2. |
| `@link-group` | group key | This block is also an option of the named group, wherever that group sits (§4.5). New in v0.2. |

Unknown tags are ignored, silently. Real Nemo presets carry display metadata
the convention does not define — `@category`, `@tooltip`, `@color`, `@icon`,
`@badge`, `@header`, `@exclusive-with-message`, `@source` — and conformant
readers ignore them like any unknown tag; the convention neither reserves nor
redefines them. (Recognised structural tags that cannot apply are different:
an ignored link or a lost group-tag conflict is never silent — §4.5, §4.6 and
§4.7 require a note naming the block.)

**Reserved namespace.** The `@pm-` prefix is reserved for future structural
keys of this convention. Readers ignore every `@pm-*` key they do not know,
exactly like any unknown tag; writers MUST NOT invent `@pm-*` keys.

Value rules:

- **Group keys** identify a group and double as its display name. Recommended
  pattern: letters, digits, space, `-`, `_` (real Nemo keys: `Vex-Personality`,
  `Core-Narration`, `Planning-Language`). Keys match case-sensitively and
  exactly; writers pick stable keys unique per preset.
- **Multiple tags per block** are allowed. Two tags with the same key on one
  block: the last one wins; unknown keys on a structural block are ignored.
- **Empty values**: `@section` / `@section-header` require the literal `true`;
  a group tag with an empty value does not make the block a member;
  `@group-header` empty falls back to "the group of the next block" (§4.4);
  `@default-option` empty means "the default of its own group" (§4.7);
  `@link-group` empty is ignored — a link needs its explicit key, no fallback.
  Writers SHOULD always give the key explicitly.

## 3. Running order

Rows are read in `prompt_order` (per character_id), the only order ST uses.
Kinds of rows: **blocks** (prompts with content), **markers** (fixed ST slots),
and **ghosts** (order entries with no matching prompt). Markers and ghosts never
join or carry structure; encountering one ends every open run.

A **run** is a maximal sequence of consecutive block rows. A **group run** is a
run in which every block carries the same group tag (`@mutual-exclusive-group`
or `@pick-any-group`) with the same non-empty key. A group run ends at a
marker, a ghost, a header block, a plain block, or a different group key. A
block carrying only `@link-group` is a plain block at its position — it joins
no run and ends an open one like any plain block.

## 4. Parsing rules (normative)

### 4.1 Sections

Two tags open a section:

- `@section true` opens a section whatever the block's name. New in v0.2; new
  writers use it.
- `@section-header true` (Nemo spelling) opens a section only when the block's
  **name** matches `=…=` (leading and trailing `=` runs, Nemo's top-header
  shape, e.g. `=== 🎭 Vex Personality ===`). Kept for parity with existing
  presets.

The section contains the rows that follow until the next opener or the end of
the order; sections are flat. Rows before the first opener sit outside every
section. A block carrying both tags opens a section either way. A
`@section-header true` block with any other name is a **sub header** and never
opens a section (§4.3).

### 4.2 Group runs (pick-one and pick-any)

Every group run of `@mutual-exclusive-group K` is the pick-one group keyed `K`
(cardinality pick-one); every group run of `@pick-any-group K` is the
pick-one-or-more group keyed `K`. Members are the run's blocks, in prompt
order. A key never fuses runs: the same key in a later run — near or far, even
across a section boundary — is a separate group that happens to share the name
(Nemo's meaning; Nemo's own extension reads these tags). Displaced members are
marked explicitly with `@link-group` (§4.5). A run of a single block is not a
group: the block stays plain (current Nemo/PM behaviour for single-row runs).

Readers that do not know `@pick-any-group` treat those blocks as plain content
(unknown-tag rule): degradation is graceful, structure is lost but text is not.

### 4.3 Sub headers (Nemo-compatible group headings)

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

New writers SHOULD prefer `@group-header` (§4.4) over the sub-header shapes; the
sub-header rules exist so today's Nemo presets parse without edits.

### 4.4 Explicit group headings

A block tagged `@group-header K` is the heading of the group keyed `K`, wherever
that group's run sits. With an empty value it binds to the group of the next
block. Headings are never counted as options; a heading block may be
comment-only (canonical: `{{// @group-header Personas }}{{trim}}`) or carry
real text.

### 4.5 Linked groups (displaced members)

Runs are never fused; pulling a block at another position into a group is
explicit:

- A block tagged `@link-group K` is, in addition to whatever it is at its own
  position, an option of the group keyed `K`.
- **`K` must exist**: some group run in the same order must form the group `K`
  (§4.2, which needs at least two members in that run). Otherwise the tag is
  ignored and the reader emits a note naming the block.
- **Position is kept**: the linked block stays where it is, and prompt order
  never changes. Rows between the group and the link are not members.
- **Dual membership**: a linked block may also be an option of an ordinary
  group via its own group tag (§4.6 rule 4). Both memberships apply, and each
  group's cardinality rules apply to the block in that group. A link that
  names the block's own group, or a group it is already linked to, is
  redundant and ignored.
- Linked members count for cardinality: in a pick-one group, exactly one of its
  options and linked members is on, however far apart they sit.

This replaces v0.1's fusion rule, motivated by real presets (roadmap 016,
2026-10-14): FF's CoT copies at different positions stay separate groups under
Nemo's meaning, and Sola V3 Flame's two `Story Grounding [PICK 1: GROUNDING]`
blocks 69 rows apart map to a group plus a link (§5). PM's Nemo recognizer
already imports repeated keys as separate groups, with a span note (`nemo:
group 'X' spans N non-contiguous run(s) …`) that is conformant and simply
reports that a link may be wanted.

### 4.6 Precedence and conflicts

One block, several tags — resolve by first match:

1. A header tag wins: `@section true` or `@section-header true` makes the block
   a section opener or a sub header; it is never a group member, and group and
   link tags on it are ignored.
2. `@group-header K` wins: the block is a heading; group and link tags on it
   are ignored.
3. Both group tags present: `@mutual-exclusive-group` wins — the block is an
   option of the pick-one group only — and the reader emits a note naming the
   block (pick-one is the stricter reading).
4. A group tag together with `@link-group K`: both apply (dual membership,
   §4.5), unless the link is redundant.
5. Otherwise the block is plain content, whatever unknown tags it carries.

### 4.7 Default option (import-time)

`@default-option K` sits on an option block and names its group (empty value:
its own group). On import the tagged option starts enabled; the file's other
enabled bits are untouched, and a resulting pick-one conflict is noted like any
other import conflict, never silently fixed. The tag is then spent: nothing is
stored, and later edits behave exactly as if the file had shipped with those
bits. Readers MAY ignore the tag; the import then just uses the file's own
bits. If the tagged block is not an option of `K` — unknown key, heading, plain
block — the tag is ignored with a note naming the block. The default may be an
ordinary option or a linked member.

## 5. Annex — Sola V3 name hints (informative, non-normative)

Sola V3 presets carry structure in visible block names: a name ending in a `═`
run opens a section, and a `[PICK 1: T]` suffix marks an option of pick-one
group `T` (plus `↓`/`↑` pair rows). Readers MAY use these hints; PM's `sola3`
recognizer does (recognizer order nemo → dem → sola3 → sola → ff5 → casus →
flat). When `[PICK 1: T]` blocks appear in several runs, the split runs map to
§4.5: the first run is the pick-one group `T`, and every block of a later run
carries the meaning of `{{// @link-group T }}`. Writers SHOULD emit §2 tags
instead of, or in addition to, name hints. Conformance never requires
recognising the annex forms.

How PM stores a link (informative): a linked member stays an ordinary row at
its own position, and the group row lists it in `remote` (row keys in the same
prompt order) — the in-document form of `@link-group K`. PM 2.3.0 builds
links from the name hints above, where the first run may be a single block
(Sola V3's `Story Grounding [PICK 1: GROUNDING]` rows at #25 and #94 become one
group of one option plus one linked member), and from its UI (*Make group from
selection* on non-adjacent rows, *Link to group*). PM does not read or write
`@link-group` tags yet; Nemo-tagged runs stay separate groups as §4.2 says.

## 6. Behaviour in plain SillyTavern

ST's macro engine removes `{{// ... }}` comments before a prompt is sent —
official docs: "Use the comment macro to add notes that won't appear in the
output" (SillyTavern-Docs, Usage/macros.md; checked 2026-10-15) — so tags never
reach the model. Unverified from primary sources: version-to-version
differences in which fields get macro processing, and ST's exact comment
regex; readers MUST therefore parse tags from the raw stored JSON and never
rely on ST having stripped (or kept) them. Related macro behaviour PM already
tolerates: comment-only headings may carry `{{trim}}`.

## 7. Conformance

A conformant **reader**:

- MUST extract tags per §2, ignore unknown tags (unknown `@pm-*` keys and
  Nemo's display tags included), and parse structure per §4;
- MUST emit a note naming the block whenever a recognised structural tag cannot
  apply: an ignored `@link-group` (§4.5), a group-tag conflict resolved by
  §4.6 rule 3, an ignored `@default-option` (§4.7);
- MUST NOT reorder prompts, drop content, or treat markers as group members;
- MUST parse every existing Nemo-tagged preset to the structure its tags
  describe (superset guarantee), and SHOULD apply `@default-option` (§4.7);
- MAY additionally use the §5 name hints, synthesise default headings for
  groups that lack one (PM does), and fall back to family-specific recognisers;
- on a preset with no recognised tags, MUST import it flat — no groups
  invented.

A conformant **writer**:

- MUST emit keys lowercase, exactly as in §2, with non-empty group keys;
- MUST use `@section true` for section openers (`@section-header true` is for
  Nemo-compatible sub headers only) and MUST NOT rely on the `=…=` name shape
  or invent `@pm-*` keys;
- on export, MUST rewrite the structural tags so they match the current
  structure — groups renamed, dissolved or created, links added or removed,
  sections and headings as they now are. Stored content is never rewritten,
  only the tag lines; ST strips `{{// … }}` before sending (§6), so the model
  never sees the tags either way;
- MUST NOT put structural meaning in block names (the §5 hints are optional);
- SHOULD keep group runs contiguous when the order allows it, make group
  headings comment-only, and MUST NOT depend on ST stripping comments for the
  tooling to work.

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

Parse: section `=== 🎭 Vex Personality ===`; the comment-only sub header
`<Vex Personas>` splits the run and moves to its head, so `📋 Default: Vex` and
the two persona blocks form pick-one group `Vex-Personality` with `<Vex
Personas>` as its heading (§4.3); unknown tags (`@category`, `@tooltip`, …) are
ignored.

A minimal tagged ST preset JSON fragment (ST stores more fields per prompt —
`role`, `injection_position`, `marker`, … — omitted), showing a `@section`
opener, a pick-any group with an explicit heading, a pick-one group with a
displaced linked member, and `@default-option`:

```json
{
  "prompts": [
    { "identifier": "sec-core", "name": "📁 Core", "content": "{{// @section true }}\n{{trim}}\n" },
    { "identifier": "style-head", "name": "<Style>", "content": "{{// @group-header Style }}\n{{trim}}\n" },
    { "identifier": "style-quiet", "name": "🎨 Style: Quiet", "content": "{{// @pick-any-group Style }}\nQuiet, unhurried prose." },
    { "identifier": "ground-a", "name": "🌍 Grounding: before history", "content": "{{// @mutual-exclusive-group Grounding }}\n{{// @default-option Grounding }}\nGrounding text A" },
    { "identifier": "ground-b", "name": "🌍 Grounding: after history", "content": "{{// @mutual-exclusive-group Grounding }}\nGrounding text B" },
    { "identifier": "history", "name": "📜 Chat History", "content": "Plain block between the group run and its linked member." },
    { "identifier": "ground-c", "name": "🌍 Grounding: late note", "content": "{{// @pick-any-group Style }}\n{{// @link-group Grounding }}\nGrounding text C, also a Style option" }
  ],
  "prompt_order": [ { "character_id": 100001, "order": [
    { "identifier": "sec-core", "enabled": true },
    { "identifier": "style-head", "enabled": true },
    { "identifier": "style-quiet", "enabled": true },
    { "identifier": "ground-a", "enabled": true },
    { "identifier": "ground-b", "enabled": false },
    { "identifier": "history", "enabled": true },
    { "identifier": "ground-c", "enabled": false }
  ] } ]
}
```

Parse: section `📁 Core`, opened by `@section true` — the name shape is
irrelevant. Pick-one-or-more group `Style`, headed by the comment-only
`<Style>` block, with `style-quiet` and the dual member `ground-c` as options
(§4.6 rule 4). Pick-one group `Grounding` = the two-block run `ground-a` +
`ground-b` (a single-block run would stay plain, §4.2) plus `ground-c`, which
sits after the plain `history` block and is pulled in by `@link-group
Grounding` — three members, exactly one on, every block at its own position.
`@default-option Grounding` on `ground-a` starts it enabled on import; nothing
about that is stored.

## 9. Decision log

Every v0.1 open question is decided (owner, 2026-10-15/17); these decisions ARE
the v0.1 → v0.2 change; the normative text sits in the sections named.

1. **No fusing.** The same `@mutual-exclusive-group` / `@pick-any-group` key in
   separate runs means separate groups (Nemo's meaning; Nemo's own extension
   reads these tags); linking is explicit via `@link-group`. → §4.2, §4.5.
2. **`@default-option`** sets the group's initial enabled option on import;
   it is not stored. → §4.7.
3. **Dual group tags:** `@mutual-exclusive-group` wins, and the reader emits a
   note naming the block. → §4.6 rule 3.
4. **Namespace:** `@pm-` reserved for future structural keys; readers ignore
   unknown `@pm-*` keys; writers must not invent them; Nemo's display tags
   stay ignored. → §2.
5. **Write-back:** a conformant writer (PM's export) rewrites the structural
   tags on export so they match the current structure; stored content is never
   rewritten; ST strips the tags, so the model never sees them. → §7.
6. **Sections:** Nemo's `=…=` rule kept for parity; the name-independent
   `@section true` tag added; new writers use `@section`. → §4.1, §7.
