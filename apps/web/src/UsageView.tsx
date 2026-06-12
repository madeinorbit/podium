import type { UsageBucketWire } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from './store'
import { formatTokens, formatUsd, usageSummary } from './usage'

/**
 * Usage chip for the status strip: rolling 5h + 7d token consumption across
 * the machine's harness transcripts. Click for the analytics breakdown.
 */
export function UsageChip(): JSX.Element | null {
  const { trpc } = useStore()
  const [buckets, setBuckets] = useState<UsageBucketWire[] | null>(null)
  const [open, setOpen] = useState(false)

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

  if (!buckets || buckets.length === 0) return null
  const s = usageSummary(buckets, Date.now())
  return (
    <>
      <button
        type="button"
        className="host-chip usage-chip"
        title={`Token usage — 5h: ${formatTokens(s.fiveHour.totalTokens)} (${formatUsd(s.fiveHour.estCostUsd)} API-equivalent) · 7d: ${formatTokens(s.week.totalTokens)} (${formatUsd(s.week.estCostUsd)}). Click for analytics.`}
        onClick={() => setOpen(true)}
      >
        <span className="host-chip-label">
          5h {formatTokens(s.fiveHour.totalTokens)} · 7d {formatTokens(s.week.totalTokens)}
        </span>
      </button>
      {open && <UsageAnalytics buckets={buckets} onClose={() => setOpen(false)} />}
    </>
  )
}

function UsageAnalytics({
  buckets,
  onClose,
}: {
  buckets: UsageBucketWire[]
  onClose: () => void
}): JSX.Element {
  const s = usageSummary(buckets, Date.now())
  const maxDay = Math.max(1, ...s.days.map((d) => d.totalTokens))
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="usage-modal" role="dialog" aria-modal="true" aria-label="Usage analytics">
        <div className="settings-head">
          <h2>Usage & analytics</h2>
          <button type="button" className="settings-close" onClick={onClose}>
            ✕
          </button>
        </div>
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
            logs join). Cost is the public API list-price equivalent of the same tokens — what this
            work would have cost off-subscription. Windows are rolling.
          </p>
        </div>
      </div>
    </div>
  )
}
