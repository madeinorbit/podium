# Issue Colour Flow System — implementation spec

Dimension: the selected issue's colour flows downstream through the whole shell —
sidebar row + bridge notch → radial glow at the top of the engraved column → tray
cards → native tab bar + pane chrome → right rail gradient + ID square — and the
user assigns that colour from a 10-swatch picker opened by clicking the issue's
ID square. Colours are always mixed/tinted (`color-mix`), never flat. Issues
without a colour (the default) run the identical mechanics in neutral slate
`#94a3b8`.

Source of truth: `.design/podium-handoff.html` **v2** — screens `1a` (coloured,
POD-128 violet `#8b5cf6`), `1b` (uncoloured, slate), `1c` (empty tray glow),
`1d` (state-driven square/rail styles), `2a/2b/2c` (mobile), **turn 4 (NEW):
`4a` colour-picker popover opened from the ID square, `4b` the canonical
10-colour palette + reserved colours**, **turn 3 (NEW): `3a` collapsed sidebar
rail, `3d` folded engraved column — colour survives both collapse states**,
build-notes cards §2 "Context flow", §3 "ID squares", §5 "Type & colour".

Product decisions (`.design/decisions.md`, Till 2026-07-14) folded in:
- Colour is **user-assigned via the picker, 10 predefined colours only** (no
  freeform hex in the UI); each colour maps to the predefined tinting of the
  colourable parts. Default = no colour = the neutral grey-black/slate flow.
