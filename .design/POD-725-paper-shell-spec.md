# POD-725 — the Paper shell: measured spec

Source of truth: the Claude Design project *ADE Shell* (`ADE Shell - Coloured Task.dc.html`
and `ADE Shell - Split View.dc.html`), rendered at 1900×1000. Every number below is
lifted from that markup, not estimated. When this file and a memory of the mock
disagree, this file wins; when this file and the mock disagree, the mock wins.

The prototype is high-fidelity but it is NOT our app: it invents no components we
lack, but it shows one particular data state and it draws with inline styles. Bring
over the **geometry, the type scale and the colour**; keep our components, our
interaction model, and our tree structures.

---

## 0. Palette → token map

The mock's literals, and the token each becomes. Never write the literal in a
component — the token is theme-aware and the dark theme has to keep working.

| Mock | Token | Role |
|---|---|---|
| `#f2f1ed` | `--background` | app ground, the stage gutter |
| `#f7f7f5` | `--bar` | command bar, status strip |
| `#f4f3f0` | `--engraved` / `--sidebar` | work list, issue panel columns |
| `#eceae4` | `--rail` (also `--secondary`) | far-right icon rail; chip/pill fills |
| `#faf9f7` | `--tabstrip` | tab strip, wells inside the sheet |
| `#f0efe9` | `--muted` | ID-square fill on unselected rows |
| `#ffffff` | `--card` / `--chip` | the stage sheet, raised cells |
| `#eeede8` | `--hairline-soft` | row rules, section rules |
| `#e6e5e0` | `--border` | panel seams, bar underline, instrument ring |
| `#e2e0d9` | `--border-strong` / `--input` | chip rims |
| `#1d1c19` | `--text-strong` | titles, primary ink |
| `#38362f` | `--foreground` | body prose |
| `#5f5d55` | `--muted-foreground` | secondary + metadata |
| `#8f8d85` | `--text-dim` / `--label` | sub-lines, mono section labels |
| `#a3a199` | `--text-faint` | micro labels, hints |
| `#f5c518` | `--primary` | the one filled brand object per view |
| `#8a6200` | `--attention` | "needs you" ink (yellow fills, ochre writes) |
| `#2a62f0` | `--live` / `--info` / `--success` | working, in-progress, forward motion |
| `#b8532e` | `--claude` | Claude agent mark, agent chips |
| `#a11a25` / `#c81e2b` | `--destructive` | |
| `#4f46e5`, `#e8e9fb`, `#f0f0fb`, `#fbfbff`, `#e2e2f4` | **`var(--issue)` and its mixes** | NOT a global accent |

**The single most important reading of this design:** the indigo running through the
mock — the sidebar spine, the deck's top inset and gradient, the active tab's dot and
ring, the rail's ID square — is the *selected issue's colour*, not a new brand hue.
POD-710 happens to be indigo. The mock also shows POD-699 in red and POD-685 in
violet, on their own rows, with the same mechanics. So it maps exactly onto our
existing `--issue` channel and the `issue-mix-*` / `issue-hairline-*` utilities.
Do not introduce a literal indigo anywhere.

---

## 1. Frame

- Command bar **48px**, `--bar`, `border-bottom: 1px --border`, `padding: 0 14px`,
  zone `gap: 18px`. Zones: logo · mode pills · (slot) · elastic gap · instrument ·
  utility icons. No seams between zones — the 18px gap does that work.
- Logo 18px tall, `opacity .8`.
- Mode pill: `28px` high, `padding 0 11px`, `radius 8px`, `gap 7px`, `12.5px/500`,
  icon 14px. Active: `--secondary` fill, `--text-strong`, weight 600. Inactive:
  transparent, `--text-dim`. No bevel, no ring, no yellow.
- Proposals count: mono `10.5px/700` in `--attention`, dropped 1px.
- Instrument: one capsule, `30px` high, `radius 9px`, floor + 1px ring, divided by
  1px `--border` verticals. Three cells: host (dot + 2-segment meter), quota
  (`QUOTA` label 8.5px mono `.14em`, meter, `62%`), working (spinner + `15 working`).
  Readouts are `10.5px` mono in `--muted-foreground`.
