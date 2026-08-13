---
name: Podium
description: Mission control for coding agents — ink-and-yellow instrument UI, refined and restrained
colors:
  superade-yellow: "#f5c518"
  attention-gold: "#e3ba52"
  dark-ink: "#16171a"
  panel-ink: "#23262d"
  chip-ink: "#252830"
  engraved-ink: "#191a1e"
  bar-ink: "#1b1d21"
  tabstrip-ink: "#202228"
  rail-ink: "#1e2024"
  alert-red: "#e5303f"
  accent-blue: "#2a62f0"
  live-blue: "#6f9dff"
  royal-blue: "#1d4ed8"
  ink-strong: "#f2f3f5"
  ink: "#d7dae0"
  ink-muted: "#a8adb6"
  ink-dim: "#848a94"
  ink-faint: "#6f7580"
  label-grey: "#949aa4"
  seam: "#26292f"
  hairline-soft: "#24272d"
  hairline-bar: "#26292f"
  border-strong: "#3a3f48"
  claude-terracotta: "#d97757"
  flow-grey: "#949aa4"
  ochre: "#8a6200"
  ochre-rim: "#c8990a"
  paper-ground: "#f2f1ed"
  paper-chrome: "#f7f7f5"
  paper-column: "#f4f3f0"
  paper-rail: "#eceae4"
  paper-sheet: "#ffffff"
  paper-ink: "#1d1c19"
  paper-flow: "#85817a"
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
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  button-outline:
    backgroundColor: "{colors.chip-ink}"
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
    backgroundColor: "{colors.dark-ink}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
---

# Design System: Podium

## 1. Overview

**Creative North Star: "The Podium"**

A stage where the work performs and the operator conducts. Dozens of agents run at once; the interface is the podium the conductor stands on — everything visible at a glance, nothing shouting for attention it hasn't earned. Superade Yellow (#f5c518) is the winner's color: it marks the primary action and the one thing that needs you now, against a neutral dark-ink chassis. The system is fast, calm, precise, technical — Linear-grade density and instant interactions, with terminal honesty at its core: real PTYs framed by chrome that recedes.

This system explicitly rejects the SaaS dashboard cliché (metric-card grids, gradient accents, marketing gloss), the AI-chat startup look (bubbles, sparkles, purple gradients), enterprise DevOps sprawl (cluttered toolbars, inconsistent panels), and Electron-app blandness (a website in a frame). Podium is an instrument, not a website.

**Key Characteristics:**
- Compact 12px-base type scale; density is a feature, not a compromise
- One brand yellow used as signal, never as decoration
- Surfaces separated by tonal tier and hairline seam; the window spends exactly one resting elevation, and it is spent on the stage
- Issue colors as translucent tints over surfaces, never flat fills
- Stillness means "needs you" — the only perpetual motion is an agent actually working

## 2. Colors