- Issue IDs: **keep the current ID scheme** for now, just render it in the new
  square style (POD-style prefixes arrive later via a colleague's push).
- Rollout is big-bang — no feature flag, the old shell goes away.

---

## 1 · Current state

### 1.1 Data model — issues have NO colour today (genuinely new concept)

Checked end-to-end; there is no colour anywhere:

- **Wire schema** — `packages/protocol/src/messages/issues.ts` → `IssueWire`
  (lines 75–180): no colour field.
- **Server row** — `apps/server/src/store/types.ts` → `IssueRow` (line 83): none.
  SQLite DDL in `apps/server/src/migrations/002-core-schema.ts`; column mapping /
  upsert in `apps/server/src/store/issues.ts` (~line 47 column list).
- **Patch surface** — `apps/server/src/modules/issues/service/types.ts` →
  `IssuePatch` (line 218) and `CreateIssueInput` (~line 190): none.
- **Serialization** — `apps/server/src/modules/issues/service/core.ts` → `toWire()`
  (line 103): nothing to pass through.
- **CLI/MCP** — `packages/issue-client/src/commands.ts` `create` / `update`
  (update at line 320): no `--color` flag. MCP tools (`issue_update` etc.) are
  generated from this registry via `apps/server/src/issue-mcp.ts`, so a flag added
  here propagates automatically. Drift tests pin the field lists:
  `packages/issue-client/src/commands.drift.test.ts` and
  `apps/server/src/modules/issues/commands-field-drift.test.ts`.
- **Hub/node sync** — `IssueWire` flows verbatim through
  `apps/server/src/relay.ts` / `modules/issues/upstream.ts`; an additive optional
  field is forward/backward compatible (pattern already used for `viaHub`,
  `unread`, `audience` — all `.optional()` / `.catch(default)`).

The only colour concept in the codebase today is **agent identity** colour
(`agentColorHex`, `packages/client-core/src/viewmodels/derive.ts` line ~1365):
Claude's `/color` names → hex, used as tab/sidebar accent lines. That is a
different axis (which agent) and stays; issue colour (which work context) is new.

### 1.2 Web UI — what exists to be tinted

- **Shell** — `apps/web/src/app/AppShell.tsx`: desktop row = resizable sidebar
  (`SidebarUnified`) | optional superagent column (`SuperagentView`, 320–860px) |
  `Workspace` | optional `RightDock` | thin icon rail (plain `bg-card`,
  `size-7` buttons). Mobile = separate `MobileApp.tsx` below 768px.
- **Sidebar** — `apps/web/src/features/worklist/SidebarUnified.tsx` +
  `sidebar-common.tsx`: selection today is a flat neutral `bg-[#232330]`
  (sidebar-common.tsx line 282). No ID squares, no bridge notch, no per-issue tint.
- **Workspace tabs** — `apps/web/src/app/Workspace.tsx`: tab strip
  (`border-b border-border bg-background`, line 277; tab at line 451,
  `rounded-t-md`, active = `border-border bg-card`). Accent line per tab comes
  from the *agent's* colour, not the issue's.
- **Right rail / dock** — `apps/web/src/app/RightDock.tsx` + rail in AppShell:
  neutral; no issue ID square, no gradient, no corner badges.
- **Engraved column / Tray** — do not exist yet (no "tray" in the codebase);
  the superagent column is a plain `bg-background` aside. The glow + tray-card
  tinting in this spec lands on components built by the layout/tray dimension.
- **Theming** — Tailwind v4 + shadcn oklch CSS variables in
  `apps/web/src/index.css` (`--accent`, `--sidebar-*`, `--live` activity accents).
  No `color-mix` usage against a dynamic per-issue variable anywhere.

### 1.3 Verdict

Everything in this dimension is NEW: the data field, its full backend surface,
the frontend colour engine, the ID-square component, and every tinted surface.

---

## 2 · Target design (exact values from the handoff)

Notation: `C` = the issue's colour (hex). Uncoloured issues substitute
`C = #94a3b8` (slate) at the *slate percentages* given in brackets — the slate
variant runs every mechanic slightly quieter (roughly 70–80% of the coloured mix
percentage; exact per-surface values below, from 1b).

Base surfaces (tokens dimension, repeated here because every mix targets them):
bg `#0e0e12` · panels `#16161c` · engraved `#0a0a0e` · compact bars `#08080c` ·
hairlines `#2a2a34` / `#25252f` · text `#f3f3f8` / `#d7d7e0` · muted `#9a9aa8` /
`#6c6c78`. Semantics: attention `#f59e0b`, working `#10b981`, Claude `#D97757`,
neutral flow `#94a3b8`. Issue palette: the canonical 10 colours of §2.11
(violet `#8b5cf6`, rose `#f43f5e`, teal `#14b8a6` are the hues sampled in
turn 1). Fonts: Geist (UI), Geist Mono (IDs, timers, labels).

**Golden rule (build notes §2):** `color-mix(in srgb, C n%, BASE)` at **8–28%**.
Never a flat fill on a surface — flat `C` appears only on the ID square itself and
the primary tray action button.

### 2.1 Sidebar row (262px sidebar, `#16161c`)

- Selected coloured row: `background: color-mix(in srgb, C 28%, #16161c)`,
  `border: 1px solid rgba(C, .8)`, `border-radius: 7px`, padding `6px 8px`.
  [slate: mix **20%**, border `rgba(148,163,184,.7)`]
- Unselected coloured row (issue has colour, not selected):
  `background: color-mix(in srgb, C 11–13%, #16161c)` (1a uses 11% rose / 13%
  teal; 1b uses 13% violet — treat as 12% ± lightness tuning), no border.
- Uncoloured non-selected rows: transparent; queued rows `opacity: .65`.
- Title on tinted rows is hue-tinted: e.g. `#f0d2d8` on rose, `#f6f3ff` selected
  violet, `#c9ebe6` teal; sub-line tinted muted: `#e79aa8` / `#cbb8f7` / `#8fd8cd`
  (see §2.9 formula).

### 2.2 Bridge notch (selected row → engraved column)

Absolutely positioned off the selected row's right edge:
`right: -10px; top: 9px; bottom: 9px; width: 10px;
border-radius: 0 3px 3px 0;
background: linear-gradient(90deg, rgba(C,.85), rgba(C,.12))`.
[slate: `rgba(148,163,184,.75)` → `rgba(148,163,184,.1)`]
It must visually cross the sidebar's right border (z-index above it; sidebar row
container needs `position: relative` and the sidebar `overflow: visible` on that
axis, or the notch is rendered by the shell).

**NEW (3a):** the notch survives sidebar collapse. In the 52px ID-square rail
the selected square carries the same gradient notch, positioned off the square
itself: `right: -14px; top: 7px; bottom: 7px; width: 10px;
border-radius: 0 3px 3px 0` — so the colour still bridges into the engraved
column when the sidebar is just squares.

### 2.3 ID square (the issue's identity, repeated everywhere)

26px rounded square (`border-radius: 7px`), Geist Mono, two stacked lines
(`POD` / `128`), `font-size: 6.5px; font-weight: 600; line-height: 1.3`.
Sizes elsewhere: right rail **30px** / radius 7px (8px in 1d) / font 7px (6px in
1d); mobile header **18px** / radius 5px / font 4.5px; collapsed-sidebar rail
(3a) **26px** / radius 7px / font **6px**; folded-column CTX square (3d)
**22px** / radius 6px / font 5.5px; tray-card chip is the reduced form: 8px
square, radius 3px, flat `C`. Per the product decision, the square renders the
*current* issue ID scheme (two stacked mono lines; POD-style prefixes later).

