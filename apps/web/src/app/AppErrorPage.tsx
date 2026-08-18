import { ChevronRight } from 'lucide-react'
import { type JSX, useEffect, useState } from 'react'
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

/** True when the keystroke belongs to whatever the operator is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/**
 * The terminal error screen. A crash is already loud enough, so this one stays
 * quiet: one yellow rule, the true sentence, one recovery action. Diagnostic
 * detail is real but disclosed — present for whoever will file the bug, invisible
 * to whoever just wants back in [POD-1004].
 */
export function AppErrorPage({
  title = 'Podium could not start',
  message,
  detail,
  onRetry,
  retryLabel = 'Try again',
  win,
}: {
  title?: string
  /** Visible prose. The actionable half of a connection or replica failure. */
  message?: string
  /** Raw diagnostic text, tucked behind "What happened". */
  detail?: string
  onRetry?: () => void
  retryLabel?: string
  win?: ReloadWindow
}): JSX.Element {
  const [copied, setCopied] = useState(false)

  // The exit must be reachable without a mouse: focus lands on the reload
  // (autoFocus, below), and `R` triggers it from anywhere on this screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'r' && event.key !== 'R') return
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return
      event.preventDefault()
      reloadApp(win)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [win])

  async function copyReport(): Promise<void> {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // A denied clipboard is not worth a second error screen; the text is on
      // screen already and can be selected by hand.
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-6">
      <section className="w-[min(440px,100%)]">
        <div className="h-[2px] w-6 rounded-full bg-primary" />
        <h1 className="mt-[18px] mb-0 text-[23px] leading-[1.25] font-medium tracking-[-0.02em] text-balance text-foreground">
          {title}
        </h1>
        {/* This screen only means the interface is down. Agents run in the daemon,
            not in this window, so the first thing an operator needs to know is that
            nothing they started has stopped. */}
        <p className="mt-2.5 mb-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {message ?? (
            <>
              <span className="font-medium text-foreground">
                Your agents are still working uninterrupted
              </span>{' '}
              in the background, independently of this window. Reloading restarts the interface
              only.
            </>
          )}
        </p>
        <div className="mt-[22px] flex flex-wrap items-center gap-2">
          <Button autoFocus type="button" onClick={() => reloadApp(win)}>
            Reload interface
          </Button>
          {onRetry && (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              onClick={onRetry}
            >
              {retryLabel}
            </Button>
          )}
        </div>
        {detail && (
          <details className="group mt-6 border-t border-border pt-3">
            {/* The label alone read as a heading, not a control. The chevron sits
                right after the words rather than before them so the rule, the
                title, the buttons and this label all stay on one left edge. */}
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 font-mono shell-type-micro tracking-[0.1em] text-muted-foreground/70 uppercase hover:text-muted-foreground [&::-webkit-details-marker]:hidden">
              What happened
              <ChevronRight
                size={11}
                aria-hidden="true"
                className="transition-transform duration-150 group-open:rotate-90"
              />
            </summary>
            <pre className="mt-2.5 mb-0 font-mono text-[10.5px] leading-[1.7] whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
              {detail}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2.5 mt-2 text-muted-foreground"
              onClick={() => void copyReport()}
            >
              {copied ? 'Copied' : 'Copy report'}
            </Button>
          </details>
        )}
      </section>
    </main>
  )
}
