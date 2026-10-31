/**
 * THE NEW TASK OVERLAY (POD-2079) — the cold-start composer laid over the
 * workspace column instead of replacing it. See `new-task-overlay.ts` for the
 * state and why nothing behind it needs restoring.
 *
 * Three ways out, and only Cancel puts the old screen back:
 *  - Cancel / Esc: close, restore the view it switched from, return focus.
 *  - A launch: the composer selects the new task; the overlay just goes.
 *  - Navigation: anything that changes the selection or leaves the workspace
 *    (a sidebar row, the Tasks tab) means the operator went somewhere else, so
 *    the overlay steps aside rather than covering where they went.
 */
import type { MainView } from '@podium/client-core/ui-state'
import { type JSX, lazy, Suspense, useEffect } from 'react'
import { closeNewTaskOverlay, newTaskOverlayOrigin } from '@/features/worklist/new-task-overlay'
import { throughRestarts } from '@/lib/chunk-recovery'

const ColdStartComposer = lazy(() =>
  throughRestarts(() => import('./ColdStartComposer')).then((module) => ({
    default: module.ColdStartComposer,
  })),
)

/** Cancel: put back what opening changed, and hand focus back. */
export function cancelNewTaskOverlay(
  setView: (view: MainView) => void,
  currentView: MainView,
): void {
  const origin = closeNewTaskOverlay()
  if (!origin) return
  if (origin.view !== currentView) setView(origin.view)
  const target = origin.returnFocus
  if (target?.isConnected) target.focus({ preventScroll: true })
}

/** Layers that own their own Esc: menus, dialogs, popovers, the palette. */
const ESC_OWNERS =
  '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [data-slot$="-popup"], [data-slot$="-content"]'

/** Esc belongs to whatever is on top: an open menu, a dialog, the palette.
 *  Anywhere else — the overlay, the page, or a rail focus somehow reached —
 *  it closes the overlay (fidelity review: Esc read as broken once focus had
 *  left the overlay). */
function escapeIsOurs(event: KeyboardEvent, overlay: HTMLElement | null): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false
  const target = event.target
  if (!(target instanceof Element)) return true
  if (overlay?.contains(target)) return true
  return target.closest(ESC_OWNERS) === null
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

/** Tab cycles inside the overlay while it is open: the screen under it is
 *  still mounted, and Tab used to walk straight out into the right rail. */
function containTab(event: KeyboardEvent, overlay: HTMLElement | null): void {
  if (event.key !== 'Tab' || event.defaultPrevented || !overlay) return
  const target = event.target
  // A menu or dialog opened from the overlay portals out of it and keeps its
  // own focus rules.
  if (target instanceof Element && !overlay.contains(target) && target.closest(ESC_OWNERS)) return
  const items = Array.from(overlay.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.getClientRects().length > 0,
  )
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return
  const inside = target instanceof Node && overlay.contains(target)
  if (!inside) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  } else if (event.shiftKey && target === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && target === last) {
    event.preventDefault()
    first.focus()
  }
}

export function NewTaskOverlay({
  selectedIssueId,
  view,
  baseView,
  setView,
}: {
  selectedIssueId: string | null
  /** The store's view (may be a sheet like Settings over the base). */
  view: MainView
  /** The mode under any sheet. */
  baseView: MainView
  setView: (view: MainView) => void
}): JSX.Element {
  // Navigation away closes without restoring.
  useEffect(() => {
    const origin = newTaskOverlayOrigin()
    if (!origin) return
    if (selectedIssueId !== origin.selectedIssueId || baseView !== 'workspace')
      closeNewTaskOverlay()
  }, [selectedIssueId, baseView])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const overlay = document.querySelector<HTMLElement>('[data-testid="new-task-overlay"]')
      containTab(event, overlay)
      if (!escapeIsOurs(event, overlay)) return
      event.preventDefault()
      cancelNewTaskOverlay(setView, view)
    }
    // Bubble phase on window: menus and dialogs handle Esc first and mark it.
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView, view])

  return (
    <div className="new-task-overlay" data-testid="new-task-overlay">
      <button
        type="button"
        data-pressable
        data-testid="new-task-cancel"
        aria-label="Cancel"
        className="new-task-cancel"
        onClick={() => cancelNewTaskOverlay(setView, view)}
      >
        Cancel
        <kbd>Esc</kbd>
      </button>
      <Suspense fallback={null}>
        <ColdStartComposer first={false} autoFocus onLaunched={closeNewTaskOverlay} />
      </Suspense>
    </div>
  )
}
