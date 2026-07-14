/**
 * The message ledger panel (#237) [spec:SP-34d7 web]: who sent what to whom,
 * when, with the full delivery story — queued/delivered/expired/cancelled,
 * urgency + lifecycle, requested-vs-effective when the clamp matrix downgraded
 * a send, and the ack link. Scoped to the active session and/or its issue;
 * lives in the right dock next to the issue panel.
 */
import { Mail as MailIcon, RefreshCw } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/home'
import { cn } from '@/lib/utils'
import {
  clampSummary,
  deliveryLine,
  type LedgerMessage,
  type LedgerStatusTone,
  ledgerStatusTone,
} from './message-ledger'

const STATUS_CHIP: Record<LedgerStatusTone, string> = {
  queued: 'bg-amber-400/15 text-amber-500 dark:text-amber-300',
  ok: 'bg-success/15 text-success',
  dead: 'bg-muted text-muted-foreground line-through',
}

function LedgerRow({ m, now }: { m: LedgerMessage; now: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const clamp = clampSummary(m)
  return (
    <div
      data-testid="ledger-row"
      className="rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5"
    >
      <button
        type="button"
        className="flex w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-left text-[11px]"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="font-medium text-foreground/85">{m.from}</span>
        <span className="text-muted-foreground/60">→</span>
        <span className="text-foreground/70">{m.to}</span>
        <span
          className={cn(
            'rounded-full px-1.5 text-[9.5px] font-semibold uppercase tracking-wide',
            STATUS_CHIP[ledgerStatusTone(m.status)],
          )}
        >
          {m.status}
        </span>
        {m.ackedBy && (
          <span className="rounded-full bg-success/15 px-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-success">
            acked
          </span>
        )}
        <span className="ml-auto flex-none text-[10px] text-muted-foreground/60">
          {relativeTime(m.createdAt, now)}
        </span>
      </button>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground/70">
        <span>{m.kind}</span>
        <span>·</span>
        <span>
          {m.urgency} / {m.lifecycle}
        </span>
        {clamp && (
          <span
            className="rounded border border-amber-500/50 px-1 text-[9px] font-semibold text-amber-600 dark:text-amber-400"
            title={clamp.reasons.join('; ')}
          >
            clamped: {clamp.parts.join(', ')}
          </span>
        )}
        {m.hop > 0 && <span>hop {m.hop}</span>}
        <span className="ml-auto font-mono text-[9.5px] text-muted-foreground/50">{m.id}</span>
      </div>
      {open && (
        <div className="mt-1 border-t border-border/40 pt-1">
          <div className="text-[10px] text-muted-foreground/70">{deliveryLine(m)}</div>
          {m.inReplyTo && (
            <div className="font-mono text-[9.5px] text-muted-foreground/50">
              in reply to {m.inReplyTo}
            </div>
          )}
          <div className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">
            {m.body}
          </div>
        </div>
      )}
    </div>
  )
}

/** Fetch + render the ledger for a session and/or issue scope. Poll every 15s
 *  while mounted (matches the dock's other lazy readers). */
export function MessageLedgerView({
  issueId,
  sessionId,
}: {
  issueId?: string
  sessionId?: string
}): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [rows, setRows] = useState<LedgerMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    if (!issueId && !sessionId) {
      setRows([])
      return
    }
    Promise.resolve()
      .then(() =>
        trpc.messages.ledger.query({
          ...(issueId ? { issueId } : {}),
          ...(sessionId ? { sessionId } : {}),
        }),
      )
      .then((r) => {
        setRows(r as LedgerMessage[])
        setError(null)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [trpc, issueId, sessionId])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [refresh])
  const now = Date.now()
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2.5"
      data-testid="message-ledger"
    >
      <div className="flex items-center gap-1.5 pb-1.5 text-[10.5px] font-semibold tracking-[0.09em] uppercase text-muted-foreground">
        <MailIcon size={12} className="flex-none" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">Message ledger</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 flex-none text-muted-foreground"
          title="Refresh ledger"
          onClick={refresh}
        >
          <RefreshCw size={12} aria-hidden="true" />
        </Button>
      </div>
      {error && <div className="pb-1 text-[11px] text-red-500">{error}</div>}
      {rows === null ? (
        <div className="py-1 text-xs text-muted-foreground/60 italic">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="py-1 text-xs text-muted-foreground/60 italic">
          No messages for this scope yet.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((m) => (
            <LedgerRow key={m.id} m={m} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
