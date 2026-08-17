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
      const startY = e.clientY
      const height = wrapper.getBoundingClientRect().height
      const scroller = scrollParent(wrapper)
      const startScroll = scroller ? scroller.scrollTop : 0

      let pointerY = startY
      let target = { scope: sourceScope, index: homeIndex }
      let done = false
      let edgeFrame = 0

      wrapper.style.zIndex = '30'
      wrapper.style.position = 'relative'
      wrapper.style.pointerEvents = 'none'
      wrapper.style.boxShadow = '0 8px 20px var(--carve-popover-near)'
      wrapper.style.borderRadius = '7px'
      // THE LIFT HAS TO OUTRANK THE SECTION BELOW IT, and `z-index: 30` on the
      // row alone does not promise that: each section is its own `layout`
      // motion.div, so the moment Motion transforms one it becomes a stacking
      // context and everything inside it paints as a unit at the SECTION's
      // level. A row dragged out of Pinned then slid under the project group it
      // was heading for. Lifting the source section for the gesture's duration
      // makes the paint order the same in every frame, transformed or not.
      const homeZ = {
        position: sourceContainer.style.position,
        zIndex: sourceContainer.style.zIndex,
      }
      sourceContainer.style.position = sourceContainer.style.position || 'relative'
      sourceContainer.style.zIndex = '40'

      grip.setPointerCapture(pointerId)

      /** Has the document drifted away from the list we froze? */
      const intact = (): boolean => {
        if (!wrapper.isConnected) return false
        for (const rows of frozen.values()) {
          for (const row of rows) if (!row.el.isConnected) return false
        }
        return true
      }

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
        // Scroll compensation: the row's own resting position moved up by
        // whatever the list scrolled, so the lift has to travel that much
        // further to stay under a pointer that never left the same clientY.
        const scrolled = scroller ? scroller.scrollTop - startScroll : 0
        wrapper.style.transform = `translateY(${pointerY - startY + scrolled}px)`

        // Which legal container is the pointer over? Default to the source.
        let scope = sourceScope
        for (const [cScope, container] of containers) {
          const r = container.getBoundingClientRect()
          if (pointerY >= r.top - SCOPE_SLOP && pointerY <= r.bottom + SCOPE_SLOP) {
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

      /** Drag to a slot that is off-screen. Runs itself frame by frame while the
       *  pointer sits in an edge zone and stops as soon as it leaves one or the
       *  list runs out of scroll. */
      const edgeStep = () => {
        edgeFrame = 0
        if (done || !scroller) return
        const r = scroller.getBoundingClientRect()
        let velocity = 0
        if (pointerY < r.top + EDGE_ZONE) {
          velocity = -((r.top + EDGE_ZONE - pointerY) / EDGE_ZONE) * EDGE_SPEED
        } else if (pointerY > r.bottom - EDGE_ZONE) {
          velocity = ((pointerY - (r.bottom - EDGE_ZONE)) / EDGE_ZONE) * EDGE_SPEED
        }
        if (velocity === 0) return
        const before = scroller.scrollTop
        scroller.scrollTop = before + velocity
        if (scroller.scrollTop === before) return
        if (!retarget()) return
        edgeFrame = requestAnimationFrame(edgeStep)
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
        sourceContainer.style.position = homeZ.position
        sourceContainer.style.zIndex = homeZ.zIndex
      }

      const detach = () => {
        if (edgeFrame) cancelAnimationFrame(edgeFrame)
        edgeFrame = 0
        window.removeEventListener('pointermove', onMove, { capture: true })
        window.removeEventListener('pointerup', onUp, { capture: true })
        window.removeEventListener('pointercancel', onCancel, { capture: true })
        window.removeEventListener('keydown', onKey, { capture: true })
        scroller?.removeEventListener('scroll', onScroll)
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
        const changed = scope !== sourceScope || index !== homeIndex
        if (!commit || !changed) {
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

      const onMove = (ev: PointerEvent) => {
        if (done || ev.pointerId !== pointerId) return
        pointerY = ev.clientY
        if (retarget() && !edgeFrame) edgeFrame = requestAnimationFrame(edgeStep)
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
      const onScroll = () => {
        if (!done) retarget()
      }

      // ON `window`, IN THE CAPTURE PHASE, NOT ON THE GRIP. The grip can unmount
      // under the gesture — see the header — and capture-phase delivery also
      // means no handler in between can swallow a move or an up that this
      // gesture is the owner of.
      window.addEventListener('pointermove', onMove, { capture: true })
      window.addEventListener('pointerup', onUp, { capture: true })
      window.addEventListener('pointercancel', onCancel, { capture: true })
      window.addEventListener('keydown', onKey, { capture: true })
      scroller?.addEventListener('scroll', onScroll, { passive: true })

      session.current = { pointerId }
      setDragging(true)
    },
    [opts, endHandoff],
  )

  return { startDrag, dragging }
}
