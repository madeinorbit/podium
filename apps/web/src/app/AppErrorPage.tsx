import type { JSX } from 'react'
import { Button } from '@/components/ui/button'

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

export function AppErrorPage({
  title = 'Podium could not start',
  message,
  onRetry,
  win,
}: {
  title?: string
  message: string
  onRetry?: () => void
  win?: ReloadWindow
}): JSX.Element {
  return (
    <main className="flex min-h-full items-center justify-center bg-background p-5">
      <section className="w-[min(520px,100%)] rounded-md border border-border bg-card p-5">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">ERROR</div>
        <h1 className="my-2 text-[22px] font-medium text-foreground">{title}</h1>
        <p className="m-0 text-muted-foreground [overflow-wrap:anywhere]">{message}</p>
        {/* This screen only means the interface is down. Agents run in the daemon,
            not in this window, so the first thing an operator needs to know is that
            nothing they started has stopped. */}
        <p className="mt-4 mb-0 rounded-sm border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Your agents are safe and still running uninterrupted — they work in the background,
          independently of this window. Reloading only restarts the interface.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {onRetry && (
            <Button type="button" onClick={onRetry}>
              Retry
            </Button>
          )}
          <Button
            type="button"
            variant={onRetry ? 'outline' : 'default'}
            onClick={() => reloadApp(win)}
          >
            Reload Podium
          </Button>
        </div>
      </section>
    </main>
  )
}
