import { type JSX, useEffect, useMemo, useState } from 'react'
import { StatusMetric } from './StatusMetric'
import type { Trpc } from './trpc'

const BUCKETS = 24
const PIXEL_CAP = 12
const REFRESH_MS = 5 * 60 * 1_000

interface HistoryBucket {
  start: string
  count: number
}

interface HistoryResult {
  sampledAt: string
  bucketMs: number
  peak: number
  buckets: HistoryBucket[]
}

function validHistory(value: HistoryResult): boolean {
  return (
    Number.isFinite(value.bucketMs) &&
    value.bucketMs > 0 &&
    Number.isInteger(value.peak) &&
    value.peak >= 0 &&
    value.buckets.length === BUCKETS &&
    value.buckets.every(
      (bucket) =>
        Number.isInteger(bucket.count) &&
        bucket.count >= 0 &&
        Number.isFinite(Date.parse(bucket.start)),
    )
  )
}

/**
 * The status strip's 71×12px history skyline. It is deliberately informational:
 * hover/focus reveals precision, and its one adjacent action shares the current
 * reading rather than changing the instrument.
 */
export function AgentConcurrencyHistory({
  working,
  trpc,
}: {
  working: number
  trpc: Trpc
}): JSX.Element {
  const [history, setHistory] = useState<HistoryResult | null>(null)

  useEffect(() => {
    let disposed = false
    const load = (): void => {
      void trpc.sessions.concurrencyHistory
        .query()
        .then((next) => {
          if (!disposed && validHistory(next)) {
            const buckets = next.buckets.map((bucket) => ({ ...bucket }))
            const latest = buckets.at(-1)
            if (latest) latest.count = Math.max(latest.count, working)
            setHistory({ ...next, peak: Math.max(next.peak, working), buckets })
          }
        })
        .catch(() => {})
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [trpc, working])

  const buckets = useMemo(() => {
    const next =
      history?.buckets.map((bucket) => ({ ...bucket })) ??
      Array.from({ length: BUCKETS }, () => ({ start: '', count: 0 }))
    // Before the first history response, the live count still draws the current
    // stack. Once loaded, the server's half-hour peak is intentionally allowed
    // to sit above the exact current sentence beside it.
    if (!history) next[BUCKETS - 1] = { start: '', count: working }
    return next
  }, [history, working])
  const peak = Math.max(history?.peak ?? 0, ...buckets.map((bucket) => bucket.count))
  const ariaLabel = `Agent concurrency over the last 12 hours. ${working} ${working === 1 ? 'agent' : 'agents'} working now. Peak ${peak}.`

  return (
    <StatusMetric
      testId="agent-concurrency-history"
      tone="agents"
      current={
        working > 0 ? (
          <span className="status-strip-live" data-testid="status-strip-working">
            <span className="status-strip-spinner" aria-hidden="true" />
            {working} {working === 1 ? 'agent' : 'agents'} working
          </span>
        ) : (
          <span className="status-strip-idle" data-testid="status-strip-working">
            no agents working
          </span>
        )
      }
      buckets={buckets.map((bucket) => ({
        startMs: Date.parse(bucket.start) || 0,
        value: bucket.count,
      }))}
      title="Agent concurrency"
      summary={ariaLabel}
      aside={`peak ${peak}`}
      reading={(value) => ({
        value: String(value),
        label: value === 1 ? 'agent at peak' : 'agents at peak',
      })}
      foot="Last 12 hours · 30-minute peaks"
      scaleMax={PIXEL_CAP}
      shareText={
        working === 0
          ? 'My Podium agent fleet is taking a breather — 0 agents working right now.'
          : `${working} AI ${working === 1 ? 'agent is' : 'agents are'} working in parallel in Podium right now. ⚡`
      }
    />
  )
}
