# Spec: Design tokens & typography

Dimension: fonts, surface colors, text colors, semantic colors, radii, hairlines, inset/engraved shadow treatment, and the 10-colour issue palette + reserved colours.
Source of truth: `/home/podium/podium/.design/podium-handoff.html` (v2) — build note №5 ("Type & colour"), №1 ("Anatomy"), №3 ("ID squares"), the inline styles of screens 1a (coloured), 1b (neutral slate), 1c (empty tray), 1d (motion demo), 2a–2c (mobile), plus **turn 3** (collapse states 3a–3d — new engraved-bar variants) and **turn 4** (4a colour-picker popover, 4b the canonical 10-colour palette + reserved-colour rules). Product decisions: `/home/podium/podium/.design/decisions.md` (user-assigned issue colours, big-bang rollout).
Verified 2026-07-14: all v1 hex values below re-checked against v2 turns 1–2 — unchanged.

---

## 1 · Current state

### Theming architecture (keep it — it already fits)
- **Tailwind v4, no tailwind.config** — everything lives in `apps/web/src/index.css`: an `@theme inline` block registers CSS vars as Tailwind colors (`--color-background: var(--background)` …), then per-preset blocks define the raw values.
- **Three presets × light/dark**: `shadcn` (default, no `data-theme`), `podium`, `superade`. Selected via `data-theme` attr + `.dark` class, managed by `apps/web/src/app/theme.tsx` (`ThemeProvider`, localStorage keys `podium.theme.preset` / `podium.theme.mode`, `THEME_BG` map that feeds the PWA `theme-color` meta; `apps/web/index.html` duplicates it in an anti-flash script).
- **Fonts already correct**: `@fontsource-variable/geist` + `@fontsource-variable/geist-mono` are imported and wired as `--font-sans` / `--font-mono` (index.css lines 4–5, 11–12). The handoff loads static Geist 400–700 / Geist Mono 400–600 from Google Fonts; the variable fonts cover those weights — no font work needed beyond weight usage.
- **`podium` dark preset already matches the handoff's core palette** (index.css `[data-theme="podium"].dark`, lines 180–216):
  - `--background: #0e0e12` ✓, `--card: #16161c` ✓, `--border: #2a2a34` ✓
  - `--primary: #f59e0b` ✓ (amber), `--secondary: #25252f` ✓, `--muted-foreground: #9a9aa8` ✓
  - `--live: #10b981` ✓, `--info: #3b82f6` ✓, `--destructive: #f87171` ✓
  - `--foreground: #d7d7e0` ✓, `--secondary-foreground / accent-foreground: #f3f3f8` ✓
  - `--success: #34d399`, `--warning: #fbbf24`, `--radius: 0.375rem` (6px), `--sidebar: #141419`, `--sidebar-border: #22222b`
- Extra semantic tokens beyond stock shadcn already exist: `--success`, `--warning`, `--live` (agent working), `--info` (user/ready blue).

