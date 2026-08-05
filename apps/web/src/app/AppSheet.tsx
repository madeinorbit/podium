import { X } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * AN INSET SHEET (POD-365) — the shell's overlay tier for utilities.
 *
 * Settings and Usage are not modes, they are utilities you visit and leave. As
 * routes they took the whole window: the sidebar, the tab strip and the rail all
 * blinked out and a document flowed from the top, which is page replacement —
 * what a website does. An application swaps its content region and keeps its
 * frame. So these open INSET over a live shell, with the chrome still visible
 * around and behind them, and close on Esc, the backdrop, or the X.
 *
 * The lift is deliberate and licensed: The Carved Rule reserves drop shadows for
 * things that will disappear, which is exactly what a sheet is. Resting surfaces
 * below it stay carved.
 */
export function AppSheet({
  label,
  title,
  onClose,
  toolbar,
  children,
  className,
  testId,
}: {
  /** Accessible name for the dialog. */
  label: string
  /** Visible title in the sheet's own header. */
  title: ReactNode
  onClose: () => void
  /** Controls pinned to the right of the sheet header, before the close button. */
  toolbar?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
}): JSX.Element {
  const sheetRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // A menu, popover or nested dialog above the sheet owns Escape first; they
      // stop propagation, so anything reaching the window is meant for us.
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Focus moves into the sheet on open so the keyboard follows the eye, and so
  // Escape works before the user has clicked anything.
  useEffect(() => {
    sheetRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <>
      {/* Escape is the keyboard route out (bound above); the backdrop is a
          pointer convenience and is hidden from the accessibility tree. */}
      <div className="app-sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-testid={testId}
        className={cn('app-sheet', className)}
      >
        <header className="app-sheet-header">
          <h2 className="app-sheet-title">{title}</h2>
          <div className="app-sheet-actions">
            {toolbar}
            {/* The keyboard route is stated on the control that performs it. A
                free-standing `esc` keycap next to an ✕ that already means close
                puts two ways to say one thing in the corner the eye checks
                first — and the shell has no keycap component anywhere else. */}
            <button
              data-pressable
              type="button"
              className="app-sheet-close"
              aria-label={`Close ${label.toLowerCase()}`}
              title="Close — Esc"
              onClick={onClose}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="app-sheet-body">{children}</div>
      </section>
    </>
  )
}
