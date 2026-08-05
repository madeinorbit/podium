---
name: Podium
description: Mission control for coding agents — navy-and-yellow instrument UI, refined and restrained
colors:
  superade-yellow: "#f5c518"
  race-navy: "#0a0f1c"
  panel-navy: "#121b30"
  chip-navy: "#16223c"
  engraved-navy: "#070b16"
  bar-navy: "#050912"
  tabstrip-navy: "#0c1322"
  rail-navy: "#0e1626"
  alert-red: "#e5303f"
  live-mint: "#3eb489"
  accent-blue: "#2f6bff"
  royal-blue: "#1d4ed8"
  ink-strong: "#f3f3f8"
  ink: "#d7d7e0"
  ink-muted: "#9a9aa8"
  ink-dim: "#6c7690"
  ink-faint: "#525c78"
  label-grey: "#7a84a0"
  seam: "#243356"
  hairline-soft: "#1e2a4c"
  hairline-bar: "#283a66"
  border-strong: "#364a78"
  claude-terracotta: "#d97757"
  flow-slate: "#94a3b8"
  ochre: "#8a6200"
  ochre-rim: "#c8990a"
  daylight-paper: "#f5f6f9"
  daylight-panel: "#f9fafc"
  daylight-engraved: "#edeff2"
  daylight-ink: "#0e1626"
typography:
  headline:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.35
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "8.5px"
    fontWeight: 500
    letterSpacing: "0.12em"
  mono:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1.7
shell:
  topbarHeight: "44px"
  statusStripHeight: "24px"
  sectionBarHeight: "36px"
  sheetGap: "14px"
  sheetMaxWidth: "1180px"
rounded:
  md: "4.8px"
  lg: "6px"
  row: "7px"
  composer: "9px"
  tray: "10px"
components:
  button-primary:
    backgroundColor: "{colors.superade-yellow}"
    textColor: "{colors.race-navy}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  button-outline:
    backgroundColor: "{colors.chip-navy}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  button-ghost:
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  button-destructive:
    textColor: "{colors.alert-red}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  input:
    backgroundColor: "{colors.race-navy}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
---

# Design System: Podium

## 1. Overview

**Creative North Star: "The Podium"**

A stage where the work performs and the operator conducts. Dozens of agents run at once; the interface is the podium the conductor stands on — everything visible at a glance, nothing shouting for attention it hasn't earned. Superade Yellow (#f5c518) is the winner's color: it marks the primary action and the one thing that needs you now, against a deep race-navy chassis. The system is fast, calm, precise, technical — Linear-grade density and instant interactions, with terminal honesty at its core: real PTYs framed by chrome that recedes.

This system explicitly rejects the SaaS dashboard cliché (metric-card grids, gradient accents, marketing gloss), the AI-chat startup look (bubbles, sparkles, purple gradients), enterprise DevOps sprawl (cluttered toolbars, inconsistent panels), and Electron-app blandness (a website in a frame). Podium is an instrument, not a website.

**Key Characteristics:**
- Compact 12px-base type scale; density is a feature, not a compromise
- One brand yellow used as signal, never as decoration
- Surfaces carved into the chassis (inset shadows, hairline seams), not floated above it
- Issue colors as translucent tints over surfaces, never flat fills
- Stillness means "needs you" — the only perpetual motion is an agent actually working

## 2. Colors

Team colors: deep navy chassis, Superade Yellow signal, with red and blue as the only other voices. The dark variant is the signature look; the light variant ("Daylight", POD-372) mirrors its mechanics rather than inverting its hexes — yellow leads in both.