### What is NOT tokenized today
- **No engraved-surface tier**: nothing for `#0a0a0e` (engraved column), `#08080c` (compact section bars / mobile key-bar strip), `#101016` (tab-strip base), `#131318` (rail base in 1d), `#1b1b22` (button chip bg), or the engraved **inset shadow**.
- **Only one hairline**: `--border #2a2a34`. The handoff uses a three-hairline system: `#2a2a34` (panel seams), `#25252f` (inner dividers / section rules), `#2e2e38` (hairlines on the darker `#08080c` bars), plus a stronger interactive border `#3a3a46` and grey-square border `#8d8d9a` / dashed `#6c6c78`.
- **Only two text levels** (`--foreground`, `--muted-foreground`). Handoff uses a 6-step text ramp (see §2).
- **Claude brand color `#D97757` is hardcoded** in at least: `apps/web/src/lib/WorkerLabel.tsx:100` (`text-[#D97757]`), `apps/web/src/lib/icons/AgentIcons.tsx:29`, `apps/web/src/lib/icons/claude-code.svg`, `apps/web/src/features/terminal/AgentPanel.tsx:649` (`bg-[#D97757]`), `apps/web/src/features/worklist/SidebarUnified.tsx:283`.
- **No neutral-flow slate** `#94a3b8` token (the 1b "uncoloured issue" accent).
- **No issue-accent channel**: nothing like `--issue-color`; `color-mix` is used only for hover math in `components/ui/button.tsx` and `features/terminal/ArrowSwipeKey.tsx`. There is also **no `color` field on issues at all** — `packages/protocol/src/messages/issues.ts` `IssueWire` has no color/hue property (data-model gap; owned by the context-flow dimension but the token layer must expose the channel).
- **`styles.css` motion contradicts the new grammar**: `.dot-working` breathing halo + `.dot-starting` pulse are permanent pulses; handoff rule is "no pulses — braille spinner only while computing" (motion dimension owns the swap, but the green `#10b981` mono-spinner styling is token work).
- Radius is a derived scale off `--radius: 0.375rem` (6px → sm 3.6 / md 4.8 / lg 6 / xl 8.4…). The handoff uses discrete values (7, 9, 10px) that don't fall out of that scale cleanly.

---

## 2 · Target design (exact values from the handoff)

### Fonts
| Role | Font | Notes |
|---|---|---|
| UI | **Geist** | weights used: 400, 500 (row titles), 600 (selected titles, headers, nav-active), 700 (badge counts) |
| Mono | **Geist Mono** | IDs, timers, terminal, section labels, key bar, command chips; weights 400–700 (badge digits 700) |

### Type scale (px, from the mocks)
| Use | Size / weight / spacing |
|---|---|
| Shell base font | 12px Geist, color `#d7d7e0` |
| Row / card titles | 11.5–12px, 500; **selected: 600** |
| Section headers ("Tray", "Super agent"), panel-menu row titles | 12px / 600 / `#f3f3f8` |
| Top-bar nav items | 11.5px (active 600 `#f3f3f8`, rest `#9a9aa8`); machine/quota 10.5px |
| Row sub-line / status | 10px |
| Chat body | 11.5px / 1.5–1.55; feed events 10.5px |
| Role labels (YOU / SUPER AGENT) | 9px / 600 / letter-spacing .07em |
| Mono section labels (LUMENFALL, WORK) | Geist Mono 8.5px, letter-spacing .12em, `#7a7a86` |
| Mono micro labels (ISSUE SCOPE, OVERARCHING…) | Geist Mono 8px, .12em, `#5a5a66` |
| Timers / "ago" stamps | Geist Mono 9px |
| Terminal body | Geist Mono 10.5px / 1.7 |
| Model/command strip | Geist Mono 10px |
| Composer placeholder | Geist Mono 11.5px `#6c6c78`; hint line 9.5px |
| ID squares | Geist Mono 600, two stacked lines, line-height 1.3 — 6.5px in 26px square, 7px in 30px rail square, 6px in 26px rail square, 4.5px in 18px mobile-header square |
| Badge counts | 9px / 700 (sidebar), 7.5px / 700 (13px corner badges) |
| Wordmark | `podium-logo.svg`, white, ~15px tall in 44px top bar |

### Surfaces (dark)
| Token (proposed) | Hex | Where |
|---|---|---|
| `--background` | `#0e0e12` | app bg, workspace base ✓ exists |
| `--card` / panel | `#16161c` | top bar, sidebar, right-rail base, panel-menu overlay ✓ exists |
| `--engraved` | `#0a0a0e` | middle column (Tray + Super agent), mobile superagent overlay — **new** |
| `--bar` | `#08080c` | compact section bars (Tray/Super-agent headers), mobile key-bar strip — **new** |
| `--tabstrip` | `#101016` | native tab-strip base (before issue mix) — **new** |
| `--rail` | `#131318` | icon-rail base (1d) — **new** |
| `--elevated` | `#25252f` | raised chips ("New Claude in podium"), neutral ID-square fill — exists as `--secondary` |
| `--chip` | `#1b1b22` | button chips (1d controls) — **new (or derive)** |

