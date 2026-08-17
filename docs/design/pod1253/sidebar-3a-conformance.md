# The work sidebar against `ADE Sidebar 3a.dc.html`

What the artboard specifies, what shipped, and what changed. Every "artboard"
number below was read off the mock rendered in a browser
(`getComputedStyle` / `getBoundingClientRect`), not off the source.

**The mock is `content-box` throughout.** `ADE Sidebar 3a.dc.html` declares
`box-sizing: border-box` exactly once, on its outer `<section>`, and the dc
runtime ships no reset — so every `height` and `min-height` in that file has its
border added ON TOP of the number written. Reading those numbers as finished
border-box heights is where most of the drift came from, at four scales at once:
4px on every row, 10px on a metered row, 2px on the spawn control and the filter
field, 1px on the bands and the footer. (Caught for the spawn control by the
agent on POD-1257, who was working the same row; the generalisation is theirs.)

Two artboards are in scope: **3a** (the column) and **3b** (the same column with
the inline filter, which is the composition we actually ship — the filter sits
between the spawn control and the list). Where they disagree about the block
around the spawn control, 3b wins, because 3b is the one that has a filter under
it.

## Geometry

| Element | Artboard | Was | Now |
|---|---|---|---|
| Row, two lines | `min-height:36px` + 7px padding + rule = **51px** | 47px | **51px** |
| Row with the progress meter | `min-height:46px` + 7px + rule = **61px** | ~55px | **61px** |
| Row padding / gap / rule | `7px 13px`, gap 11, 1px | same | same |
| Spawn block | `padding: 9px 10px 0` (3b) | `10px 16px 8px 12px` | **`9px 10px 0`** |
| Spawn control | 38px inside a 1px rim = **40px**, radius 8, gap 9, `padding: 0 11px`, label boundary at 11+16+9 = **36px** | 30px, radius 6, gap 8, no rim | **40px, radius 8, gap 9, rim, pr 36** |
| Spawn control ground | the RAISED tier (`#ffffff` paper / `#23262d` dark) | `--secondary`, a recess | **`--chip`** |
| Spawn label | 500, 12.5px, `-.005em` | 400, 12px | **500, 12.5px** |
| Spawn swatch / chevron | 11px radius 3 / 16px at an 11px inset | 10px / 14px | **11px / 16px** |
| Section band | 34px of ground + a 1px rule = **35px**, `0 13px`, gap 9, `--muted` | 34px total, gap 8 | **35px, gap 9** |
| Tail fold (`12 closed`) | `padding: 16px 13px 0`, gap 9, 13px chevron | `16px 13px 4px`, 12px chevron, one rung fainter | **`16px 13px 0`, 13px, `--text-dim`** |
| Footer strip | 34px + its 1px rule = **35px**, `0 13px`, gap 14, 16px glyphs on the 13px inset | 34px total, gap 4, 28px cells, first glyph at 19px | **35px, gap 14, glyphs at 13px** |
| Search field (3b) | 30px inside a 1px rim = **32px**, radius 7, `0 9px`, 14px glyph | 30px total, 13px glyph | **32px, 14px glyph** |

The row box is the one that mattered most: **every row in the column was four
pixels short**, and a metered row ten. The mock writes two different
`min-height`s — 36px for a two-line row, 46px for one carrying the meter — on a
content box, and both are minima over a text block (16 + 5 + 10.5 = 31.5px) that
is shorter than either. The extra is deliberate air, and centring the block in it
is most of what makes the artboard's column read as calm. It shipped as one
`min-h-[46px]` utility on a border-box row.

The height now lives in `.shell-work-row` as
`calc(var(--work-row-content) + 2 * var(--work-row-pad) + 1px)`, with
`:has([data-testid="row-progress"])` selecting the taller box — so the meter's
own render decides it, and the `ROW_PROGRESS_MIN_TASKS` threshold stays in one
place.

## Ink

- **The working clock's digits are neutral again**, with the braille cell keeping
  the blue. The artboard writes the meta column as `⠋ 4:53` with the glyph blue
  and the digits on the same ramp as every other stamp; ours set the whole clock
  in `--live` (`PhaseTimer` now takes `mutedWorking`, sidebar only — the Flight
  Deck and the issue page still colour the clock, where the clock *is* the fact).
- **The status line takes no ink for `working`.** It was a full blue sentence on
  every running row; the artboard has no blue text anywhere in this column.
  DESIGN.md §5 asks live activity to read calm blue and it still does — in the
  spinner and in the meter's running segment, which are the two marks that *are*
  the activity. Amber remains the one exception, for a row that is asking.

