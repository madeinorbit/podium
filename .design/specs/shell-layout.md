# Shell Layout — Desktop Column System, 44px Header, Right Rail/Dock

Dimension spec for the Podium UI redesign, updated against handoff **v2**. Source of
truth: `.design/podium-handoff.html` (sections `#notes` build notes, `#1a` coloured flow,
`#1b` neutral flow, `#1d` motion, `#mnotes` responsive notes, and **new in v2**:
`#cnotes` collapse rules, `#3a` sidebar rail, `#3b` tray/superagent collapsed, `#3d`
engraved column folded to a 44px bar, `#3c` column-state overview) plus the product
decisions in `.design/decisions.md`. This spec covers the desktop shell skeleton only:
the top header, the four-column row (sidebar → engraved column → native pane →
rail/dock), and the collapse/resize mechanics. Sidebar row content, tray/superagent
internals, native-pane chrome, and mobile are separate dimensions — this spec defines
the containers they live in.

Product decisions folded in (from `.design/decisions.md`, 2026-07-14):

- **Rollout is BIG BANG** — replace the shell outright, no feature flag, delete the old
  layout paths as they're superseded.
- **Every section is resizable**, even where the comps don't show a handle. Collapsed
  rails/bars (52px sidebar rail, 44px right rail, 44px folded engraved bar) are the
  fixed-width exception — they're states, not sections.
- **Issue IDs keep the current scheme** for now, rendered in the new square style;
  POD-prefixed ids arrive later from a colleague's push.
- **Issue colours** are user-assigned (10-colour picker, turn 4 — owned by the
  tokens/id-square dimension); the shell only consumes the accent variable. No colour =
  slate `#94a3b8` neutral flow.
- **Header meters show the same data as today's footer** (machine + Claude Code quota).
- Logo asset: `.design/podium-logo.svg`.

---

## 1 · Current state

### Layout tree (desktop)

`apps/web/src/app/AppShell.tsx` → `AppBody` renders:

```
.desktop-shell (flex column, 100dvh)                     [styles.css:102]
  .desktop-shell-row (flex row, flex:1)                  [styles.css:113]
    ResizableAside > SidebarUnified                      (min 200, max 520, default 280)
    [superOpen] ResizableColumn > SuperagentView         (min 320, max 860, default 460, max-w 55vw)
    MainViewOutlet(workspace=<Workspace/>)               (routes: home | issues | specs | automations | workspace)
    [rightPanel] ResizableColumn > RightDock             (min 280, max 860, default 340, max-w 45vw, handleSide left)
    <nav aria-label="Panels">                            (thin rail: px-[3px], size-7 buttons)
  HostStatusBar                                          (full-width BOTTOM strip: host chips + quota + active count)
```

Key facts:

- **No desktop top header exists.** App nav (Home / Issues / Specs / Automations) is a
  button list *inside the sidebar* (`SidebarUnified.tsx` ~line 95, `nav` array with
  hard-coded hex `#232330`/`#f3f3f8`/`#9a9aa8`). Machine + quota meters live in the
  **bottom** `HostStatusBar` (`features/machines/HostIndicators.tsx:172`).
- **Column mechanics already match the target model**: `ResizableColumn`
  (`features/worklist/sidebar-common.tsx`) is the one resize mechanism (pointer-capture
  drag handle, width persisted in ui-state under `storageKey`); no media queries drive
  desktop layout; `useIsMobile` (768px) swaps to a wholly separate `MobileApp`. Keep all
  of this.
- **Superagent column** already sits sidebar | superagent | workspace, collapsible via
  store `superOpen`, resizable 320–860 default 460 (`podium:superagent:width`). Values
  already match the handoff. What's missing is the *engraved* treatment (darker surface,
  inset shadows, issue-coloured radial glow) — its column today is plain
  `border-r border-border bg-background`.
- **Right rail** exists but is a minimal `px-[3px]` strip of `size-7` ghost buttons:
  optional Sparkles (reopen superagent when closed) + the four `RIGHT_PANELS`
  (`RightDock.tsx`: issue / files / git / shell as lucide icons). No fixed 44px width,
  no issue ID square, no status corner badges, no issue-colour gradient.
