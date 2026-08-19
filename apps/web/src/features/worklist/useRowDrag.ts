/**
 * Grip-drag manual reordering for sidebar rows (POD-168, POD-100 §4).
 *
 * Pointer-based, no dnd lib: the ⠿ grip's pointerdown starts a drag; the row
 * follows the pointer (lifted, tight transient shadow) while displaced siblings
 * FLIP 180ms via transform transitions. Drops are confined to the SIBLING SCOPE
 * (a `[data-drag-scope]` container) — except the PINNED section, which is a
 * legal cross-target for a top-level row (into/out of PINNED toggles `pinned`).
 *
 * DOM contract: every draggable row is wrapped in `[data-drag-key="<issueId>"]`
 * placed as a DIRECT child of its `[data-drag-scope="<scopeId>"]` container.
 * A scope may sit inside `[data-drag-section]` when an animated clip has to wrap
 * the rows; the hook relaxes that clip while dragging and lifts the section so
 * cross-scope movement can still paint above its neighbours.
 * On drop the hook reports the target scope and the full new id order there and
 * hands the rows back unstyled; the caller persists sortKeys and the store
 * repaints the new order (keys stay mounted, so the arrival one-shot never
 * fires).
 *
 * THE DROP PREVIEW IS GONE (POD-781), and the line between what went and what
 * stayed is worth stating, because the two look alike from a distance.
 *
 * WHAT WENT: a post-drop HOLD. The transforms stayed applied after the pointer
 * lifted — a 1500ms timer, plus a `settleDrag` the sidebar called from an effect
 * on the derived work list — so the row would not snap back "until the real order
 * arrived". That was a fourth optimism mechanism beside the outbox-as-overlay
 * (#263 collapsed three into one precisely because parallel mechanisms drift):
 * it held a value the SERVER had not confirmed, on a timeout, in the DOM, where
 * nothing else could see it. The reorder now enqueues through the overlay, so
 * the overlay is the preview and nothing here waits on a round trip.
 *
 * WHAT STAYED is drag MECHANICS: pointer math, hit-testing the legal containers,
 * and the FLIP transforms that show where the row would land while the pointer is
 * down. They describe a gesture in progress, not a write in flight.
 *
 * AND THE HANDOFF, measured rather than assumed. `onDrop` may return the enqueue's
 * promise, which resolves when the overlay has been PUBLISHED; the transforms are
 * released in the `requestAnimationFrame` after that. Both halves are ordering,
 * not waiting: the promise is one local await on a durable write (no timer, no
 * opinion about the server), and the rAF is the event loop's own guarantee that
 * React's commit — scheduled by that publish — runs before the frame paints.
 * Release earlier and the drive measured five painted frames of the pre-drop
 * order: the row visibly went home, then moved again. Release on a refusal too,
 * which is right — there is no overlay then, and home is where the row belongs.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GESTURE OWNS `transform`, AND IT OWNS THE ROW LIST (POD-1191).
 *
 * Everything above described a hook that was the only thing writing to these
 * elements. It never was, from the day after it landed: the `[data-drag-key]`
 * wrapper is a `motion.div layout="position"`, and Motion's layout projection
 * writes `style.transform` on the nodes it manages — its own delta each frame
 * while projecting, and a flat `"none"` in the measure pass that precedes every
 * layout animation. Two owners of one property, neither aware of the other, so
 * a projection pass landing mid-drag erased the lift AND the previewed gaps. The
 * row snapped home under a moving pointer, and because the preview is only
 * re-applied when the target index CHANGES, it stayed erased until the pointer
 * crossed the next midpoint. That is the whole "drag is unreliable" report.
 *
 * The fix is upstream of this file and belongs there: the sidebar freezes
 * `layoutRevision` while `dragging` is true, and Motion only measures when that
 * dependency changes, so no projection runs while the gesture does. Which is why
 * this hook now REPORTS `dragging` — the flag is not decoration, it is the other
 * half of the mechanism, and it stays true through the handoff window so the
 * drop's own repaint cannot animate from a baseline measured through the
 * gesture's transforms either.
 *
 * The second half of the same lesson is that this hook also read live DOM it
 * assumed was frozen. The row list, the ids in it, and `homeIndex` are all
 * captured at pointerdown now, because they are STATEMENTS ABOUT WHAT THE
 * OPERATOR IS LOOKING AT. Re-reading them mid-gesture meant a row losing its
 * `data-drag-key` (a lane change, an expiring snooze) silently shifted every
 * index under a preview already on screen, and planned the write against a set
 * of neighbours nobody had seen. When the frozen list stops matching the
 * document, the honest move is to CANCEL — the arrangement the operator was
 * reasoning about no longer exists.
 *
 * And the listeners live on `window`, not on the grip. The grip is conditionally
 * rendered; when it unmounted mid-drag the browser released pointer capture and
 * `pointerup` was delivered to a node nobody was listening to, so `finish` never
 * ran, `session` stayed occupied and every LATER drag was refused at the top of
 * `startDrag`. Capture is still taken — it keeps hover and text selection out of
 * the gesture — but nothing depends on it surviving.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useRef, useState } from 'react'

export interface RowDrop {
  /** Scope the row was picked up from. */
  sourceScope: string
  /** Scope it was dropped into (=== sourceScope unless a pinned crossing). */
  targetScope: string
  /** The dragged row's id. DELIBERATELY UNBRANDED, and not a POD-363 sweep
   *  target: this hook reads every id back out of a `data-drag-key` DOM
   *  attribute (see `order` below), so the values are document strings, and the
   *  id SPACE depends on which scope was dragged. Branding here would force one
   *  entity's brand on a generic row hook — the same false choice POD-362
   *  refused for `workflowAssignInput.targetId` and `MessageRow.toId`. The
   *  consumer narrows at its scope discriminant instead. */
  movedId: string
  /** Ids in the target scope, in the NEW visual order (moved id included).
   *  Read from `data-drag-key` AT POINTERDOWN, hence plain strings — see
   *  `movedId` — and hence a description of the list the operator dragged
   *  within rather than of whatever the store published since. */
  order: string[]
}

