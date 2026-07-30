# Mobile shell — Home list, one-pane Workspace, panel dropdown, Superagent overlay, key bar

Dimension spec for the mobile (<768px) shell of the Podium redesign.

Source of truth: `/home/podium/podium/.design/podium-handoff.html` (v2) — turn 2
("Responsive", section `#m1`, lines ~317–534): responsive notes `#mnotes` (~321–333),
`#2a` mobile Home (~336–417), `#2b` mobile Workspace + panel menu (~420–475),
`#2c` Superagent overlay (~478–531). Product decisions:
`/home/podium/podium/.design/decisions.md` (big-bang rollout — restyle in place, no flag;
issue colours user-assigned, no colour = slate `#94a3b8`).

Sibling specs this one leans on (same directory):
- `tokens.md` — hex/typography tokens (Geist / Geist Mono, surface tiers, amber `#f59e0b`, working `#10b981`, Claude `#D97757`).
- `sidebar.md` — ID-square component + row grammar; mobile Home IS the sidebar full-width.
- `engraved-column.md` — Tray + Super agent internals; mobile hosts them as a full-screen overlay.
- `colour-flow.md` — the `--issue-color` accent channel and `color-mix` percentages; mobile consumes it in header/menu/pane tints.
- `motion.md` — braille spinner + one-shot morph grammar, reused verbatim in mobile rows/badges.

The handoff's own verdict (#mnotes item 1): **the repo's mobile concept is carried
over** — single 768px breakpoint, a completely separate `MobileApp` shell, never a
squeezed desktop. This dimension is therefore a *restyle + upgrade* of an
architecture that stays.

---

## 1 · Current state

### 1.1 Shell architecture (KEEP all of this)

- `apps/web/src/lib/hooks/use-is-mobile.ts` — `matchMedia('(max-width: 768px)')`,
  single breakpoint. `AppShell.tsx` renders `MobileApp` below it, desktop shell above.
