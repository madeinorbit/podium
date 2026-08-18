import type { JSX, ReactNode } from 'react'
import { type BootField, BootScreen, type BootTrace } from './BootScreen'

export function formatAppError(error: unknown, fallback = 'Something went wrong'): string {
  const message = rawErrorMessage(error)
  if (message?.includes('No procedure found on path "discovery.')) {
    return 'This relay server is running an older Podium backend that does not support repo discovery. Restart the relay from this branch, or connect to a matching relay server.'
  }
  return message ?? fallback
}

function rawErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return null
}

/** The slice of `window` a reload needs — narrow so tests can pass a stand-in. */
export type ReloadWindow = { location: { reload: () => void; href: string } }

/**
 * Reload the document without going through the app. This page is the last thing
 * standing when the UI is broken (a render crash, a dead replica, a Tauri shell
 * with no browser chrome to reload from), so the recovery path must not depend on
 * the router, the store, or the transport. If `reload()` is unavailable or throws
 * — some embedded webviews restrict it — re-assign the current URL, which any
 * navigable context honours.
 */
export function reloadApp(win: ReloadWindow = window): void {
  try {
    win.location.reload()
  } catch {
    const { href } = win.location
    win.location.href = href
  }
}

/**
 * The terminal error screen, as the composition every stopped Podium screen now
 * shares (`BootScreen`). This module keeps the general case — a render crash, a
 * transport that never came up — where the only true things are a sentence and a
 * reload. Faults that know MORE about themselves say so through the richer props
 * rather than through a longer sentence [POD-1304].
 *
 * Diagnostic detail stays real but disclosed: present for whoever will file the
 * bug, invisible to whoever just wants back in [POD-1004].
 */
export function AppErrorPage({
  title = 'Podium could not start',
  eyebrow = 'Interface / stopped',
  message,
  detail,
  fields,
  trace,
  onRetry,
  retryLabel = 'Try again',
  win,
}: {
  title?: string
  /** Mono kicker above the headline: the fault's category, not a sentence. */
  eyebrow?: string
  /** Visible prose. The actionable half of a connection or replica failure. */
  message?: ReactNode
  /** Raw diagnostic text, tucked behind "What happened". */
  detail?: string
  /** What the machine tried, for the console panel. */
  fields?: readonly BootField[]
  trace?: BootTrace
  onRetry?: () => void
  retryLabel?: string
  win?: ReloadWindow
}): JSX.Element {
  return (
    <BootScreen
      eyebrow={eyebrow}
      headline={title}
      // This screen only means the interface is down. Agents run in the daemon,
      // not in this window, so the first thing an operator needs to know is that
      // nothing they started has stopped.
      prose={
        message ?? (
          <>
            <strong style={{ fontWeight: 600, color: 'var(--text-strong, var(--foreground))' }}>
              Your agents are still working uninterrupted
            </strong>{' '}
            in the background, independently of this window. Reloading restarts the interface only.
          </>
        )
      }
      fields={fields}
      trace={trace}
      detail={detail}
      primary={{ label: 'Reload interface', onClick: () => reloadApp(win) }}
      secondary={onRetry ? { label: retryLabel, onClick: onRetry } : undefined}
    />
  )
}
