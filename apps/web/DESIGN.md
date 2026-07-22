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

Team colors: deep navy chassis, Superade Yellow signal, with red and blue as the only other voices — the dark variant is the signature look; the light variant derives with Royal Blue leading.

### Primary
- **Superade Yellow** (#f5c518): The brand color. Primary buttons, the active ring, quota warnings, and "waiting on you" attention states in the dark theme. On yellow, ink is always Race Navy — never white.
- **Royal Blue** (#1d4ed8): Carries the primary role in the light variant, where yellow can't hold contrast on paper-white; yellow remains the brand mark.

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
- **Engraved** (`inset 3px 0 6px -3px …, inset -3px 0 6px -3px …, inset 0 3px 6px -3px rgb(0 0 0 / 0.85)`): The recessed Tray/Super-agent column; compose with the issue-glow radial.
- **Engraved bar** (`inset 2px 0 5px -2px rgb(0 0 0 / 0.85) ×2`): The folded 44px vertical bar.
- **Bar drop** (`0 5px 10px -5px rgb(0 0 0 / 0.9)`): Below compact section bars.
- **Popover** (`0 14px 34px rgb(0 0 0 / 0.65), 0 2px 8px rgb(0 0 0 / 0.5)`): Menus, color pickers — the only lifted tier.

### Named Rules
**The Carved Rule.** If a resting surface needs to look different from its neighbor, change its tone or engrave it — never lift it. Drop shadows are for things that will disappear.

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
- **Shell:** A 44px command header (logo, nav, host/quota chips) over independently folding columns: sidebar (52px collapsed) | engraved column | native pane | dock | rail. Every section is resizable.
- **Tabs:** Native-pane tabs carry a 7×7px issue-color square (2.5px radius) and, when active, a 1px issue-color inset top line.
- **States:** Hover on chrome cells = accent wash + Strong ink; selection = issue tint at its prescribed percentage.

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