- **Right dock** (`RightDock.tsx`): one panel at a time, header row `h-[49px]` with
  icon + label + close, panel persisted under `podium.rightPanel` via component state in
  `AppShell.tsx` (`RIGHT_PANEL_KEY`). Min/max/default (280/860/340) already match.
- **Workspace** (`Workspace.tsx`): native agents pane — tab strip (sessions + files,
  dnd-kit sortable), split panes A/B, `NewPanelMenu` "+" dropdown (agents only, resume
  search). Structurally correct for the target; its *chrome recolouring* (issue-tinted
  tab bar etc.) belongs to the workspace/context-flow dimension, but the shell must
  provide the issue-accent CSS variables it reads (see §4.6).
- `selectedIssueId`, `issues` (with `sessionSummary`, `seq`), `sessions` are all in the
  store — enough to derive the rail badge states. **`IssueWire` has no colour field and
  no ID prefix** (`packages/protocol/src/messages/issues.ts`): per-issue hue is genuinely
  new data-model surface (owned by the tokens/id-square dimension; the shell consumes it
  as a `--issue-*` variable set + an `<IssueIdSquare>` component). Per decisions.md the
  ID square renders the *current* id scheme, not POD-prefixes.
- **No collapse mechanisms beyond `superOpen` exist.** The sidebar only resizes (no
  52px rail state); the superagent column is binary open/closed (no 44px folded-bar
  state); `ResizableColumn` has no collapsed rendering. All three are new v2 surface.

### Current px/behaviour vs target, at a glance

| Region            | Current                                            | Target (handoff)                                    |
|-------------------|----------------------------------------------------|-----------------------------------------------------|
| Top header        | none (nav in sidebar, meters in bottom bar)        | 44px header: logo, nav pills, machine+quota meters  |
| Bottom status bar | full-width `HostStatusBar`                         | **removed** — meters move into header               |
| Sidebar           | 200–520, default 280, no collapse                  | default **262** (stays resizable) ↔ **52px rail**   |
| Superagent column | 320–860, default 460, plain bg, open/closed only   | same sizes; **engraved** surface + glow; 3 states: open ↔ **44px folded bar** ↔ closed (✦ in rail) |
| Native pane       | `bg-background`                                    | issue-tinted `color-mix` bg (context-flow dim.)     |
| Right rail        | ~22px strip, size-7 buttons                        | **44px** rail, 30px cells, ID square, gradient      |
| Right dock        | 280–860, default 340, one panel                    | unchanged values; `⟨` expand affordance on rail     |

---

## 2 · Target design (exact values from the handoff)