interface DragSession {
  pointerId: number
}

/** A row as it stood at pointerdown: the element, and the id it carried THEN. */
interface FrozenRow {
  el: HTMLElement
  key: string
}

const FLIP = 'transform 180ms cubic-bezier(.22,1,.36,1)'
/** Slop on a container's edges when deciding which scope the pointer is in. */
const SCOPE_SLOP = 6
/** How close to the scroll container's edge the pointer must be to auto-scroll. */
const EDGE_ZONE = 44
/** Auto-scroll speed at the very edge, in px per frame. */
const EDGE_SPEED = 13

function siblingWrappers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.dragKey !== undefined,
  )
}

/** The nearest ancestor that actually scrolls. The sidebar list is one
 *  (`overflow-y-auto`), and every coordinate below is client-space, so the
 *  gesture has to know when the ground moves under it. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
      return p
    }
  }
  return null
}

/** The visual offset a FLIP transition has currently applied to `el`, in px.
 *  Read from the COMPUTED transform, which is the interpolated value actually
 *  painted, so subtracting it recovers the row's undisplaced position even
 *  while the preview is still animating. */
function appliedShift(el: HTMLElement): number {
  const tf = getComputedStyle(el).transform
  return tf && tf !== 'none' ? new DOMMatrixReadOnly(tf).m42 : 0
}