**NEW (4a): the sidebar ID square is a button** — clicking it (anywhere it
appears in the sidebar, expanded rows or collapsed rail) opens the colour-picker
popover (§2.11). While the popover is open the clicked square gets a white ring:
`box-shadow: 0 0 0 2px #f3f3f8`.

State language (build notes §3):
- **Coloured issue** — solid `C` fill; label text is a *dark shade of C*
  (handoff hand-picks: `#1e0b44` on violet, `#4a0715` on rose, `#032e28` on teal
  — see §2.9).
- **Active but uncoloured** — `background: #25252f; border: 1px solid #8d8d9a;
  color: #c5c5d0`. When *selected* the border/text brighten: border `#c8d2e0`,
  text `#e8edf5` (1b).
- **Queued/idle** — `background: #25252f; border: 1px dashed #6c6c78;
  color: #8d8d9a`, row dimmed `opacity: .65`.
- **Selected ring** — `box-shadow: 0 0 0 2px rgba(C,.35)` [slate `.3`].
- Corner badges (10–13px, top −4/−5, right −4/−5): amber attention dot/count
  (`#f59e0b`, count text `#161006`, 7.5px mono 700), green spinner badge
  (`background:#0c1f18; border:1px solid #10b981; color:#34d399`, braille glyph
  8px), done ✓ (same green badge, ✓ 8px 700). Badge ring border matches the
  parent surface (`2px solid #16161c` in sidebar, `1px solid #131318`/`#16161c`
  in rail).
- 1d state styles for the square itself: working → flat `C` +
  `animation: ignite .55s cubic-bezier(.34,1.56,.64,1)`; done → flat `C` at
  `opacity: .6`; transitions `background .4s, border-color .4s, opacity .4s`.

### 2.4 Engraved column glow

Column background (over engraved `#0a0a0e`):
`radial-gradient(560px 300px at 50% 12%, rgba(C,.10), rgba(C,0) 72%), #0a0a0e`
[slate: `rgba(148,163,184,.09)`], plus the engraving insets (tokens dimension):
`box-shadow: inset 3px 0 6px -3px rgba(0,0,0,.85),
inset -3px 0 6px -3px rgba(0,0,0,.85), inset 0 3px 6px -3px rgba(0,0,0,.85)`.
Variants: empty-tray card (1c) `radial-gradient(300px 120px at 50% 0%,
rgba(C,.08), rgba(C,0) 75%)`; mobile overlay (2c) `radial-gradient(340px 220px
at 50% 6%, rgba(C,.10), rgba(C,0) 72%), #0a0a0e`.
The Tray/Super-agent header bars (`#08080c`, hairlines `#2e2e38`) stay neutral —
only the glow behind and the tray items carry colour (build notes §2/§6).
Collapsed-sidebar variant (3a) narrows the glow: `radial-gradient(300px 200px at
50% 10%, rgba(C,.10), rgba(C,0) 72%), #0a0a0e`.

**NEW (3d) — whole column folded to a 44px vertical bar**, still coloured:
`background: linear-gradient(180deg, color-mix(in srgb, C 14%, #0a0a0e),
#0a0a0e 300px), #0a0a0e; border-right: 1px solid rgba(C,.35);
box-shadow: inset 2px 0 5px -2px rgba(0,0,0,.85),
inset -2px 0 5px -2px rgba(0,0,0,.85)`. Contents top→bottom: ⟩ expand chevron
(tinted muted `#8d84a6`), neutral 28px ▤ Tray button (bg `#16161c`, border
`#2e2e38`) with amber count badge, neutral ✦ Super-agent button with amber
unread dot, rotated mono label `TRAY · SUPER AGENT` (8px, `.18em`, `#5a5a66`,
`writing-mode: vertical-rl`), and the 22px CTX ID square (flat `C`, ink §2.9)
at the bottom — the colour bridge sidebar → bar → native pane never breaks.
When the column is fully *closed* (state C in 3c) the ✦ moves into the right
rail and the rail's gradient (§2.7) is the only colour carrier.

### 2.5 Tray cards (issue-scoped items inside the engraved column)

