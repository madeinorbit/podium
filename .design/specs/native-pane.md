# Native agents pane — tab bar, status grammar, pane chrome, terminal + prompt surfaces

Dimension spec for the Podium UI redesign (handoff **v2**). The native agents pane is the
third column of the desktop shell: the issue's agent/shell/file tabs, the Claude Code
session header, the model/command strip, the live terminal, and the prompt area — all
tinted by the selected issue's colour.

Source of truth: `/home/podium/podium/.design/podium-handoff.html`
- `#1a` lines ~680–727 — **NATIVE AGENTS pane, coloured (POD-128 violet `#8b5cf6`)**: tab bar, header, model strip, terminal, prompt. This is the reference block; every px/hex below comes from it.
- `#1b` lines ~866–913 — the same pane in **neutral slate `#94a3b8`** (uncoloured issue): gives the slate percentages.
- `#1d` (~961–1046) + build note №4 — motion grammar (braille spinner + one-shot morphs) reused on tabs.
- `#3d` (~246–262) — the pane when the engraved column folds to 44px (native gets the width; chrome identical).
- `#mnotes` item 4 + `#2b` (~419–475) — mobile: the panel dropdown replaces the tab bar; rows carry the same status grammar + pin/kill.
- `#cnotes` / `#3c` — column states; the pane always sits between the engraved column (or its folded bar) and the right rail.
- `#4b` (~85–104) — reserved colours: `#f59e0b` waiting-on-you, `#10b981` working, `#D97757` Claude. Issue colours can never collide with these.

Product decisions (`.design/decisions.md`, 2026-07-14): **big-bang rollout** (no feature flag, old chrome deleted); **every section resizable**; issue IDs keep the current scheme (square rendering owned by the sidebar/tokens dimensions); issue colours are user-assigned via the 10-colour picker.

Sibling specs this one depends on / defers to:
- `tokens.md` — fonts (Geist / Geist Mono already wired), surface tiers, hairlines, text ramp.
- `colour-flow.md` — owns the **`--ctx*` CSS-variable engine** (selected issue → `--ctx`, `--ctx-ink`, `--ctx-muted`, `--ctx-text`, slate default). This spec only CONSUMES those vars; its gap G7 ("native tab bar + pane chrome tint") is implemented HERE.
- `motion.md` — owns the `spB` braille keyframes, the one-shot morph rules, and the deletion of `.dot-working` / `.dot-starting` pulses. This spec consumes the spinner/badge classes on tabs.
- `shell-layout.md` — owns the column container the pane sits in (widths, resize, collapse).
- Mobile shell (responsive dimension) owns `MobileApp.tsx` structure; §6 below defines the shared tab-row grammar it must reuse.

---

## 1 · Current state

### 1.1 Tab bar — `apps/web/src/app/Workspace.tsx`

