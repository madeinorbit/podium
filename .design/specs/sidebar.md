# Work sidebar redesign — implementation spec

Dimension: the left "Work" sidebar (issues grouped by project, Linear-style ID squares,
square state language, working spinner + timer, selected-row bridge notch), plus —
new in handoff v2 — the **collapsed 52px ID-square rail** (3a) and the **issue colour
picker** opened by clicking an ID square (4a).

Source of truth: `.design/podium-handoff.html` (v2) — reference screens
**1a** (coloured selection, sidebar markup lines ~572–635), **1b** (uncoloured/slate
selection, ~760–813), **1d** (motion grammar, ~961–1046), build notes (★, ~540–552);
**3a** (collapsed sidebar rail, ~124–168) + collapse rules (★, ~113–121);
**4a** (colour picker popover, ~30–82) + **4b** (10-colour palette reference, ~85–104).
Mobile home **2a** (~336–417) reuses the same rows full-width.
Product decisions: `.design/decisions.md` (colours = user-picked from 10; keep current
issue-id scheme for now; big-bang rollout; everything resizable).

Maps to: `apps/web/src/features/worklist/` (SidebarUnified.tsx, sidebar-common.tsx,
time-indicators.tsx) + view-models in `packages/client-core/src/viewmodels/derive.ts`.

---

## 1 · Current state

**Mount points**
- Desktop: `apps/web/src/app/AppShell.tsx:156` — `<ResizableAside><SidebarUnified /></ResizableAside>`
  (resizable 200–520px, default 280, persisted `podium:sidebar:width`). No
  collapse-to-rail state exists.