### Primary
- **Superade Yellow** (#f5c518): The brand color. Primary buttons, the active ring, quota warnings, and "waiting on you" attention states in the dark theme. On yellow, ink is always Race Navy — never white.
- **Ochre** (#8a6200): Superade Yellow as *ink*, for the light variant only. Yellow fills; ochre writes — #f5c518 as text is 1.6:1 on paper and must never be assigned to a text token (`--attention` is a `color:` in six places, so in light it takes the ochre). Its lighter sibling **#c8990a** is `--primary-rim`, the 1px edge that gives the yellow fill a silhouette against paper.
- **Royal Blue** (#1d4ed8): Info and success in the light variant. It no longer carries primary — that call was reversed in POD-372: a blue-primary light theme is indistinguishable from every other tool, and the premise was wrong. The rule was never yellow *text*; it is Race Navy ink on a yellow fill, which measures 11.1:1. Yellow's problem on paper is edge, not contrast.

### Secondary
- **Alert Red** (#e5303f): Destructive actions and alerts only (amended by POD-100/POD-166: live agent activity moved to calm blue). Use sparingly so it stays alarming.
- **Accent Blue** (#2f6bff): Success, host health, info, quota meters. Superade has no green; blue is the calm "all good." Live agent activity (spinner + timer, working dots) reads a lighter calm blue (#6f9dff) on dark surfaces.

### Tertiary
- **Claude Terracotta** (#d97757): Reserved for the Claude brand — agent icons, cursor blocks, ⏺ glyphs. Never an issue color, never a UI accent.
- **Flow Slate** (#94a3b8): The neutral issue-accent default when an issue has no assigned color; runs the same tint mechanics, quieter.

### Neutral
- **Race Navy** (#0a0f1c): App background (dark). The whole surface-tier family is navy: Engraved (#070b16, recessed columns), Bar (#050912, section bars), Tabstrip (#0c1322), Rail (#0e1626), Panel (#121b30, cards/sidebar), Chip (#16223c, raised buttons and popovers).
- **Ink ramp**: Strong (#f3f3f8, selected titles/headers) → Ink (#d7d7e0, body) → Muted (#9a9aa8, secondary) → Dim (#6c7690, timestamps/sub-lines) → Faint (#525c78, micro hints) → Label Grey (#7a84a0, mono section labels). Step down deliberately; never invent an in-between grey.
- **Seams**: Border (#243356, panel seams), Hairline Soft (#1e2a4c, inner dividers), Hairline Bar (#283a66), Border Strong (#364a78, chip borders, idle composer).

### Named Rules
**The Signal Rule.** Yellow marks the primary action or the thing waiting on you — one voice per screen region. If yellow appears somewhere nothing is asked of the operator, it is wrong.

**The Tint, Never Fill Rule.** Issue colors color-mix into their base surface at prescribed percentages (workspace pane 10–12%, tab strip 18%, selected row 28%, hairlines 30–50%). A flat fill of an issue color is prohibited.

The percentages above are the *dark* values; a hue mixed into a light base saturates about twice as fast, so light themes scale them rather than restating them. Two variables do it globally — `--issue-tint-scale` (0.5% in Daylight, so 28 → 14) and `--issue-line-scale` (0.85%) — consumed by the `issue-mix-*` / `issue-hairline-*` utilities, so no call site carries a per-theme percentage. Hairlines scale *down*, not up: measured against both grounds, a mid-lightness hue reads more strongly on paper than on navy, not less.

**The Reserved Hues Rule.** Terracotta (Claude), the motion colors, and the theme's signal hues are excluded from the issue palette so state and identity never collide.

## 3. Typography

**Body Font:** Geist Variable (with sans-serif fallback)
**Label/Mono Font:** Geist Mono Variable (with ui-monospace, Menlo fallback)

**Character:** One engineering-grade sans for everything, its mono sibling for machine voice — labels, timers, terminals. No display font; hierarchy comes from weight, tone, and case, not size jumps.

### Hierarchy
- **Headline** (600, 12px): Section headers in Strong ink.
- **Title** (500, 12px, 600 when selected): Row titles — sidebar rows, issue rows, tabs at 11.5–12px.
- **Body** (400, 12px, 1.5): Chat and prose runs 11.5px/1.5; sub-lines drop to 10px in Dim ink.
- **Label** (500, 8.5px Geist Mono, 0.12em tracking, UPPERCASE): Section labels (WORK, TRAY) in Label Grey; micro variant at 8px in Faint ink. Role labels 9px/600/0.07em; badge counts 9px/700.
- **Mono** (400, 10.5px Geist Mono, 1.7): Terminal output. Timers and counters use Geist Mono 9px with `tabular-nums` so digits never shift width as they tick.

### Named Rules
**The Machine Voice Rule.** Anything the system says about itself — labels, timers, counts, IDs, terminal — is Geist Mono. Anything addressed to the human is Geist Sans. Do not mix voices within one element.

## 4. Elevation

**Carved, not floating.** Depth goes inward: the middle column is engraved into the chassis with pure-black inset shadows (`inset ±3px 0 6px -3px rgb(0 0 0 / 0.85)` plus a top inset), sections separate by hairline seams and tonal tier (Bar below Engraved below Panel), and surfaces at rest cast nothing. Only transient overlays may lift: popovers use `0 14px 34px rgb(0 0 0 / 0.65), 0 2px 8px rgb(0 0 0 / 0.5)`; compact section bars cast a tight drop (`0 5px 10px -5px rgb(0 0 0 / 0.9)`) to read as a fold, not a float.

### Shadow Vocabulary
- **Engraved** (`inset 3px 0 6px -3px …, inset -3px 0 6px -3px …, inset 0 3px 6px -3px rgb(0 0 0 / 0.85)`): The recessed Tray/Super-agent column, on a flat `--engraved` surface (no issue tint).
- **Engraved bar** (`inset 2px 0 5px -2px rgb(0 0 0 / 0.85) ×2`): The folded 44px vertical bar.
- **Bar drop** (`0 5px 10px -5px rgb(0 0 0 / 0.9)`): Below compact section bars.
- **Popover** (`0 14px 34px rgb(0 0 0 / 0.65), 0 2px 8px rgb(0 0 0 / 0.5)`): Menus, color pickers — the only lifted tier.

### Named Rules
**The Carved Rule.** If a resting surface needs to look different from its neighbor, change its tone or engrave it — never lift it. Drop shadows are for things that will disappear.

**Carving in light (Daylight).** The rule holds; the material changes. Three things follow from a light ground:
- **The carve ink is the theme's, never black.** Black at 0.85 on paper reads as dirt, not depth. Themes set `--carve-engraved` / `--carve-drop` / `--carve-popover-*`; the shadow *geometry* stays shared. Daylight carves in `#0e1626` at 26%.
- **The tonal ramp compresses.** Light UIs separate with **line, not tone** — Daylight's seven tiers span 6.2 L-points against the dark theme's 12.4, so hairlines carry the separation and the engraved groove becomes the depth rather than supporting it. That is why its carve is *stronger* (26%) than a wider ramp would need (22%).
- **Still nothing lifts at rest.** Floating a white card on grey is the light-mode default and the thing to refuse; it is what makes a product look like every other tool.

## 5. Components

Refined and restrained: quiet borders, subtle states, nothing decorative. Every control is compact (32px default height) and instrument-precise.

### Buttons
- **Shape:** Gently rounded (6px, `rounded-lg`); 32px tall default, 28px `sm`, 24px `xs`, matching icon-square sizes.
- **Primary:** Superade Yellow fill, Race Navy text, 500 weight; hover dims to 80% opacity of the fill.
- **Hover / Focus:** All variants transition ~150ms; focus is a 3px ring at 50% ring color with a solid ring-colored border; active presses down 1px (`translate-y-px`).
- **Outline / Secondary / Ghost:** Outline uses the input border over a translucent chip fill; secondary mixes 5% foreground into its surface on hover; ghost only gains a muted wash. Destructive is a 10–20% red tint with red text — never a solid red slab.

### Chips
- **Style:** Header machine/quota chips are borderless, transparent, 10.5px text in Muted or Dim ink with a 6px gap to their meter or dot.
- **Meters:** 34×3.5px rounded bars on the secondary surface — data, not decoration.

### Cards / Containers
- **Corner Style:** Tray cards 10px; rows and ID squares 7px; the composer field 9px.
- **Background:** Panel Navy on the chassis; Chip Navy when raised (popovers, chip buttons).
- **Shadow Strategy:** None at rest (see The Carved Rule); engraved when recessed.
- **Border:** 1px seam (#243356); Border Strong for chip borders and the idle composer.
- **Internal Padding:** Tight 4px grid — rows pad 10–14px horizontally, sections gap 10–12px.

### Inputs / Fields
- **Style:** Full-width, 4.8px radius (`rounded-md`), 1px input border on the app background, 14px text at `text-sm`, padded 8×10px.
- **Focus:** 2px ring at 40% ring color; no border-color swap, no glow.
- **Error / Disabled:** Invalid controls get a destructive border + 20% red ring; disabled drops to 50% opacity and loses pointer events.

### Navigation
- **Shell:** A 44px command bar over independently folding columns — sidebar (52px collapsed) | engraved column | native pane | dock | rail — closed by a 24px status strip. Every section is resizable. The sidebar is persistent chrome and stays mounted in every mode; the engraved column, dock and rail are workspace instruments and go with it.
- **Tabs:** Native-pane tabs carry a 7×7px issue-color square (2.5px radius) and, when active, a 1px issue-color inset top line.
- **States:** Hover on chrome cells = accent wash + Strong ink; selection = issue tint at its prescribed percentage.
- **One datum:** every column header is `--section-bar-h` (36px), so a single seam runs edge to edge across sidebar | tray | tab strip. A column needing more room takes a second row below the datum, never a taller first row.
- **Two bands, ever:** the 44px command bar and at most one 40px contextual strip. Anything else belongs inside a column, not spanning the window. Content regions carry no page title — the mode tab already said where you are.

### The Command Bar (signature)
**Four zones, left to right. The zones are fixed; only the third changes.**

```
mark │ mode tabs │ ─ │ mode-contextual slot │ ⇠gap⇢ │ instrument well │ ─ │ utilities
```

1. **Mode tabs.** One per tool (Work, Tasks, Workflows, Specs, Automations): a 13px glyph plus an 11.5px label in a 26px cell, all cells inside **one 30px well** (see The Wells). The ACTIVE cell is the well's raised one — Chip Navy at 85%, lit along its top edge, Strong ink; the rest are bare at Dim ink. **No yellow anywhere in the switcher:** the well already answers "you are here", and a permanently-lit brand hairline in the chrome is the exact spend The Signal Rule guards. A count that is genuinely waiting on you (Tasks' proposals) keeps Attention ink, as bare tabular digits — never a filled badge, which is a consumer notification and has no home in this system.
2. **The dynamic centre** (`ToolbarSlot`). Belongs to the active mode, filled by portal from the view that owns the state. **A control earns it only when its scope is the whole mode AND no column already owns it.** Work renders nothing here — starting an agent belongs to the sidebar's spawn row, adding a session to the tab strip's `+`, splitting to the glyph beside it, and branch state to `GitStamp`'s four densities — and an empty centre is evidence the workspace is well organised, not an omission. Tasks fills it with search / Flatten / Filter / Display / New Task, which is why it no longer needs bars of its own.
3. **The instrument well.** Host and quota in ONE well divided by hairlines, never loose readouts on the bar: one object with internal structure reads as an instrument, five evenly-spaced numbers read as a website's account row. Always visible, in every mode.
4. **Utilities.** Usage and Settings as 28px icon cells at the far right, after a hairline, followed by the native window controls on Windows/Linux. The only bare cells on the bar — everything else belongs to a well or the slot.

**Surface:** `--bar`, the darkest tier — one step below the panels beneath it, so every column reads as carved INTO the chassis. **Rhythm:** one 10px gap between every zone, seams 18px tall centred in it; containers are 30px, loose controls 28px, cells inside a container 26px. Three heights, one gap — a bar whose spacings all differ reads as assembled rather than composed.

**The Wells (signature).** Modes on the left and instruments on the right are the same object: 30px, 8px radius, 2px inset, carved into the bar. It is the WELL that stops a row of glyphs reading as hyperlinks — not a container drawn around the selected one, which just makes the selection look like a button. Because `--bar` is already near-black, a groove cannot be a darker tone: its floor sits a hair ABOVE the bar (Chip Navy at 30%) and the recess comes from the edges — a dark lip along the top, a lit one along the bottom. The raised cell inside inverts exactly that bevel. Never ring a well all the way round; an outline around a group is one big button.

**Narrow behaviour:** the bar gives up words before it gives up data, and data before controls. In order: tool labels at 1180px and the QUOTA group label with them; the hostname at 1100px; the numbers on *quiet* pools at 1024px; mode labels and the MEM mark at 940px, tooltips carrying the names. A number that crossed a threshold is never shed, and no control is ever removed. Nothing is ever clipped — the well truncates the hostname, not the percentages.

### The Sheet Tier
Utilities are visited and left, so they open as a **bounded inset sheet over a held shell** (≤1180px, centred, gapped from the command bar and status strip), never as a route that replaces the window. The chrome stays *visible* around and behind them and deliberately not *operable* — the sheet is `aria-modal` and the backdrop closes it, because a surface carrying an unsaved edit has to be the only thing you can act on. Esc, the backdrop and the ✕ all close, returning to the mode you came from — and the keyboard route is stated on the ✕'s own tooltip rather than as a free-standing keycap, because the system has no keycap component and two ways to say "close" in one corner is one too many. A sheet is the one thing licensed to lift — The Carved Rule reserves drop shadows for what will disappear. Inside, panes fill the sheet and the measure caps the *text*, never the pane.

**A sheet is sized by its content, in both axes.** Vertically, `app-sheet-fit` ends the sheet where its content ends (Usage: one screen of figures); a browsing surface like Settings earns the full height. Horizontally, a sheet asks for rail + seam + padding + measure and no more — Settings caps at 1049px, not the shared 1180, because nothing in it can ever reach past 780px of measure and the difference was a dead column. A frame wider or taller than anything that can fill it is the "content stopped halfway" tell moved inside the sheet.

**One layer, ever.** A sub-flow inside a sheet — adding a machine, the Telegram setup, writing a secret, signing an account in — **takes over the sheet's own body and offers a way back**. It never opens a second modal over the first. Dialog-on-dialog is the modal tier's characteristic failure: two backdrops, two Escape owners, and a Save bar the user can no longer reach behind the thing asking them to confirm.

**Closing is refused, not confirmed, while a sheet is dirty.** Esc and the backdrop are each one stray input away, so they must not discard work — but the answer is a refusal that points at the sheet's own Save bar, not a confirm dialog, which the one-layer rule forbids and which would only restate the Discard / Save the bar already offers. The refusal is announced and nudges once; it is never silent, or Escape reads as broken.

### The Status Strip
24px, `--bar`, mono at label scale. Closes the frame at the bottom: a page ends by scrolling off into nothing, a window closes. It carries only what is window-scoped and unstated elsewhere — how many agents are computing, which task the window is pointed at, and link health while it is degraded. **Not branch or commit state:** `GitStamp` owns that in four densities and its rule is that one git fact is never restated in two places.

### The Issue-Color Channel (signature)
Every issue-tinted surface derives from one `--issue` custom property scoped per subtree, mixed over its base surface (`issue-mix-*` utilities), with a derived text ramp per scope. Reselecting or recoloring crossfades every derived mix together over 0.4s via a registered `@property`. Uncolored issues run identical mechanics in Flow Slate, slightly quieter.

### Agent State Grammar (signature)
The braille spinner (10-frame CSS `content` animation) plus a counting mono timer are the ONLY perpetual motion, running only while an agent computes. Phase changes are single one-shot morphs (~150–400ms, ease-out), then total stillness. Live activity reads calm blue (#6f9dff) in every theme — red is reserved for alerts and destructive actions (POD-166 R10). No pulses, no glows, no breathing rings.

## 6. Do's and Don'ts

### Do:
- **Do** use Superade Yellow only where action or attention is being asked — The Signal Rule.
- **Do** tint issue-colored surfaces with `color-mix` over their base at the prescribed percentages; pair every colored surface with its quieter slate fallback.
- **Do** keep controls on the compact scale: 32px buttons, 12px type, 4px spacing grid, 6–10px radii.
- **Do** put machine voice (labels, timers, IDs, counts) in Geist Mono with `tabular-nums` where digits tick.
- **Do** carve depth inward — tonal tiers, hairline seams, engraved insets; reserve drop shadows for transient overlays.
- **Do** honor `prefers-reduced-motion`: the issue-color crossfade and phase morphs already gate on it; new motion must too.

### Don't:
- **Don't** build SaaS dashboard clichés: metric-card grids, gradient accents, or marketing gloss inside the product.
- **Don't** drift toward the AI-chat startup look: bubbly chat-first layouts, sparkle icons, purple gradients, mascot energy.
- **Don't** ship enterprise-DevOps-console sprawl: cluttered toolbars, inconsistent panels, Jenkins/Grafana utilitarianism.
- **Don't** let it feel like Electron-app blandness — a website in a frame; the shell is an instrument with native manners (real pointer cursors, no text selection on chrome, safe-area aware).
- **Don't** flat-fill an issue color, use terracotta or a signal hue as an issue color, or add a green anywhere in the Superade theme — its palette is navy, yellow, red, blue.
- **Don't** add perpetual motion beyond the working spinner and timer; stillness is the "needs you" signal and must stay legible.
- **Don't** use white text on Superade Yellow — ink on yellow is always Race Navy.