- **The spawn control has a hover again, in light.** Making it the artboard's
  raised `--chip` card quietly killed its hover: `data-pressable` says hover with
  `filter: brightness(1.08)`, which can only brighten, and `--chip` is `#ffffff`
  in every light preset. Measured as painted pixels, the hover delta there was
  `[0,0,0]` — no feedback at all — while dark moved `+3`. The artboard hovers the
  other way (`#faf9f7` under `#ffffff`, `#282c33` under `#23262d`): both move
  *toward the foreground*, which `.shell-spawn-chip` now spells once for both
  themes as a 3% mix, standing the filter down. Post-fix: light `-6`, dark `+5`,
  against the mock's own `+5`. (Caught by the agent on POD-1257.)

## Not changed, and why

- **Row title size.** The artboard sets 12.5px; the shell's `--shell-type-primary`
  is 13px at comfortable density and 12.5px at compact. Matching the artboard
  exactly means moving a token the whole app reads. The artboard corresponds to
  the compact end of a scale it does not know about.
- **Band label size.** The artboard sets 9.5px. The shell has a tested 10.5px
  floor for ordinary information (POD-783, `app/type-floor.test.ts`), and an
  uppercase tracked mono label is the worst case on that ramp.
- **The scroller's `padding-right: 10px`.** That is the mock leaving room for a
  scrollbar in a 352px artboard; our scroller hides its own. Taking it literally
  would inset the list 10px from a header and footer that are not inset.
- **The panel header** (`podium · ● 2 · ‹`). The artboard draws a standalone
  panel; in the app that row is the window's top bar and the collapse control,
  which are not this column.

## Folding

The bands and both tail folds were `{!collapsed && rows}` — present in one frame,
absent in the next, with everything below teleporting into the hole. They now run
through one `FoldPanel`: a clipped height animation, `contain: layout paint`, the
rows themselves never moving or squashing, and the content unmounting only once
the exit lands (so a shut band still hides its rows from the ⌘-digit shortcuts,
the drag scope and a screen reader).

Measured on a production build of the harness, 24 rows, median of five trials —
each direction sampled frame by frame, with an idle run first as the control:

| | pre-roll | animation | frames |
|---|---|---|---|
| collapse | 49ms | 234–248ms | 15–16 |
| expand | 43ms | 299–312ms | 19–20 |

~60fps through the gesture. The curve is `cubic-bezier(0.4, 0, 0.2, 1)`; the
first cut used the shell's usual expo-out and, sampled, spent 76% of the travel
in the first 18% of the time — a snap followed by a drift rather than one fold.

**No `AnimatePresence`.** The obvious spelling of a fold that unmounts after its
exit is `<AnimatePresence>{open && <motion.div exit=… />}</AnimatePresence>`, and
measured, it cost **27KB of eager source** — enough on its own to push the web
bundle from 7,586,320 through its 7,600,000 ratchet to 7,613,223. This repo's own
precedent is to pay the eager bundle down rather than raise the ratchet
(e39d805f3), so `FoldPanel` does the two things the presence machinery was doing
for it — hold the subtree while the exit plays, drop it when the exit lands — in
a `useState` and a `useRef`. The landed cost is +10,754 bytes, leaving 2,926
under the ceiling, and the motion is unchanged: the numbers in the table above
are the rewrite's, and they are within noise of the `AnimatePresence` version's
(56ms/220–270ms, 39ms/295–360ms).

**Do not measure this against the live instance.** An idle second of the live
column on this host delivers 2 frames and two 1.2s long tasks with nothing
clicked at all, because the machine is running a fleet into that very column.
Against that baseline a butter-smooth fold and a jump cut measure the same. The
harness (`apps/web/vite.sidebar.config.ts`) exists for exactly this: the real
`SidebarUnified` over a stubbed store, still between presses.
`apps/web/e2e/pod1253-raf-control.ts` is the positive control — a plain CSS
transition in the same browser, which must report ~60 frames or the rig is blind.

## The rigs, and their controls

Three of these measure things a screenshot and a computed style both lie about,
so each carries a control that has to fire before its result means anything:

- `pod1253-harness.ts` — geometry and fold sampling in the harness. Control: an
  **idle** run before each gesture (~60fps, no long tasks) — without it a busy
  app and a slow fold are the same number.
- `pod1253-raf-control.ts` — a plain CSS transition in the same browser. If this
  reports a handful of frames, the sampler is blind.
- `pod1253-spawn-hover.ts` — the hover read as **painted pixels**, because
  `getComputedStyle` reports the background it was handed whether or not a filter
  cancelled it. Control: the dark run, which must move even when light does not.
- `pod1253-spawn-label.ts` — whether a padding deviation actually buys label
  width. It did not, which is how `pr-36` came back.

## Shots

- `artboard-3a-light.png` / `artboard-3a-dark.png` — the mock, rendered.
- `before-*.png` / `after-*.png` — the live column on main vs this branch, same
  account and same rows. (The sessions went idle between the two captures, so the
  ink change is easier to read in the harness pair.)
- `harness-light.png` / `harness-dark.png` — the harness, which is the only place
  both row boxes appear: no mission in the live column currently has a subtree.