- Primary card (review, actions): `border: 1px solid rgba(C,.6);
  border-radius: 10px; background: color-mix(in srgb, C 20%, #0e0e12);
  padding: 9px 11px`. [slate: `.55` / **14%**]
- Secondary card (question): `border: 1px solid rgba(C,.4);
  background: color-mix(in srgb, C 10%, #0e0e12); padding: 8px 11px`.
  [slate: `.4` / **8%**]
- 8×8px colour chip, radius 3px, flat `C`.
- Primary action: `background: C; color: <dark shade of C>` (violet → `#160b30`,
  slate → `#141a24`), radius 6px, 10.5px 600, padding 3px 10px.
- Secondary action: `border: 1px solid rgba(<near-white tint of C>, .3)`
  (violet `rgba(233,226,255,.3)`, slate `rgba(226,233,242,.3)`), text that tint.
- Answer chips: `border: 1px solid rgba(C,.45); border-radius: 5px; font-size:
  10px; padding: 2px 8px; color: <light tint>` (violet `#cbb8f7`, slate `#c3cddb`);
  neutral "Reply…" chip: border `#3a3a46`, text `#9a9aa8`.
- Body text tinted: violet `#cfc8e2`, slate `#cdd5e0`; timestamps amber mono 9px.
- Sub-issues of the selected issue render in the SELECTED issue's colour
  (POD-129/130 cards are violet under POD-128).

### 2.6 Native tab bar + pane chrome (Workspace)

Percentages: coloured [slate]:
- Pane background: `color-mix(in srgb, C 12% [9%], #0e0e12)`.
- Tab strip: height 34px, `background: color-mix(in srgb, C 18% [14%], #101016)`,
  `border-bottom: 1px solid rgba(C,.5) [.45]`, padding `4px 6px 0`, gap 2px.
- Active tab: `border-radius: 7px 7px 0 0;
  background: color-mix(in srgb, C 28% [22%], #0e0e12);
  border: 1px solid rgba(C,.5) [.45]; border-bottom: 0;
  box-shadow: inset 0 2px 0 C` (the flat top accent line IS the issue colour),
  `font: 600 10.5px Geist; color: #f6f3ff [#f2f5fa]`.
- Inactive tab: no fill; text = tinted muted (violet `#a89fc2`, slate `#9aa3b2`);
  7×7px issue dot radius 2.5px flat `C`, `opacity: .55` on inactive tabs.
  Per-tab status glyphs stay semantic: amber 6px dot = waiting, braille spinner
  9px mono `#10b981` = computing.
- Session header row: height 42px, `background: color-mix(in srgb, C 24% [18%],
  #0e0e12); border-bottom: 1px solid rgba(C,.45) [.4]`; agent pill
  `border: 1px solid rgba(C,.35); background: rgba(14,14,18,.5)`; icon buttons
  26px, tinted-muted icons.
- Meta row: height 32px, `border-bottom: 1px solid rgba(C,.3)`, mono 10px,
  tinted muted (`#8d84a6` / `#8b93a2`).
- Prompt: rules `border-top/bottom: 1px solid rgba(C,.35)`; caret stays Claude
  `#D97757`. Terminal content colours stay agent-semantic, only *chrome* tints.

### 2.7 Right rail

44px wide column:
`background: linear-gradient(180deg, color-mix(in srgb, C 16% [13%], #16161c),
#16161c 240px), #16161c; border-left: 1px solid rgba(C,.35) [.3];
padding: 10px 0; gap: 6px`.
Top: collapse chevron (tinted muted). Then the issue ID square 30×30px radius
7px (mono 7px 600) with corner state badge (13px: amber count / green braille
spinner / ✓ — §2.3). Below: Git/Files/Shell icons 30×30px radius 7px, colour =
tinted muted (violet `#a89fc2`, slate `#9aa3b2`).

### 2.8 Mobile (2a/2b/2c)

- Workspace header (2b): 44px, `background: color-mix(in srgb, C 16%, #16161c);
  border-bottom: 1px solid rgba(C,.45)`; internal cell dividers `rgba(C,.3)`;
  18px ID square radius 5px carries the colour into the header; page behind:
  `color-mix(in srgb, C 10%, #0e0e12)`.
- Panel dropdown (2b): panel `#16161c`, `border-bottom: 1px solid rgba(C,.5)`,
  `box-shadow: 0 8px 24px rgba(0,0,0,.55)`; active row
  `background: color-mix(in srgb, C 18%, #16161c)`; rows reuse desktop tab
  colours (7px dots, tinted text `#c5bede`).
