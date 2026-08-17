# Sidebar drag-and-drop is visually unreliable

The investigation is below as it was written, off `main` at `5357c5c31`. **The fix
has since landed on this issue's branch** — see [What shipped](#what-shipped) at
the end, including the measured before/after and the one finding that is fixed
defensively rather than demonstrated.

## The headline: two owners of `style.transform` on the same nodes

`useRowDrag` (`apps/web/src/features/worklist/useRowDrag.ts`) is a hand-rolled
pointer drag that animates the gesture by writing inline transforms:

- the dragged row follows the pointer — `wrapper.style.transform =
  translateY(dy)` (line 183), rewritten on every `pointermove`;
- displaced siblings FLIP into their previewed slots — `el.style.transform =
  translateY(±height)` (line 176), written **only when the target index
  changes** (line 209–212).

The element it writes to is `[data-drag-key]`. That element is
`SidebarUnified.tsx:543` — a **`motion.div` with `layout="position"` and
`layoutDependency={layoutRevision}`**, inside a `LayoutGroup`
(`SidebarUnified.tsx:671`). Its scope containers (`data-drag-scope`, lines 673
and 695) are `layout="position"` motion divs too.

Motion's layout projection owns `style.transform` on every node it manages:

- `node_modules/motion-dom/dist/cjs/index.js:10025` — while projecting,
  `targetStyle.transform = buildProjectionTransform(...)`, written each frame;
- same file line 10015 — when a projection stops, `targetStyle.transform =
  "none"`;
- line 10403 — the measure pass's `resetTransform` is literally
  `instance.style.transform = value !== undefined ? value : "none"`, and
  line 9150 runs it across the **whole node tree**
  (`this.nodes.forEach(resetTransformStyle)`).

Neither side knows about the other. Nothing in the worklist suppresses layout
animation during a drag — `grep -rn "dragging\|isDragging\|dragActive"` over
`features/worklist` returns nothing.