- Utility icons: `28px` square, `radius 8px`, `--text-dim`.
- Status strip **28px**, `--bar`, `border-top: 1px --border`, `padding 0 16px`,
  `gap 14px`, mono `9.5px` in `--text-dim`.

## 2. Columns

| Column | Width | Surface |
|---|---|---|
| Work list | **306** | `--sidebar` |
| Flight deck | **366** | issue fade → `--card` over 240px, `inset 0 3px 0 var(--issue)` |
| Stage | `1 1 360` | transparent (the ground shows) + `padding: 12px 12px 12px 14px` |
| Issue panel | **316** | `--engraved` |
| Icon rail | **46** | `--rail` |

The stage's child is a **sheet**: `radius 12px`, `--card`, `overflow hidden`,
`box-shadow: 0 0 0 1px rgb(29 28 25 / .07), 0 2px 4px rgb(29 28 25 / .05),
0 20px 44px -20px rgb(29 28 25 / .3)` (tokenized as `--shadow-sheet`).
This is the one place the Paper theme floats instead of carving: everything else
separates by tone, so the work itself gets the only real elevation in the window.

## 3. Work list

- Spawn row: `30px`, `radius 8`, `--secondary`, 12px label, 10px colour square
  (radius 3), trailing chevron.
- Section label: mono `8.5px`, `.16em`, uppercase, `--text-faint`, count on the right.
- Row: `padding 9px 14px`, `gap 10px`, `border-bottom: 1px --hairline-soft`.
  - ID square `30×30`, `radius 7`, `--muted`; `POD` at mono `6.5px/600` over the
    number at mono `10px/600`. Waiting badge: 7px dot in `--primary`, 2px ring in
    the row's own background, top/right `-2px`.
  - Title `13px/1.35`, `--foreground`, ellipsis. Agent chip `18×18`, `radius 5`,
    claude-tinted. Session count mono `9.5px`.
  - Status line: `10px/1.4` mono, phase word in its state colour, the rest in
    `--muted-foreground`, right-hand git stamp mono `9.5px` `--text-faint`.
  - Progress: a `2px` rule, `--hairline-soft` track, `--live` (or `--text-faint`
    when settled) fill, `margin-top 6px`.
- **Selected row is a band, not a card**: full-bleed, no radius, issue-tinted
  ground, `inset 3px 0 0 var(--issue)`, title weight 600 in `--text-strong`, ID
  square tinted + 1px issue ring, and the bridge notch reaching right.
- Footer `38px`, `padding 0 16px`. The mock writes `new task` / `search` as words;
  **we keep our muted icons** (operator call) and keep the `⌘K` hint right-aligned
  in `--text-faint`.

## 4. Flight deck

Keep our tree. Take the colour and the metrics.

- Header row `32px`, `padding 0 16px`: state ring `10px` (1.5px border, `--live`),
  `POD-710 in progress` mono `11px` `--text-dim`, collapse chevron right.
- Title block `padding 4px 16px 12px`: title `17px/1.3/600`, `-.015em`,
  `--text-strong`; description `12px/1.6` `--muted-foreground`.
- Gauge row: `24px` pills, `radius 8`, `--background` fill. The progress pill is a
  well whose *extent* is a tinted region with a 2px datum rule along the floor and
  the reading sitting inside it, mono `10.5px`. Fleet presence is a separate pill.
- Filter bar `32px`, rules top and bottom in `--hairline-soft`, labels `11px/500`;
  active is `--text-strong` with `inset 0 -2px 0 var(--issue)`; counts mono `10px`
  in `--attention`.
- Session row: `18px` glyph cell (radius 5), label `12px/1.3`, trailing state mono
  `9.5px`. Sub-rows indented to `26px`, mono `10px/1.4`.
- Task row: `min-height 30px`, `radius 7`, `padding 0 9px`, quiet fill `--tabstrip`;
  **active** = `--card` + `inset 0 0 0 1px` issue hairline + `inset 2px 0 0 var(--issue)`.
  Ref in mono `10.5px` `--text-faint` then the title at `12px/1.3` weight 600.
- Under each task, a `22px` status line indented to `30px`: 14px dashed box +
  mono `10px` (`--text-faint`, or `--attention` when it needs you).