- Mobile: `apps/web/src/app/MobileApp.tsx` composes `NewWorkRow` + `WorkSections` +
  `AppToolsRow` exports directly (#227).

**Structure today** (`SidebarUnified.tsx`)
1. `NewWorkRow` — "New \<Agent\> in \<Repo\>" spawn button with agent/repo dropdown.
2. App-surface nav — Home / Issues / Specs / Automations as sidebar buttons.
3. `WorkSections` —
   - **WORKING** collapsible section (fully-working rows + lifted working sessions,
     with a live `WorkingTimer`),
   - **PINNED** collapsible section (pinned session `PanelRow`s),
   - **WORK** list: `UnifiedWorkRow`s (issues + unowned worktrees) in urgency order,
     optionally grouped by repo behind a `Group: repo / none` Select
     (`sidebarSettings.groupByRepo`, `groupUnifiedWorkRows` in
     `packages/client-core/src/viewmodels/derive.ts:1211` keyed on
     `issue.repoId ?? issue.repoPath`).
4. `AppToolsRow` footer — add repo / usage / settings / search (⌘K), 30px buttons.

**Row anatomy today** (`UnifiedRowShell`, SidebarUnified.tsx:743)
- Leading icon: `IssueStatusIcon` (stage glyph) or agent `KindIcon`; hover swaps it
  for an expand chevron. No issue-ID visual at all — the seq shows as a muted
  `#{issue.seq}` text extra (10.5px mono).
- Title 13.5px; unread = `font-medium` (email-style, #126); selection = flat
  `bg-[#232330]` accent background only (#170).
- Right side: extras (Pin, AlarmClock, "Unsnoozed"/"epic" chips), `timeMeta`
  (`WorkingTimer` "12m 34s" grey `#6c6c78` 10px, or `AgoStamp` "2h ago"), child count,
  and the most-urgent-session **status dot** (`sessionDotClass`: bg-live green /
  bg-warning amber / red / info blue, with a CSS `dot-working` breathing glow).
- Expandable child `PanelRow`s with a tree guide line.

**Existing state machinery that carries over**
- `isSessionWorking`, `attentionGroup`, `mostUrgentSession`, `agentBadge` (labels like
  "needs answer", "plan ready"), `rowUnreadEmphasized`, snooze/defer logic — all in
  `client-core/viewmodels/derive.ts`.
- `WorkingTimer` / `workingSinceMs` / `AgoStamp` in `time-indicators.tsx`
  (per-timer 1s interval under 1h, then 1min — keep this pattern).
- Fonts: Geist Variable / Geist Mono Variable already wired
  (`apps/web/src/index.css:11-12`).

**What does NOT exist**
- No ID square anywhere; no project/prefix key ("POD"); no per-issue colour in the
  data model (`IssueWire`, `packages/protocol/src/messages/issues.ts:80-181` has
  `seq`, `repoId/repoPath`, `linearIdentifier?` — no `color`); sessions have
  `agentColor` but issues do not. No colour picker UI.
- No braille spinner (working indication is the breathing dot).
- No bridge notch; the sidebar scroll container (`overflow-y-auto px-2`) would clip one.
- No always-on project grouping with the handoff's mono section-label style.
- No M:SS timer format, no green working timer, no amber "ago" freeze, no ∑ total.
- No collapsed rail: `ResizableAside` only resizes; there is no 52px icon-rail state
  or persisted expanded/collapsed toggle for the sidebar.

---

## 2 · Target design (exact values from the handoff)

### 2.1 Column
- Width **262px** flex-none (handoff `flex:0 0 262px`); keep drag-resize (decisions.md:
  "EVERY section is resizable") but change the default to 262. Background `#16161c`,
  `border-right: 1px solid #2a2a34`, padding `10px 8px 6px`, rows in a column with
  `gap: 3px`.
- The column has a second, collapsed state: the **52px rail** (§2.7). Expanded ↔
  collapsed is persisted via a uiState key (collapse-rules note: keys like
  `podium:superagent:width`, `podium.rightPanel` — add e.g. `podium:sidebar:collapsed`).
- Top: the "New Claude in podium" spawn row — `border 1px solid #3a3a46`,
  `background #25252f`, `border-radius 8px`, `padding 8px 10px`, 12px/500 text
  `#eaeaf0`, Claude glyph `#D97757` 14px, trailing ▾ `#7a7a86` 10px, `margin 0 0 4px`.
- Divider under it: `height 1px; background #25252f; margin 4px 2px 6px`.
- **App nav (Home/Issues/Specs/Automations) leaves the sidebar** — it moves to the
  44px top bar (shell dimension). The sidebar is the work list only.
- Footer (kept): `border-top 1px solid #25252f; padding 8px 10px 4px`,
  4 icon buttons 28×28 radius 6, icons 15px stroke 1.8 `#9a9aa8`,
  `justify-content: space-around` — Add repo / Stats / Settings / Search.

### 2.2 Project section labels (mono 8.5px)
Always-on grouping (no "Group: none" select). Header per project:

```
font-family: Geist Mono; font-size: 8.5px; letter-spacing: .12em;
color: #7a7a86; padding: 4px 4px 2px  (8px top for non-first groups);
display:flex; align-items:center; gap:6px;
LABEL + trailing hairline: flex:1; height:1px; background:#25252f;
```

Label is the project name uppercased (handoff: LUMENFALL / TARTLET). No chevron in the
handoff; if collapse is kept it must not disturb this look. In the collapsed rail,
project groups reduce to a bare hairline: `width:26px; height:1px; background:#25252f`
(tooltip = project name).

### 2.3 ID squares (the issue identity — shared component)
26×26px, `border-radius 7px`, two stacked lines (`POD` / `128`) in
**Geist Mono 6.5px, weight 600, line-height 1.3**, flex-none,
`display:flex; flex-direction:column; align-items:center; justify-content:center`.

**ID content (decisions.md)**: POD-128-style prefixes arrive later from a colleague's
push — for now KEEP the current id scheme (`seq`) and just render it in the square
style. Prefix line is a display-only derivation (no persistence); when real
identifiers land they slot into the same two lines.

Square language (build note 3):

| State | Fill | Border | Text | Row |
|---|---|---|---|---|
| Coloured issue | solid issue colour (e.g. `#8b5cf6`) | none | `color-mix(in srgb, COLOUR 30%, #000)` (4b rule; 1a samples: violet→`#1e0b44`, rose→`#4a0715`, teal→`#032e28`) | row bg `color-mix(in srgb, ISSUE 11–13%, #16161c)` |
| Working, uncoloured | `#25252f` | `1px solid #8d8d9a` | `#c5c5d0` | plain row |
| Queued / idle | `#25252f` | `1px dashed #6c6c78` | `#8d8d9a` | whole row `opacity:.65` |
| Selected (any) | as above + `box-shadow: 0 0 0 2px rgba(ISSUE,.35)` (slate: `rgba(148,163,184,.3)`, border `#c8d2e0`, text `#e8edf5`) | | | see 2.5 |
| Picker open (4a) | as above + **white ring** `box-shadow: 0 0 0 2px #f3f3f8` on the clicked square | | | |

Corner badges on the square (`position:absolute`):
- **waiting dot** (expanded rows): 10×10px circle `#f59e0b`,
  `border: 2px solid #16161c`, at `top:-4px; right:-4px`.
- **waiting COUNT badge** (rail + 1d rail): `min-width:13px; height:13px;
  border-radius:99px; background:#f59e0b; border:1px solid #16161c` (rail-surface
  colour), number `7.5px/700 #161006`, at `top:-5px; right:-5px`.
- **working spinner badge** (selected/rail squares): 13×13px circle,
  bg `#0c1f18`, `border 1px solid #10b981`, braille glyph 8px `#34d399`,
  at `top:-5px; right:-5px`.
- **done badge** (rail, 1d): same 13px circle, ✓ `8px/700 #34d399`.
- The identical square repeats in Tray header, CTX badge, the collapsed rail (26px,
  **6px** font, radius 7–8px) and the mobile header (18px, 4.5px font, radius 5px) —
  build it once, size-prop it.

Interaction: **clicking the ID square (anywhere it appears in the sidebar) opens the
colour picker popover** (§2.8); the clicked square gets the white ring while open.

Neutral flow colour for uncoloured issues everywhere: **slate `#94a3b8`** (1b) —
explicitly *not* a pickable colour (4b).

### 2.4 Row anatomy
`display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:7px`
(mobile 2a uses `padding:7px 9px; gap:9px` and 12px titles).

- Line 1: title **11.5px** — unselected coloured `mix of colour` (violet `#f0d2d8`/
  `#c9ebe6` style tints; implement as `color-mix(in srgb, ISSUE 25%, #d7d7e0)`),
  plain rows `#d7d7e0`, queued `#9a9aa8`; ellipsis truncate. Right-aligned amber count
  pill when sessions wait: `border-radius:99px; background:#f59e0b; color:#161006;
  font-size:9px; font-weight:700; padding:0 5px`.
- Line 2: status text **10px** — muted `#6c6c78` on plain rows, colour-tinted on
  coloured rows (`#e79aa8`, `#cbb8f7`, `#8fd8cd` ≈ `color-mix(ISSUE 55%, #9a9aa8)`;
  slate-selected uses `#aab6c8`).
  Copy patterns from the handoff: `interview waiting`, `3 agents on 3 sub-issues`,
  `working · subtasks 1/3`, `asked: "16:9 or vertical?"`,
  `drafting · started by you`, `queued`.
- Line 2 right meta (Geist Mono 9px):
  - waiting: `2h ago` amber-ish (`opacity:.85` over the line-2 tint; on the live 1d
    row explicitly `#f59e0b`),
  - working: braille spinner + counting timer, both `#10b981`,
    `display:inline-flex; gap:4px`, spinner slot `min-width:8px`,
    timer format **M:SS** (`6:30`, `2:12`),
  - done: grey total `∑ M:SS` `#6c6c78`.

### 2.5 Selected row + bridge notch
Selected row (1a, POD-128):
```
background: color-mix(in srgb, ISSUE 28%, #16161c);
border: 1px solid rgba(ISSUE, .8);          /* slate: 20% mix, rgba(148,163,184,.7) */
padding: 6px 8px;  position: relative;
title: font-weight 600, near-white tint (#f6f3ff / slate #f2f5fa)
```
Bridge notch — grows out of the row's right edge toward the engraved column:
```
position:absolute; right:-10px; top:9px; bottom:9px; width:10px;
border-radius: 0 3px 3px 0;
background: linear-gradient(90deg, rgba(ISSUE,.85), rgba(ISSUE,.12));
/* slate: rgba(148,163,184,.75) → rgba(148,163,184,.1) */
```
The notch must overlap the sidebar's right border (paint over `#2a2a34`): the scroll
container needs `overflow-x: visible` semantics — practically, render rows with
`margin-right` head-room inside the 262px column, or move the notch to a
`position:absolute` element that escapes via a non-clipping wrapper. It must also sit
above the aside's `border-right` (z-index; the aside likely needs the border drawn on
an inner element so the notch can cross it). The same mechanism must work in the
collapsed rail (§2.7) where the notch hangs off the selected *square*.

### 2.6 Motion (1d + build note 4)
Keyframes (copy verbatim from handoff `<style>` lines 16–23):
```css
@keyframes spB{0%{content:"⠋"}11%{content:"⠙"}22%{content:"⠹"}33%{content:"⠸"}
  44%{content:"⠼"}55%{content:"⠴"}66%{content:"⠦"}77%{content:"⠧"}88%{content:"⠇"}
  100%{content:"⠏"}}                             /* .8s steps(1,end) infinite */
@keyframes ignite{0%{transform:scale(.5)}55%{transform:scale(1.35)}100%{transform:scale(1)}}
@keyframes popIn{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.18);opacity:1}100%{transform:scale(1)}}
@keyframes rowFlash{0%{background-color:rgba(245,158,11,.32)}100%{background-color:rgba(245,158,11,.10)}}
@keyframes tickIn{0%{transform:translateY(5px);opacity:0}100%{transform:none;opacity:1}}
@keyframes flipAgo{0%{transform:scale(1.35);color:#10b981;opacity:.4}45%{color:#f59e0b}100%{transform:scale(1);opacity:1}}
@keyframes iconFlash{0%{box-shadow:0 0 0 0 rgba(245,158,11,.6)}100%{box-shadow:0 0 0 9px rgba(245,158,11,0)}}
```
Grammar:
- **Working** (only permanent motion): spinner `spB .8s steps(1,end) infinite` (CSS
  `content` on a `::before`) + timer counting, both mono green `#10b981`. Timer/spinner
  entrance: `tickIn .35s ease` (also on the rail's spinner corner badge).
- **queued → working**: square `ignite .55s cubic-bezier(.34,1.56,.64,1)`; row gains
  `background: color-mix(ISSUE 20%, #16161c); border: 1px solid rgba(ISSUE,.5)`
  with `transition: background .4s, border-color .4s, opacity .4s`.
- **working → waiting**: one-shot morph — row `rowFlash .9s ease-out` then holds
  `rgba(245,158,11,.10)` bg + `1px solid rgba(245,158,11,.45)` border; count pill
  `popIn .45s cubic-bezier(.34,1.56,.64,1)` (rail count badge: same popIn); timer
  freezes and flips to the "ago" stamp with `flipAgo .5s ease` (then amber, static).
  **Stillness is the signal** — nothing else may animate.
- **→ done**: ✓ `#10b981` 10px/700 pops in (`popIn .45s`; rail ✓ badge `popIn .4s`),
  timer becomes grey `∑ total`; row cools to `color-mix(ISSUE 8%, #16161c)`, border
  `rgba(ISSUE,.25)`, `opacity:.85`.
- **Queued/idle**: zero motion, dimmed `.65`.
- Ago-stamp granularity in the demo: `just now` under ~4s, then `Nm ago`.

### 2.7 Collapsed rail (3a — NEW in v2)
The sidebar collapses **262px ↔ 52px** (collapse-rules note 1); state persists.
"The rail keeps the full language" (note 2) — everything the wide rows carry survives.

Rail column (3a, lines ~129–142):
```
flex: 0 0 52px; display:flex; flex-direction:column; align-items:center;
gap:10px; background:#16161c; border-right:1px solid #2a2a34; padding:10px 0;
```
Top-to-bottom:
1. **Expand control**: `⟩` glyph, `#6c6c78`, 11px (tooltip "Expand sidebar"). The
   expanded state gets the mirrored collapse affordance (design shows only ⟩ in rail).
2. **Compact new-Claude button**: 28×28, `border:1px solid #3a3a46;
   background:#25252f; border-radius:8px`, Claude glyph `#D97757` 13px.
3. **Project hairline** per group: `width:26px; height:1px; background:#25252f`
   (title tooltip = project name). No text label.
4. **ID squares**, one per issue row, 26×26 radius 7, **Geist Mono 6px** /600 stacked
   lines — same fill/border/text language as §2.3. Queued = dashed + `opacity:.6`.
   Row-level info moves onto the square:
   - waiting → numbered amber corner badge (13px, count, §2.3),
   - working → green spinner corner badge (13px braille, §2.3),
   - selected → `box-shadow:0 0 0 2px rgba(ISSUE,.35)` **plus the bridge notch**
     hanging off the square: `position:absolute; right:-14px; top:7px; bottom:7px;
     width:10px; border-radius:0 3px 3px 0;
     background:linear-gradient(90deg, rgba(ISSUE,.85), rgba(ISSUE,.12))` — it must
     escape the 52px rail and cross the border into the engraved column (same
     clipping/z-index treatment as §2.5).
   Tooltips carry what the text lost: `"POD-128 Token refresh loop — selected, 2 waiting"`.
5. **Footer** pinned with `margin-top:auto`: the search icon (14px, `#9a9aa8`) —
   the rail keeps only search from the 4 footer buttons.

Clicking a rail square selects the issue (primary action). Colour-picker access from
the rail: secondary (context menu or reuse click-square-again on the selected square —
see OQ8); 4a says "anywhere it appears in the sidebar", so the picker must be able to
anchor to a rail square too.

### 2.8 Issue colour picker (4a/4b — NEW in v2)
Trigger: click any issue ID square in the sidebar (expanded row or rail). While open,
the clicked square shows the white ring `box-shadow: 0 0 0 2px #f3f3f8`.

Popover (anchored to the square, arrow pointing at it):
```
width:196px; background:#1b1b22; border:1px solid #3a3a46; border-radius:10px;
box-shadow:0 14px 34px rgba(0,0,0,.65), 0 2px 8px rgba(0,0,0,.5); padding:10px 11px;
arrow: 8×8px, same bg, border-left+bottom #3a3a46, rotate(45deg), on the square-facing edge
```
- Header row: `ISSUE COLOUR` (Geist Mono 8px, `.12em`, `#8d8d9a`) + right-aligned
  issue id (mono 8px `#5a5a66`, e.g. `POD-128`). `margin-bottom:9px`.
- Swatch grid: `grid-template-columns:repeat(5,1fr); gap:8px`; swatches
  `aspect-ratio:1; border-radius:6px; cursor:pointer`; hover = white ring
  `box-shadow:0 0 0 2px #f3f3f8`; current colour = white ring + centered ✓
  (10px/700, colour `color-mix(in srgb, COLOUR 30%, #000)`).
- Footer (`border-top:1px solid #25252f; padding-top:8px`): "No colour" reset —
  16×16 square `background:#25252f; border:1px dashed #6c6c78; border-radius:5px`
  with `✕` 9px `#8d8d9a`, label `10.5px #9a9aa8`, right-aligned mono hint
  `flows everywhere` (8px `#5a5a66`).

**The 10 colours** (4b, spectrum order — store as this fixed palette, decisions.md:
"10 predefined colours; each triggers predefined colouring of the colourable UI parts"):

| Name | Hex | | Name | Hex |
|---|---|---|---|---|
| Rose | `#f43f5e` | | Blue | `#3b82f6` |
| Pink | `#ec4899` | | Cyan | `#06b6d4` |
| Fuchsia | `#d946ef` | | Teal | `#14b8a6` |
| Violet | `#8b5cf6` | | Green | `#22c55e` |
| Indigo | `#6366f1` | | Lime | `#84cc16` |

Rules (4b): square text = `color-mix(in srgb, COLOUR 30%, #000)`; all tints via
`color-mix(in srgb, COLOUR n%, BASE)` at the 1a percentages. Amber/orange band is
deliberately absent — `#f59e0b` is reserved for "waiting on you", `#D97757` for
Claude, `#10b981` for working; an issue colour must never be confusable with a
status. Red folds into Rose. Slate `#94a3b8` is the no-colour flow, **not pickable**.
"No colour" resets to the neutral square (solid/dashed border per state) + slate flow.

Picking a colour recolours the whole context flow **live** — row tint, bridge,
engraved glow, tray cards, tab bar, rail (cross-dimension: the persistence + flow is
shared; the picker UI itself belongs to this dimension).

---

## 3 · Gap list

| # | Gap | Type |
|---|---|---|
| G1 | No per-issue colour in data model (`IssueWire` has none; only sessions have `agentColor`). **Decided**: user-assigned, one of 10 predefined palette entries (store name or hex), default = none/neutral | NEW data model + backend |
| G2 | No project prefix/key for the ID square's "POD" line. **Decided (decisions.md)**: keep the current `seq` id scheme, render it in the square style; real POD-prefixes arrive later via a colleague's push — any prefix shown is display-only, nothing persisted | change (display-only) |
| G3 | No `IssueIdSquare` component (needed by sidebar rows + rail + tray + mobile header — 26px/6.5px, 26px/6px rail, 18px/4.5px mobile variants, corner badges, click-to-pick) | NEW component |
| G4 | No braille spinner component / keyframes | NEW component + CSS |
| G5 | Timer: grey `12m 34s` → green mono `M:SS`, freeze→amber flipAgo→grey ∑ lifecycle | change (`time-indicators.tsx`) |
| G6 | Grouping: optional repo-grouping w/ chevroned 10.5px headers → always-on project groups w/ mono 8.5px `.12em` labels + hairline (rail: bare 26px hairline) | change |
| G7 | Sections: WORKING / PINNED / WORK sections disappear as such — state is expressed per-row (spinner/dim/amber) inside project groups | structural change (ordering rules must be re-decided, see OQ) |
| G8 | Row visuals: stage icon + 13.5px title + status dot → ID square + 11.5px/10px two-line row with colour-mixed tints, amber count pill | change |
| G9 | Selected row: flat `#232330` bg → colour-mixed bg + border + **bridge notch** overlapping the sidebar border (needs clipping/z-index rework of the aside + scroll container; must also work off a rail square) | change |
| G10 | No two-line status text derivation (`3 agents on 3 sub-issues`, `working · subtasks 1/3`, `asked: "…"`) — needs a view-model that folds sessionSummary, childCount/childDoneCount, needsHuman/humanQuestion, agentBadge into one string | NEW derive |
| G11 | Waiting **count** per row (amber pill number / rail badge number) — today only a single most-urgent dot; count of attention-state sessions/tray items needed | NEW derive |
| G12 | One-shot phase-transition animations require detecting transitions client-side (prev→next phase per issue row) — no such tracker exists | NEW hook |
| G13 | App nav rows leave the sidebar (move to top bar — shell dimension) | change (cross-dimension) |
| G14 | Nine test files in `features/worklist/` assert current DOM/classes | update |
| G15 | **No collapsed rail state** — `ResizableAside` only resizes; needs 262↔52px toggle, persisted uiState key, rail rendering of squares/hairlines/badges/notch (§2.7) | NEW state + UI |
| G16 | **No colour picker** — popover component (§2.8), 10-swatch palette constant, click handling on every ID square, "No colour" reset, live re-flow on pick | NEW component + wiring |

---

## 4 · Implementation approach

Rollout is **big bang** (decisions.md): the old sidebar layout is replaced outright,
no feature flag. Phases below are build order only.

**Phase A — foundations (blocking)**
1. Issue colour: add `color: z.enum([...10 names]).optional()` (or hex string
   constrained to the palette) to `IssueWire`
   (`packages/protocol/src/messages/issues.ts`), persist through the server issue
   store/patch registry (`apps/server/src/modules/issues/registry.ts`, `trpc.ts`),
   expose in `issues.update` patch and issue MCP (`issue_update`). Absent = neutral:
   slate `#94a3b8` flow, grey square. Define the palette once (name → hex, §2.8) in a
   shared module (client-core or a tokens package) — tints derive via `color-mix`.
2. Issue-id rendering: shared helper `issueSquareId(issue) → { top?: string, num: string }`
   — current scheme only (`seq`; prefer `linearIdentifier` split when present).
   Display-only; no stored prefix (decisions.md). Design a graceful fallback for a
   missing top line (number centered).
3. Add the seven keyframes to `apps/web/src/styles.css`; add
   `BrailleSpinner`(span + `::before` content animation, `steps(1,end)`, .8s) and
   `IssueIdSquare({ issue|id, size: 26|18, fontSize: 6.5|6|4.5, state, selected,
   corner: 'waitingDot'|'waitingCount'|'spinner'|'done', notch?, onClick })`
   under `apps/web/src/components/` (cross-feature: worklist, rail, tray, mobile
   header).

**Phase B — view-models** (`packages/client-core/src/viewmodels/derive.ts`)
4. `issueRowPhase(row, now) → 'queued' | 'working' | 'waiting' | 'done'` mapped from
   existing `attentionGroup`/`isSessionWorking`/stage.
5. `rowWaitingCount(row)` (attention-state sessions + needsHuman), and
   `rowStatusLine(row)` producing the handoff's copy patterns from sessionSummary,
   childCount/childDoneCount, humanQuestion, agentBadge labels.
6. Make project grouping unconditional: reuse `groupUnifiedWorkRows` keyed on
   repoId/repoPath; group label = repo/project display name uppercased. Retire the
   `groupByRepo` sidebar setting (or hard-default it on).

**Phase C — rows + layout** (`apps/web/src/features/worklist/`)
7. Rewrite `UnifiedRowShell`/`UnifiedIssueRow` to the two-line square row (2.4);
   keep context menu, rename editor, expandable child `PanelRow`s (children keep the
   tree, restyled to the new muted palette), snooze/defer/draft chips as line-1
   extras. ID square click = open colour picker (row click elsewhere = select).
8. Selected state + bridge notch: draw the aside's right border on an inner element,
   give the scroll container horizontal head-room (`padding-right` + negative margin
   or an un-clipped absolute layer) so the notch's `right:-10px` (rail: `-14px`)
   paints over it; notch colour = issue colour or slate.
9. New timers in `time-indicators.tsx`: `formatClock(ms) → M:SS`; `WorkingTimer`
   → green mono 9px next to `BrailleSpinner`; `AgoStamp` amber variant; `∑ total`
   variant. Keep the 1s/60s adaptive interval.
10. Phase-transition hook `useRowPhase(issueId, phase)` that remembers the previous
    phase and returns `{ phase, justEntered }` to drive the one-shot classes
    (ignite / rowFlash / popIn / flipAgo); honour `prefers-reduced-motion`.
11. Section headers: replace `CollapsibleSection`'s uppercase 10.5px header with the
    mono 8.5px label + hairline for project groups (keep collapse behaviour only if
    OQ4 says yes); drop WORKING/PINNED sections; drop the app-nav block (coordinated
    with the shell dimension); restyle `AppToolsRow` to space-around 28px buttons.
12. Sidebar width default 262px (`SIDEBAR_WIDTH_DEFAULT` in `sidebar-common.tsx:37`),
    keep drag-resize (decisions.md).

**Phase D — collapsed rail (§2.7)**
13. Add a persisted collapsed flag (uiState, e.g. `podium:sidebar:collapsed`) to the
    aside; when collapsed render `SidebarRail`: ⟩ expand control, compact new-Claude
    button, per-project hairlines, one `IssueIdSquare` per row (corner badges from
    `issueRowPhase` + `rowWaitingCount`), tooltips, footer search icon; selected
    square carries the notch across the border. Rail squares stay clickable for
    select + colour picker anchoring.

**Phase E — colour picker (§2.8)**
14. `IssueColorPicker` popover (anchored to any `IssueIdSquare`; Radix Popover or the
    app's existing popover primitive): header, 5×2 swatch grid, current-✓, hover white
    ring, "No colour" reset; writes via `issues.update` patch; optimistic local apply
    so the flow recolours live. White ring on the anchor square while open. Also add
    a context-menu entry ("Set colour…") for keyboard/rail access.

**Phase F — tests**
15. Update the nine `SidebarUnified.*.test.tsx` + `time-indicators.test.ts` +
    `derive-unified.test.ts`; add unit tests for `issueRowPhase`, `rowStatusLine`,
    `formatClock`, square-state selection, rail rendering, and colour patch
    round-trip.

### Files to touch
- `apps/web/src/features/worklist/SidebarUnified.tsx` — major rewrite of rows/sections
- `apps/web/src/features/worklist/sidebar-common.tsx` — section header, PanelRow child
  restyle, width default, collapse-to-rail state, aside border rework for the notch
- `apps/web/src/features/worklist/SidebarRail.tsx` — NEW (collapsed 52px rail)
- `apps/web/src/features/worklist/time-indicators.tsx` (+ test) — M:SS, green/amber/∑
- `apps/web/src/components/IssueIdSquare.tsx` — NEW (shared with rail/tray/mobile)
- `apps/web/src/components/BrailleSpinner.tsx` — NEW
- `apps/web/src/components/IssueColorPicker.tsx` — NEW (popover, 10 swatches, reset)
- `apps/web/src/styles.css` — keyframes; retire `dot-working` breathing glow here
- `packages/client-core/src/viewmodels/derive.ts` (+ `derive-unified.test.ts`) —
  phase/count/status-line/grouping
- shared palette module (e.g. `packages/client-core/src/issue-colors.ts`) — the 10
  colours + reserved-colour constants
- `packages/protocol/src/messages/issues.ts` — `color`
- `apps/server/src/modules/issues/registry.ts`, `trpc.ts`, `apps/server/src/issue-mcp.ts`
  — persist + patch `color`
- `apps/web/src/features/issues/issue-card.ts` (`issueIdTitle`) & IssueContextMenu —
  "Set colour…" entry
- `apps/web/src/app/AppShell.tsx` / `MobileApp.tsx` — nav relocation touchpoint
- Tests: `apps/web/src/features/worklist/SidebarUnified.*.test.tsx` (7 files)

### Dependencies on other dimensions
- **tokens**: surface/hairline/semantic palette (`#0e0e12/#16161c/#2a2a34/#25252f`,
  `#f59e0b/#10b981/#94a3b8/#D97757`) + the 10-colour issue palette should come from
  the shared token pass.
- **motion**: the keyframes above are shared with tabs/rail/tray — define once.
- **shell**: top-bar nav absorbs the sidebar nav; engraved column consumes the
  notch's colour flow and the selected issue colour; the shell owns the overall
  collapse choreography (sidebar rail is one of four desktop configurations, 3c).
- **colour-flow**: picking a colour must recolour tray/tabs/rail/engraved glow live —
  the picker writes the data; the flow spec consumes it.

---

## 5 · Open questions (need a human decision)

*(Resolved since v1: colours are user-picked from a fixed 10-swatch palette (was OQ3);
ids keep the current scheme with display-only square rendering, real prefixes later
(was OQ1); the sidebar stays resizable with 262 default (was OQ9); rollout is big
bang, no feature flag.)*

1. **Square top line today** — with only numeric `seq` available, does the square
   render a derived 3-letter repo key as the top line (display-only, e.g. "POD" from
   "podium") or the number alone centered until real identifiers arrive? Collisions
   between derived keys need no persistence answer, only display.
2. **Is "project" == repo?** The handoff groups by LUMENFALL/TARTLET. Podium groups by
   repo today. If a project is a new grouping entity above repos, that is a much
   bigger data-model change; assuming project=repo unless told otherwise.
3. **What happens to WORKING / PINNED sections and the group toggle?** The handoff
   shows neither. Do pinned sessions/issues get any affordance in the new sidebar, or
   does pinning die with this redesign? And is per-project collapse kept (handoff
   headers have no chevron)?
4. **Ordering inside a project group** — handoff shows waiting → selected → working →
   queued top-to-bottom, but is that a hard sort (state-banded, recency within band)
   or should rows keep the current urgency-rank order?
5. **Unowned-worktree rows** (`UnifiedWorktreeRow`) — the handoff only draws issue
   rows. Do worktrees get a pseudo-square (branch glyph in a 26px square?) or are they
   excluded from the new sidebar (and the rail)?
6. **Row "done" state in the sidebar** — 1d shows a done morph (✓, ∑ total, cooled
   tint). How long does a done issue linger in the list before leaving it?
7. **The `#seq` extra and hover tooltip** — the ID square now carries the number; keep
   the `#15` text extra for agent-citation matching (#21) or drop it?
8. **Colour picker from the rail** — clicking a rail square must primarily *select*
   the issue; is the picker reached by a second click on the already-selected square,
   right-click/context menu only, or does the rail drop square-click-to-pick entirely?
9. **Expanded-sidebar collapse affordance** — 3a shows only the rail's ⟩ expand
   control; where does the collapse control live in the 262px state (top bar chevron,
   footer button, drag-to-snap below a width threshold)?
10. **Expand-row chevron vs. square click** — today hover swaps the leading icon for
    an expand chevron (child sessions). With the square now clickable for colour,
    where does expand/collapse of child `PanelRow`s live (hover chevron elsewhere,
    line-2 affordance, double-click)?
