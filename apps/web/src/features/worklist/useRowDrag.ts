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
 * On drop the hook reports the target scope and the full new id order there;
 * the caller persists sortKeys and clears the preview once React re-renders
 * the new order (keys stay mounted, so the arrival one-shot never fires).
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef } from 'react'

export interface RowDrop {
  /** Scope the row was picked up from. */
  sourceScope: string
  /** Scope it was dropped into (=== sourceScope unless a pinned crossing). */
  targetScope: string
  /** The dragged issue id. */
  movedId: string
  /** Ids in the target scope, in the NEW visual order (moved id included). */
  order: string[]
}

interface DragSession {
  pointerId: number
  wrapper: HTMLElement
  sourceScope: string
  movedId: string
  startY: number
  height: number
  /** scopeId → container element, every legal drop target (source included). */
  containers: Map<string, HTMLElement>
  target: { scope: string; index: number }
  cleanup: () => void
}

const FLIP = 'transform 180ms cubic-bezier(.22,1,.36,1)'

function siblingWrappers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.dragKey !== undefined,
  )
}

export function useRowDrag(opts: {
  /** Legal drop scopes for a drag out of `sourceScope` (source itself is always legal). */
  allowedTargets: (sourceScope: string, movedId: string) => string[]
  onDrop: (drop: RowDrop) => void
}): {
  startDrag: (e: ReactPointerEvent, movedId: string) => void
  /** Clear any lingering post-drop preview (call when the real order arrived). */
  settleDrag: () => void
} {
  const session = useRef<DragSession | null>(null)
  /** Post-drop hold: transforms stay applied until the store echoes the new
   *  order (or a timeout), so the row doesn't snap back for a frame. */
  const hold = useRef<{ clear: () => void; timer: ReturnType<typeof setTimeout> } | null>(null)

  const settleDrag = useCallback(() => {
    if (!hold.current) return
    clearTimeout(hold.current.timer)
    hold.current.clear()
    hold.current = null
  }, [])

  useEffect(() => () => settleDrag(), [settleDrag])

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
      // Flush any previous drop still holding its preview.
      settleDrag()

      const containers = new Map<string, HTMLElement>([[sourceScope, sourceContainer]])
      for (const scope of opts.allowedTargets(sourceScope, movedId)) {
        if (containers.has(scope)) continue
        const el = document.querySelector<HTMLElement>(`[data-drag-scope="${CSS.escape(scope)}"]`)
        if (el) containers.set(scope, el)
      }

      const startY = e.clientY
      const height = wrapper.getBoundingClientRect().height
      const homeOrder = siblingWrappers(sourceContainer)
      const homeIndex = homeOrder.indexOf(wrapper)

      wrapper.style.zIndex = '30'
      wrapper.style.position = 'relative'
      wrapper.style.pointerEvents = 'none'
      wrapper.style.boxShadow = '0 8px 20px rgb(0 0 0 / .45)'
      wrapper.style.borderRadius = '7px'
      grip.setPointerCapture(e.pointerId)

      const state: DragSession = {
        pointerId: e.pointerId,
        wrapper,
        sourceScope,
        movedId,
        startY,
        height,
        containers,
        target: { scope: sourceScope, index: homeIndex },
        cleanup: () => {},
      }

      /** Re-apply the whole preview for the current target (idempotent). */
      const applyPreview = () => {
        const { scope, index } = state.target
        for (const [cScope, container] of containers) {
          const rows = siblingWrappers(container)
          for (const el of rows) {
            if (el === wrapper) continue
            let dy = 0
            if (cScope === sourceScope) {
              const i = rows.indexOf(el)
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
              const i = rows.indexOf(el)
              if (i >= index) dy = height
            }
            el.style.transition = FLIP
            el.style.transform = dy ? `translateY(${dy}px)` : ''
          }
        }
      }

      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY
        wrapper.style.transform = `translateY(${dy}px)`
        // Which legal container is the pointer over? Default to the source.
        let targetScope = sourceScope
        for (const [cScope, container] of containers) {
          const r = container.getBoundingClientRect()
          if (ev.clientY >= r.top - 6 && ev.clientY <= r.bottom + 6) {
            targetScope = cScope
            break
          }
        }
        const container = containers.get(targetScope)!
        const rows = siblingWrappers(container).filter((el) => el !== wrapper)
        // Insertion index from midpoints of the UNDISPLACED positions: subtract
        // any preview transform so the math is stable while things animate.
        let index = rows.length
        for (let i = 0; i < rows.length; i++) {
          const el = rows[i]!
          const r = el.getBoundingClientRect()
          const tf = getComputedStyle(el).transform
          const shift = tf && tf !== 'none' ? new DOMMatrixReadOnly(tf).m42 : 0
          const mid = r.top - shift + r.height / 2
          if (ev.clientY < mid) {
            index = i
            break
          }
        }
        if (state.target.scope !== targetScope || state.target.index !== index) {
          state.target = { scope: targetScope, index }
          applyPreview()
        }
      }

      const clearAll = () => {
        for (const [, container] of containers) {
          for (const el of siblingWrappers(container)) {
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
      }

      const finish = (commit: boolean) => {
        grip.removeEventListener('pointermove', onMove)
        session.current = null
        const { scope, index } = state.target
        const changed = scope !== sourceScope || index !== homeIndex
        if (!commit || !changed) {
          clearAll()
          return
        }
        const container = containers.get(scope)!
        const others = siblingWrappers(container)
          .filter((el) => el !== wrapper)
          .map((el) => el.dataset.dragKey!)
        const order = [...others.slice(0, index), movedId, ...others.slice(index)]
        // Hold the preview until React renders the new order (settleDrag), so
        // the row doesn't snap back while the mutation round-trips.
        hold.current = {
          clear: clearAll,
          timer: setTimeout(() => {
            hold.current = null
            clearAll()
          }, 1500),
        }
        opts.onDrop({ sourceScope, targetScope: scope, movedId, order })
      }

      const onUp = () => finish(true)
      const onCancel = () => finish(false)
      grip.addEventListener('pointermove', onMove)
      grip.addEventListener('pointerup', onUp, { once: true })
      grip.addEventListener('pointercancel', onCancel, { once: true })
      state.cleanup = () => {
        grip.removeEventListener('pointermove', onMove)
        grip.removeEventListener('pointerup', onUp)
        grip.removeEventListener('pointercancel', onCancel)
      }
      session.current = state
    },
    [opts, settleDrag],
  )

  return { startDrag, settleDrag }
}