### Engraved treatment (exact)
```css
background:
  radial-gradient(560px 300px at 50% 12%, rgba(ISSUE, .10), rgba(ISSUE, 0) 72%),
  #0a0a0e;
box-shadow:
  inset 3px 0 6px -3px rgba(0,0,0,.85),
  inset -3px 0 6px -3px rgba(0,0,0,.85),
  inset 0 3px 6px -3px rgba(0,0,0,.85);
```
(Mobile overlay variant: `radial-gradient(340px 220px at 50% 6%, …)`; empty-tray card: `300px 120px at 50% 0%`, alpha .08.) Bar headers get `box-shadow: 0 5px 10px -5px rgba(0,0,0,.9)` below the Super-agent bar; panel-menu overlay `0 8px 24px rgba(0,0,0,.55)`.

### Hairlines / borders
| Token (proposed) | Value | Where |
|---|---|---|
| `--border` (hairline) | `#2a2a34` | panel seams, top-bar bottom, sidebar right ✓ exists |
| `--hairline-soft` | `#25252f` | inner dividers, section-label rules, list top borders — **new** |
| `--hairline-bar` | `#2e2e38` | borders on `#08080c` bars, key-bar keys (`#2e2e38`) — **new** |
| `--border-strong` | `#3a3a46` | chip borders, neutral action buttons, composer idle (`1.5px solid #3a3a46`) — **new** |
| grey ID-square border | `1px solid #8d8d9a` on `#25252f` (active uncoloured) — component-level |
| queued square border | `1px dashed #6c6c78`, row `opacity: .65` — component-level |
| composer focus/armed | `1.5px solid #f59e0b` | Super-agent composer |

### Text ramp
| Token (proposed) | Hex | Use |
|---|---|---|
| `--text-strong` | `#f3f3f8` | selected titles, headers, terminal emphasis (`#f0edf8` in violet terminal — mixed variant) |
| `--foreground` | `#d7d7e0` | body ✓ exists |
| `--muted-foreground` | `#9a9aa8` | secondary text, inactive nav ✓ exists |
| `--text-dim` | `#6c6c78` | status sub-lines, timestamps, placeholders — **new** |
| `--text-faint` | `#5a5a66` | micro labels, hints — **new** |
| `--label` | `#7a7a86` | mono section labels — **new** |
| ghost glyphs | `#3f3f4a` (empty-tray ✓), `#4a4a56` (idle dot), `#8d8d9a` (queued square text `#c5c5d0` active-grey) — pick 1–2 tokens |

### Semantic colors
| Meaning | Value | Notes |
|---|---|---|
| **Attention / waiting on you** | `#f59e0b` amber — everywhere; badge fg `#161006`; amber tint text `#e8c477`; flash bg `rgba(245,158,11,.32)→.10` | = current `--primary`. Add explicit `--attention` alias. |
| **Working / computing** | `#10b981` green — braille spinner + timer, always Geist Mono; rail spinner badge: bg `#0c1f18`, border `#10b981`, glyph `#34d399` | = current `--live` ✓ |
| **Host/health dot, quota bars** | `#34d399` | = current `--success` ✓ |
| **Claude brand** | `#D97757` | agent icon, cursor block (`1.5px solid #D97757`), `⏺` glyphs, model dot — **new token, currently hardcoded** |
| **User / YOU rail** | `#3b82f6` | = current `--info` ✓ |
| **Fail / error / diff-del** | `#f87171` | = current `--destructive` ✓ |
| **Neutral flow (uncoloured issue accent)** | `#94a3b8` slate; fg on solid slate `#141a24` | **new** — 1b runs the whole context-flow identically in slate. **Not a pickable colour** (4b): it is the default/no-colour flow only |
| Terminal link/path blue | `#8ea7f5` | terminal only |

