import type { JSX } from 'react'
import { AppSheet } from '@/app/AppSheet'
import { useStoreSelector } from '@/app/store'
import { formatTick, formatTokens, formatUsd, niceAxisMax, usageSummary } from './usage'
import { formatClock, useArrived, useUsageFeed, type UsageFeed } from './useUsageFeed'

/**
 * Usage & analytics — rolling 5h + 7d token consumption across the machine's
 * harness transcripts, a per-day bar chart, and a per-model cost table.
 *
 * A UTILITY, NOT A MODE (POD-365): it opens as an inset sheet over the live
 * shell rather than replacing the window, and its regions stretch to the sheet
 * so the content never stops halfway down an empty frame.
 *
 * LOADING IS A SHAPE, NOT A SENTENCE (POD-394). A centred "Loading usage…" made
 * a fit-height sheet open at the height of one line and snap to full size when
 * the buckets landed — a page assembling itself in front of you. The instrument
 * is now drawn in full from the first frame, and only its READINGS are missing:
 * everything known before the fetch (both window labels, the caption, the three
 * gridlines, the seven calendar-day ticks, the table header, the footnote) is
 * real, and the dozen unknown figures show as unfilled slots. Reopening the
 * sheet skips even that — see useUsageFeed.
 */
export function UsageView({ onClose }: { onClose: () => void }): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const feed = useUsageFeed(trpc)
  const cold = feed.buckets === null
  const arrived = useArrived(!cold)

  return (
    <AppSheet
      label="Usage & analytics"
      title="Usage & analytics"
      testId="usage-sheet"
      // One screen of figures, so the sheet ends where they do rather than
      // stretching them to the frame.
      className="app-sheet-fit"
      toolbar={<UsageStamp feed={feed} />}
      onClose={onClose}
    >
      {cold && feed.failed ? (
        <UsageUnreachable onRetry={feed.retry} />
      ) : feed.buckets?.length === 0 ? (
        <div className="usage-empty">No token usage recorded yet.</div>
      ) : (
        <UsageBody feed={feed} cold={cold} arrived={arrived} />
      )}
    </AppSheet>
  )
}

/**
 * Visible ONLY when what is on screen is not current. Serving figures from cache
 * is honest only if the sheet admits when they went stale; a permanent
 * "updated 14:32" would just be a clock in the corner the eye checks first.
 */
function UsageStamp({ feed }: { feed: UsageFeed }): JSX.Element | null {
  if (!feed.failed || feed.fetchedAt === null) return null
  return (
    <span
      className="usage-stamp"
      title="Couldn't reach the daemon for a fresh reading, so these are the last one. Retrying automatically."
    >
      LAST READ {formatClock(feed.fetchedAt)}
    </span>
  )
}

/** Cold and unreachable — the one state with nothing truthful to draw. */
function UsageUnreachable({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <div className="usage-unreachable">
      <p className="usage-unreachable-line">Couldn't read usage from the daemon.</p>
      <button data-pressable type="button" className="usage-retry" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

function UsageBody({
  feed,
  cold,
  arrived,
}: {
  feed: UsageFeed
  cold: boolean
  arrived: boolean
}): JSX.Element {
  // The cold pass runs the REAL component over an empty dataset rather than a
  // bespoke skeleton: same summary, same plot grid, same seven columns, same
  // table header and footnote. The layout it holds IS the layout that lands, so
  // there is no second geometry to keep in step with this one — and nothing
  // moves when the answer arrives except the values themselves.
  const s = usageSummary(feed.buckets ?? [], Date.now())
  const peakDay = Math.max(0, ...s.days.map((d) => d.totalTokens))
  const axisMax = niceAxisMax(peakDay)
  // Three lines, not five. A seven-bar chart needs enough grid to read a value
  // off and no more; denser than this is chart junk competing with the data.
  const ticks = [0, axisMax / 2, axisMax]

  return (
    <div
      className="usage-body"
      data-cold={cold || undefined}
      data-arrive={arrived || undefined}
      data-waiting={feed.waiting || undefined}
      aria-busy={cold || undefined}
    >
      {/* A refresh earns a hairline only once it has been slow enough to be
          worth admitting (PENDING_REVEAL_MS). It is bounded by a request in
          flight rather than ambient, which is what keeps it clear of the
          standing ban on perpetual motion — the working spinner and its timer
          stay the only always-on movement in the shell. */}
      {feed.waiting && <div className="usage-refreshing" aria-hidden="true" />}
      {cold && <span className="sr-only">Loading usage…</span>}
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
            <div className="usage-window-value">
              {cold ? <Unfilled ch={5} /> : formatTokens(win.totalTokens)}
            </div>
            <div className="usage-window-sub">
              {cold ? (
                <Unfilled ch={24} />
              ) : (
                `${win.messages} replies · ${formatUsd(win.estCostUsd)} API-equivalent`
              )}
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
                {/* The gridlines are geometry and hold from the first frame; the
                    numbers ON them are not known until the peak is, and an axis
                    labelled off an empty dataset would read 1 / 0.5 / 0. */}
                {cold ? <Unfilled ch={3.5} /> : formatTick(t)}
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
            {s.days.map((d, i) => {
              const pct = Math.max(2, (d.totalTokens / axisMax) * 100)
              return (
                <div key={d.day} className="usage-day">
                  <div
                    className="usage-bar"
                    style={{
                      height: `${pct}%`,
                      // Left to right, the way the axis is read. Twenty
                      // milliseconds apart is enough to be a sequence and not
                      // enough to be a wait.
                      transitionDelay: arrived ? `${i * 20}ms` : undefined,
                    }}
                    title={
                      cold
                        ? undefined
                        : `${d.day}: ${formatTokens(d.totalTokens)} tokens · ${formatUsd(d.estCostUsd)}`
                    }
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
              {['Model', 'Tokens (7d)', 'Replies', 'API-equivalent'].map((h) => (
                <th
                  key={h}
                  className="border-b border-border px-2 py-1 text-left text-[11px] font-semibold text-muted-foreground"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cold
              ? // Three rows: the table is the one region whose LENGTH is
                // genuinely unknown before the answer, and holding a plausible
                // few keeps the sheet from growing under the pointer.
                [0, 1, 2].map((r) => (
                  <tr key={r}>
                    {[14, 5, 3, 6].map((ch, c) => (
                      <td key={c} className="border-b border-border px-2 py-1">
                        <Unfilled ch={ch} />
                      </td>
                    ))}
                  </tr>
                ))
              : s.models.map((m) => (
                  <tr key={m.model}>
                    <td className="border-b border-border px-2 py-1 text-foreground">{m.model}</td>
                    <td className="border-b border-border px-2 py-1 text-foreground">
                      {formatTokens(m.totalTokens)}
                    </td>
                    <td className="border-b border-border px-2 py-1 text-foreground">
                      {m.messages}
                    </td>
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

/**
 * A reading that has not come in yet: an unfilled slot — a rule sitting on the
 * baseline the digits will sit on. Not a soft grey block, which is a shape
 * standing in for content and belongs to a different kind of product; and not a
 * `0` or an `—`, both of which are claims about the number.
 */
function Unfilled({ ch }: { ch: number }): JSX.Element {
  return <span className="usage-unfilled" style={{ width: `${ch}ch` }} aria-hidden="true" />
}