- Home (2a): header neutral; list rows use the same sidebar row tints
  (selected 28% + border, coloured 11–13%).
- Super-agent overlay (2c): the mobile glow gradient (§2.4).

### 2.9 Derived shades (formulas — the mock hand-picks these)

Three derived colours per issue hue appear throughout; codify as functions of `C`
(one place, so a designer can retune):

- **`ctxInk`** — dark label text on flat `C` fills (`#1e0b44`, `#4a0715`,
  `#032e28`, `#160b30`, slate `#141a24`/`#161006`-family). **RESOLVED by 4b**,
  which states the rule explicitly: square text =
  `color-mix(in srgb, C 30%, #000)`. Use that formula everywhere (the turn-1
  hand-picked hexes are approximations of it); verify contrast ≥ 4.5:1
  against `C` for all 10 palette entries.
- **`ctxMuted`** — tinted muted text (`#8d84a6`/`#a89fc2` violet, `#8b93a2`/
  `#9aa3b2` slate, `#e79aa8` rose, `#8fd8cd` teal). Proposal: two steps,
  `color-mix(in srgb, C 18%, #9a9aa8)` and `color-mix(in srgb, C 28%, #c5c5d0)`.
- **`ctxText`** — near-white tinted text (`#f6f3ff`, `#f2f5fa`, `#f0d2d8`,
  `#c9ebe6`, `#cfc8e2`, `#cbb8f7`). Proposal: `color-mix(in srgb, C 8%, #f3f3f8)`
  (headers) and `color-mix(in srgb, C 22%, #d7d7e0)` (body).

### 2.10 Motion touchpoints (owned by the motion dimension, referenced here)

Colour surfaces transition, they don't pulse: `transition: background .4s,
border-color .4s, opacity .4s` on rows/squares/rail icons (1d). Selecting a
different issue should crossfade every tinted surface over the same .4s. One-shot
keyframes that involve colour: `ignite` (.55s `cubic-bezier(.34,1.56,.64,1)`,
square lights up on start), `rowFlash` (.9s, amber), `iconFlash` (1s), `popIn`
(.45s), `flipAgo` (.5s), braille `spB` (.8s `steps(1,end)` infinite). Respect
`prefers-reduced-motion`. Picking a colour in the picker (§2.11) recolours the
entire context flow live — same .4s crossfade as selection change.

### 2.11 The 10-colour palette + colour picker (NEW — turn 4)

**Canonical palette (4b), spectrum order — names + hexes are frozen:**

| # | Name | Hex |
|---|------|-----|
| 1 | Rose | `#f43f5e` |
| 2 | Pink | `#ec4899` |
| 3 | Fuchsia | `#d946ef` |
| 4 | Violet | `#8b5cf6` |
| 5 | Indigo | `#6366f1` |
| 6 | Blue | `#3b82f6` |
| 7 | Cyan | `#06b6d4` |
| 8 | Teal | `#14b8a6` |
| 9 | Green | `#22c55e` |
| 10 | Lime | `#84cc16` |

**Reserved — never pickable, never confusable with an issue colour:** amber
`#f59e0b` = "waiting on you", `#D97757` = Claude, `#10b981` = working. The
yellow/orange/amber band is deliberately absent from the palette (status
collision); red is folded into Rose. Slate `#94a3b8` is the no-colour *flow*,
not a pickable colour.

**Picker popover (4a)** — anchored to the clicked ID square, opening to its
right (left-pointing arrow):

- Panel: `width: 196px; background: #1b1b22; border: 1px solid #3a3a46;
  border-radius: 10px; padding: 10px 11px;
  box-shadow: 0 14px 34px rgba(0,0,0,.65), 0 2px 8px rgba(0,0,0,.5)`.
- Arrow: 8×8px square, `background: #1b1b22; border-left/bottom: 1px solid
  #3a3a46; transform: rotate(45deg)`, at `left: -5px; top: 14px`.
- Header row (margin-bottom 9px): `ISSUE COLOUR` — Geist Mono 8px,
  letter-spacing `.12em`, `#8d8d9a`; right-aligned issue ID — mono 8px,
  `#5a5a66`.
- Swatch grid: `grid-template-columns: repeat(5, 1fr); gap: 8px` (2 rows of 5,
  spectrum order above); each swatch `aspect-ratio: 1; border-radius: 6px`,
  flat palette colour, `title` = colour name. Hover = white ring
  `box-shadow: 0 0 0 2px #f3f3f8`. Current colour = same white ring + centred
  ✓ (10px, 700, colour = `ctxInk` of that swatch).