### The 10-colour issue palette (turn 4b — canonical, these are tokens)
User-assigned via the colour-picker popover (4a); spectrum order. Square/solid-fill text = `color-mix(in srgb, COLOUR 30%, #000)` — 4b states this formula as the rule (the hand-tuned fgs seen in turn 1 — `#4a0715` rose, `#1e0b44` violet, `#032e28` teal — are within a hair of it; use the formula).

| # | Name | Hex |
|---|---|---|
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

**Reserved colours (never pickable, never confusable with an issue colour):** amber `#f59e0b` = "waiting on you", `#D97757` = Claude, green `#10b981` = working. The yellow/orange/amber band is deliberately absent from the palette; red is folded into Rose. Slate `#94a3b8` = no-colour flow, not pickable. Default (no colour) = the neutral grey-black square language (solid `#8d8d9a` border / dashed `#6c6c78` per state).

### Colour-picker popover tokens (4a)
- Popover surface: `#1b1b22` (= `--chip`), border `1px solid #3a3a46` (= `--border-strong`), radius **10px**, shadow `0 14px 34px rgba(0,0,0,.65), 0 2px 8px rgba(0,0,0,.5)` (**new `--shadow-popover`**); anchored arrow is an 8px rotated square of the same bg/border.
- Swatches: square, `border-radius: 6px`, grid 5×2, gap 8px; **hover and current ring = `box-shadow: 0 0 0 2px #f3f3f8`** (text-strong white); current swatch shows a `✓` in the 30%-black-mix fg, 10px/700.
- The clicked ID square gets the same white ring `0 0 0 2px #f3f3f8` while the popover is open.
- "No colour" row: 16px square, `#25252f` bg, `1px dashed #6c6c78`, `✕` in `#8d8d9a`, radius 5px; divider `#25252f`; header label Geist Mono 8px `.12em` `#8d8d9a`, right-aligned ID `#5a5a66`.

### Collapse-state token deltas (turn 3)
- Selected ID square in the collapsed 52px rail (and wide sidebar 1a): ring `box-shadow: 0 0 0 2px rgba(ISSUE, .35)`.
- Numbered attention badge on rail squares: 13px pill, bg `#f59e0b`, fg `#161006`, `border: 1px solid #16161c` (or `#0a0a0e` when on the engraved bar), Geist Mono 7.5px/700.
- Working corner badge: 13px pill, bg `#0c1f18`, `border: 1px solid #10b981`, glyph `#34d399` Geist Mono 8px (braille spinner).
- Folded engraved column (3d, 44px vertical bar): `background: linear-gradient(180deg, color-mix(in srgb, ISSUE 14%, #0a0a0e), #0a0a0e 300px), #0a0a0e`; `border-right: 1px solid rgba(ISSUE, .35)`; inset variant `inset 2px 0 5px -2px rgba(0,0,0,.85), inset -2px 0 5px -2px rgba(0,0,0,.85)` (**new `--shadow-engraved-bar`**). Icon chips on it: 28px, `#16161c` bg, `1px solid #2e2e38`, radius 7px. Rotated label: Geist Mono 8px, letter-spacing **.18em**, `#5a5a66`, `writing-mode: vertical-rl`. Mini CTX square: 22px, radius 6px, Geist Mono 5.5px/600.
- Compact section bars (`#08080c`, hairline `#2e2e38`) are load-bearing in every collapse state — Tray/Super-agent collapse **to** these bars (⌄ open / ▸ closed chevrons in `#6c6c78`), the collapsed Tray bar keeps the amber 13px count pill, collapsed Super agent keeps a 7px amber unread dot.

