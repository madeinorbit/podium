import type { UsageBucketWire } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from './store'
import { formatTokens, formatUsd, usageSummary } from './usage'

/**
 * Usage & analytics — a full main-content surface (not a modal): rolling 5h + 7d
 * token consumption across the machine's harness transcripts, a per-day bar
 * chart, and a per-model cost table. Reached from the sidebar tools row (desktop)
 * and the picker-sheet actions (mobile).
 */
export function UsageView(): JSX.Element {
  const { trpc, setView } = useStore()
  const [buckets, setBuckets] = useState<UsageBucketWire[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      trpc.usage.summary
        .query()
        .then((r) => {
          if (!cancelled) setBuckets(r.buckets)
        })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 90_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [trpc])

  return (
    <section className="usage-view" aria-label="Usage & analytics">
      <div className="settings-head">
        <h2>Usage & analytics</h2>
        <button
          type="button"
          className="settings-close"
          title="Close analytics"
          onClick={() => setView('home')}
        >
          ✕
        </button>
      </div>
      {buckets === null ? (
        <div className="usage-body">
          <div className="empty">Loading usage…</div>
        </div>
      ) : buckets.length === 0 ? (
        <div className="usage-body">
          <div className="empty">No token usage recorded yet.</div>
        </div>
      ) : (
        <UsageBody buckets={buckets} />
      )}
    </section>
  )
}

function UsageBody({ buckets }: { buckets: UsageBucketWire[] }): JSX.Element {
  const s = usageSummary(buckets, Date.now())
  const maxDay = Math.max(1, ...s.days.map((d) => d.totalTokens))
  return (
    <div className="usage-body">
      <div className="usage-windows">
        <div className="usage-window">
          <div className="usage-window-label">Last 5 hours</div>
          <div className="usage-window-big">{formatTokens(s.fiveHour.totalTokens)}</div>
          <div className="usage-window-sub">
            {s.fiveHour.messages} replies · {formatUsd(s.fiveHour.estCostUsd)} API-equivalent
          </div>
        </div>
        <div className="usage-window">
          <div className="usage-window-label">Last 7 days</div>
          <div className="usage-window-big">{formatTokens(s.week.totalTokens)}</div>
          <div className="usage-window-sub">
            {s.week.messages} replies · {formatUsd(s.week.estCostUsd)} API-equivalent
          </div>
        </div>
      </div>
      <div className="usage-days">
        {s.days.map((d) => (
          <div key={d.day} className="usage-day">
            <div
              className="usage-day-bar"
              style={{ height: `${Math.max(2, (d.totalTokens / maxDay) * 72)}px` }}
              title={`${d.day}: ${formatTokens(d.totalTokens)} tokens · ${formatUsd(d.estCostUsd)}`}
            />
            <div className="usage-day-label">{d.day.slice(5)}</div>
          </div>
        ))}
      </div>
      <table className="usage-models">
        <thead>
          <tr>
            <th>Model</th>
            <th>Tokens (7d)</th>
            <th>Replies</th>
            <th>API-equivalent</th>
          </tr>
        </thead>
        <tbody>
          {s.models.map((m) => (
            <tr key={m.model}>
              <td>{m.model}</td>
              <td>{formatTokens(m.totalTokens)}</td>
              <td>{m.messages}</td>
              <td>{formatUsd(m.estCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="settings-note">
        Harvested from harness transcripts on the dev machine (Claude Code today; Codex when its
        logs join). Cost is the public API list-price equivalent of the same tokens — what this work
        would have cost off-subscription. Windows are rolling.
      </p>
    </div>
  )
}