- Footer (below `border-top: 1px solid #25252f; padding-top: 8px`): a 16px
  square, radius 5px, `background: #25252f; border: 1px dashed #6c6c78` with
  ✕ (9px, `#8d8d9a`) + label "No colour" (10.5px, `#9a9aa8`); right-aligned
  hint "flows everywhere" (mono 8px, `#5a5a66`). Choosing it clears the colour
  → neutral square (solid/dashed border per state, §2.3) + the slate flow (1b).
- Behaviour: opens on ID-square click anywhere in the sidebar (expanded rows
  and the collapsed 3a rail); clicked square shows the white ring while open;
  Esc / outside click dismisses; picking applies immediately (optimistic) and
  recolours every tinted surface live.

---

## 3 · Gap list

| # | Gap | Layer |
|---|-----|-------|
| G1 | `color` field missing from issue data model end-to-end (SQLite column, IssueRow, IssuePatch, CreateIssueInput, toWire, IssueWire, CLI/MCP `--color`, drift tests, hub passthrough) | backend — NEW |
| G2 | No way for a human/agent to set an issue's colour — the colour-picker popover of §2.11 (opened from the sidebar ID square) does not exist; no CLI flag | backend+web — NEW |
| G3 | No frontend context-colour engine (selected issue → `--ctx` CSS var + derived shades + slate fallback) | web — NEW |
| G4 | No shared ID-square component (5 sizes incl. collapsed-rail 26px and folded-bar 22px, coloured/uncoloured/queued states, corner badges, click-to-pick) | web — NEW |
| G5 | Sidebar rows: flat neutral selection, no per-issue tint, no bridge notch (expanded rows AND the collapsed 3a square rail) | web |
| G6 | Engraved column glow + tray-card tinting, incl. the folded 44px bar's gradient + CTX square (blocked on engraved column/tray existing at all) | web |
| G7 | Native tab bar + pane chrome tint (Workspace strip currently neutral; accent is agent-, not issue-based) | web |
| G8 | Right rail: neutral icon rail, no gradient, no ID square, no corner badges | web |
| G9 | Mobile colour flow (header, panel dropdown, page bg, overlay glow) | web |
| G10 | Selection-change crossfade (.4s) on all tinted surfaces | web |

---

## 4 · Implementation approach

### 4.1 Backend: `color` end-to-end (additive, no breaking change)

Store as a hex string `#rrggbb` (nullable). The UI is **palette-only** (the 10
colours of §2.11 — product decision), but the wire stays freeform hex
(validated `/^#[0-9a-f]{6}$/i`) so hub-mirrored / future Linear-derived colours
are representable and the palette can evolve without a protocol change.
Null/absent = uncoloured → slate flow.

1. `apps/server/src/migrations/016-issues-color.ts` —
   `ALTER TABLE issues ADD COLUMN color TEXT` (nullable, no default).
2. `apps/server/src/store/types.ts` — `IssueRow.color?: string | null`
   (optional, like `panel`/`origin`, so existing row literals stay valid).
3. `apps/server/src/store/issues.ts` — add to the upsert column list, params,
   and the row→camelCase read mapping.
4. `apps/server/src/modules/issues/service/types.ts` — add `'color'` to the
   `IssuePatch` pick list and `color?: string` to `CreateIssueInput`.
5. `apps/server/src/modules/issues/service/core.ts` `toWire()` — pass through
   (`color: row.color ?? undefined`). Validate/normalize on write in crud.ts
   (lowercase, regex; reject otherwise).
6. `packages/protocol/src/messages/issues.ts` — `IssueWire.color:
   z.string().regex(/^#[0-9a-f]{6}$/).optional()`; update
   `packages/protocol/src/issues.test.ts`.
7. `packages/issue-client/src/commands.ts` — `--color` on `create` and `update`
   (accept hex or one of the 10 palette names — rose, pink, fuchsia, violet,
   indigo, blue, cyan, teal, green, lime — mapped client-side; `none` clears,
   same pattern as `--machine none`). Update `commands.drift.test.ts` and
   `apps/server/src/modules/issues/commands-field-drift.test.ts`.
8. tRPC router (`apps/server/src/modules/issues/trpc.ts`) — patch schema union
   gains `color` (follow whatever mechanism the drift tests pin).
