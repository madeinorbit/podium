import type { UsageBucketWire } from '@podium/model'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { AppSheet } from '@/app/AppSheet'
import { useStoreSelector } from '@/app/store'
import { formatTick, formatTokens, formatUsd, niceAxisMax, usageSummary } from './usage'

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
  const peakDay = Math.max(0, ...s.days.map((d) => d.totalTokens))
  const axisMax = niceAxisMax(peakDay)
  // Three lines, not five. A seven-bar chart needs enough grid to read a value
  // off and no more; denser than this is chart junk competing with the data.
  const ticks = [0, axisMax / 2, axisMax]
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
          for what is asking something of you, and a token history asks nothing.

          AND IT HAS A SCALE NOW. Without one the chart answered "which day was
          biggest" and nothing else — you could compare bars and not read a
          single value. Three recessive gridlines off a rounded axis top, the
          axis labelled in the same units as the summary above it, and the peak
          bar direct-labelled. Only the peak: a number on every bar is the habit
          that turns a chart back into a table, and five of these days are 4px
          tall with nowhere to put one. */}
      <figure className="usage-figure">
        <figcaption className="usage-figure-caption">Tokens per day</figcaption>
        <div className="usage-plot">
          {/* The scale. aria-hidden because the table below carries the same
              numbers to a screen reader in a form it can actually read. */}
          <div className="usage-axis" aria-hidden="true">
            {ticks.map((t) => (
              <span
                key={t}
                className="usage-axis-tick"
                style={{ bottom: `${(t / axisMax) * 100}%` }}
              >
                {formatTick(t)}
              </span>
            ))}
          </div>
          <div className="usage-chart">
            {ticks.map((t) => (
              <span
                key={t}
                className="usage-gridline"
                style={{ bottom: `${(t / axisMax) * 100}%` }}
                aria-hidden="true"
              />
            ))}
            {s.days.map((d) => {
              const pct = Math.max(2, (d.totalTokens / axisMax) * 100)
              return (
                <div key={d.day} className="usage-day">
                  <div
                    className="usage-bar"
                    style={{ height: `${pct}%` }}
                    title={`${d.day}: ${formatTokens(d.totalTokens)} tokens · ${formatUsd(d.estCostUsd)}`}
                  />
                  {d.totalTokens === peakDay && peakDay > 0 && (
                    <span className="usage-bar-value" style={{ bottom: `${pct}%` }}>
                      {formatTokens(d.totalTokens)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          <div className="usage-days" aria-hidden="true">
            {s.days.map((d) => (
              <span key={d.day} className="usage-day-label">
                {d.day.slice(5)}
              </span>
            ))}
          </div>
        </div>
      </figure>
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