- `apps/web/src/app/MobileApp.tsx` (~465 lines) — the whole mobile shell:
  - `useVisualViewportHeight()` (lines 47–82): pins `--viewport-h` to
    `visualViewport.height`, snaps document scroll to 0, sets `--kb-open` (0/1)
    when the layout−visual viewport delta > 150px. **Handoff #mnotes item 6 says
    copy this verbatim — it already exists here; keep byte-for-byte.**
  - Header (lines 254–357): `height: calc(44px + var(--safe-top))`,
    `pt-[var(--safe-top)]`. Cells: Home, Sparkles (✦ toggle → `superOpen`),
    KanbanSquare (Issues), then the one context dropdown (selection title +
    current panel, `aria-expanded`), then `NewPanelMenu` ("+", controlled, mutual
    exclusion with the panel menu — repo #97), then `<HostIndicators compact />`.
  - Panel dropdown (lines 358–427): `absolute inset-x-0 z-30`,
    `top: calc(44px + var(--safe-top))`,
    `max-h-[min(70vh,calc(var(--viewport-h,100dvh)-120px))]`, scrollable,
    `shadow-[0_8px_24px_rgba(0,0,0,0.5)]`. Rows: session rows
    (`sessionDotClass` dot + `WorkerLabel` + Pin + ✕ kill via `guardedKill`) and
    file rows (FileText icon + basename + ✕ close). `panels` memo merges
    `sessionsForIssueNav`/`sessionsForWorktree` (agents AND shells) with
    `fileTabs`, ordered by `orderTabs` under the same `issue:<id>` key desktop uses.
  - Keep-pane-valid effect (lines 213–229) incl. `justOpened` ref and `file:` panes.
  - `MobileHomeView` (lines 89–99): reuses `NewWorkRow`, `AppToolsRow`,
    `WorkSections` from `features/worklist/SidebarUnified.tsx`.
  - Superagent overlay (lines 456–460): `superOpen` → `absolute inset-0 z-20`
    wrapping `<SuperagentView onClose={…}/>` over the content area (header stays).
  - `onPointerDownCapture={closePanelMenus}` on the content area dismisses both menus.
- `apps/web/src/styles.css`:
  - `--safe-top/right/bottom/left` from `env(safe-area-inset-*)` (lines 5–8).
  - `.mobile-shell` (line 154): `height: var(--viewport-h, 100dvh)`,
    `touch-action: manipulation`; `body:has(.mobile-shell){position:fixed}` so the
    document never scrolls/rubber-bands.
  - Key bars (lines 198–307): `.toolbar` (scrollable strip of terminal keys,
    populated by AgentPanel via `toolbarRef`) and `.key-actions`
    (Submit / Newline / Paste / `ArrowSwipeKey` D-pad / mic — AgentPanel.tsx
    lines 768–819). Both mobile-only, both hidden until `ready` (`kb-hidden`) and
    in chat mode. Bottom padding = `(1 - var(--kb-open)) * env(safe-area-inset-bottom)`
    so the bar sits flush above the soft keyboard when it's up.
- Tests: `apps/web/src/app/MobileApp.test.tsx`.

### 1.2 What does NOT match the target

- **Zero issue-colour / ID-square language.** Generic shadcn tokens (`bg-card`,
  `border-border`, `text-primary`), lucide icons, no 18px ID square in the header,
  no tinted chrome on the workspace, no colour dots in the panel menu.
- Header dropdown shows *issue title (small) / panel name (big)* but lacks the ID
  square, the 7px issue-colour dot, the `+N` other-panel count, and ▾/▴ caret states.
- Panel-menu rows lack the status grammar: amber numbered pill for waiting, green
  braille spinner while working, agent-kind label ("· ◆ Claude Code"), the active
  row's 18% tint. Pin is a lucide icon vs. the design's ⌖; kill ✕ matches.
- Home list styling is whatever `SidebarUnified` currently renders (old grammar);
  the redesigned rows arrive from the sidebar dimension — mobile only owns the
  full-width container, paddings, and the bottom utility icon row.
- Superagent overlay has **no Tray** — `SuperagentView` is chat-only today; the
  engraved-column dimension builds Tray + the two compact section bars. Mobile
  must host that column full-screen with the ⌄ minimize affordance.
- Key bar visuals: current two rows (`.key-actions` + `.toolbar`) with flat keys;
  the design (2b lines 464–471) shows one row of six equal bordered keys.
- `superOpen` header button uses `text-primary` for active; design wants lit amber
  `#f59e0b` (same thing once tokens land) — fine, but the ✦ glyph itself is used
  in the design, not lucide Sparkles (glyph choice: see open questions).

---

## 2 · Target design (exact values from the handoff)

All Geist / Geist Mono per `tokens.md`. Frame width in comps: 390px, height 720px.

### 2.1 Header (all views) — 2a lines 340–353, 2b 424–437, 2c 482–495

- Bar: `height: 44px` (+ `--safe-top` padding above), `flex; align-items:stretch`,
  `border-bottom: 1px solid`.
- **Neutral (Home / Superagent views)**: bg `#16161c`, cell borders + bottom
  border `#2a2a34`.
- **Workspace (issue selected)**: bg `color-mix(in srgb, ISSUE 16%, #16161c)`,
  cell borders `rgba(ISSUE, .3)`, bottom border `rgba(ISSUE, .45)`. (2b uses
  violet `#8b5cf6`; slate `#94a3b8` when uncoloured, per colour-flow.)
- Three nav cells, left: Home (house svg 15px), ✦ Super agent, Issues (kanban svg
  15px). Each `padding: 0 13px; border-right: 1px solid <cell-border>`. Inactive
  `#9a9aa8`; the active view's cell is **amber `#f59e0b`** (2a Home lit, 2c ✦ lit).
- **Context dropdown** (flex:1, `gap:8px; padding:0 10px`):
  - **18px ID square**: `border-radius:5px`, issue colour bg, Geist Mono
    **4.5px/600**, two stacked lines (POD / 128), text = dark mix of the colour
    (`#1e0b44` for violet; rule: `color-mix(in srgb, COLOUR 30%, #000)`).
  - Two-line text block (`line-height:1.2`):
    - line 1 — 9px, muted (`#8d84a6` tinted / `#8d84a6`-ish neutral), truncating:
      the **issue title** on workspace/home (2a/2b) or the **branch** in 2c.
    - line 2 — 12px / 500 / `#f3f3f8`, truncating: `7px × 7px, radius 2.5px`
      issue-colour dot + **active panel name** (e.g. `auth-refresh`) + caret
      (9px, ▾ closed / ▴ open) + mono 9px `#6c6c78` **`+3`** count of the other
      panels (2a line 348; count hidden when the menu is open, 2b line 432).
  - 2a note (line 416): **the dropdown is NOT an issue picker** — it's the panel
    selector for the current work; issues are chosen on Home. Tapping it from any
    view is the way back into the current issue's panels.
- **"+"** (new agent): `＋` 15px `#9a9aa8` (`#a89fc2` on tinted header), `padding:0 3px`.
- **Host cell**: `border-left: 1px solid <cell-border>; padding: 0 11px`, 6px
  round dot `#34d399` (compact `HostIndicators`).

### 2.2 Home (2a, lines 354–413)

Full-width work list = the redesigned desktop sidebar content (sidebar dimension
owns row internals; identical hexes). Container: `flex-1; overflow;
padding: 10px 10px 6px; row gap: 3px` over bg `#0e0e12`.

- "New Claude in podium" chip: `border:1px solid #3a3a46; bg #25252f;
  radius 8px; padding 9px 11px; 12px/500 #eaeaf0`, Claude glyph `#D97757` 14px, ▾ right.
- Project labels: Geist Mono 8.5px, `letter-spacing:.12em`, `#7a7a86`, trailing
  1px hairline `#25252f`; `padding:4px 4px 2px` (later groups `8px 4px 2px`).
- Issue rows (`gap:9px; padding:7px 9px; radius 7px`):
  - 26px ID square (radius 7px, Geist Mono 6.5px/600 stacked; solid colour fill /
    solid `#8d8d9a` border on `#25252f` / dashed `#6c6c78` = queued, row opacity .65).
  - Title 12px (coloured rows use the tinted text ramp, e.g. `#f0d2d8` on rose);
    selected row title 600 `#f6f3ff`.
  - Status line 10px + right-aligned mono 9px timestamp (opacity .85), or the
    working pair: braille spinner + counting timer, mono 9px `#10b981`.
  - Amber count pill: `border-radius:99px; bg #f59e0b; color #161006;
    font-size 9px/700; padding 0 5px`.
  - Row tints: unselected coloured `color-mix(in srgb, COLOUR 11–13%, #16161c)`;
    **selected** `28%` + `border:1px solid rgba(COLOUR,.8)`.
- Bottom utility row (lines 407–412): `margin-top:auto; border-top:1px solid
  #25252f; padding:9px 10px 4px; justify-content:space-around; color:#9a9aa8`;
  four 15px icons — new issue (folder+), usage (bar chart), settings (gear),
  search. Maps to today's `AppToolsRow` relocated to the bottom.

### 2.3 Workspace + panel dropdown (2b, lines 422–474)

- Shell bg behind the pane: `color-mix(in srgb, ISSUE 10%, #0e0e12)`.
- **Panel dropdown** (replaces the tab bar; ▴ in header while open):
  - Overlay: `position:absolute; left/right:0; top:44px(+safe-top); z above pane;
    bg #16161c; border-bottom:1px solid rgba(ISSUE,.5);
    box-shadow: 0 8px 24px rgba(0,0,0,.55)`; **max-height ~70vh, scrolls**
    (2b caption; keep the current `min(70vh, viewport-h − 120px)` refinement).
    Opening it closes the "+" menu and vice-versa (repo #97 — already done).
  - Rows: `gap:9px; padding:10px 12px; border-bottom:1px solid #25252f` (none on last).
    - **Active session row** (line 440): bg `color-mix(in srgb, ISSUE 18%, #16161c)`,
      7px/2.5px colour dot, name 12px/600 `#f6f3ff`, kind label
      `· ◆ Claude Code` 10px `#8d84a6` with ◆ in `#D97757`; right: ⌖ pin ✕ kill,
      `#8d84a6` 11px, `gap:14px`.
    - Other session rows: dot at `opacity:.55`, name 12px `#c5bede`; right cluster
      `gap:12px` = status (13px amber count pill, mono 7.5px/700 — or braille
      spinner mono 10px `#10b981`) then ⌖ then ✕.
    - File rows (line 443): 12px file svg `#8d84a6` + filename Geist Mono 11px
      `#c5bede` + ✕ only (no pin, no status).
  - Pane behind dims to `opacity:.55` while the menu is open.
- **Native pane chrome** (owned by the workspace/native-pane dimension; mobile
  just hosts one pane): 38px bar `color-mix(ISSUE 24%, #0e0e12)`, bottom border
  `rgba(ISSUE,.45)`, agent chip (bordered `rgba(ISSUE,.35)`, radius 6, Claude glyph +
  11px/600 name), `NATIVE` 9px/600 letter-spaced `#8d84a6`, cwd mono 10px right.
- **Key bar** (lines 464–471) — bottom-anchored, flush above the soft keyboard:
  - Strip: `bg #08080c; border-top:1px solid #2a2a34; padding:6px 8px 8px`
    (+ safe-bottom only while the keyboard is closed — keep `--kb-open` math).
  - Six equal keys `esc · tab · ctrl · ↑ · ↓ · ⏎`: `flex:1; border:1px solid
    #2e2e38; radius 6px; bg #16161c; padding:7px 0; Geist Mono 10px; #9a9aa8;
    margin-left:5px` between keys; **⏎ tinted `#e8c477`**.
  - Pinned via `--viewport-h` (#mnotes item 6 — mechanism already in repo).

### 2.4 Superagent full-screen overlay (2c, lines 480–530)

- Toggled by header ✦ (cell lit amber while open); overlay covers the content
  area under the header (`absolute inset-0` in the content wrapper, current
  z-20 fine); ⌄ in the Tray bar minimizes it back (and ✦ toggles).
- Background: `radial-gradient(340px 220px at 50% 6%, rgba(ISSUE,.10),
  rgba(ISSUE,0) 72%), #0a0a0e` — the engraved surface + context glow.
- Structure **identical to the desktop engraved column** (2c caption: "nothing has
  to be relearned"), stacked top→bottom:
  1. **Tray bar**: `bg #08080c; border-bottom:1px solid #2e2e38; padding:5px 13px`;
     ▤ amber 11px, "Tray" 12px/600 `#f3f3f8`, `ISSUE SCOPE` mono 8px
     `letter-spacing:.12em` `#5a5a66`, ⌄ right `#6c6c78` (Minimize).
  2. Tray cards (flex:none, `gap:6px; padding:8px 10px 10px`) — issue-tinted
     review/question cards, actionable only, same empty state as desktop 1c.
     **Internals owned by `engraved-column.md`** — mobile renders the same components.
  3. **Super agent bar**: same bar style, `border-top`+`border-bottom #2e2e38`,
     `box-shadow: 0 5px 10px -5px rgba(0,0,0,.9)`; ✦ amber, "Super agent",
     `OVERARCHING · KNOWS THIS ISSUE` mono 8px.
  4. Chat feed (flex:1, `padding:12px`): event lines / YOU / SUPER AGENT blocks
     with 3px left rules (`#3b82f6` you, `#10b981` agent) — engraved-column spec.
  5. Input (`padding:8px 10px 10px`): `border:1.5px solid #f59e0b; radius 9px;
     bg rgba(8,8,12,.7); padding:9px 11px; Geist Mono`; `>` prompt `#9a9aa8`,
     7×14px amber block cursor, placeholder 11.5px `#6c6c78`, send-arrow svg 13px.
- Tray is issue-scoped; the right rail's Issue/Git/Files/Shell have **no rail on
  mobile** — they fold into the panel dropdown + issue page (#mnotes item 5).

---

## 3 · Gap list (current → target)

| # | Gap | Where |
|---|-----|-------|
| G1 | Header has no ID square, no `+N` count, no ▾/▴ caret glyph states, no issue-colour tinting of bar/cell borders per view | `MobileApp.tsx` header |
| G2 | Nav cells use `text-primary` for active and lucide Sparkles/Kanban; target = amber lit cell, ✦ glyph, exact 0 13px cells with per-state border colours | `MobileApp.tsx` header |
| G3 | Panel dropdown rows lack: active-row 18% tint, colour dots, agent-kind label, amber count pill / braille spinner status column, ⌖ pin glyph, mono file names; menu lacks tinted bottom border; pane doesn't dim behind it | `MobileApp.tsx` lines 358–427 |
| G4 | Home list: old row grammar (fixed by sidebar dimension via shared `WorkSections`); mobile-owned gaps = container padding/gap, `AppToolsRow` must move to a bottom-anchored utility row, "New Claude" chip + section labels restyle (shared) | `MobileHomeView`, `SidebarUnified.tsx` |
| G5 | Superagent overlay is chat-only — no Tray, no compact section bars, no engraved glow bg, no ⌄ minimize bar; blocked on engraved-column dimension delivering mobile-hostable Tray/SA components | `SuperagentView.tsx`, `MobileApp.tsx` overlay |
| G6 | Key bar: two stacked rows of flat keys vs. one row of six bordered keys (esc/tab/ctrl/↑/↓/⏎) on `#08080c`, ⏎ highlighted; no `ctrl` key today | `styles.css` 198–307, `AgentPanel.tsx` 768–819 |
| G7 | Workspace shell/pane tinting (`color-mix` 10/16/24% chrome) absent — depends on `--issue-color` channel from colour-flow | `MobileApp.tsx`, `styles.css` |
| G8 | No mobile route to the colour picker (4a) — desktop opens it from ID squares; undefined on mobile (see open questions) | — |

Not gaps (already correct, keep): 768px breakpoint + separate shell; `--viewport-h`
/ `--kb-open` / document-scroll pinning; `--safe-top` header math; 70vh scrolling
overlay dropdown; #97 mutual exclusion; keep-pane-valid effect; `file:` panes;
pin/kill wiring (`setPinned`, `guardedKill`); `superOpen` overlay mechanism.

---

## 4 · Implementation approach

Big bang, but the mobile shell can land in three self-contained passes. All new
hexes come from the tokens spec (`tokens.md`); the accent is consumed as the
colour-flow spec's `--issue-color` variable (slate `#94a3b8` fallback), never
hardcoded per-issue.

1. **Header + panel dropdown** (core interaction surface):
   - Extract a small `IdSquare` usage from the sidebar dimension's component
     (18px variant, mono 4.5px) into the header dropdown; add the two-line block
     per §2.1, `+N` count (`panels.length - 1`, hidden while open), ▾/▴.
   - Set a `data-*`/class on `.mobile-shell` per view (`home | workspace | issues`)
     + inline `--issue-color`; CSS drives neutral vs. tinted header.
   - Rebuild dropdown rows per §2.3: status column via the same
     waiting-count/working-state selectors the sidebar rows use (`derive.ts`),
     spinner from motion spec's `.spinner-braille`, amber pill shared component.
   - Dim the pane (`opacity .55` on the content wrapper) while a menu is open.
2. **Home + Superagent overlay** (mostly composition):
   - Home: reflow `MobileHomeView` — `NewWorkRow` on top, `WorkSections` (arrives
     redesigned from the sidebar dimension), `AppToolsRow` restyled and moved to
     `margin-top:auto` bottom row per §2.2. Container `padding:10px 10px 6px`.
   - Overlay: replace bare `<SuperagentView/>` with the engraved-column
     dimension's column component (Tray + bars + chat + input) in a full-screen
     container with the §2.4 radial-glow background; wire ⌄ → `setSuperOpen(false)`;
     light the header ✦ cell amber while open.
3. **Key bar**:
   - Restyle `.toolbar`/`.key-actions` in `styles.css` to the §2.3 strip
     (`#08080c`, bordered `#16161c` keys, ⏎ `#e8c477`); reconcile the key set
     (see OQ2/OQ3) in `AgentPanel.tsx`. Keep `kb-hidden`, chat-mode hiding, the
     `--kb-open` safe-area math, and `ArrowSwipeKey` behavior unless product says
     otherwise.

Testing: extend `MobileApp.test.tsx` (header states per view, +N count, dropdown
row status grammar, overlay minimize); manual pass on iOS standalone PWA for
safe-area + keyboard (the `--kb-open` path is device-only).

## 5 · Files to touch

- `/home/podium/podium/apps/web/src/app/MobileApp.tsx` — header, dropdown, view classes, overlay host, home reflow
- `/home/podium/podium/apps/web/src/app/MobileApp.test.tsx` — extend
- `/home/podium/podium/apps/web/src/styles.css` — `.mobile-shell` tint vars, key-bar restyle (lines 154–307)
- `/home/podium/podium/apps/web/src/features/terminal/AgentPanel.tsx` — key bar rows (lines 762–819)
- `/home/podium/podium/apps/web/src/features/terminal/ArrowSwipeKey.tsx` — restyle to bordered-key look (if kept)
- `/home/podium/podium/apps/web/src/features/worklist/SidebarUnified.tsx` — `AppToolsRow` bottom variant (shared with sidebar dimension)
- `/home/podium/podium/apps/web/src/features/superagent/SuperagentView.tsx` — mobile hosting of the new column (shared with engraved-column dimension)
- `/home/podium/podium/apps/web/src/features/machines/HostIndicators.tsx` — compact cell styling
- Consumes (does not own): `IdSquare` + row grammar (sidebar dim), Tray/SA column (engraved-column dim), `--issue-color` (colour-flow dim), spinner/pill (motion + tokens dims)

## 6 · Open questions (product owner)

1. **Key-bar key set**: the comp shows exactly `esc tab ctrl ↑ ↓ ⏎`, but the shipped
   bar has Submit / Newline / Paste / swipe-D-pad / mic **plus** a scrollable strip of
   extra terminal keys. Replace with the comp's single six-key row, or keep the richer
   two-row bar restyled to the new key look? (Losing Paste/mic/Newline is a real
   capability regression on iOS.)
2. **`ctrl` behavior**: the comp adds a `ctrl` key that doesn't exist today — sticky
   one-shot modifier (press ctrl, then c → ^C), or a dedicated ^C key instead?
3. **Colour picker on mobile** (turn 4): desktop opens it by tapping ID squares, but
   the mobile header ID square opens the panel menu. Where does the picker live on
   mobile — long-press on squares, on the issue page, or not on mobile at all?
4. **Superagent overlay vs. Home**: with ✦ open, tapping Home currently switches the
   view *under* the overlay. Should Home/Issues taps auto-minimize the overlay?
5. **Issues cell**: the Issues view on mobile is today's desktop `IssuesView` squeezed.
   In scope for this redesign (own mobile layout), or explicitly out?
6. **Host cell tap**: the compact host dot is display-only in the comp. Should tapping
   it open a machines/usage sheet, or stay inert?
7. **`+N` count semantics**: reading of 2a is "other panels of the selected issue"
   (3 more besides `auth-refresh`). Confirm it's `panels − 1`, not waiting-count.
