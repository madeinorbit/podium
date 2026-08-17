import { type RefObject, useEffect, useRef, useState } from 'react'
import type { ContextMenuAnchor } from './session-context-menu'

/**
 * A CURSOR-ANCHORED MENU'S TWO EFFECTS, IN ONE HOME (POD-1188).
 *
 * Every right-click panel in the app does the same two things, and only these
 * two: it CLAMPS itself into the viewport once it has measured its real size, so
 * a menu opened near an edge is not clipped, and it DISMISSES on an outside
 * press, on Escape, on a scroll or on a resize. Both were written out verbatim
 * in `IssueContextMenu` and `SessionContextMenu` — identical down to the 8px
 * margin and the capture-phase listeners — and the folded row's menu would have
 * been a third copy of the pair. The panel's LOOK already has one home
 * (`menu-surface.ts`); its behaviour now has one too.
 *
 * `dismiss: false` suspends the dismissal half alone (the clamp is harmless
 * either way): a host that has handed the panel over to a dialog it owns must
 * not tear itself down when a press inside that dialog lands outside this ref,
 * and Escape there belongs to the dialog.
 */
export function useCursorMenu(
  anchor: ContextMenuAnchor,
  onClose: () => void,
  { dismiss = true }: { dismiss?: boolean } = {},
): { ref: RefObject<HTMLDivElement | null>; pos: ContextMenuAnchor } {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<ContextMenuAnchor>(anchor)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)),
    })
  }, [anchor])

  useEffect(() => {
    if (!dismiss) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, dismiss])

  return { ref, pos }
}