9. Hub sync: nothing extra — `IssueWire` is relayed whole; older peers ignore
   the optional field (verify `relay.metadata-delta.test.ts` still passes).

### 4.2 Web: context-colour engine

New `apps/web/src/lib/issue-color.ts`:
- `ISSUE_PALETTE`: the frozen 10 `{ name, hex }` entries of §2.11 (Rose
  `#f43f5e` → Lime `#84cc16`, spectrum order).
- `SLATE = '#94a3b8'`.
- `ctxOf(issue?: IssueWire): { ctx: string; colored: boolean }` — issue colour or
  slate. Optionally resolve inheritance: a sub-issue without its own colour uses
  its nearest coloured ancestor (matches 1a where POD-129/130 flow violet).
- Derived-shade helpers per §2.9 (`ctxInk`, `ctxMuted`, `ctxText`) — computed
  once (tiny colour math or `color-mix()` strings).

Delivery: `AppShell` (and `MobileApp`) look up the selected issue
(`selectedIssueId` in `apps/web/src/app/store.tsx`) and set CSS custom properties
on the shell root: `--ctx`, `--ctx-ink`, `--ctx-muted`, `--ctx-text` (+ a
`data-ctx-colored` attr if slate needs different opacities). All tinted surfaces
are plain CSS/Tailwind arbitrary values against the vars, e.g.
`bg-[color-mix(in_srgb,var(--ctx)_18%,#101016)]` or utility classes in
`index.css` (`.ctx-tabstrip`, `.ctx-rail`, `.ctx-row-selected`, …) — prefer the
utility-class route: the mix percentages live in ONE stylesheet, slate variants
fall out automatically because slate is just another `--ctx` value (only the
handful of surfaces whose *percentage* differs for slate need the
`data-ctx-colored` switch). Transition rule once:
`.ctx-surface { transition: background-color .4s, border-color .4s }`.

`color-mix()` with `var()` is supported by all target runtimes (Chromium ≥ 111,
Safari ≥ 16.2); the repo already targets modern evergreen.

### 4.3 Web: components

- `apps/web/src/components/IssueIdSquare.tsx` (new, shared): props
  `{ issue, size: 26|30|22|18, selected?, state: 'colored'|'plain'|'queued',
  badge?: {kind:'count'|'spinner'|'done', n?}, pickable? }`. Used by sidebar
  rows, collapsed sidebar rail (3a), tray header, folded-column CTX badge (3d),
  right rail, mobile header — it IS the identity everywhere (build notes §3).
  Renders the current issue-ID scheme as two stacked mono lines (decision:
  real POD-prefixes come later). When `pickable`, click opens
  `IssueColorPicker` and shows the white open-ring (§2.3/§2.11).
- Sidebar (`SidebarUnified.tsx` / `sidebar-common.tsx`): replace flat
  `bg-[#232330]` selection with ctx row classes; add the bridge-notch element on
  the selected row (needs the row to overflow the sidebar edge — render the notch
  inside the row with `right:-10px` and raise `z-index`; the sidebar's
  `border-r` sits under it).
- Workspace (`Workspace.tsx`): tab strip + tab + session header + meta row +
  prompt rules pick up ctx classes. The agent identity accent (`agentColorHex`)
  moves off the tab's top edge (that inset line is now the issue colour) —
  keep agent colour on the in-tab dot/label if desired (open question Q5).
- Right rail (`AppShell.tsx` nav + `RightDock.tsx`): gradient background, ctx
  border, `IssueIdSquare size=30` with attention/working badge derived from the
  issue's `sessionSummary` / `needsHuman`.
- Engraved column glow + tray cards: applied inside the tray/engraved-column
  components when the layout dimension lands them; the glow is one background
  line on the column wrapper, tray cards consume `.ctx-card-primary` /
  `.ctx-card-secondary`.
- Mobile (`MobileApp.tsx`): header/dropdown/page classes per §2.8.
- Colour picker: `apps/web/src/components/IssueColorPicker.tsx` (new) — the 4a
  popover exactly per §2.11, anchored to the clicked `IssueIdSquare` (primary
  path: sidebar rows + collapsed rail; `IssueIdSquare` takes an `onPick`/
  `pickable` prop that wires the popover and the open-state white ring).
  Mutates via existing `issues.update` with `{ color }` (optimistic), `null`
  clears. Optionally reuse the same swatch grid in `IssueContextMenu.tsx`
  ("Set colour →") and `IssuePage.tsx` properties as secondary entry points.