So any projection pass that lands mid-gesture sets `transform` to `"none"` (or
to motion's own delta) on the row wrappers, erasing both the pointer-follow
transform on the dragged row and the FLIP transforms on its siblings. The
dragged row snaps back to its home position while the pointer keeps moving, and
the preview gap collapses. Because `applyPreview` only re-runs when the target
index *changes* (line 209), an erased preview stays erased until the pointer
crosses the next row midpoint — which is exactly the "sometimes it works,
sometimes it doesn't, depends where I am" character of the report.

`resetTransform` is guarded by `isLayoutDirty || shouldResetTransform` **and**
`hasProjection || hasTransform(latestValues)` (line 9272–9291), so a row sitting
at rest is skipped. It fires precisely when a layout animation is touching the
row — which is what `layoutRevision` bumps cause.

### What bumps `layoutRevision` mid-drag

`layoutRevision` (`SidebarUnified.tsx:328–338`) is derived from the row-slot
signature, so clock and content updates are correctly excluded. Structural
change is not, and this sidebar is structurally live:

- any row entering, exiting, or changing lane (an agent finishing, a mission
  closing, mail arriving that moves a row) — the common case with agents running;
- a band fold toggling, the snoozed or closed folds mounting/unmounting
  (lines 718–751);
- and, every single time, **the drop itself**.

`LayoutGroup` makes this tree-wide: a layout change anywhere in the sidebar runs
`resetTransformStyle` over all nodes, including the ones the drag has
transformed.

### This is accretion, not a bad hook

`useRowDrag` landed 2026-07-22 (`49a2b4b5d`), written against a DOM it owned.
`layout="position"` arrived on these same rows from 2026-07-23 onward
(`f22bd859e`, then `71c64d217`, `93efd9f5d`). The two were never wired together.

## Second bug, at the moment of drop: the FLIP baseline is measured through the drag's transforms

At release, `finish` (line 231) enqueues the reorder and then holds the drag's
transforms until the enqueue resolves, releasing them one `requestAnimationFrame`
later (lines 252–256). Deliberate — the file header explains why.

But the overlay's repaint is what bumps `layoutRevision`, so motion snapshots its
"before" boxes **while the drag's transforms are still applied**. And it will not
undo them first: for these wrappers `hasTransform(latestValues)` is false and
`projectionDelta` is still zero at snapshot time, so `resetTransform` skips them
(line 9280–9286). Motion therefore records each displaced row's *displaced* box
as its starting position and animates from there — off by one row height.

This is very likely the same defect the header comment records as "the drive
measured five painted frames of the pre-drop order": the release timing was
tuned, but the measurement the release feeds into was never the problem's root.

## Third bug: the gesture can get permanently stuck

`pointerup` and `pointercancel` are attached to the **grip element** (lines
262–263), and there is no `lostpointercapture` handler. The grip is conditionally
rendered:

- `WorkRowShell.tsx:226` — `{onGripDown && (<span data-testid="row-grip" …>)}`
- `SidebarUnified.tsx:548` — `data-drag-key` is likewise conditional

Both hang off one predicate (`SidebarUnified.tsx:488`):

```ts
const draggable =
  row.kind === 'issue' && !exiting && !filtering && !isIssueDeferred(row.issue, now)
```

If any term flips mid-drag — the row starts `exiting` because its lane changed, a
snooze expires on a `now` tick — the grip unmounts. Pointer capture is implicitly
released, no `pointerup` ever fires on the detached node, `finish` never runs, and
`session.current` stays non-null. Every subsequent drag then returns early at
line 108:

```ts
if (session.current || e.button !== 0) return
```

Sidebar drag is dead until the component remounts, with the last drag's
transforms possibly still painted. `state.cleanup` is assigned at line 264 and
**never called from anywhere** — there is no abnormal-termination path at all.

## Fourth: `homeIndex` is frozen while the sibling set is re-read live

`homeIndex` is captured once at pointerdown (line 130). `applyPreview` and
`finish` re-read `siblingWrappers(container)` every time (lines 153, 194, 241).
Any row losing `data-drag-key` mid-drag — same `draggable` predicate as above —
shortens that list and shifts every index, so `homeIndex` no longer points where
it did. The preview goes off by one, and the `order` array handed to `onDrop`
describes a different set of rows from the one the operator was looking at.

## Fifth: scroll is unaccounted for

The list is a scroll container — `SidebarUnified.tsx:90`, `overflow-y-auto`. The
hook works entirely in client coordinates from a captured `startY` (line 127),
with no scroll listener and no auto-scroll at the edges. Scrolling mid-drag
detaches the row from the pointer and leaves the preview stale until the next
`pointermove`, and a row cannot be dragged to any slot that is off-screen.

## Sixth: the lift can be painted underneath the section below it

`wrapper.style.zIndex = '30'` (line 132) only wins inside the nearest stacking
context. Each section container is a `layout="position"` motion div, so the
moment motion applies a transform to one, that section becomes a stacking
context and everything inside it paints as a unit at the section's own z-level.
Dragging a row out of **Pinned** (first in DOM order) down toward a project group
while any layout animation is touching the pinned container means the lifted row
is painted *under* the group below it — the one cross-scope crossing the hook
explicitly supports.

## Why the tests are green

There is no `useRowDrag.test.ts` — the hook has no direct coverage. And jsdom
could not catch findings 1, 2, 5 or 6 anyway: no layout, no projection, no
scroll, no paint order. The existing `SidebarUnified.*.test.tsx` files assert
list structure, not gesture geometry.

## Ranking

| # | Finding | Character |
| - | ------- | --------- |
| 1 | Motion projection erases the drag's inline transforms | Constant, intermittent, the main symptom |
| 2 | Drop's FLIP baseline measured through the drag's transforms | Every drop |
| 3 | No `lostpointercapture`/abnormal path → drag dies permanently | Occasional, then total |
| 4 | Frozen `homeIndex` vs live sibling set | Occasional, wrong persisted order |
| 5 | No scroll compensation or auto-scroll | Whenever the list scrolls |
| 6 | Lift trapped in a section stacking context | Pinned↔group crossings |

Findings 1, 2, 3 and 4 all share one root: **the drag mutates DOM that React and
motion own, and reads DOM state it assumes is frozen for the gesture's
duration.** A fix that only patches symptoms one at a time will keep finding new
ones. The two coherent directions are to give the drag exclusive ownership of
transform for its duration (suspend layout projection on the rows in the dragged
scopes while a drag is live, and freeze the sibling set at pointerdown), or to
stop writing transforms at all and drive the preview through motion — a
`layout`-driven reorder of a React-held preview order, so there is one animation
owner instead of two.

## Not a bug, checked and dismissed

- **Non-uniform row heights.** `applyPreview` displaces every sibling by the
  *dragged* row's height. That is correct regardless of sibling heights — the gap
  that opens and closes is the dragged row's own.
- **The mixed index coordinates** at lines 160–169 ("with dragged" `i`/`homeIndex`
  vs "without dragged" `index`). The comment is right and the arithmetic checks
  out, identity position included.
- **Reading `getComputedStyle(el).transform` mid-transition** (line 201). Browsers
  return the interpolated matrix, which is the value actually painted, so
  subtracting it does recover the undisplaced top — as long as the transform is
  the hook's own. Finding 1 is what breaks it, not the technique.
- **`pointerEvents: 'none'` on the wrapper** (line 134) with the grip inside it.
  Pointer capture bypasses hit-testing, so moves still arrive.

## What shipped

Two files: `apps/web/src/features/worklist/useRowDrag.ts` and the
`layoutRevision` block in `SidebarUnified.tsx`.

**Finding 1 — one owner of `transform`.** `layoutDependency` is the only thing in
this app that makes Motion measure: `MeasureLayout.getSnapshotBeforeUpdate` calls
`willUpdate` only when it changes, every `layout` site in the sidebar passes the
same `layoutRevision`, and there is no `layoutId` or `AnimatePresence` anywhere in
`apps/web`. Without a `willUpdate`, `didUpdate` takes its `clearIsLayoutDirty`
branch and never reaches `resetTransformStyle`. So the sidebar simply **holds
`layoutRevision` still while `dragging` is true** — signature included — and the
hook reports `dragging` for exactly that purpose.

**Finding 2** falls out of the same freeze: the flag stays true through the
handoff window, so the drop's repaint carries no layout animation at all. That is
the right answer rather than a lucky one — the preview has already put every row
where the new order wants it, so there is nothing left to animate.

**Finding 3** — listeners moved to `window` in the capture phase, `state.cleanup`
replaced by a `detach()` that every exit path runs, plus Escape-to-cancel.
**Finding 4** — the row list, its ids and `homeIndex` are captured at pointerdown;
a scope that has drifted from its frozen list cancels the gesture, re-checked at
the release because that is when a preview becomes a write. Only the *source* and
*current target* scopes are held to this, so a Pinned arrival cannot cancel a drag
happening inside a project.
**Finding 5** — the lift is now **measured, not accumulated**: it is defined by the
grab offset against the row's resting top each frame, on a `requestAnimationFrame`
loop that runs for the gesture's duration, plus edge auto-scroll. The loop is not
a poll standing in for an event — a row's resting position moves for reasons no
input event announces, and recomputing only on `pointermove` left the row parked
one row-height from the pointer until the operator moved again.

### Measured

A throwaway Vite harness reproduced the one structural fact jsdom cannot hold —
rows whose `[data-drag-key]` wrapper is a `motion.div layout="position"` in a
`LayoutGroup`, driven by the real hook — with `?fix=0` restoring the pre-fix
arrangement so the same Playwright drive measures both. A row arrives in Pinned
mid-gesture, which reflows the section below it.

| | pre-fix (`?fix=0`) | fixed |
| - | - | - |
| max distance between the lift and the pointer | **23.4 px** | **0.00006 px** |
| inline `transform` writes on the dragged row the hook did not make | **15** — a `none`, then `translate3d(…)` frames | **0** |
| inline `transform` after the drop settles | `none` (Motion's) | `""` (the hook's clear) |
| list scrolled 90 px mid-drag, no pointer event after | 0 px drift | 0 px drift |

The `none` and `translate3d(…)` writes are finding 1 caught in the act: Motion
measuring a box that included the gesture's transform, concluding the row had
moved, and animating it.

The scroll row passes in **both** columns because the harness only A/Bs the
`layoutRevision` freeze — both columns run the new hook. The old hook had no
scroll handling at all, which is a code fact, not a measured one.

### Finding 6 is fixed defensively, not demonstrated

The source section now takes an explicit `position`/`z-index` for the gesture's
duration, so the lift's paint order is the same whether or not Motion has made a
section a stacking context. But **the failure was never reproduced**: making it
happen needs the *Pinned* container itself to be transformed, and Pinned is first
in its `LayoutGroup`, so nothing in the harness moves it. The first probe
attempted `elementFromPoint` at the lift's midpoint, which is invalid — the hook
sets `pointer-events: none` on the dragged row, so that call reports what is
behind it. Screenshots at the crossing look correct in both columns. Treat the
z-index as cheap insurance on a mechanism reasoned from the CSS spec, not as a
fixed bug.

### What guards this

`useRowDrag.test.ts` covers what happy-dom can hold: the reported order, the
`dragging` flag's lifecycle including the handoff window, the gesture surviving
its grip unmounting, the session never being left occupied, frozen ids, and the
four ways a drifting list cancels. The `layoutRevision` freeze itself is guarded
only by the prose at both ends and by the harness — a future refactor that
re-derives the revision without the `!dragging` guard would silently restore
finding 1.