### Issue-accent mix recipes (the token layer must make these one-liners)
`color-mix(in srgb, var(--issue) N%, BASE)` — never flat fills. N per surface: selected sidebar row 28% over `#16161c` + border `rgba(issue,.8)`; attention rows 11–13%; workspace pane 10–12% over `#0e0e12`; tab strip 18% over `#101016`; pane header 24% over `#0e0e12`; tray card 20% (primary) / 10% (secondary) over `#0e0e12`; rail `linear-gradient(180deg, color-mix(issue 16%, #16161c), #16161c 240px)`; folded engraved bar 14% over `#0a0a0e` fading by 300px (turn 3d); hairlines as `rgba(issue, .3–.5)`; selection rings `rgba(issue, .35)`; glow `rgba(issue, .08–.10)`. These recipes apply identically to all 10 palette colours and slate — 4b confirms "tints via color-mix at the 1a percentages".

### Radii
| Value | Where |
|---|---|
| 7px | ID squares (26px), sidebar rows, rail icon cells (30px), tabs (`7px 7px 0 0`), phase buttons |
| 8px | "New Claude" chip, rail squares in 1d, home mobile chip |
| 9px | composer field |
| 10px | tray cards |
| 6px | small buttons/action chips, key-bar keys, icon buttons (26–28px) |
| 5px | tiny chips, 18px header ID square |
| 2.5–3px | 7–8px mini dot-squares (`border-radius:2.5px` at 7px, `3px` at 8px) |
| 99px | pills / count badges / host dots |

Current `--radius: 0.375rem` (6px) scale gives sm 3.6 / md 4.8 / lg 6 / xl 8.4 — the design's workhorse is **7px**. Recommendation: set `--radius: 0.4375rem` (7px → lg 7, xl ~9.8, md ~5.6, sm ~4.2) *or* keep 6px and add explicit `--radius-row: 7px`, `--radius-card-tray: 10px`, `--radius-composer: 9px`. Prefer the explicit named radii — the derived scale never lands on 9/10.

### Motion-related constants owned by tokens (motion dimension consumes)
Braille spinner set `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, `.8s steps(1,end) infinite`, Geist Mono, `#10b981`. One-shot morphs: `popIn .45s cubic-bezier(.34,1.56,.64,1)`, `tickIn .35s ease`, `flipAgo .5s ease`, `rowFlash` amber, `iconFlash` amber 9px ring, `ignite`, ping ring `rgba(16,185,129,.55)`. Timer color sequence: green `#10b981` counting → amber `#f59e0b` "Nm ago" → grey `#6c6c78` total.

---

## 3 · Gap list

