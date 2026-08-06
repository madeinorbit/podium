import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useState,
} from 'react'
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

function timeLabel(bucket: HistoryBucket | undefined, index: number, bucketMs: number): string {
  if (index === BUCKETS - 1 || !bucket) return 'now'
  return new Date(Date.parse(bucket.start) + bucketMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * The status strip's 71×12px history skyline. It is deliberately informational:
 * hover/focus reveals precision, but there is no click action competing with
 * the current-state spinner and sentence immediately to its left.
 */
export function AgentConcurrencyHistory({
  working,
  trpc,
}: {
  working: number
  trpc: Trpc
}): JSX.Element {
  const [history, setHistory] = useState<HistoryResult | null>(null)
  const [activeIndex, setActiveIndex] = useState(BUCKETS - 1)

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
  const active = buckets[activeIndex] ?? { start: '', count: working }
  const activeTime = timeLabel(active, activeIndex, history?.bucketMs ?? 30 * 60 * 1_000)
  const ariaLabel = `Agent concurrency over the last 12 hours. ${working} ${working === 1 ? 'agent' : 'agents'} working now. Peak ${peak}.`

  const move = (event: MouseEvent<HTMLSpanElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 1
    setActiveIndex(Math.max(0, Math.min(BUCKETS - 1, Math.floor(ratio * BUCKETS))))
  }
  const moveWithKeyboard = (event: KeyboardEvent<HTMLSpanElement>): void => {
    let next = activeIndex
    if (event.key === 'ArrowLeft') next -= 1
    else if (event.key === 'ArrowRight') next += 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = BUCKETS - 1
    else return
    event.preventDefault()
    setActiveIndex(Math.max(0, Math.min(BUCKETS - 1, next)))
  }

  return (
    <span className="status-strip-history">
      <span className="status-strip-history-label" aria-hidden="true">
        12h
      </span>
      <span
        className="status-strip-history-graph"
        data-testid="agent-concurrency-history"
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={BUCKETS - 1}
        aria-valuenow={activeIndex}
        aria-valuetext={`${active.count} ${active.count === 1 ? 'agent' : 'agents'} at peak in the bucket ending ${activeTime}`}
        onBlur={() => setActiveIndex(BUCKETS - 1)}
        onKeyDown={moveWithKeyboard}
        onMouseLeave={() => setActiveIndex(BUCKETS - 1)}
        onMouseMove={move}
      >
        {buckets.map((bucket, index) => {
          const shown = Math.min(bucket.count, PIXEL_CAP)
          const ageStrength = 0.36 + (index / (BUCKETS - 1)) * 0.34
          return (
            <span
              // Time is the stable identity once the server history has loaded;
              // index is the honest fallback for the initial empty skeleton.
              key={bucket.start || index}
              className="status-strip-history-stack"
              data-active={index === activeIndex ? 'true' : 'false'}
              data-current={index === BUCKETS - 1 ? 'true' : 'false'}
              data-over-cap={bucket.count > PIXEL_CAP ? 'true' : 'false'}
              style={
                {
                  '--history-strength': ageStrength,
                  '--history-height': `${shown}px`,
                } as CSSProperties
              }
            >
              <i className="status-strip-history-pixel" />
            </span>
          )
        })}
      </span>
      <span className="status-strip-history-tooltip" aria-hidden="true">
        <span className="status-strip-history-tip-head">
          <b>Agent concurrency</b>
          <span>peak {peak}</span>
        </span>
        <span className="status-strip-history-reading">
          <b>{active.count}</b>
          <span>{active.count === 1 ? 'agent at peak' : 'agents at peak'}</span>
          <time>{activeTime}</time>
        </span>
        <span className="status-strip-history-foot">Last 12 hours · 30-minute peaks</span>
      </span>
    </span>
  )
}