### 4.4 Testing

- Protocol round-trip + drift tests (see 4.1).
- Server: migration test (`migrations/upgrade.test.ts` pattern), crud
  validation test (bad hex rejected, `none`/null clears).
- Web: unit-test `issue-color.ts` (slate fallback, inheritance, derived shades,
  the 10-entry palette, `ctxInk` = `color-mix(in srgb, C 30%, #000)` contrast);
  a selected-row test alongside `SidebarUnified.selected-weight.test.tsx`
  asserting the ctx var / class wiring for coloured vs uncoloured issues;
  a picker test (ID-square click opens popover, swatch click calls
  `issues.update` with the hex, "No colour" sends null, current swatch checked).

---

## 5 · Files to touch

Backend / shared:
- `apps/server/src/migrations/016-issues-color.ts` (new) + `migrations/index.ts`
- `apps/server/src/store/types.ts`, `apps/server/src/store/issues.ts`
- `apps/server/src/modules/issues/service/types.ts`, `service/crud.ts`,
  `service/core.ts` (`toWire`)
- `apps/server/src/modules/issues/trpc.ts`
- `apps/server/src/modules/issues/commands-field-drift.test.ts`
- `packages/protocol/src/messages/issues.ts`, `packages/protocol/src/issues.test.ts`
- `packages/issue-client/src/commands.ts`, `commands.drift.test.ts`

Web:
- `apps/web/src/lib/issue-color.ts` (new) + test
- `apps/web/src/components/IssueIdSquare.tsx` (new)
- `apps/web/src/components/IssueColorPicker.tsx` (new)
- `apps/web/src/index.css` (ctx utility classes, `--ctx*` var defaults = slate)
- `apps/web/src/app/AppShell.tsx` (set vars; rail gradient + square)
- `apps/web/src/app/Workspace.tsx` (tab bar + pane chrome)
- `apps/web/src/app/RightDock.tsx` (panel header tint, optional)
- `apps/web/src/features/worklist/SidebarUnified.tsx`, `sidebar-common.tsx`
  (rows, notch, squares)
- `apps/web/src/app/MobileApp.tsx` (header/dropdown/page)
- `apps/web/src/features/issues/NewIssueDialog.tsx`, `IssueContextMenu.tsx`,
  `IssuePage.tsx` (picker)
- Engraved column / tray components (owned by the layout+tray dimensions;
  consume `.ctx-*` classes when they exist)

---

## 6 · Open questions (designer / product owner)

Resolved by v2 + decisions.md (kept for the record):

- ~~Colour assignment model~~ — **RESOLVED**: manual only, via the 4a picker
  opened from the ID square. Default = no colour = neutral/slate flow.
- ~~Palette~~ — **RESOLVED**: exactly the 10 named colours of §2.11,
  palette-only in the UI (no freeform hex picker). Amber/orange/red excluded;
  slate not pickable.
- ~~ID-square ink~~ — **RESOLVED** by 4b: `color-mix(in srgb, C 30%, #000)`.

Still open:

1. **Derived muted/text shades** — `ctxMuted`/`ctxText` (§2.9) remain
   hand-picked per hue in the mock; only the ink formula was codified in 4b.
   Are the §2.9 formulas acceptable, or do you want an explicit per-swatch
   table of {muted, text} for the 10 colours?
2. **Sub-issue inheritance** — tray cards for POD-129/130 flow POD-128's violet.
   If a *child* issue has its own colour, does the child's colour win inside its
   parent's context, or does the selected (parent) issue always dictate the flow?
3. **Agent identity accent vs issue colour** — today's tab accent line is the
   agent's `/color`. The new design gives the tab's inset top line to the issue
   colour. Should agent identity colour survive anywhere (e.g. the small dot in
   the tab), or is agent identity now conveyed only by name/status?
4. **Linear sync** — issues can carry `linearId`. Should Podium mirror a colour
   from Linear (project/label colour) for linked issues (nearest of the 10?),
   or is issue colour purely local? (Wire stays freeform hex either way.)
5. **Unselected coloured rows** — 1a/1b use 11%/13% mixes for different hues
   (4a's popover mock uses 11% rose). Single value (12%) for all hues, or
   per-hue lightness compensation?
6. **Picker on mobile** — 4a is desktop (sidebar-anchored popover). On mobile,
   same popover from the 2a list rows' squares, or a bottom sheet?