- Strip (line 277): `flex items-stretch gap-2 border-b border-border bg-background px-2 pt-1.5` — neutral, no issue tint, no fixed height.
- Tabs are Chrome-like (`SortableTab`, line 441): `max-w-[200px] min-w-[110px] flex-[1_1_180px] rounded-t-md`, active = `border-border bg-card`, inactive transparent with `hover:bg-muted`.
- Per-tab accent is the **agent colour**, not the issue colour: a 2px top line from `agentColorHex(tab.session.agentColor)` (line 440/461) — Claude's `/color` name mapped to hex.
- Status = `sessionDotClass(session)` (`apps/web/src/lib/derive.ts:35`): an 8px round dot, tone classes `bg-live`/`bg-warning`/`bg-red-500`/`bg-info`/`bg-muted-foreground`, plus the **forbidden** infinite pulses `dot-working` / `dot-starting` (`styles.css:39–96`).
- Pin: hover-revealed `Pin` icon button (line 515), persisted via `pins.panels` / `setPinned('panel', …)`; pinned tabs sort first (`orderTabs`). Kill: hover/active `X` button → `guardedKill` (active-session confirm, #115); file tabs → `closeFileTab`.
- Also in the strip, all to KEEP functionally: dnd-kit drag reorder (persisted per `issue:<id>` / worktree key), double-click rename (`SessionNameEditor`), right-click `SessionContextMenu`, "N archived" reveal toggle, `NewPanelMenu` ("+", portalled dropdown), Split button (`Columns2`, `toggleSplit`), pane A/B split rendering, warm-set LRU mounting, file tabs (`FileText` icon).

### 1.2 Session header + status line — `apps/web/src/features/terminal/AgentPanel.tsx`

- Header (line 497): `h-[49px] border-b border-border bg-card` — agent-kind chip (`KindIcon` + `panelLabel`), `NATIVE`/`CHAT` eyebrow (10px, hardcoded `#6c6c78`), session name, machine badge, cwd (`prettyCwd`, Folder icon), then right controls: chat/native toggle, `ResumeCommandMenu` (Terminal icon dropdown), `SnoozeControl`, BTW `Sparkles`, hibernate `Moon`, `Archive`, take-control `Keyboard`. All `size-7` ghost buttons, neutral colours.
- Status line (line 646): `h-[37px] font-mono text-[11px]` — `#D97757` 6px dot + lowercase agent kind, copy-resume pill (`border-border bg-background rounded-[5px]`), right-aligned `esc to interrupt · / for commands`. Close to the design's model strip but untinted and missing the model name.
- Terminal container (line 727): pinned to `termBg` = user's appearance background or `TERMINAL_DEFAULTS.background` (xterm `DEFAULT_THEME.background` from `packages/terminal-client/src/terminal-view.ts`). `px-3 py-2` padding. "Starting…" overlay, jump-to-bottom pill, `key-actions` row (mobile submit/newline/paste/D-pad/mic), `toolbar` slot.
- Hibernated/exited banners + panes; warm chat↔native toggle keeps the PTY mounted.

### 1.3 Terminal client packages

- `packages/terminal-client-react/src/use-terminal-session.ts` — mount/appearance/focus lifecycle only; no chrome. **No changes needed** except consuming an appearance whose background may be the tinted pane colour.
- `packages/terminal-client/src/terminal-view.ts` — `DEFAULT_THEME` (xterm palette), `DEFAULT_FONT_SIZE`, `DEFAULT_LINE_HEIGHT`. `apps/web/src/features/terminal/appearance.ts` merges user settings (`podium.terminal.appearance` ui-state blob: fontSize 8–28, fontFamily, lineHeight 1–2, background hex) over the defaults.
- `apps/web/src/features/terminal/DockShellPanel.tsx` — the right-dock shell panel reuses the terminal mount; gets the same terminal-surface treatment but its chrome is owned by the dock dimension.

### 1.4 What carries "waiting" today

`sessionDotTone` (client-core viewmodels) → `attention` tone; `attentionGroup` (`lib/home.ts`) buckets sessions. There is **no numeric waiting count per session** in the tab strip today (the sidebar dimension owns per-issue counts). The design's desktop tab shows a plain amber dot (not a number); numbers appear only on mobile menu rows and rails.

---

## 2 · Target design (exact values)

All "C" values are the issue colour via the colour-flow engine: `var(--ctx)` (slate `#94a3b8` when the issue has no colour). Percentages differ slightly between coloured (1a) and slate (1b) — the engine exposes them; where they differ they're listed as `coloured / slate`.

### 2.1 Pane surface

- Pane root: `background: color-mix(in srgb, C 12% / 9%, #0e0e12)`; right seam `1px solid #2a2a34` toward the rail.
- Fonts: UI Geist; everything mono is Geist Mono.

### 2.2 Tab bar (desktop)

- Strip: **height 34px**, `display:flex; align-items:stretch; gap:2px; padding:4px 6px 0;`
  `background: color-mix(in srgb, C 18% / 14%, #101016)`; `border-bottom: 1px solid rgba(C, .5 / .45)`.
- **Active tab**: `border-radius: 7px 7px 0 0; background: color-mix(in srgb, C 28% / 22%, #0e0e12); border: 1px solid rgba(C, .5 / .45); border-bottom: 0; box-shadow: inset 0 2px 0 C` (the 2px issue-colour top inset line); `padding: 0 11px`; text 10.5px weight 600, colour = ctx-tinted white (`#f6f3ff` violet / `#f2f5fa` slate — `--ctx-text`). Leading **7×7px square dot, radius 2.5px, background C** (full opacity). Trailing close `✕` in ctx-muted (`#8d84a6` / `#8b93a2`), weight 400.
- **Inactive tab**: no fill, no border; same radius/padding; text 10.5px weight 400 in ctx-muted-bright (`#a89fc2` / `#9aa3b2`); the 7px issue dot at `opacity: .55`.
- **Tab status glyphs** (trailing, semantic colours never the issue colour):
  - *Waiting on you*: 6px round dot, `background:#f59e0b` (plain dot on desktop tabs — no number).
  - *Working*: braille spinner — `::before` cycling `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` via `@keyframes spB`, `animation: spB .8s steps(1,end) infinite`, Geist Mono 9px `#10b981`, `min-width:8px` (reserve width so the strip doesn't jiggle).
  - *Idle/done*: nothing — stillness.
- **"+" button**: inline in the strip, `padding: 0 9px; font-size:12px; color:#6c6c78` (stays neutral, untinted).
- File tabs: same shape; keep the `FileText` glyph in place of the issue dot (mobile 2b shows a file icon + mono 11px filename).

### 2.3 Session header bar

- **Height 42px** (38px on mobile per 2b), `padding: 0 10px`, `background: color-mix(in srgb, C 24% / 18%, #0e0e12)`, `border-bottom: 1px solid rgba(C, .45 / .4)`, `gap: 8px`.
- Agent chip: `border: 1px solid rgba(C, .35); border-radius: 6px; background: rgba(14,14,18,.5); padding: 3px 7px;` Claude logo 12px `#D97757` + label 11px / 600 / `#f3f3f8`.
- Eyebrow `NATIVE` (or `CHAT`): 9px / 600 / letter-spacing .06em / ctx-muted (`#8d84a6` / `#8b93a2`).
- cwd: folder icon 11px + 10.5px ctx-muted-bright (`#a89fc2` / `#9aa3b2`), truncating.
- Right controls: **26×26px**, radius 6. The chat/native switch is the emphasized one: `background: rgba(14,14,18,.45); border: 1px solid rgba(C,.3); color: #c5bede / #c3cddb`. The rest (resume, ask-super-agent ✨, hibernate, archive) are borderless, `color: #a89fc2 / #9aa3b2`. Order in the mock: switch · resume · super-agent · hibernate · archive.

### 2.4 Model / command strip

- **Height 32px**, `padding: 0 11px`, `border-bottom: 1px solid rgba(C, .3)`, Geist Mono 10px, base colour ctx-muted (`#8d84a6` / `#8b93a2`), `gap: 9px`, overflow hidden.
- Model chip: 6px round dot `#D97757` + model name (e.g. `claude-sonnet-4.5`) in `#c5bede / #c3cddb`.
- Divider `│` in ctx-dim (`#4d4466` violet / `#4a5261` slate).
- Resume pill: `border: 1px solid rgba(C,.3); border-radius: 5px; background: rgba(14,14,18,.5); padding: 1px 7px; color: #a89fc2 / #9aa3b2` — the literal `claude --resume <id>` (click = copy, as today).
- Right-aligned: `esc to interrupt` in `#6c6478 / #6b7280`.

### 2.5 Terminal surface

- `padding: 12px 13px`; Geist Mono **10.5px / line-height 1.7**; body text `#c9c5d8 / #c9cdd8` on the pane's tinted background (i.e. the terminal region shows `color-mix(in srgb, C 12%, #0e0e12)` behind the glyphs — no separate flat black box).
- The mock's transcript colours are the CLI's own output (tool `⏺` in `#D97757`, results indented `⎿` in ctx-muted, `+14`/`−3` in `#10b981`/`#f87171`, file refs `#8ea7f5`) — these come out of the PTY; the app does not restyle transcript content.

### 2.6 Prompt / composer area (bottom of the pane)

As drawn (1a lines 721–726, identical in 1b/2b/3d): `padding: 0 13px 7px`, Geist Mono:
- Prompt row: `border-top: 1px solid rgba(C,.35); border-bottom: 1px solid rgba(C,.35); padding: 8px 2px; gap: 8px;` — `›` in `#c5bede / #c3cddb` and a **hollow block cursor 8×15px, `border: 1.5px solid #D97757`** (Claude's colour).
- Hint row below: 9.5px mono `#6c6478 / #6b7280`: `⏵⏵` in `#f59e0b`, `auto mode on` in `#e8c477`, `(shift+tab to cycle)`, `· ⇤ for agents`, right-aligned `? for shortcuts`.
- NOTE: in the real app the composer lives INSIDE the PTY (Claude Code draws its own box). See open question Q1 — default interpretation: the tinted top/bottom rules + hint row are pane chrome hugging the terminal's bottom edge; the `›` + cursor are the CLI's own pixels and are NOT re-drawn by the web app.

### 2.7 Mobile mapping (shared grammar; container owned by the responsive dimension)

From `#2b` + `#mnotes` №4: the tab bar becomes the 44px-header **panel dropdown** (overlay below the header, `background:#16161c`, `border-bottom: 1px solid rgba(C,.5)`, `box-shadow: 0 8px 24px rgba(0,0,0,.55)`, max-height ~70vh, scrolls; opening it closes the "+" menu and vice-versa). Rows `padding: 10px 12px`, `border-bottom: 1px solid #25252f`:
- Active session row: `background: color-mix(in srgb, C 18%, #16161c)`, 7px issue dot, name 12px/600 `--ctx-text`, `· ◆ Claude Code` sub-label 10px.
- Other sessions: dot at .55, name 12px `#c5bede`; right side: status (numbered amber badge — `min-width:13px; height:13px; border-radius:99px; background:#f59e0b; font: 700 7.5px Geist Mono; color:#161006` — or braille spinner `#10b981`), then **pin `⌖` and kill `✕`** icons 11px `#8d84a6`, gap 12–14px.
- File rows: file icon 12px + mono 11px path + `✕`.
- Mobile pane header is 38px (2.3's chrome, compressed); key bar cells `border:1px solid #2e2e38; border-radius:6px; background:#16161c; mono 10px #9a9aa8`, `⏎` in `#e8c477`.

### 2.8 Status grammar summary (tabs and rows)

| State | Desktop tab | Mobile menu row / rails |
|---|---|---|
| Working | braille spinner, mono 9px `#10b981` | same (rails: 13px corner badge `#0c1f18` bg, `#10b981` border, `#34d399` glyph) |
| Waiting on you | 6px amber dot `#f59e0b` | numbered amber badge 13px |
| Idle / done | nothing (stillness) | nothing / `✓` pop on completion (motion spec) |
| Phase change | one-shot morph ≤ .9s (popIn/tickIn from motion spec), then still | same |

---

## 3 · Gap list

| # | Gap | Where |
|---|---|---|
| G1 | Tab strip geometry & surfaces all wrong: no 34px height, `bg-background` untinted, `rounded-t-md`/`bg-card` tabs vs 7px-radius tinted tabs with `inset 0 2px 0 C` top line | `Workspace.tsx` 277–553 |
| G2 | Tab accent is the **agent** colour (`agentColorHex` 2px line); design keys the tab dot + all chrome to the **issue** colour (`--ctx`), agent identity moves to the header chip only | `Workspace.tsx` 440, 461 |
| G3 | Tab status is a pulsing tone dot (`sessionDotClass` + `dot-working`/`dot-starting`); design wants braille spinner (working) / plain amber dot (waiting) / stillness — no pulses | `Workspace.tsx` 500, `derive.ts` 35, `styles.css` 39–96 (motion spec owns keyframe swap) |
| G4 | Header is 49px neutral `bg-card`; design is 42px ctx-tinted with tinted hairline, 26px controls, emphasized switch button | `AgentPanel.tsx` 497 |
| G5 | Status line is 37px untinted, missing the model name chip; design is a 32px ctx-tinted model/command strip | `AgentPanel.tsx` 646 |
| G6 | Terminal container is flat `termBg` (near-black); design floats the terminal on the ctx-tinted pane surface | `AgentPanel.tsx` 727, `appearance.ts`, `terminal-view.ts` DEFAULT_THEME |
| G7 | No prompt-area chrome: tinted top/bottom rules + `auto mode on … ⇤ for agents … ? for shortcuts` hint row don't exist | `AgentPanel.tsx` bottom of native branch |
| G8 | Mobile panel dropdown rows don't carry the new grammar (status badge/spinner + `⌖`/`✕` per row, ctx tint) | `MobileApp.tsx` (container owned by responsive dimension; row component shared from here) |
| G9 | Pin affordance not in the desktop mock (only `✕` on the active tab; pin appears on mobile rows as `⌖`) — behaviour to keep, presentation to decide (Q3) | `Workspace.tsx` 515 |
| G10 | Strip extras (Split button, archived toggle, drag reorder, rename, context menu) have no styled home in the mock | `Workspace.tsx` 315–352 |

---

## 4 · Implementation approach

Big-bang restyle; keep ALL behaviour (guards, warm set, split, dnd, rename, pins, archived reveal, draft flush, e2e hooks) and swap the presentation layer.

1. **Consume the ctx engine** (prereq: colour-flow G3 lands the `--ctx*` vars + slate default on the shell root). The pane never computes issue colour itself; every value in §2 is written against `var(--ctx)` / the engine's derived shades (`--ctx-text`, `--ctx-muted`, …). Prefer a small set of `.native-*` classes in `index.css` using `color-mix(in srgb, var(--ctx) N%, BASE)` over inline arbitrary Tailwind values, since ~15 mixes repeat across strip/header/rules.
2. **Tab strip** (`Workspace.tsx`): restyle the strip container to §2.2 (34px, tinted, `pt-[4px] px-[6px]`); rewrite `SortableTab`'s classes — active/inactive per §2.2, issue dot replaces `sessionDotClass` dot, add a `TabStatus` glyph component (spinner/amber-dot/none) fed by `sessionDotTone`/`agentState.phase`. Keep dnd transform/transition, rename editor, context menu, `scrollIntoView`. Move the 2px agent-colour line off the tab (the inset top line is now `--ctx`); agent identity is already in the header chip. Restyle "+" (NewPanelMenu trigger), Split, archived toggle to quiet neutral glyphs per §2.2/Q4.
3. **Status glyph component** (shared): `AgentStatusGlyph({ session, variant: 'tab' | 'row' | 'badge' })` in `apps/web/src/lib/` — desktop-tab dot/spinner, mobile-row numbered badge, rail corner badge — so Workspace, MobileApp and the rails (other dimensions) render one grammar. Spinner CSS (`spB`) comes from the motion spec's stylesheet work; this component just applies the classes. Respect `prefers-reduced-motion` (motion spec: spinner may step slower/freeze; never pulse).
4. **AgentPanel header + model strip**: compress to 42px, apply tints; add the model-name chip (from `session.agentKind` + model metadata if available — else the kind label, Q5); merge today's 37px line into the 32px strip (keep copy-on-click resume pill, keep `/ for commands` out — design says only `esc to interrupt`). Keep machine badge, snooze, take-control (not in the mock — park them in the overflow/context menu or keep inline, Q4).
5. **Terminal surface**: default the container + xterm theme background to transparent-over-pane (xterm `background: 'transparent'` with `allowTransparency`, or compute the flat equivalent of `color-mix(C 12%, #0e0e12)` per ctx change via `setAppearance` — the hook already applies appearance live without remount). A user-set custom background in `podium.terminal.appearance` **wins over the tint** (their explicit choice); document in settings. Keep `TERMINAL_DEFAULTS` shape; adjust `toTerminalAppearance` merge.
6. **Prompt-area chrome**: add the two tinted 1px rules + the 9.5px hint row under the terminal in native mode (`⏵⏵ auto mode on (shift+tab to cycle) · ⇤ for agents … ? for shortcuts`); wire `⇤ for agents` / `? for shortcuts` only if those affordances exist (Q1/Q2) — otherwise render the static text the CLI state implies, or omit. Do NOT draw a fake `›` composer over the PTY (default per Q1).
7. **Mobile**: export the styled panel-menu row (issue dot, name, status glyph, `⌖` pin, `✕` kill; file rows) for `MobileApp.tsx` to consume; the responsive dimension wires the dropdown container.
8. **Cleanup**: delete `agentColorHex` usage in Workspace (keep the helper if the header/kind chip still wants it), drop `dot-working`/`dot-starting` from tab paths (full deletion owned by motion spec).

Suggested order: (a) strip + tabs + status glyph → (b) header/model strip → (c) terminal bg + prompt chrome → (d) mobile row export. (a) is visually independent once `--ctx` exists.

### Files to touch

- `/home/podium/podium/apps/web/src/app/Workspace.tsx` — strip, SortableTab, Empty/PanePicker restyle
- `/home/podium/podium/apps/web/src/app/NewPanelMenu.tsx` — "+" trigger styling
- `/home/podium/podium/apps/web/src/features/terminal/AgentPanel.tsx` — header, model strip, terminal container, prompt chrome
- `/home/podium/podium/apps/web/src/features/terminal/appearance.ts` (+ `appearance.test.ts`) — background default/transparency rules
- `/home/podium/podium/packages/terminal-client/src/terminal-view.ts` — only if transparency needs `allowTransparency`/theme plumbing
- `/home/podium/podium/apps/web/src/lib/derive.ts` — retire `sessionDotClass` from tab paths; new status-glyph mapping (shared)
- new: `/home/podium/podium/apps/web/src/lib/AgentStatusGlyph.tsx` (or under `features/terminal/`)
- `/home/podium/podium/apps/web/src/index.css` — `.native-*` ctx-mix utility classes
- `/home/podium/podium/apps/web/src/app/MobileApp.tsx` — consume the shared row (coordinate with responsive dimension)
- tests: `Workspace`-adjacent tests, `agent-panel-*.test.tsx` (header markup assertions), new glyph tests

---

## 5 · Open questions (product owner)

- **Q1 — Prompt chrome vs the CLI's own composer.** The mock draws a `›` + hollow `#D97757` block cursor between tinted rules at the pane bottom. The real composer is rendered by Claude Code inside the PTY. Should the web app (a) only add the tinted rules + hint row around the terminal's bottom edge (default assumed here), or (b) build a real native input strip that injects into the PTY (a big feature)?
- **Q2 — Hint-row contents.** `auto mode on (shift+tab to cycle)` and `⇤ for agents` imply app-level keybindings (cycle delegate mode, jump to agents pane). Do those shortcuts exist/ship with this redesign, or is the row decorative CLI-state text only?
- **Q3 — Pin on desktop tabs.** The mock shows no pin glyph on desktop tabs (only mobile `⌖`). Keep the hover-reveal pin button (restyled 11px `⌖`, ctx-muted), or move pinning to the right-click menu only?
- **Q4 — Un-mocked controls.** Split, "N archived", machine badge, snooze, take-control keyboard aren't in the handoff. Assumed: keep all, restyled quiet/neutral (Split + archived at the strip end; snooze/take-control in the header control row or its overflow). Confirm.
- **Q5 — Model name source.** The strip shows `claude-sonnet-4.5`. Does the server report the session's model (extend `SessionMeta`?), or do we show the agent kind (`claude code`) as today until it does?
- **Q6 — Custom terminal background vs tint.** Assumed: a user-set `podium.terminal.appearance.background` overrides the ctx tint for the terminal region (chrome stays tinted). OK, or should the tint always win / the setting be removed?
- **Q7 — Waiting numbers on desktop tabs.** Mock uses a plain amber dot on tabs but numbered badges on mobile rows/rails. Confirm desktop tabs stay unnumbered even when a session has multiple pending asks.
