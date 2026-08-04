import type { UsageBucketWire } from '@podium/model'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { AppSheet } from '@/app/AppSheet'
import { useStoreSelector } from '@/app/store'
import { formatTokens, formatUsd, usageSummary } from './usage'

/**
 * Usage & analytics — rolling 5h + 7d token consumption across the machine's
 * harness transcripts, a per-day bar chart, and a per-model cost table.
 *
 * A UTILITY, NOT A MODE (POD-365): it opens as an inset sheet over the live
 * shell rather than replacing the window, and its regions stretch to the sheet
 * so the content never stops halfway down an empty frame.
 */
export function UsageView({ onClose }: { onClose: () => void }): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
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
    <AppSheet
      label="Usage & analytics"
      title="Usage & analytics"
      testId="usage-sheet"
      // One screen of figures, so the sheet ends where they do rather than
      // stretching them to the frame.
      className="app-sheet-fit"
      onClose={onClose}
    >
      {buckets === null ? (
        <div className="usage-empty">Loading usage…</div>
      ) : buckets.length === 0 ? (
        <div className="usage-empty">No token usage recorded yet.</div>
      ) : (
        <UsageBody buckets={buckets} />
      )}
    </AppSheet>
  )
}

function UsageBody({ buckets }: { buckets: UsageBucketWire[] }): JSX.Element {
  const s = usageSummary(buckets, Date.now())
  const maxDay = Math.max(1, ...s.days.map((d) => d.totalTokens))
  return (
    <div className="usage-body">
      {/* TWO READOUTS, NOT TWO CARDS. Same-size bordered tiles carrying a big
          number over a small label are the SaaS-dashboard cliché PRODUCT.md
          names as an anti-reference, and a 24px bold figure is a size jump this
          type ramp does not have. Both windows are machine voice, so they read
          the way the instrument well reads: a mono micro-label, a tabular
          figure, a dim sub-line, divided by a hairline rather than boxed. */}
      <div className="usage-summary">
        {[
          { label: 'Last 5 hours', win: s.fiveHour },
          { label: 'Last 7 days', win: s.week },
        ].map(({ label, win }) => (
          <div key={label} className="usage-window">
            <div className="usage-window-label">{label}</div>
            <div className="usage-window-value">{formatTokens(win.totalTokens)}</div>
            <div className="usage-window-sub">
              {win.messages} replies · {formatUsd(win.estCostUsd)} API-equivalent
            </div>
          </div>
        ))}
      </div>
      {/* A fixed chart height, not a stretched one. Filling the sheet turned one
          busy day into a 660px monolith and five quiet ones into 4px stubs —
          proportion is the only thing a bar chart says, so the frame must not be
          the thing setting it. The sheet sizes to its content instead (see
          .app-sheet-fit). Bars are DATA and read calm blue: yellow is reserved
          for what is asking something of you, and a token history asks nothing. */}
      <div className="usage-chart">
        {s.days.map((d) => (
          <div key={d.day} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <div
              className="usage-bar"
              style={{ height: `${Math.max(2, (d.totalTokens / maxDay) * 100)}%` }}
              title={`${d.day}: ${formatTokens(d.totalTokens)} tokens · ${formatUsd(d.estCostUsd)}`}
            />
            <div className="text-[10px] text-muted-foreground/70">{d.day.slice(5)}</div>
          </div>
        ))}
      </div>
      <div className="usage-table-scroll">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b border-border px-2 py-1 text-left text-[11px] font-semibold text-muted-foreground">
                Model
              </th>
              <th className="border-b border-border px-2 py-1 text-left text-[11px] font-semibold text-muted-foreground">
                Tokens (7d)
              </th>
              <th className="border-b border-border px-2 py-1 text-left text-[11px] font-semibold text-muted-foreground">
                Replies
              </th>
              <th className="border-b border-border px-2 py-1 text-left text-[11px] font-semibold text-muted-foreground">
                API-equivalent
              </th>
            </tr>
          </thead>
          <tbody>
            {s.models.map((m) => (
              <tr key={m.model}>
                <td className="border-b border-border px-2 py-1 text-foreground">{m.model}</td>
                <td className="border-b border-border px-2 py-1 text-foreground">
                  {formatTokens(m.totalTokens)}
                </td>
                <td className="border-b border-border px-2 py-1 text-foreground">{m.messages}</td>
                <td className="border-b border-border px-2 py-1 text-foreground">
                  {formatUsd(m.estCostUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="usage-note">
        Harvested from harness transcripts on the dev machine (Claude Code today; Codex when its
        logs join). Cost is the public API list-price equivalent of the same tokens — what this work
        would have cost off-subscription. Windows are rolling.
      </p>
    </div>
  )
}