Team colors: a neutral dark-ink chassis, Superade Yellow signal, with red and blue as the only other voices. The dark variant is the signature look; the light variant ("Paper", POD-725, replacing POD-372's "Daylight") mirrors its mechanics rather than inverting its hexes — yellow leads in both. The dark chassis was a deep race navy through POD-725; POD-737 ("Dark Ink") took the hue out of it, so that a hue on a surface always MEANS something — which is the premise the issue-accent channel rests on.

### Primary
- **Superade Yellow** (#f5c518): The brand color. Primary buttons, the active ring, and every yellow FILL — the dots, the spines, the one primary button per region. On yellow, ink is always Dark Ink — never white.
- **Attention Gold** (#e3ba52): Superade Yellow as *ink*, for the dark variant. Same split Paper makes with ochre, one tier up: yellow fills, gold writes. `--attention` and `--warning` are `color:` in a dozen places (waiting-on-decision, needs-review, dirty-file counts); pure #f5c518 as running text against neutral ink reads as a highlighter smear, and gold measures 9.9:1.
- **Ochre** (#8a6200): Superade Yellow as *ink*, for the light variant only. Yellow fills; ochre writes — #f5c518 as text is 1.6:1 on paper and must never be assigned to a text token (`--attention` is a `color:` in six places, so in light it takes the ochre). Daylight also gave the yellow fill a 1px ochre rim for silhouette; Paper drops it (`--primary-rim: transparent`) — against warm stone the fill has an edge without one, and the rim only muddied it.
- **Accent Blue** (#2a62f0) carries info and live in the light variant; **Royal Blue** (#1d4ed8) carries success. Two blues, not one: the mission gauge puts a done band and a running band adjacent in a single meter, so a shared hue would leave the counts inside them as the only difference. Blue does not carry primary: that call was reversed in POD-372 and stands. A blue-primary light theme is indistinguishable from every other tool, and the premise was wrong. The rule was never yellow *text*; it is dark ink on a yellow fill, which measures 11.1:1. Yellow's problem on paper is edge, not contrast.

### Secondary
- **Alert Red** (#e5303f): Destructive actions and alerts only (amended by POD-100/POD-166: live agent activity moved to calm blue). Use sparingly so it stays alarming.
- **Accent Blue** (#2a62f0): Success, host health, info, quota meters — the settled fill. Superade has no green; blue is the calm "all good." What is MOVING takes the lighter **Live Blue** (#6f9dff): spinner, counting timer, working dots, live rings.

### Tertiary
- **Claude Terracotta** (#d97757): Reserved for the Claude brand — agent icons, cursor blocks, ⏺ glyphs. Never an issue color, never a UI accent.
- **Flow Grey** (#949aa4 dark / #85817a paper): The neutral issue-accent default when an issue has no assigned color; runs the same tint mechanics, quieter. It must be a TRUE neutral of its own ground — it was Flow Slate (#94a3b8) while the chassis was navy, and a blue-grey default over neutral ink reads as a blue somebody chose. `FLOW_SLATE` in `lib/issueColors.ts` keeps the old hex as a JS-mixer fallback only; call sites use `FLOW_CSS` / `var(--flow)`.

### Neutral
- **Dark Ink** (#16171a): App background (dark), and the darkest thing in the window. The surface tiers step UP from it, so the frame lifts rather than recedes (as on Paper, inverting the old navy ramp): Engraved (#191a1e, the work list and the right dock — a flat surface that steps AWAY from the work, and never an issue tint; the name outlived the groove, see §4), Bar (#1b1d21, command bar and status strip), Rail (#1e2024, the icon rail), Tabstrip (#202228), Panel (#23262d, the stage sheet, cards, popovers), Chip (#252830, raised buttons and badges), Secondary (#2c3038, active pills and the raised cell in a well).
- **Ink ramp**: Strong (#f2f3f5, selected titles/headers) → Ink (#d7dae0, body) → Muted (#a8adb6, secondary) → Label Grey (#949aa4, mono section labels) → Dim (#848a94, timestamps/sub-lines) → Faint (#6f7580, micro hints). 16.5 · 13.1 · 8.1 · 6.5 · 5.3 · 3.9 against the ground. Step down deliberately; never invent an in-between grey.
- **Seams**: Border / Hairline Bar (#26292f, panel seams and bar edges), Hairline Soft (#24272d, inner dividers and row rules), Border Strong (#3a3f48, chip borders, idle composer).
- **Paper** (#f2f1ed): App background (light), and warm stone rather than cool glass — every surface sits at hue ≈ 80–90 and chroma 0.003–0.010. Daylight's neutrals were hue 264 at near-zero chroma: correct, careful and completely anonymous, because a light UI with no warmth reads as an unlit dark theme rather than as paper. Its tiers run the same direction as Dark Ink's, but the ground is not the extreme — the icon rail, furthest from the work, sits DEEPEST: Rail (#eceae4), Ground (#f2f1ed), Column (#f4f3f0, the work list), Bar (#f7f7f5, command bar and status strip), Tabstrip (#faf9f7), Sheet/Card/Chip (#ffffff, the one true white).
- **The one ink** (#1d1c19): Paper is written from a single warm near-black — every neutral, every seam and every carve alpha is that ink at an alpha, so nothing in the light window is a cool grey. Text ramp at 100 / 82 / 68 / 48 / 40% (14.9 · 9.9 · 6.2 · 3.2 · 2.6 against the ground; the last is micro hints only); seams at 7 / 11 / 14% (#eeede8 row rules → #e6e5e0 panel seams → #e2e0d9 chip rims).

### Named Rules
**The Signal Rule.** Yellow marks the primary action or the thing waiting on you — one voice per screen region. If yellow appears somewhere nothing is asked of the operator, it is wrong.

**The Tint, Never Fill Rule.** Issue colors color-mix into their base surface at prescribed percentages (selected row 28%, hairlines 30–50%, pane header 24%). A flat fill of an issue color is prohibited.

A tint may never carry its surface past the surface *above* it in the ramp. Every mix walks toward a lighter color, and the Dark Ink ramp leaves only three levels between the tab strip (`#202228`) and the sheet it is cut into (`#23262d`) — so the strip's dose is capped at 2–3, not the handoff's 18, or the recess reads as a raised band. The workspace gutter takes no tint at all: since POD-725 it is the ground the sheet lies on, not a surface, and ground is the one thing an issue color has nothing to say about.

The percentages above are the *dark* values; a hue mixed into a light base saturates about twice as fast, so light themes scale them rather than restating them. Two variables do it globally — `--issue-tint-scale` and `--issue-line-scale`, consumed by the `issue-mix-*` / `issue-hairline-*` utilities — so no call site carries a per-theme percentage. **Dark Ink runs both at 1%**, which is what makes the numbers above literal. **Paper runs the tint at 0.4% and the line at 0.8%** (28 → 11), down from Daylight's 0.5% (POD-725): the issue palette is the Tailwind-500 ramp, chosen against a dark ground, and a saturated hue mixed into warm stone reads about twice as loud as the same mix into cool grey — at 0.5% a teal issue turned the middle of the window green. Hairlines scale *down*, not up: measured against both grounds, a mid-lightness hue reads more strongly on paper than on the dark ground, not less.

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

**The Reading Tier (POD-407).** The 12px base is the density of surfaces you *live* in — the shell, its columns, its rows. A surface you *visit*, read a sentence on, decide and leave gets one step up: 15px section heading, 13.5px/500 row label and field, 13px/1.6 prose on a 62ch measure, 12px micro, 9.5px mono eyebrow. Settings is the first tenant (`.settings-*` in styles.css); Usage is the second (`.usage-*`); any future utility sheet inherits it rather than inventing its own. Three constraints keep it from becoming a second design: **chrome never joins it** — a sheet's own header, and the command bar behind it, stay at the shell's 12px, because a utility whose frame grew with its content stops reading as part of the app — and **every step moves on two axes**, size plus weight or ink, because 13 against 13.5 is not a hierarchy on its own.

The tier has one step above its heading: **the readout, 24px/600 mono tabular in Strong ink** (POD-596). It is the answer a surface exists to give — the Usage sheet's API-equivalent cost — and it is rationed to **one figure per surface**, unboxed. The moment a second number takes it they become a metric-card grid, which is the anti-reference this system opens with; a surface with no single answer to give does not use the step at all. Everything supporting it stays inside the tier, which is the only thing that leaves it room to be loud without a card drawn around it.

**The subject step: 22px/600, −0.018em (POD-591, revised by POD-635).** A surface whose whole purpose is ONE named thing — the task detail page, and any successor that opens a single record — gets one step above the Reading Tier's section heading for that thing's name, and for nothing else on the page. Tracking tightens at this size because Geist's default spacing opens up as the optical size grows. **One per surface.** A second line at this size makes the first one chrome.

The step was 18px between POD-591 and POD-635, and the reversal is worth keeping rather than overwriting, because both readings were about the same defect seen from opposite ends. POD-591 cut an undocumented 22px title to 18px on the argument that 22 against 13px prose was a jump with nothing between it and the body. That was true, and the fix was aimed at the wrong end of the gap: read beside Linear, the whole page was small — an 18px title over 13px prose over 8.5px labels has no comfortably readable middle tier, and the eye has nowhere to rest between the name of the thing and the machine's footnotes. POD-635 raised the ladder instead of flattening it. **On this page the tier reads 22px title → 15px/600 authored section heading → 14.5px/1.6 prose → 10px mono utility label**, and the rung POD-591 was missing is the authored heading, which did not exist then. The one-figure readout, the utility sheets and the shell are unchanged: this is the SUBJECT tier, and it is the only place these values apply.

## 4. Elevation

**One elevation, spent on the stage.** The window separates by tonal tier and hairline seam; where depth exists it goes inward. Exactly one resting surface floats — the stage sheet, a 12px-radius card lying in its own gutter under the window's single real drop shadow — and that is precisely what makes the elevation legible: a shadow means something here because nothing else at rest casts one. Beyond it, only transient overlays lift, and they lift because they will disappear.

**The frame lifts (POD-725, POD-737).** Both themes step UP from their ground rather than cutting the chrome into it, and the stage ends up the brightest surface in each:

- **Dark Ink** — ground `#16171a` → work list and right dock `#191a1e` → command bar and status strip `#1b1d21` → icon rail `#1e2024` → tab strip `#202228` → **stage sheet, panels, popovers `#23262d`** → raised chip `#252830` → active cell `#2c3038`. Eight tiers across ≈10 L-points.
- **Paper** — icon rail `#eceae4` → ground `#f2f1ed` → work list `#f4f3f0` → command bar and status strip `#f7f7f5` → tab strip `#faf9f7` → **stage sheet, cards, chips, popovers `#ffffff`**. Six tiers across ≈6 L-points, with the rail — furthest from the work — set deepest rather than highest.

The old navy ramp ran the other way: `--bar` was the darkest thing in the window and every column read as cut into it. Paper inverted it first, because on a light ground the inverted order has no way to be stated at all; POD-737 then brought the dark theme with it, and the wells flipped along with the bar (see §5).

### Shadow Vocabulary
- **Sheet** (`--shadow-sheet`): The stage, and nothing else. Three layers — a 1px contact ring, a `0 2px 4px` near shadow that gives the edge weight, and `0 20px 44px -20px` of long cast that puts air under it. Built on `--carve-drop` and `--carve-popover-far`, so it blackens on ink and warms on paper.
- **Popover** (`--shadow-popover`, `0 14px 34px var(--carve-popover-far), 0 2px 8px var(--carve-popover-near)`): Menus, color pickers, drag ghosts, the Settings save bar — the transient tier.
- **Inset carve** (`--carve-engraved` as `inset 0 3px 7–8px -2px` plus a 1px lit bottom edge): The operator's prompt and the standby panel — a field that has to read as pressed INTO its surface. This is what survives of the engraved idiom: an ink for wells, not a groove around columns.
- **The wells** (`--well-floor` / `-lip` / `-rim` / `-lit`, and the `--well-cell-*` inversion): The command bar's mode and instrument containers carry their own bevel contract — see §5, The Wells.

`--shadow-engraved`, `--shadow-engraved-bar` and `--shadow-bar-drop` are still defined in `index.css` and no longer paint anything. POD-725 replaced the recessed middle column with the gutter-and-sheet, and the flight deck now states itself with an issue fade over the card tone under a 3px issue inset — a lit top edge, not a groove.

### Named Rules
**The Carved Rule (amended, POD-725).** If a resting surface needs to look different from its neighbor, change its tone or draw a hairline; it may not lift. The stage sheet is the single exception, and it is not a licence — the sheet reads as elevated *because* it is the only thing that does, so a second resting shadow anywhere in the window costs the first one its meaning. Drop shadows are otherwise for things that will disappear.

**Carving in light (Paper, POD-725).** The rule holds; the material changes. Three things follow from a light ground:
- **The carve ink is the theme's, never black.** Black at 0.85 on paper reads as dirt, not depth. Themes override `--carve-engraved` / `--carve-drop` / `--carve-popover-*` in their own ink; the shadow *geometry* stays shared. Paper carves in `#1d1c19` at **7%** (engraved) and **10%** (drop) — every alpha is the one ink, exactly.
- **Carve lightly, because tone already groups.** This reverses Daylight, which treated tonal tiering as a dark-mode idiom, leaned on hairlines alone, and then needed a 26% groove to do all the separating — which is how one palette came out flat and grubby at once. Paper tiers its chrome by tone in steps of about one L-point, so tone GROUPS and the hairline still CUTS, and the groove is left as an edge rather than a shadow.
- **The floating inks are the exception to carving lightly.** A popover and the stage sheet are the only things genuinely above the page, and on paper a cast must be deep enough to be a shadow rather than a smudge: `--carve-popover-far` is 30%, four times the engraved ink.

What Daylight was right to refuse is still refused: a *field* of white cards floating on grey is the light-mode default and the thing that makes a product look like every other tool. Paper floats one card, once, over the work.

## 5. Components

Refined and restrained: quiet borders, subtle states, nothing decorative. Every control is compact (32px default height) and instrument-precise.

### Buttons
- **Shape:** Gently rounded (6px, `rounded-lg`); 32px tall default, 28px `sm`, 24px `xs`, matching icon-square sizes.
- **Primary:** Superade Yellow fill, Dark Ink text, 500 weight; hover dims to 80% opacity of the fill.
- **Hover / Focus:** All variants transition ~150ms; focus is a 3px ring at 50% ring color with a solid ring-colored border; active presses down 1px (`translate-y-px`).
- **Outline / Secondary / Ghost:** Outline uses the input border over a translucent chip fill; secondary mixes 5% foreground into its surface on hover; ghost only gains a muted wash. Destructive is a 10–20% red tint with red text — never a solid red slab.

### Chips
- **Style:** Header machine/quota chips are borderless, transparent, 10.5px text in Muted or Dim ink with a 6px gap to their meter or dot.
- **Meters:** 34×3.5px rounded bars on the secondary surface — data, not decoration.

### Cards / Containers
- **Corner Style:** Tray cards 10px; rows and ID squares 7px; the composer field 9px.
- **Background:** Panel on the chassis; Chip when raised (popovers, chip buttons).
- **Shadow Strategy:** None at rest — the stage sheet holds the window's only resting elevation (see The Carved Rule). A field that must read as pressed in takes the `--carve-engraved` inset; it never lifts instead.
- **Border:** 1px seam (#26292f); Border Strong for chip borders and the idle composer.
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

1. **Mode tabs.** One per tool (Work, Tasks, Workflows, Specs, Automations): a 13px glyph plus an 11.5px label in a 26px cell, all cells inside **one 30px well** (see The Wells). The ACTIVE cell is the well's raised one — Secondary at 85%, lit along its top edge, Strong ink; the rest are bare at Dim ink. **No yellow anywhere in the switcher:** the well already answers "you are here", and a permanently-lit brand hairline in the chrome is the exact spend The Signal Rule guards. A count that is genuinely waiting on you (Tasks' proposals) keeps Attention ink, as bare tabular digits — never a filled badge, which is a consumer notification and has no home in this system.
2. **The dynamic centre** (`ToolbarSlot`). Belongs to the active mode, filled by portal from the view that owns the state. **A control earns it only when its scope is the whole mode AND no column already owns it.** Work renders nothing here — starting an agent belongs to the sidebar's spawn row, adding a session to the tab strip's `+`, splitting to the glyph beside it, and branch state to `GitStamp`'s four densities — and an empty centre is evidence the workspace is well organised, not an omission. Tasks fills it with search / Flatten / Filter / Display / New Task, which is why it no longer needs bars of its own.
3. **The instrument well.** Host and quota in ONE well divided by hairlines, never loose readouts on the bar: one object with internal structure reads as an instrument, five evenly-spaced numbers read as a website's account row. Always visible, in every mode.
4. **Utilities.** Usage and Settings as 28px icon cells at the far right, after a hairline, followed by the native window controls on Windows/Linux. The only bare cells on the bar — everything else belongs to a well or the slot.

**Surface:** `--bar`, one step ABOVE the ground in both themes (#1b1d21 on ink, #f7f7f5 on paper) — the frame lifts off the chassis rather than being cut into it, and the carving is spent *inside* the bar, on its wells. It read the other way until POD-737, when the bar was the darkest tier and every column below it was meant to look engraved. **Rhythm:** one 10px gap between every zone, seams 18px tall centred in it; containers are 30px, loose controls 28px, cells inside a container 26px. Three heights, one gap — a bar whose spacings all differ reads as assembled rather than composed.

**The Wells (signature).** Modes on the left and instruments on the right are the same object: 30px, 8px radius, 2px inset, carved into the bar. It is the WELL that stops a row of glyphs reading as hyperlinks — not a container drawn around the selected one, which just makes the selection look like a button. The floor sits a hair BELOW its bar on both grounds (black at 17% on ink, the theme ink at 4.5% on paper) and the recess is sharpened by the edges — a dark lip along the top, a lit one along the bottom. It used to sit ABOVE on dark, because the navy bar was itself the darkest thing in the window and a groove had nothing left to darken into; POD-737 lifted the bar off the ground, so the groove now goes where a groove goes. The raised cell inside inverts exactly that bevel. Never ring a well all the way round; an outline around a group is one big button.

**Narrow behaviour:** the bar gives up words before it gives up data, and data before controls. In order: tool labels at 1180px and the QUOTA group label with them; the hostname at 1100px; the numbers on *quiet* pools at 1024px; mode labels and the MEM mark at 940px, tooltips carrying the names. A number that crossed a threshold is never shed, and no control is ever removed. Nothing is ever clipped — the well truncates the hostname, not the percentages.

### The Sheet Tier
Utilities are visited and left, so they open as a **bounded inset sheet over a held shell** (≤1180px, centred, gapped from the command bar and status strip), never as a route that replaces the window. The chrome stays *visible* around and behind them and deliberately not *operable* — the sheet is `aria-modal` and the backdrop closes it, because a surface carrying an unsaved edit has to be the only thing you can act on. Esc, the backdrop and the ✕ all close, returning to the mode you came from — and the keyboard route is stated on the ✕'s own tooltip rather than as a free-standing keycap, because the system has no keycap component and two ways to say "close" in one corner is one too many. A utility sheet lifts because it will disappear, which is exactly what The Carved Rule reserves drop shadows for — the stage's own sheet is the other, and the only resting one. Inside, panes fill the sheet and the measure caps the *text*, never the pane.

**A sheet is sized by its content, in both axes — and the size is computed, not asserted.** Vertically, `app-sheet-fit` ends the sheet where its content ends (Usage: one screen of figures); a browsing surface like Settings earns the full height. Horizontally, a sheet asks for rail + seam + padding + form and no more — Settings resolves to 1141px, not the shared 1180, because nothing in it can reach past its form column and the difference was a dead column. Write that as a `calc()` over the parts (`--settings-rail-w`, `--settings-pane-pad`, `--settings-form-w`), never as one number with the arithmetic in a comment: the parts move — POD-407's type change moved every one of them — and a comment does not. A frame wider or taller than anything that can fill it is the "content stopped halfway" tell moved inside the sheet.

**A sheet's panes carry no repeated class banner.** Grouping in the rail states which class a destination belongs to, once. A sentence about that class re-rendered at the top of every tab on the surface is not a caption — at eight identical repeats the eye learns to skip the top of the pane, which is exactly where the tab's own heading lives. What a *single* surface genuinely has to promise belongs to that section's hint, beside the rows it is about.

**One layer, ever.** A sub-flow inside a sheet — adding a machine, the Telegram setup, writing a secret, signing an account in — **takes over the sheet's own body and offers a way back**. It never opens a second modal over the first. Dialog-on-dialog is the modal tier's characteristic failure: two backdrops, two Escape owners, and a Save bar the user can no longer reach behind the thing asking them to confirm.

**Closing is refused, not confirmed, while a sheet is dirty.** Esc and the backdrop are each one stray input away, so they must not discard work — but the answer is a refusal that points at the sheet's own Save bar, not a confirm dialog, which the one-layer rule forbids and which would only restate the Discard / Save the bar already offers. The refusal is announced and nudges once; it is never silent, or Escape reads as broken.

### The Status Strip
24px, `--bar`, mono at label scale. Closes the frame at the bottom: a page ends by scrolling off into nothing, a window closes. It carries only what is window-scoped and unstated elsewhere — how many agents are computing, which task the window is pointed at, and link health while it is degraded. **Not branch or commit state:** `GitStamp` owns that in four densities and its rule is that one git fact is never restated in two places.

### The Issue-Color Channel (signature)
Every issue-tinted surface derives from one `--issue` custom property scoped per subtree, mixed over its base surface (`issue-mix-*` utilities), with a derived text ramp per scope. Reselecting or recoloring crossfades every derived mix together over 0.4s via a registered `@property`. Uncolored issues run identical mechanics in Flow Grey (`--flow`), slightly quieter.

**The color belongs to the mission (POD-697).** A slot is set on top-level tasks only — the ones the left sidebar lists — because what the color does is tell missions apart in that column. Everything downstream (flight deck, terminal tint, tab squares, rail notch) is that one color flowing down the mission, so a sub-task holds no slot of its own and offers no picker: it would be a second, competing statement of the same thing. Sub-tasks inherit from the nearest colored ancestor, which is the mission root.

### Agent State Grammar (signature)
The braille spinner (10-frame CSS `content` animation) plus a counting mono timer are the canonical perpetual motion, running only while an agent computes. Phase changes are single one-shot morphs (~150–400ms, ease-out), then total stillness. Live activity reads calm blue (#6f9dff) in every theme — red is reserved for alerts and destructive actions (POD-166 R10). No pulses, no glows, no breathing rings.

**The predicate, not the device (POD-516 R3).** What licenses perpetual motion is not *being the spinner* — it is being driven by "an agent is computing right now". A surface may render that same fact as its own texture provided it gates on the identical predicate the spinner gates on, and provided it is the texture of the thing the fact is about rather than a second signal beside it. The worklist row's progress meter is the sanctioned instance: its running segment sweeps (1.6s ease-in-out) only while a session on that row is actually working, so a parked `in_progress` task and a stopped fleet both leave the row completely still. Anything whose motion would outlive the computing it depicts is still forbidden.

**The breath, at the end of the feed (POD-993).** The tail of a transcript gets one exception to "no breathing rings": a 14px mark whose halo expands and fades on a 3.6s symmetric ease, in the working hue. It is licensed by the same predicate as everything else here — it renders only while the session is computing, or while a message the operator just sent is in transport to it — and it is rationed to **two places, which are one signal**: the object that ENDS the feed, and the session tab that leads to that feed — a tab and its transcript must not describe the same working session with two differently shaped marks. The braille spinner is unchanged and remains the machine-voice spinner everywhere else: work lines, sidebar and menu rows, badges — dense mono lines, where a mono glyph belongs. The reasoning is that the tail is the one surface a reader watches while nothing else moves — they have just sent something and are waiting to be answered — and a stepped ten-frame glyph reads there as a terminal artefact rather than as the system thinking. Two properties only (transform, opacity), so it composites and never touches the rows above it; under reduced motion it holds its small resting frame.

**Structural motion is not state motion.** Space opening and closing — a session row joining a task, a branch folding, a reserved seat appearing, a strip growing as work leaves Proposed — is a one-shot transition of layout (~200–260ms), not a status signal, and does not spend the stillness budget. It must be latched so a freshly mounted list never replays it on first paint, and gated on `prefers-reduced-motion`.

## 6. Do's and Don'ts

### Do:
- **Do** use Superade Yellow only where action or attention is being asked — The Signal Rule.
- **Do** tint issue-colored surfaces with `color-mix` over their base at the prescribed percentages; pair every colored surface with its quieter Flow Grey fallback.
- **Do** keep controls on the compact scale: 32px buttons, 12px type, 4px spacing grid, 6–10px radii.
- **Do** put machine voice (labels, timers, IDs, counts) in Geist Mono with `tabular-nums` where digits tick.
- **Do** separate surfaces by tonal tier and hairline seam, and carve inward when a field must read as pressed in; reserve drop shadows for the stage and for what will disappear.
- **Do** honor `prefers-reduced-motion`: the issue-color crossfade and phase morphs already gate on it; new motion must too.

### Don't:
- **Don't** build SaaS dashboard clichés: metric-card grids, gradient accents, or marketing gloss inside the product.
- **Don't** drift toward the AI-chat startup look: sparkle icons, purple gradients, mascot energy, or a field of alternating bubbles. **Amended by POD-993:** the OPERATOR's turn in a transcript is a right-aligned card at a measure, because side is the cheapest possible statement of who spoke and it costs no colour, no label and no vertical space. The exception is one-sided and stays that way — the agent keeps the full column and the flat ground, the card is a tint over the sheet rather than a fill, and its radius stays on the system's 7–10px scale. Two columns of bubbles would halve the measure of the thing the reader actually came to read, which is the defect the original rule was aimed at.
- **Don't** ship enterprise-DevOps-console sprawl: cluttered toolbars, inconsistent panels, Jenkins/Grafana utilitarianism.
- **Don't** let it feel like Electron-app blandness — a website in a frame; the shell is an instrument with native manners (real pointer cursors, no text selection on chrome, safe-area aware).
- **Don't** flat-fill an issue color, use terracotta or a signal hue as an issue color, or add a green anywhere in the Superade theme — its palette is neutral ink, yellow, red, blue.
- **Don't** add perpetual motion that is not gated on the working spinner's own predicate; stillness is the "needs you" signal and must stay legible.
- **Don't** use white text on Superade Yellow — ink on yellow is always Dark Ink; and don't put #f5c518 in a text token at all (gold writes on ink, ochre on paper).
- **Don't** re-hue the neutrals. The dark chassis is neutral ink and the light one is warm stone; a tinted chrome competes with the issue-accent channel, whose whole premise is that a hue on a surface was chosen by somebody.
- **Don't** add a second resting shadow. The stage sheet is the window's one elevation, and it only reads as one while nothing else at rest casts anything.