export function useRowDrag(opts: {
  /** Legal drop scopes for a drag out of `sourceScope` (source itself is always legal). */
  allowedTargets: (sourceScope: string, movedId: string) => string[]
  /** Persist the drop. Return the write's promise to hold the gesture's
   *  transforms until it settles (see the handoff note in the file header). */
  onDrop: (drop: RowDrop) => void | Promise<unknown>
}): {
  startDrag: (e: ReactPointerEvent, movedId: string) => void
  /** True from pointerdown until the gesture's transforms are released — the
   *  handoff window included. The caller MUST suspend layout animation on these
   *  rows while it is true; see the POD-1191 note in the file header. */
  dragging: boolean
} {
  const session = useRef<DragSession | null>(null)
  /** The last drop's un-styling, until its write settles. Held here so a NEW drag
   *  can run it first: the closure belongs to the previous drag's elements, and
   *  running it late would wipe the new drag's own transforms. */
  const handoff = useRef<(() => void) | null>(null)
  const [dragging, setDragging] = useState(false)
  const endHandoff = useCallback((clear: () => void) => {
    if (handoff.current !== clear) return
    handoff.current = null
    clear()
    // AFTER the styles are gone, never before. This flip is what lets the
    // sidebar's `layoutRevision` move again, and Motion snapshots the DOM as it
    // stands in the render that follows — so the gesture's transforms have to be
    // off the elements by then, or the layout animation it schedules starts from
    // a position no row was ever really in.
    setDragging(false)
  }, [])

  const startDrag = useCallback(
    (e: ReactPointerEvent, movedId: string) => {
      if (session.current || e.button !== 0) return
      const grip = e.currentTarget as HTMLElement
      const wrapper = grip.closest<HTMLElement>('[data-drag-key]')
      const sourceContainer = wrapper?.closest<HTMLElement>('[data-drag-scope]')
      const sourceScope = sourceContainer?.dataset.dragScope
      if (!wrapper || !sourceContainer || !sourceScope) return
      e.preventDefault()
      e.stopPropagation()
      // A previous drop still holding its transforms belongs to the frame before
      // this one — settle it now rather than letting its promise land mid-drag.
      if (handoff.current) endHandoff(handoff.current)

      const containers = new Map<string, HTMLElement>([[sourceScope, sourceContainer]])
      for (const scope of opts.allowedTargets(sourceScope, movedId)) {
        if (containers.has(scope)) continue
        const el = document.querySelector<HTMLElement>(`[data-drag-scope="${CSS.escape(scope)}"]`)
        if (el) containers.set(scope, el)
      }

      // FROZEN HERE, all of it. See the POD-1191 note in the header: these lists
      // are what the operator is looking at, and the gesture reasons about that
      // arrangement until it ends.
      const frozen = new Map<string, FrozenRow[]>()
      for (const [scope, container] of containers) {
        frozen.set(
          scope,
          siblingWrappers(container).map((el) => ({ el, key: el.dataset.dragKey! })),
        )
      }
      const homeRows = frozen.get(sourceScope)!
      const homeIndex = homeRows.findIndex((row) => row.el === wrapper)
      if (homeIndex < 0) return

      const pointerId = e.pointerId
      const startRect = wrapper.getBoundingClientRect()
      const height = startRect.height
      /** Where in the row the operator took hold of it. The lift is defined by
       *  this offset rather than by a travelled distance, so it survives the
       *  row's RESTING position moving under the gesture — which the list
       *  scrolling does, and so does anything that reflows the rows above. */
      const grabOffset = e.clientY - startRect.top
      const scroller = scrollParent(wrapper)

      let pointerY = e.clientY
      let target = { scope: sourceScope, index: homeIndex }
      let done = false
      let frame = 0

      wrapper.style.zIndex = '30'
      wrapper.style.position = 'relative'
      wrapper.style.pointerEvents = 'none'
      wrapper.style.boxShadow = '0 8px 20px var(--carve-popover-near)'
      wrapper.style.borderRadius = '7px'
      // FoldPanel became the direct row parent in POD-1253. Its clipping is what
      // makes the fold animation honest, but during a drag it would hide a row
      // crossing into or out of Pinned (and clip the target scope's displaced
      // last row). Relax only the legal scopes for the life of this gesture,
      // then put their exact inline values back in clearAll.
      const scopePaint = new Map(
        [...containers.values()].map((container) => [
          container,
          { overflow: container.style.overflow, contain: container.style.contain },
        ]),
      )
      for (const container of containers.values()) {
        container.style.overflow = 'visible'
        container.style.contain = 'none'
      }
      // THE LIFT HAS TO OUTRANK THE SECTION BELOW IT, and `z-index: 30` on the
      // row alone does not promise that: each section is its own `layout`
      // motion.div, so the moment Motion transforms one it becomes a stacking
      // context and everything inside it paints as a unit at the SECTION's
      // level. A row dragged out of Pinned then slid under the project group it
      // was heading for. Lifting the source section for the gesture's duration
      // makes the paint order the same in every frame, transformed or not.
      const sourceSection =
        sourceContainer.closest<HTMLElement>('[data-drag-section]') ?? sourceContainer
      const homeZ = {
        position: sourceSection.style.position,
        zIndex: sourceSection.style.zIndex,
      }
      sourceSection.style.position = sourceSection.style.position || 'relative'
      sourceSection.style.zIndex = '40'

      grip.setPointerCapture(pointerId)

      /** Does one scope still hold the rows we froze for it, in that order? An
       *  INSERTION matters as much as a removal: the frozen list is what the
       *  reported `order` is built from, so a scope that has gained a row would
       *  be renumbered from a set that no longer describes it — the same
       *  "renumbering a sample" the caller refuses for a filtered column. Cheap
       *  enough per move: a handful of element comparisons. */
      const scopeIntact = (scope: string): boolean => {
        const container = containers.get(scope)
        const rows = frozen.get(scope)
        if (!container || !rows || !container.isConnected) return false
        const live = siblingWrappers(container)
        if (live.length !== rows.length) return false
        for (let i = 0; i < rows.length; i++) if (live[i] !== rows[i]!.el) return false
        return true
      }

      /** ONLY THE SCOPES THIS GESTURE IS ACTUALLY SPEAKING FOR. The source, whose
       *  `homeIndex` the whole preview is expressed in, and wherever the row would
       *  land right now, which is the one list a drop would renumber. A legal
       *  target the pointer never visits is free to change — cancelling a drag
       *  within a project because Pinned gained a row would be a gesture ended by
       *  something that had nothing to do with it. */
      const intact = (): boolean =>
        wrapper.isConnected && scopeIntact(sourceScope) && scopeIntact(target.scope)

      /** Re-apply the whole preview for the current target (idempotent). */
      const applyPreview = () => {
        const { scope, index } = target
        for (const [cScope, rows] of frozen) {
          for (let i = 0; i < rows.length; i++) {
            const el = rows[i]!.el
            if (el === wrapper) continue
            let dy = 0
            if (cScope === sourceScope) {
              if (cScope === scope) {
                // In-scope move: rows between the old and new slot swap past
                // the dragged row (indexes below are "with dragged" vs the
                // insertion index in "without dragged" coordinates).
                if (i < homeIndex && i >= index) dy = height
                else if (i > homeIndex && i - 1 < index) dy = -height
              } else if (i > homeIndex) {
                // Dragged out of this scope: the gap it left closes.
                dy = -height
              }
            } else if (cScope === scope) {
              // A foreign scope's list never held the dragged row, so `i` is
              // already in "without dragged" coordinates.
              if (i >= index) dy = height
            }
            el.style.transition = FLIP
            el.style.transform = dy ? `translateY(${dy}px)` : ''
          }
        }
      }

      /** Put the lift under the pointer and recompute where it would land.
       *  Called on every move AND on every scroll of the list, because both
       *  change where the pointer is relative to the rows. Returns false when it
       *  abandoned the gesture instead — the one check every path needs, since a
       *  detached row measures as a zero-height box at the top of the viewport
       *  and would drag the insertion index to 0 on its way out. */
      const retarget = (): boolean => {
        // The frozen list is the gesture's whole frame of reference. Once the
        // document stops matching it, there is nothing honest left to preview.
        if (!intact()) {
          finish(false)
          return false
        }
        // THE LIFT IS MEASURED, NOT ACCUMULATED. Subtracting the transform we
        // ourselves applied recovers the row's RESTING top, so the offset below
        // is computed against where the row actually sits this frame. A travelled
        // `clientY - startY` silently assumed that resting position never moved,
        // and it moves whenever the list scrolls or anything above the row
        // reflows — including, on the sidebar, Motion correcting a section.
        const restTop = wrapper.getBoundingClientRect().top - appliedShift(wrapper)
        wrapper.style.transform = `translateY(${pointerY - grabOffset - restTop}px)`

        // Which legal container is the pointer over? Default to the source, and
        // never move into a scope that has drifted from its frozen list — the
        // pointer being over it is not a reason to plan a write against it.
        let scope = sourceScope
        for (const [cScope, container] of containers) {
          const r = container.getBoundingClientRect()
          if (pointerY >= r.top - SCOPE_SLOP && pointerY <= r.bottom + SCOPE_SLOP) {
            if (cScope !== sourceScope && !scopeIntact(cScope)) break
            scope = cScope
            break
          }
        }
        // Insertion index from midpoints of the UNDISPLACED positions: subtract
        // any preview transform so the math is stable while things animate.
        const rows = frozen.get(scope)!.filter((row) => row.el !== wrapper)
        let index = rows.length
        for (let i = 0; i < rows.length; i++) {
          const el = rows[i]!.el
          const r = el.getBoundingClientRect()
          if (pointerY < r.top - appliedShift(el) + r.height / 2) {
            index = i
            break
          }
        }
        if (target.scope !== scope || target.index !== index) {
          target = { scope, index }
          applyPreview()
        }
        return true
      }

      /** Auto-scroll when the pointer sits in one of the list's edge zones, so a
       *  row can be dragged to a slot that is off-screen. */
      const edgeScroll = () => {
        if (!scroller) return
        const r = scroller.getBoundingClientRect()
        let velocity = 0
        if (pointerY < r.top + EDGE_ZONE) {
          velocity = -((r.top + EDGE_ZONE - pointerY) / EDGE_ZONE) * EDGE_SPEED
        } else if (pointerY > r.bottom - EDGE_ZONE) {
          velocity = ((pointerY - (r.bottom - EDGE_ZONE)) / EDGE_ZONE) * EDGE_SPEED
        }
        if (velocity !== 0) scroller.scrollTop += velocity
      }

      /** ONE FRAME LOOP FOR THE WHOLE GESTURE, and it is not a poll standing in
       *  for an event — it is the only thing that can be right. The lift's
       *  position is a function of where the row RESTS, and the row's resting
       *  position moves for reasons no input event announces: the list scrolling,
       *  a section above it reflowing, a fold opening. Recomputing only on
       *  `pointermove` left the row parked one row-height away from the pointer
       *  until the operator happened to move again — measured at 47px on the
       *  drive, exactly the height of a row that had arrived above it. A drag is
       *  an active gesture; a frame's worth of reads while the pointer is down is
       *  what it costs to have the lift always be where the hand is. */
      const tick = () => {
        if (done) return
        edgeScroll()
        if (!retarget()) return
        frame = requestAnimationFrame(tick)
      }

      const clearAll = () => {
        for (const rows of frozen.values()) {
          for (const { el } of rows) {
            if (el === wrapper) continue
            el.style.transition = ''
            el.style.transform = ''
          }
        }
        wrapper.style.zIndex = ''
        wrapper.style.position = ''
        wrapper.style.pointerEvents = ''
        wrapper.style.boxShadow = ''
        wrapper.style.borderRadius = ''
        wrapper.style.transform = ''
        sourceSection.style.position = homeZ.position
        sourceSection.style.zIndex = homeZ.zIndex
        for (const [container, paint] of scopePaint) {
          container.style.overflow = paint.overflow
          container.style.contain = paint.contain
        }
      }

      const detach = () => {
        if (frame) cancelAnimationFrame(frame)
        frame = 0
        window.removeEventListener('pointermove', onMove, { capture: true })
        window.removeEventListener('pointerup', onUp, { capture: true })
        window.removeEventListener('pointercancel', onCancel, { capture: true })
        window.removeEventListener('keydown', onKey, { capture: true })
        // Detached grips throw on release, and a detached grip is exactly the
        // case this whole listener arrangement exists to survive.
        if (grip.isConnected && grip.hasPointerCapture(pointerId)) {
          grip.releasePointerCapture(pointerId)
        }
      }

      const finish = (commit: boolean) => {
        if (done) return
        done = true
        detach()
        session.current = null
        const { scope, index } = target
        // Re-checked at the last moment, because the release is when the frozen
        // list stops being a preview and becomes a write.
        const changed = scope !== sourceScope || index !== homeIndex
        if (!commit || !changed || !scopeIntact(scope)) {
          clearAll()
          setDragging(false)
          return
        }
        const others = frozen
          .get(scope)!
          .filter((row) => row.el !== wrapper)
          .map((row) => row.key)
        const order = [...others.slice(0, index), movedId, ...others.slice(index)]
        // The order is the FROZEN reading order, which the preview never moved —
        // only the insertion index came from the previewed geometry.
        const queued = opts.onDrop({ sourceScope, targetScope: scope, movedId, order })
        if (queued === undefined) {
          clearAll()
          setDragging(false)
          return
        }
        handoff.current = clearAll
        const settle = (): void => {
          requestAnimationFrame(() => endHandoff(clearAll))
        }
        void Promise.resolve(queued).then(settle, settle)
      }

      // Input is answered immediately rather than waiting for the next frame; the
      // loop is there for the frames where no pointer event arrives at all.
      // `retarget` is idempotent, so doing both costs nothing.
      const onMove = (ev: PointerEvent) => {
        if (done || ev.pointerId !== pointerId) return
        pointerY = ev.clientY
        retarget()
      }
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish(true)
      }
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish(false)
      }
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return
        // Escape during a drag means THIS drag, and nothing else. Taken in the
        // capture phase and stopped so the press cannot also close the panel
        // behind the gesture it was aimed at.
        ev.preventDefault()
        ev.stopPropagation()
        finish(false)
      }
      // ON `window`, IN THE CAPTURE PHASE, NOT ON THE GRIP. The grip can unmount
      // under the gesture — see the header — and capture-phase delivery also
      // means no handler in between can swallow a move or an up that this
      // gesture is the owner of.
      window.addEventListener('pointermove', onMove, { capture: true })
      window.addEventListener('pointerup', onUp, { capture: true })
      window.addEventListener('pointercancel', onCancel, { capture: true })
      window.addEventListener('keydown', onKey, { capture: true })

      session.current = { pointerId }
      setDragging(true)
      frame = requestAnimationFrame(tick)
    },
    [opts, endHandoff],
  )

  return { startDrag, dragging }
}
