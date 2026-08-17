# Flight deck — design vs. implementation, agent rows

Read against **ADE Flight Deck - Header & Tail** (`2d7a6747`), sections 1a/1b/1f, and
against the shipped build (`5b1082bc7`, which *is* what the redeploy has running —
`.git/podium-redeploy-head` matches `HEAD`, so the redesign had landed).

## What was already true

The design doc's eight implementation notes are in the code and correct: the collapse
chevron is a member of the eyebrow row, the relation chip prints relation-then-ref
(`IssueNote.label`), `HungRows`' arrival wrapper carries `overflow:hidden` +
`contain: layout paint`, `DeckSection` starts at `GUTTER`, the continuation is the
first row of *Where the work went*, the gauge has its `NO TASKS` band, its
`gauge-band-march` and its `IN PROGRESS` relabel. None of those deviate.

The deviation was entirely in the **agent row**, and it had two independent causes.

## Finding 1 — the narrow ladder had no container, so it never ran

`.deck-agent` declared `container-type: inline-size; container-name: deck-agent`, and
then `@container deck-agent (max-width: 310px)` styled `.deck-agent` itself. **A
container query only ever matches descendants of the container — never the container.**
Every rule in that block was dead from the day it was written: no `flex-wrap`, no
`.deck-agent-break`, no released cell widths.

With the ladder inert, the row kept four unshrinkable cells — ref 68px, role 96px,
state 80px, 244px before the name gets a pixel — at every width. Measured on the
shipped stylesheet at a 268px row: the name cell resolves to **0px** and the button's
scroll width overruns its box by 117px, so the icon and the name are clipped away by
`overflow-hidden` and the role and state are pushed out of the column entirely. That is
the reported "just keeping the agent id".

**Fix:** the container moves to the row's wrapper, `.deck-agent-row`, which
`SessionRow` already draws and which is exactly as wide as the row.

## Finding 2 — the name could not reach its ellipsis

`WorkerLabel` is an `inline-flex` and sat in a **block** wrapper in the deck (the
sidebar wraps it in a `flex`, which is why only the deck showed this). An inline-flex in
a block parent is sized shrink-to-fit, and shrink-to-fit floors at the box's
min-content width — which `white-space: nowrap` on `.worker-name` makes equal to the
entire name. So the label grew past its parent (measured 189px inside a 97px cell), the
`text-overflow: ellipsis` never had a narrower box to fire in, and the name was clipped
mid-glyph and painted over the ref. `min-w-0` cannot help: it lifts a *flex item's*
automatic minimum, and here the label was not a flex item at all.

**Fix:** `max-w-full` on `.worker-label` (fixes every surface, including any future
block parent) and `flex` on the deck's wrapper span, matching the sidebar.

## Finding 3 — the rung was in the wrong place

Even with both bugs fixed, four rigid columns do not fit a deck at its **366px
default**: a root agent row is ~334px, and one line left the name **41px** — three
characters — while `COORDINATOR` sat beside it in full. The 310px rung was chosen for
the column's floor, not for the name's measure.

A name wants ~120px to be worth printing, and one line only pays that from ~400px up.
**The rung moves to 400px**, unconditionally — a roster of rows that are sometimes 28px
and sometimes 44px scans worse than one honest height. Below it the row spends the line
the design always allowed: name + ref on line 1, role + state on line 2, exactly as 1f
draws its 300px roster (including the role keeping its 96px cell on line 2).

## Measured, on the built stylesheet

| deck | row | lines | name cell | name text | overruns its box |
|-----:|----:|------:|----------:|----------:|:-----------------|
| 300 | 268 | 2 | 173px | 145px | no |
| 366 | 334 | 2 | 239px | 187px (full name) | no |
| 420 | 388 | 2 | 293px | 187px (full name) | no |
| 500 | 468 | 1 | 180px | 152px | no |
| 620 | 588 | 1 | 300px | 187px (full name) | no |

Before the fix, every one of those rows overran its box and the ellipsis never fired.

The selection tick stands 5px *outside* the row wrapper, so the new container was
checked not to clip it: `container-type: inline-size` implies `contain: layout style
inline-size` and **not** `paint`, and the tick still paints at −5px.

## Finding 4 — the elbow was pierced by the selection tick

Reported separately: rows where the guides read as a broken cross rather than a tree.

The gutter between a rail and the thing hanging on it is `RAIL_INSET` — **eight pixels** —
and the elbow crosses all eight of them. `TICK_SELECTED_X` parked a 3px tick at +3, dead
centre of that run, so the elbow came in from the rail, disappeared behind the tick and
re-emerged as a 2px stub on the far side. On a row that is *both* asking and selected
that stub sits between an amber elbow and an amber inner rule, which is exactly the
reported screenshot.

`TICK_SELECTED_X` becomes `RAIL_INSET - TICK_WIDTH`, landing the tick's **right** edge on
the row's own edge: the elbow now runs into the tick and stops, so the tick is the line's
terminal cap instead of an obstacle in it. Attention is unaffected — it sits at −5, on the
other side of the rail, and never met the elbow.

The same constant drives task strips (`bandLeft − ownRailX` is the same 8px gutter, and
the strip's elbow is the same 8px wide), so one change fixes both surfaces consistently.

**Checked and *not* changed:** `HUNG_MID = 14` is correct. A first probe suggested the
elbow sat 2px above the row's first line, but that was the probe omitting
`shell-type-secondary` from the row and inflating its line box. With the real class the
elbow, the ref, the role and the icon all centre on 14 — Δ = 0, wrapped and unwrapped.