All colours/sizes below are lifted verbatim from `#1a` (coloured, ISSUE=`#8b5cf6`) and
`#1b` (uncoloured, ISSUE=slate `#94a3b8`). `ISSUE` = the selected issue's accent; when
the issue has no colour, the identical mechanics run in `#94a3b8` at slightly lower
percentages (given as `violet% / slate%` below). Fonts: Geist (UI), Geist Mono (IDs,
timers, meters' labels, section labels) — provided by the tokens dimension.

### 2.1 Top header (desktop) — NEW

- Container: `height:44px; flex:none; display:flex; align-items:center; gap:10px;
  border-bottom:1px solid #2a2a34; background:#16161c; padding:0 14px`.
- Logo: `podium-logo.svg`, white wordmark, `height:15px`, leftmost.
- Nav group: `display:inline-flex; gap:2px; margin-left:10px; font-size:11.5px`.
  - Item: `padding:4px 12px; border-radius:6px; color:#9a9aa8` (inactive).
  - Active item: `padding:4px 10px; color:#f3f3f8; font-weight:600` (no bg in comp).
  - Items: **Home · Issues · Specs · Automations** (same routes as today's sidebar nav).
  - Home attention badge: `border-radius:99px; background:#25252f; color:#f59e0b;
    font-size:9.5px; padding:0 6px` — count of items waiting on the human across all
    issues (same number the sidebar amber badges sum to).
- Right cluster (`margin-left:auto`):
  - Machine chip: `gap:6px; font-size:10.5px; color:#9a9aa8` — green dot `6px` round
    `#34d399`, hostname (`studio-mbp`), meter.
  - Quota chip: `gap:6px; font-size:10.5px; color:#6c6c78` — label `quota`, meter.
  - Meter (both): track `34px × 3.5px; border-radius:2px; background:#25252f`;
    fill `height:100%; background:#34d399` (width = usage %; severity recolours via the
    existing `SEVERITY` mapping — warn/critical amber/red per HostIndicators).
  - Clicking either opens the existing `HostInfoView` / quota dialog (keep behaviour).
  - Decision (decisions.md): the meters are **the same data as today's footer** —
    machine memory/health + Claude Code quota — only redesigned; no new metrics.
- The bottom `HostStatusBar` strip is removed from the desktop shell.

Note: the *mobile* header (44px + safe-area; icon cells Home/✦/Issues, issue-context
dropdown with 18px ID square, ＋, host dot) is specced in `#2a/#2b/#mnotes` and already
half-exists in `MobileApp.tsx` — out of scope here except that both headers share the
44px height and hairline `#2a2a34`.

### 2.2 Work sidebar (shell aspects only)

- Column: `flex:0 0 262px` default; **keep drag-resize** (`ResizableAside`), change
  `SIDEBAR_WIDTH_DEFAULT` 280 → **262** (min 200 / max 520 stay — handoff doesn't
  constrain them).
- Surface: `background:#16161c; border-right:1px solid #2a2a34; padding:10px 8px 6px;
  gap:3px` (column of rows).
- Structure (contents owned by worklist dimension): New-Claude spawn row on top
  (`border:1px solid #3a3a46; background:#25252f; border-radius:8px; padding:8px 10px`),
  `1px #25252f` divider, project sections with mono labels
  (`Geist Mono 8.5px; letter-spacing:.12em; color:#7a7a86`), and a bottom pinned tool
  row `margin-top:auto; border-top:1px solid #25252f; padding:8px 10px 4px;
  justify-content:space-around` with 28×28 icon buttons (Add repo / Stats / Settings /
  Search, 15px icons, `#9a9aa8`). **App nav leaves the sidebar** (→ header).

#### 2.2.1 Collapsed sidebar rail — NEW in v2 (`#3a`)

The sidebar collapses (independently, persisted) to a **52px ID-square rail**:

- Column: `flex:0 0 52px; display:flex; flex-direction:column; align-items:center;
  gap:10px; background:#16161c; border-right:1px solid #2a2a34; padding:10px 0`. Fixed
  width — no resize handle in this state.
- Top → bottom:
  1. `⟩` "Expand sidebar" control (`font-size:11px; color:#6c6c78`). (The expanded
     sidebar needs the matching collapse control — not shown in `#1a`; see Q1.)
  2. Compact New-Claude button: `28×28; border:1px solid #3a3a46; background:#25252f;
     border-radius:8px`, 13px Claude mark `#D97757`.
  3. Project groups become **hairlines**: `26×1px; background:#25252f` (project name in
     the tooltip).
  4. Issue rows become bare **26×26 ID squares** (`border-radius:7px`, Geist Mono 6px)
     with the full square grammar intact: solid colour fill + dark ink = coloured;
     `#25252f` + solid `#8d8d9a` border = active uncoloured; dashed `#6c6c78` border +
     `opacity:.6` = queued. Corner badges survive identically (amber count
     `top:-5px; right:-5px; 13px`, green braille-spinner badge). Row title/status move
     to `title` tooltips.
  5. The **selected** square keeps a `box-shadow:0 0 0 2px rgba(ISSUE,.35)` ring **and
     its bridge notch** into the engraved column: `position:absolute; right:-14px;
     top:7px; bottom:7px; width:10px; border-radius:0 3px 3px 0;
     background:linear-gradient(90deg, rgba(ISSUE,.85), rgba(ISSUE,.12))` — context
     flow survives collapse (`#cnotes` rule 2).
  6. Bottom pinned (`margin-top:auto`): the comp shows Search only (14px icon,
     `#9a9aa8`); treat as the tool row condensed to a vertical icon stack.
- Persist the state in ui-state (new key `podium:sidebar:collapsed`), independent of
  the stored expanded width.

### 2.3 Engraved column (superagent)

- Sizing: unchanged — `ResizableColumn`, min **320**, max **860**, default **460**,
  `max-w-[55vw]`. Collapse is now a tri-state (open / 44px bar / closed) — see below.
- Surface (the "engraved" look):
  - `background: radial-gradient(560px 300px at 50% 12%, rgba(ISSUE, .10 / .09),
    rgba(ISSUE, 0) 72%), #0a0a0e`
  - `box-shadow: inset 3px 0 6px -3px rgba(0,0,0,.85),
    inset -3px 0 6px -3px rgba(0,0,0,.85), inset 0 3px 6px -3px rgba(0,0,0,.85)`
  - `border-right: 1px solid #2a2a34`
- Contents (Tray + Super agent chat, `#08080c` section bars) are the superagent
  dimension; the shell owns the column surface, glow variable, and collapse.
- **Three column states — NEW in v2** (`#cnotes`, `#3c`, `#3d`); each transition
  persisted, no animation required:
  1. **Open**: resizable 320–860 as above.
  2. **Folded 44px vertical bar, in place** (`#3d`) — one step short of closing:
     - Bar: `flex:0 0 44px; display:flex; flex-direction:column; align-items:center;
       gap:12px; padding:10px 0; background:linear-gradient(180deg,
       color-mix(in srgb, ISSUE 14%, #0a0a0e), #0a0a0e 300px), #0a0a0e;
       border-right:1px solid rgba(ISSUE,.35); box-shadow:inset 2px 0 5px -2px
       rgba(0,0,0,.85), inset -2px 0 5px -2px rgba(0,0,0,.85)` — keeps the engraved
       surface + context glow.
     - Top → bottom: `⟩` expand (`11px; #8d84a6`); **Tray cell** `28×28;
       border-radius:7px; background:#16161c; border:1px solid #2e2e38` with ▤
       (`#f59e0b, 12px`) and the amber waiting-count corner badge (13px, border
       `#0a0a0e`); **Super agent cell** (same 28×28 chrome) with ✦ and a 9px amber
       unread dot (`border:2px solid #0a0a0e; top/right:-3px`); rotated label
       `TRAY · SUPER AGENT` (`flex:1; Geist Mono 8px; letter-spacing:.18em;
       color:#5a5a66; writing-mode:vertical-rl`); bottom **CTX ID square** `22×22;
       border-radius:6px; Geist Mono 5.5px` in the selected issue's fill — the colour
       still bridges sidebar → bar → native pane.
     - `⟩` (or clicking ▤/✦) expands back, landing on the clicked half.
  3. **Fully closed** (state C in `#3c`): the column is gone; a ✦ cell (30×30) appears
     in the right rail above the ID square **and the amber tray count moves onto it**.
- Inside the open column, Tray and Super agent each collapse to their compact header
  bars (`#3b`: chevron `⌄` open / `▸` closed; collapsed Tray keeps its amber count in
  the bar, collapsed Super agent keeps an unread dot and loses its input; the bars never
  disappear). That internal split is owned by the superagent dimension — the shell only
  guarantees the column surface and that its own fold/close states compose with it.

### 2.4 Native agents pane

- Stays `flex:1` (the comp's `flex:1.45 1 0` vs engraved `1.05 1 0` is a static
  approximation; the live app keeps engraved at a fixed resizable width and native takes
  the remainder). Min readable width is enforced by *collapsing other columns*, not by
  shrinking below readable — no media queries.
- Shell provides `--issue-accent` so the pane's tinted chrome
  (`color-mix(in srgb, ISSUE 12% / 9%, #0e0e12)` body, `18%/14%` tab bar, etc. — details
  in the workspace dimension) has a single source.

### 2.5 Right rail (44px)

- Column: `flex:0 0 44px; display:flex; flex-direction:column; align-items:center;
  gap:6px; padding:10px 0`.
- Surface: `background: linear-gradient(180deg,
  color-mix(in srgb, ISSUE 16% / 13%, #16161c), #16161c 240px), #16161c;
  border-left: 1px solid rgba(ISSUE, .35 / .30)`.
- Top affordance: `⟨` "Expand panel" (`font-size:11px; color:#8d84a6 / #8b93a2`) —
  opens/expands the dock to the last-used panel.
- Cells, top→bottom:
  1. **Issue ID square** (replaces the `CircleDot` Issue icon): `30×30; border-radius:7px`,
     two stacked lines (`POD` / `128`), `Geist Mono 7px; font-weight:600; line-height:1.3`.
     Fill language: solid `ISSUE` colour + dark ink (e.g. `#1e0b44` on violet) = coloured
     issue; `background:#25252f; border:1px solid #c8d2e0; color:#e8edf5` = active
     uncoloured; dashed `#6c6c78` border + `opacity:.6` = queued/idle.
     Corner status badge at `top:-5px; right:-5px`:
     - waiting: `min-width:13px; height:13px; border-radius:99px; background:#f59e0b;
       border:1px solid #16161c; font: Geist Mono 7.5px 700; color:#161006` — count of
       items waiting on the human for this issue; `animation: popIn .45s
       cubic-bezier(.34,1.56,.64,1)` on appear.
     - computing: `13px; background:#0c1f18; border:1px solid #10b981; color:#34d399;
       font-size:8px` braille spinner (`spB .8s steps(1,end) infinite`, CSS `content`
       keyframes ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏); `tickIn .35s ease` on appear.
     - done: same green scheme, static `✓`, `popIn .4s ease`.
     No badge = idle. Clicking the square toggles the **Issue** dock panel.
  2. **Git**, **Files**, **Shell**: `30×30; border-radius:7px`, 15px lucide icons,
     `stroke-width:1.8`, colour `#a89fc2` (violet context) / `#9aa3b2` (slate).
     Active panel gets a pressed treatment (keep today's `bg-secondary text-primary`
     until the tokens dimension supplies rail-specific active styles).
- When the engraved column is **fully closed**, a ✦ cell (30×30) appears above the ID
  square and carries the amber tray-count corner badge (`#3c`: "the ✦ moves into the
  right rail and the amber tray count moves onto it"). Clicking it reopens the column
  at its stored width. (This resolves former open question Q1: the reopen affordance is
  the rail cell, not a header cell.)

### 2.6 Right dock

- Unchanged mechanics: `ResizableColumn` min **280**, max **860**, default **340**,
  `handleSide:left`, `max-w-[45vw]`, exactly one of Issue / Git / Files / Shell,
  persisted (`podium.rightPanel`). Dock header restyling is the panels dimension.
- `#cnotes` phrasing: "Right dock: 44px rail ↔ rail + one panel (280–860, default 340)"
  — i.e. the rail is always present; the dock opens beside it (state D in `#3c`).

### 2.7 Motion & keyframes (shell-owned)

From `#1d` / helmet styles — copy verbatim into the app stylesheet (or motion tokens):

```css
@keyframes popIn{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.18);opacity:1}100%{transform:scale(1)}}
@keyframes tickIn{0%{transform:translateY(5px);opacity:0}100%{transform:none;opacity:1}}
@keyframes iconFlash{0%{box-shadow:0 0 0 0 rgba(245,158,11,.6)}100%{box-shadow:0 0 0 9px rgba(245,158,11,0)}}
@keyframes ignite{0%{transform:scale(.5)}55%{transform:scale(1.35)}100%{transform:scale(1)}}
@keyframes spB{0%{content:"⠋"}11%{content:"⠙"}22%{content:"⠹"}33%{content:"⠸"}44%{content:"⠼"}55%{content:"⠴"}66%{content:"⠦"}77%{content:"⠧"}88%{content:"⠇"}100%{content:"⠏"}}
```

Rules: permanent motion **only** the braille spinner + counting timer while computing;
every phase change is one one-shot morph (.35–1s) then stillness; column
collapse/expand and dock open need no animation (comp shows none — instant is fine).
Respect `prefers-reduced-motion` (repo already does this for `.dot-starting`).

### 2.8 Surfaces / palette used by the shell

`bg #0e0e12` · `panel #16161c` · `engraved #0a0a0e` · `section bar #08080c` ·
hairlines `#2a2a34` / `#25252f` / `#2e2e38` · text `#f3f3f8` / `#d7d7e0` · muted
`#9a9aa8` / `#6c6c78` · attention `#f59e0b` · working `#10b981` (dot `#34d399`) ·
Claude `#D97757` · neutral flow `#94a3b8`. Context tints are always
`color-mix(in srgb, ISSUE n%, BASE)` at 8–28%, never flat.

### 2.9 Column states & collapse rules — NEW in v2 (`#3c`, `#cnotes`)

The four canonical desktop configurations (all toggles independent — combinations are
legal, e.g. B+C = maximum native width):

| State | Layout (left → right)                                             |
|-------|-------------------------------------------------------------------|
| A     | Sidebar 262 · Tray/Super agent 320–860 · Native · Rail 44         |
| B     | **Sidebar rail 52** (§2.2.1) · Tray/Super agent · Native · Rail 44|
| C     | Sidebar 262 · *(engraved closed)* · Native (wide) · Rail 44 with ✦+count |
| D     | Sidebar 262 · Tray/Super agent · Native · **Dock 280–860** · Rail 44 |

Plus the in-place fold (`#3d`, §2.3 state 2): the engraved column as a 44px vertical
bar between sidebar and native — an intermediate between A and C.

Rules (`#cnotes`):

1. Every region collapses **independently** and its state **persists** (ui-state keys,
   same mechanism as `podium:superagent:width` / `podium.rightPanel`).
2. Collapsed states keep the full status language: ID squares, amber counts, braille
   spinners, and the selected issue's bridge notch — context flow survives collapse.
3. Tray and Super agent collapse only to their bars, never disappear (superagent dim.).
4. Per decisions.md every open section stays resizable; the fixed-width collapsed
   forms (52 rail, 44 bar, 44 rail) do not get handles.

---

## 3 · Gap list

1. **Desktop top header missing entirely** — new `TopBar` component: logo, nav pills
   (moved out of `SidebarUnified`), Home attention count, machine + quota meters
   (moved out of bottom `HostStatusBar`); bottom bar removed.
2. **Sidebar default width** 280 → 262; nav block removed from sidebar (its `view`/
   `setView` wiring moves to TopBar).
3. **Engraved treatment** on the superagent column: `#0a0a0e` + 3-side inset shadows +
   issue-accent radial glow (`--issue-accent`-driven), replacing plain
   `bg-background`.
4. **Right rail rebuild**: `flex:0 0 44px`, gradient/tint from issue accent, `⟨` expand
   affordance, Issue button → 26–30px **IssueIdSquare** with corner status badge
   (waiting count / braille spinner / ✓), Git/Files/Shell as 30×30 cells, ✦ reopen cell
   when superagent collapsed.
5. **Issue-accent plumbing**: shell computes the selected issue's accent (colour or
   slate `#94a3b8` fallback) and exposes CSS custom properties
   (`--issue-accent`, plus pre-mixed tints) on `.desktop-shell-row` for the engraved
   glow, rail gradient/border, and downstream dimensions. Depends on the new
   issue-colour field (tokens/data dimension).
6. **Shell-owned keyframes** (`popIn`, `tickIn`, `iconFlash`, `ignite`, `spB`) +
   braille-spinner element (shared with worklist/tabs dimensions).
7. **Rail badge data derivation**: per-selected-issue "waiting on human" count and
   "any session computing" boolean from `issues[].sessionSummary` / `sessions` (client
   derive only — verify `sessionSummary` exposes waiting/working counts; extend derive
   helpers if not).
8. Hard-coded hex in `SidebarUnified` nav (`#232330` etc.) disappears with the nav move;
   header/rail should consume tokens (`--surface-panel`, `--hairline`, …) once the
   tokens dimension lands, with the exact hexes above as the values.
9. **Sidebar collapse (NEW v2)**: no rail state exists — add `podium:sidebar:collapsed`
   + the 52px ID-square rail rendering (§2.2.1), with a collapse control in the
   expanded sidebar and `⟩` expand in the rail.
10. **Engraved column tri-state (NEW v2)**: `superOpen: boolean` becomes a three-value
    mode (`open | bar | closed`) — add the 44px folded vertical bar (§2.3), reopen
    landing on the clicked half, and move the amber tray count onto the rail ✦ when
    closed.
11. **Big-bang removal (decision)**: delete the retired desktop paths outright
    (bottom `HostStatusBar` on desktop, sidebar nav block) — no feature flag, no
    legacy layout kept.

Non-gaps (already correct, keep): `ResizableColumn` drag/persist mechanics; superagent
320/860/460; dock 280/860/340, one-panel-at-a-time, left handle; single 768px
breakpoint + separate `MobileApp`; `useVisualViewportHeight`; command palette wiring.

---

## 4 · Implementation approach

Ordered so each step ships green:

1. **Tokens/keyframes first** (blocked on tokens dimension for Geist + palette vars):
   add the five keyframes and surface variables to `apps/web/src/styles.css` (or the new
   tokens file). Add `IssueAccentProvider` — a small module in `apps/web/src/lib/` that
   selects `selectedIssueId` → issue colour (or `#94a3b8`) and sets
   `--issue-accent` (+ `--issue-accent-glow`, `--issue-accent-border`) via a style on
   `.desktop-shell-row` in `AppBody`.
2. **TopBar** (`apps/web/src/app/TopBar.tsx`): render inside `.desktop-shell` above
   `.desktop-shell-row`. Move the `nav` array + `view/setView` store wiring from
   `SidebarUnified`; compute the Home badge from the same derive the sidebar amber
   badges use. Extract meter markup from `HostStatusBar`/`QuotaIndicator` into compact
   header chips reusing `hostMemoryView`, `useStableConnection`, quota summary +
   existing dialogs. Delete `<HostStatusBar />` from `AppShell` (keep the `compact`
   `HostIndicators` for mobile).
3. **Sidebar shell tweaks**: `SIDEBAR_WIDTH_DEFAULT = 262` in `sidebar-common.tsx`;
   remove the nav block from `SidebarUnified` (worklist dimension restyles the rest).
4. **Sidebar rail collapse (v2)**: add `podium:sidebar:collapsed` to ui-state; when
   collapsed, `ResizableAside` renders a fixed 52px rail (`SidebarRail`, §2.2.1 —
   reuses `IssueIdSquare` + the same badge derives as the wide rows) instead of the
   resizable aside. Collapse control in the expanded sidebar, `⟩` expand in the rail.
5. **Engraved column tri-state**: replace `superOpen` with a persisted
   `superMode: 'open' | 'bar' | 'closed'` (store migration: `true`→`'open'`,
   `false`→`'closed'`). `'open'` = `ResizableColumn` + engraved surface via accent vars
   (no structural change); `'bar'` = the 44px folded bar (§2.3 state 2, new
   `SuperagentBar` component; ▤/✦ clicks expand landing on that half — coordinate the
   landing-half signal with the superagent dimension); `'closed'` = nothing rendered,
   rail shows ✦ + tray count.
6. **RightRail** (`apps/web/src/app/RightRail.tsx`, extracted from the inline `<nav>` in
   `AppShell.tsx`): 44px column, gradient bg, `⟨` expand (opens last-used
   `rightPanel`, stored alongside `podium.rightPanel`), ✦ cell (with amber tray-count
   badge) when `superMode === 'closed'`, `IssueIdSquare` (from the id-square dimension;
   consume as a component) + Git/Files/Shell cells. Badge state via a new derive helper
   (`railIssueStatus(issue, sessions): { waiting: number } | 'working' | 'done' | 'idle'`)
   in `apps/web/src/lib/derive.ts` with tests.
7. **Persistence keys**: keep `podium:superagent:width`, `podium:rightdock:width`,
   `podium:sidebar:width`, `podium.rightPanel`; add `podium.rightPanel.last` (`⟨`
   affordance), `podium:sidebar:collapsed`, `podium:superagent:mode`.
8. **Tests**: extend `AppShell`-adjacent tests (`store-viewstate`, new `TopBar.test.tsx`,
   `RightRail.test.tsx`, `SidebarRail.test.tsx`) — nav switching, badge counts,
   sidebar collapse round-trip, superMode transitions (open↔bar↔closed, reopen via rail
   ✦ and via bar cells), accent variable fallback to slate.

## 5 · Files to touch

- `apps/web/src/app/AppShell.tsx` — insert TopBar, remove bottom HostStatusBar, engraved
  aside styling, `superMode` tri-state wiring, swap inline rail for `RightRail`, mount
  accent vars.
- `apps/web/src/app/TopBar.tsx` — **new**.
- `apps/web/src/app/RightRail.tsx` — **new** (extracted + rebuilt rail).
- `apps/web/src/features/worklist/SidebarRail.tsx` — **new** (52px collapsed rail,
  §2.2.1).
- `apps/web/src/features/superagent/SuperagentBar.tsx` (or co-located with
  `SuperagentView`) — **new** (44px folded engraved bar, §2.3 state 2).
- `apps/web/src/app/RightDock.tsx` — `RIGHT_PANELS` metadata reused; Issue entry's icon
  replaced by the ID square at the rail (dock header untouched here).
- `apps/web/src/features/worklist/SidebarUnified.tsx` — remove nav block.
- `apps/web/src/features/worklist/sidebar-common.tsx` — default width 262.
- `apps/web/src/features/machines/HostIndicators.tsx` / `QuotaIndicator.tsx` — export
  compact header-chip variants; retire desktop `HostStatusBar`.
- `apps/web/src/styles.css` — keyframes, header/rail/engraved surface rules,
  `--issue-accent` defaults.
- `apps/web/src/lib/derive.ts` (+ test) — `railIssueStatus`, header attention count.
- `apps/web/src/app/store.tsx` — only if `podium.rightPanel.last` should live in
  ui-state alongside the panel key.
- Consumes from other dimensions: `IssueIdSquare` component + issue colour/prefix data
  (id-squares/tokens), Geist fonts + palette tokens (tokens), issue-tinted workspace
  chrome (workspace/context-flow).

## 6 · Open questions (for design/product)

Resolved by v2 / decisions.md (kept for the record):

- ~~Desktop ✦ placement when the engraved column is closed~~ → **resolved by `#3c`**:
  ✦ cell at the top of the right rail, carrying the amber tray count.
- ~~Sidebar min/max~~ → decisions.md makes everything resizable; keep today's 200–520.
  Collapse is a separate state (52px rail), not "resized very small".
- ~~Rollout / feature flag~~ → big bang, delete the old shell paths.

Still open:

1. **Where does the sidebar-collapse control live in the expanded sidebar?** `#3a` only
   shows the rail's `⟩` expand. Options: a `⟨` mirror at the top of the expanded
   sidebar, double-click on the resize handle, or a header/keyboard affordance.
   Assumed: a small `⟨` at the top of the sidebar (mirroring the rail) + snap-to-rail
   when dragged below min width.
2. **Header attention count semantics** — the `Home 4` badge: waiting-on-human items
   across *all* projects (sum of sidebar ambers), or count of *issues* with ≥1 waiting
   item? (Comp shows 4 with rows carrying 1+2+1 badges — suggests sum of item counts,
   but confirm.)
3. **Rail `⟨` behaviour** — expand to the last-used dock panel, or always to the Issue
   panel? And should the ID square and `⟨` be redundant (square = Issue panel, `⟨` =
   last used), as assumed here?
4. **Desktop nav badge on other views** — do Issues/Specs/Automations ever carry
   counts, or is the amber badge Home-only?
5. **HostStatusBar removal** — the bottom strip today shows per-host chips for
   *multiple* machines and an "N agents active" counter. The header comp shows exactly
   one machine chip + one quota chip. With >1 machine: aggregate into one chip that
   opens the breakdown, or repeat chips (header width risk)?
6. **Rail "done" ✓ badge lifetime** — when does an issue's ✓ clear (on view? timed?)?
   The motion spec defines the pop, not the decay.
7. **How is the folded 44px bar reached?** `#3d` shows the state, not the trigger.
   Assumed: the engraved column's collapse affordance folds to the bar, and closing the
   bar (or a second action) fully closes it into the rail — confirm the exact
   open→bar→closed gesture chain with design.
8. **Left rail 52 vs right rail 44** — the widths differ in the comps (52 fits 26px
   squares + badges; 44 fits 30px cells). Assumed deliberate; confirm.