1. **Missing surface tokens**: `--engraved #0a0a0e`, `--bar #08080c`, `--tabstrip #101016`, `--rail #131318`, `--chip #1b1b22`.
2. **Missing hairline tiers**: `--hairline-soft #25252f`, `--hairline-bar #2e2e38`, `--border-strong #3a3a46`.
3. **Missing text ramp steps**: `--text-strong #f3f3f8` (exists only as secondary/accent-foreground), `--text-dim #6c6c78`, `--text-faint #5a5a66`, `--label #7a7a86`.
4. **Claude brand color untokenized** — 5 hardcoded `#D97757` sites.
5. **No `--attention` alias** (amber is only `--primary`, which components can't rely on across presets).
6. **No neutral-flow slate `#94a3b8`** token + its solid-fg `#141a24`.
7. **No issue-accent channel** (`--issue` CSS custom property + mix utilities) and **no issue color in the data model** (`IssueWire` has no color field). Decision (decisions.md): colour is **user-assigned from the fixed 10-colour palette**, default = no colour (neutral). The palette itself is untokenized — no named list of the 10 hues + fg formula exists anywhere in code.
8. **No engraved inset-shadow / glow tokens** (`--shadow-engraved`, `--shadow-engraved-bar`, `--shadow-bar-drop`, `--shadow-popover`, glow gradient util).
9. **Radius mismatch**: design workhorse 7px + 9/10px specials vs derived 6px scale.
10. **Amber-on-amber foreground `#161006`** (badge text) untokenized; current code uses hardcoded `#1a1205` in `styles.css` key `:active` states (close but not equal).
11. **Existing pulse animations** (`.dot-working::after`, `.dot-starting`) violate the "no permanent pulses" rule — replacement spinner needs the mono/green token pair (handoff to motion dimension).
12. **Mono micro-typography utilities absent** — nothing encodes the 8/8.5px + `.12em` label style; components will re-invent it.
13. **`--success` (#34d399) vs `--live` (#10b981) roles are correct** but the done-✓ pop uses `#34d399` on `#0c1f18` — fine, document, no change.
14. Light-mode + shadcn/superade preset equivalents for all new tokens are undefined by the handoff (dark-only spec). Rollout decision is **big bang** (old shell dies), which strengthens the case for podium-dark as the only first-class preset.
15. **No palette-collision guard**: nothing prevents future code from using `#3b82f6`/`#22c55e` (now also issue colours Blue/Green) as status colours; the reserved-colour rule (amber/Claude-orange/working-green never in the palette, slate never pickable) must live next to the palette constant as documentation + lint-friendly naming.

## 4 · Implementation approach

1. **Single-file token drop** in `apps/web/src/index.css`:
   - Register new tokens in `@theme inline` (`--color-engraved: var(--engraved)`, `--color-bar`, `--color-hairline-soft`, `--color-hairline-bar`, `--color-border-strong`, `--color-text-strong`, `--color-text-dim`, `--color-text-faint`, `--color-label`, `--color-attention`, `--color-claude`, `--color-flow`, `--color-attention-foreground`) so Tailwind utilities (`bg-engraved`, `text-label`, `border-hairline-bar`…) exist.
   - Add values to **every preset block** (podium dark = the handoff values above; podium light / shadcn / superade get derived sensible values so nothing breaks — see open question 1).
   - Add named radii: `--radius-row: 7px; --radius-tray: 10px; --radius-composer: 9px;` registered as `--radius-*`.
   - Add shadows: `--shadow-engraved: inset 3px 0 6px -3px rgb(0 0 0/.85), inset -3px 0 6px -3px rgb(0 0 0/.85), inset 0 3px 6px -3px rgb(0 0 0/.85);`, `--shadow-engraved-bar: inset 2px 0 5px -2px rgb(0 0 0/.85), inset -2px 0 5px -2px rgb(0 0 0/.85);`, `--shadow-bar-drop: 0 5px 10px -5px rgb(0 0 0/.9);`, `--shadow-popover: 0 14px 34px rgb(0 0 0/.65), 0 2px 8px rgb(0 0 0/.5);`.
2. **Issue-accent channel**: define `--issue: var(--flow)` (slate default) at `:root`; downstream components set `style={{ '--issue': issueColor }}` on the shell subtree. Provide utility classes in `styles.css` (or `@utility` in index.css): `.issue-mix-{8,11,13,14,16,18,20,24,28}` → `background: color-mix(in srgb, var(--issue) N%, <base>)`, `.issue-hairline-{30,35,45,50}` → `border-color: color-mix(in srgb, var(--issue) N%, transparent)`, `.issue-ring` (`0 0 0 2px` at .35), `.issue-glow` (radial). Exact recipes in §2. (The context-flow dimension consumes; this issue only ships the plumbing + slate fallback.)
2b. **Palette module** (new, from turn 4b): a single TS constant, e.g. `apps/web/src/lib/issueColors.ts` (or `packages/protocol` if the wire format stores the name), exporting the ordered 10-entry list `{ name: 'rose', hex: '#f43f5e' }…`, `issueSquareFg(hex) = color-mix(in srgb, HEX 30%, #000)` (emit the CSS string; no JS color math needed), the slate no-colour constant, and a documented reserved-colours note (amber/`#D97757`/`#10b981` never assignable; slate not pickable). Store the **name** (or index), not the hex, wherever the issue's colour persists, so the palette can be tuned centrally. The picker popover UI itself belongs to the sidebar/context-flow dimension; this module + the popover surface/ring tokens are what tokens ship.
3. **Claude token sweep**: add `--claude: #D97757`; replace `text-[#D97757]` / `fill` / `bg-[#D97757]` in `WorkerLabel.tsx`, `AgentIcons.tsx`, `AgentPanel.tsx`, `SidebarUnified.tsx` with `text-claude` / `var(--claude)` (leave the static `claude-code.svg` file as-is; it's brand art).
4. **Typography utilities**: add `@utility label-mono { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: .12em; }` and `label-mono-micro` (8px, color `var(--text-faint)`), plus a `tabular-nums` mono timer utility. Document the type scale in a comment block.
5. **Theme plumbing**: `THEME_BG['podium-dark']` already `#0e0e12` — unchanged; verify `apps/web/index.html` anti-flash copy. `theme.tsx` needs no logic change unless presets are culled (open question 1).
6. **Do NOT** change `--primary`/`--live`/`--info`/`--destructive` values (already correct); `--attention` is an alias so future presets can split attention from primary.
7. Ordering: this is the P1 foundation — every other redesign dimension (layout, context flow, motion, ID squares, tray) builds on these utilities.

## 5 · Files to touch

- `apps/web/src/index.css` — main token work (new vars, @theme registrations, radii, shadows, utilities).
- `apps/web/src/styles.css` — issue-mix utilities (if not `@utility`), fix `#1a1205` → `var(--attention-foreground)` (`#161006`), later motion swap.
- `apps/web/src/app/theme.tsx` + `apps/web/index.html` — only if presets change / THEME_BG additions.
- `apps/web/src/lib/WorkerLabel.tsx`, `apps/web/src/lib/icons/AgentIcons.tsx`, `apps/web/src/features/terminal/AgentPanel.tsx`, `apps/web/src/features/worklist/SidebarUnified.tsx` — `#D97757` → token.
- `apps/web/src/lib/issueColors.ts` — **new**: 10-colour palette constant + fg formula + slate/reserved-colour docs (§4.2b).
- `apps/web/src/app/theme.test.ts`, `apps/web/src/index.css`-adjacent tests — extend if token names are asserted anywhere.
- (Other dimension, referenced) `packages/protocol/src/messages/issues.ts` — `color` field on `IssueWire` (palette **name**, optional) for per-issue accents; the picker popover component consumes the palette module.

## 6 · Open questions (designer/product owner)

Resolved since v1:
- ~~Issue color palette~~ → **decided** (decisions.md + turn 4): fixed 10-colour palette, user-picked per issue via the ID-square popover; default = no colour (neutral squares, slate flow).
- ~~Dark foreground on solid issue fills~~ → **decided** (4b): derive with `color-mix(in srgb, COLOUR 30%, #000)`.

Still open:
1. **Preset fate**: the rollout is big-bang and the handoff is dark-only — may `shadcn`/`superade` presets and podium-light be deleted (make podium-dark the only theme), or must they receive derived equivalents of the new tokens? Recommendation given big-bang: keep the preset machinery but only guarantee podium-dark; give other presets non-breaking fallbacks.
2. **Sidebar surface**: current podium preset uses `--sidebar: #141419` / border `#22222b`; the handoff sidebar is plain `#16161c` / `#2a2a34`. Collapse sidebar tokens onto card/panel, or keep the distinct sidebar tint? (Handoff says plain — default to collapsing onto `#16161c`.)
3. **`--warning #fbbf24` vs attention `#f59e0b`**: the handoff uses one amber everywhere; may `--warning` be folded into `--attention`, or does anything still need a second, lighter amber?
4. **Where the colour persists**: palette name vs hex vs index on `IssueWire` (spec recommends name) — needs sign-off from whoever owns the protocol dimension.
