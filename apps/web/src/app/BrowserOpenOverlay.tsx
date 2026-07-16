import type { SessionOpenUrlMessage, SessionOpenUrlResultMessage } from '@podium/protocol'
import { ExternalLink, X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useStoreSelector } from './store'

interface PendingOpen {
  request: SessionOpenUrlMessage
  callbackUrl: string
  submitting: boolean
  error?: string
}

function requestKey(request: Pick<SessionOpenUrlMessage, 'sessionId' | 'requestId'>): string {
  return `${request.sessionId}:${request.requestId}`
}

/** Older daemons don't send `intent`; a derived callback target implies login. */
function isLogin(request: SessionOpenUrlMessage): boolean {
  return request.intent ? request.intent === 'login' : Boolean(request.callbackTarget)
}

function displayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'a browser URL'
  }
}

/**
 * Confirm-first browser opening plus the persistent callback paste-back
 * affordance. The daemon remains the authority for callback validation and
 * loopback execution; this component only forwards explicit user actions.
 * [spec:SP-a43e]
 */
export function BrowserOpenOverlay(): JSX.Element | null {
  const hub = useStoreSelector((store) => store.hub)
  const sessions = useStoreSelector((store) => store.sessions)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const [pending, setPending] = useState<Map<string, PendingOpen>>(() => new Map())

  useEffect(() => {
    const dismiss = (request: SessionOpenUrlMessage): void => {
      toast.dismiss(`browser-open-${requestKey(request)}`)
      hub.dismissOpenUrl(request.sessionId, request.requestId)
    }
    const open = (request: SessionOpenUrlMessage): void => {
      const opened = window.open(request.url, '_blank', 'noopener,noreferrer')
      if (!opened) {
        toast.error('Browser blocked the new tab', {
          description: 'Allow popups for Podium, then retry Open.',
        })
        return
      }
      toast.dismiss(`browser-open-${requestKey(request)}`)
      // A plain link is done once opened — revoke the daemon-side request so
      // it neither replays nor lingers. Logins stay pending for the callback.
      if (!isLogin(request)) hub.dismissOpenUrl(request.sessionId, request.requestId)
    }
    const offOpen = hub.on('openUrl', (request) => {
      const key = requestKey(request)
      // Only login flows earn the persistent pending-login card; a plain link
      // gets the confirm toast alone. [spec:SP-a43e]
      if (isLogin(request)) {
        setPending((current) => {
          const next = new Map(current)
          if (!next.has(key)) {
            next.set(key, { request, callbackUrl: '', submitting: false })
          }
          return next
        })
      }
      const session = sessionsRef.current.find((item) => item.sessionId === request.sessionId)
      const label = session?.name || session?.title || 'Agent'
      toast(`${label} wants to open ${displayHost(request.url)}`, {
        id: `browser-open-${key}`,
        duration: Number.POSITIVE_INFINITY,
        description: 'Review the destination before opening it in your browser.',
        action: { label: 'Open', onClick: () => open(request) },
        cancel: { label: 'Dismiss', onClick: () => dismiss(request) },
      })
    })
    const offResult = hub.on('openUrlResult', (result: SessionOpenUrlResultMessage) => {
      const key = requestKey(result)
      if (result.status === 'failed') {
        setPending((current) => {
          const existing = current.get(key)
          if (!existing) return current
          const next = new Map(current)
          next.set(key, {
            ...existing,
            submitting: false,
            error: result.error || 'The remote callback request failed.',
          })
          return next
        })
        return
      }
      toast.dismiss(`browser-open-${key}`)
      setPending((current) => {
        if (!current.has(key)) return current
        const next = new Map(current)
        next.delete(key)
        return next
      })
      if (result.status === 'completed') toast.success('Login callback forwarded')
    })
    return () => {
      offOpen()
      offResult()
    }
  }, [hub])

  if (pending.size === 0) return null

  return (
    <aside
      aria-label="Pending agent browser requests"
      className="fixed right-3 bottom-3 z-[90] flex w-[min(26rem,calc(100vw-1.5rem))] flex-col gap-2"
    >
      {[...pending.entries()].map(([key, item]) => {
        const target = item.request.callbackTarget
        return (
          <section
            key={key}
            className="rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">Agent login pending</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {displayHost(item.request.url)}
                </div>
              </div>
              <button
                type="button"
                aria-label="Dismiss pending login"
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => hub.dismissOpenUrl(item.request.sessionId, item.request.requestId)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            <Button
              type="button"
              size="sm"
              className="mt-3 w-full"
              onClick={() => {
                const opened = window.open(item.request.url, '_blank', 'noopener,noreferrer')
                if (!opened) {
                  setPending((current) => {
                    const next = new Map(current)
                    next.set(key, { ...item, error: 'Browser blocked the new tab.' })
                    return next
                  })
                }
              }}
            >
              <ExternalLink size={14} aria-hidden="true" />
              Open login page
            </Button>

            {target ? (
              <form
                className="mt-3 border-t border-border pt-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!item.callbackUrl.trim()) return
                  setPending((current) => {
                    const next = new Map(current)
                    next.set(key, { ...item, submitting: true, error: undefined })
                    return next
                  })
                  hub.submitOpenUrlCallback(
                    item.request.sessionId,
                    item.request.requestId,
                    item.callbackUrl,
                  )
                }}
              >
                <label
                  htmlFor={`browser-callback-${key}`}
                  className="block text-xs font-medium text-foreground"
                >
                  Paste the localhost callback URL
                </label>
                <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  After login, copy the URL from your browser when it reaches localhost:
                  {target.port}
                  {target.path}.
                </div>
                <input
                  id={`browser-callback-${key}`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={`http://localhost:${target.port}${target.path}?code=…`}
                  value={item.callbackUrl}
                  onChange={(event) => {
                    const callbackUrl = event.target.value
                    setPending((current) => {
                      const next = new Map(current)
                      next.set(key, { ...item, callbackUrl, error: undefined })
                      return next
                    })
                  }}
                  className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                />
                {item.error && (
                  <p role="alert" className="mt-1.5 text-xs text-destructive">
                    {item.error}
                  </p>
                )}
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  className="mt-2 w-full"
                  disabled={!item.callbackUrl.trim() || item.submitting}
                >
                  {item.submitting ? 'Forwarding…' : 'Forward callback'}
                </Button>
              </form>
            ) : (
              <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                This request did not declare a localhost callback. You can keep it pending or
                dismiss it.
              </p>
            )}
          </section>
        )
      })}
    </aside>
  )
}