## 5. Stage

- Tab strip `38px`, `--tabstrip`, `border-bottom 1px --hairline-soft`, `padding 0 10px`,
  `gap 4px`. Tab: `28px`, `radius 8`, `padding 0 11px`, `11.5px`. Active tab is
  raised onto `--card` with a small drop shadow and a 1px issue ring; its leading
  6px square is `var(--issue)`, an inactive tab's is `--border-strong`. Attention
  dot `5px` `--primary`. Pane letter badge `14×14`, `radius 4`, mono `8px/700`.
  Trailing: `+`, then a right-aligned mono `9.5px` `--text-faint` panel count.
- Pane header `36px` (`34px` in a split), `padding 0 16px`, rule below: agent name
  `11.5px/500` with a 7px agent square, branch/dirty stamp mono `10.5px/1.6`
  `--text-dim`, Chat/Native segmented control (`--background` track, `--card` cell
  with a 1px drop), overflow glyph.
- **Transcript** (§6) then composer: `padding 0 18px 16px`, field `42px`,
  `radius 11`, `--tabstrip` fill, `inset 0 0 0 1px --hairline-soft`, placeholder
  `12.5px` `--text-faint`, send button `26px` square, `radius 8`, `--text-strong`
  fill with `--card` glyph.

## 6. Transcript — the document

This is the part the operator called out. The mock's chat is a **document**, not a
feed of bubbles.

- Body padding `26px 56px` (a split pane drops to `18px 24px`); block gap `16px`.
- Operator brief: mono `9px`, `.16em`, uppercase, `--text-faint` eyebrow
  (`Your brief · 17:53`), then the prompt at `13.5px/1.7` in `--muted-foreground`.
  The operator's words are *quieter* than the answer, not louder — no bubble, no fill.
- A `1px --hairline-soft` rule separates the brief from the answer.
- Answer prose: **`15px/25px`** in `--foreground`. Headings inside the answer:
  `16px/25px` weight 600 in `--text-strong`. Numbered points lead with a bold
  fragment in `--text-strong` and continue in `--foreground` on the same line.
  Inline code: mono `13px` `--text-strong`, no fill.
- Offer: separated by `padding-top 16px; border-top 1px --hairline-soft`. Eyebrow
  mono `9px` `.16em` uppercase in `--attention` (`Offer · needs you · waiting 41s`).
  Headline `15px/1.5/600` `--text-strong`. Actions on one `14px`-gap row: the first
  is a `--primary` fill, `padding 8px 16px`, `radius 8`, `12px/600`,
  `--primary-foreground`; every other action is **plain text**, `12px/500`,
  `--muted-foreground` — not an outlined button.
- Tool calls in the native/mono pane: `⏺` in `var(--issue)`, subject in
  `--text-strong`, elapsed right-aligned in `--text-faint`, all mono `10.5px/1.7`.

## 7. Issue panel

- Head `44px`, `padding 0 14px`, `gap 9`: `12px` state ring (2px border), title
  `13.5px/600` `--text-strong`, close glyph.
- `POD-710` mono `11px` `--text-dim`.
- Controls row: status pill `28px`, `radius 8`, `--card` + `inset 0 0 0 1px --border`,
  `11.5px/500`; primary action `28px`, `radius 8`, `--primary`, `11.5px/600`.
- Sections `gap 14px`, `padding 0 14px`. A section header is
  `label (10.5px/600 --muted-foreground)` + `flex-1 1px --border rule` + optional
  trailing meta (mono `9.5px` `--text-faint`).
- Section bodies at `12px/1.4–1.5` — deliberately a step larger than today.
- Subtask row: `11px` state ring, mono `10px` ref, `12px/1.4` title, trailing state
  mono `9.5px` (`--attention` + weight 600 when it needs you).
- Mono facts (branch, dirty counts) at `10.5px/1.6`.

## 8. Rail

`46px`, `--rail`, `padding 16px 0`, `gap 14px`. The selected issue's number in mono
`9.5px` `var(--issue)` at the top, then the active cell as a `30×30` `--card` chip
with a 1px issue ring and a small drop, then plain `17px` glyphs in `--text-dim`.
