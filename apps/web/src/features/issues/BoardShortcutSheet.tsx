/**
 * The `?` sheet — the board's accelerators, said out loud (POD-591).
 *
 * Rendered from `BOARD_SHORTCUTS`, the same table the key handler switches on,
 * so it cannot describe a binding the board does not have or miss one it does.
 *
 * It LIFTS, and that is the one place DESIGN.md's Carved Rule allows a shadow:
 * this is a transient overlay that will disappear. Escape, the backdrop and the
 * ✕ all close it — and the keyboard route is on the ✕'s own tooltip rather than
 * as a free-standing keycap, matching the sheet tier's rule.
 */
import { X } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect } from 'react'
import { BOARD_SHORTCUTS, shortcutGlyph } from './board-shortcuts'

export function BoardShortcutSheet({ onClose }: { onClose: () => void }): JSX.Element {
  // Escape closes from anywhere, including with focus inside the panel. Capture
  // phase so it never reaches the board's own Escape (which clears selection) —
  // one keypress must do one thing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/50 p-6"
      data-testid="board-shortcuts"
    >
      {/* The backdrop closes; it carries no other affordance, so a button with
          an aria-label is the honest element rather than a div with a click. */}
      <button
        type="button"
        aria-label="Close shortcuts"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Board keyboard shortcuts"
        className="relative w-[420px] max-w-full overflow-hidden rounded-[10px] border border-border-strong bg-card"
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        <div className="flex h-9 items-center gap-2 border-hairline-soft border-b bg-bar px-3">
          <span className="label-mono">Board shortcuts</span>
          <button
            data-pressable
            type="button"
            className="ml-auto grid size-6 place-items-center rounded-[4.8px] text-text-faint transition-colors hover:bg-accent hover:text-foreground"
            title="Close (esc)"
            aria-label="Close shortcuts"
            onClick={onClose}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
        <dl className="flex flex-col px-3 py-2">
          {BOARD_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys.join('|')} className="flex items-center gap-3 py-[3px]">
              <dt className="flex w-[86px] flex-none items-center gap-1">
                {shortcut.keys.map((key) => (
                  <kbd
                    key={key}
                    className="min-w-[18px] rounded-[4px] border border-border-strong bg-chip px-1 text-center font-mono text-[9.5px] text-muted-foreground leading-[16px]"
                  >
                    {shortcutGlyph(key)}
                  </kbd>
                ))}
              </dt>
              <dd className="m-0 min-w-0 flex-1 text-[12px] text-foreground">{shortcut.label}</dd>
              {shortcut.needsFocus && (
                <span className="flex-none font-mono text-[8.5px] text-text-faint uppercase tracking-[0.08em]">
                  focused
                </span>
              )}
            </div>
          ))}
        </dl>
        <p className="border-hairline-soft border-t px-3 py-2 text-[11px] text-text-dim">
          Shift-click a card selects it too, and right-click opens the full menu.
        </p>
      </div>
    </div>
  )
}
