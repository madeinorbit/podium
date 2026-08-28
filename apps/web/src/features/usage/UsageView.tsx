import {
  formatCostWeightRatio,
  formatCount,
  formatHour,
  formatShare,
  formatTick,
  formatTokens,
  formatUsd,
  formatUsdTick,
  formatWindowSpan,
  niceAxisMax,
  type UsageProvider,
  type UsageSummaryView,
  usageSummary,
} from '@podium/client-core/viewmodels'
import { type CSSProperties, type JSX, useState } from 'react'
import { AppSheet } from '@/app/AppSheet'
import { useStoreSelector } from '@/app/store'
import { QuotaLedger } from './QuotaLedger'
import { Unfilled } from './Unfilled'
import { type QuotaLedgerFeed, useQuotaLedger } from './useQuotaLedger'
import { formatClock, type UsageFeed, useArrived, useUsageFeed } from './useUsageFeed'

/**
 * Usage & analytics — what the machine's agents spent, at hour resolution.
 *
 * A UTILITY, NOT A MODE (POD-365): it opens as an inset sheet over the live
 * shell rather than replacing the window, and its regions stretch to the sheet
 * so the content never stops halfway down an empty frame.
 *
 * IT LEADS WITH COST (POD-596). Tokens are the raw material; the reason to open
 * this sheet is what the week would have cost off-subscription, so the dollar
 * figure is the readout and its active-day rate supplies the reading beneath
 * it. The old sheet
 * answered "how many tokens" three times — window, chart and table — and "where
 * did it go" only once, badly.
 *
 * THE TRACE (POD-596). The chart is one column per HOUR across the whole seven
 * days, not one bar per day. Seven bars answered which day was biggest and
 * nothing else; 168 columns show the shape of the week — the overnight runs, the
 * gaps where nothing ran, the hour a fleet went wide — which is the thing a
 * person running agents around the clock actually wants to see. Day totals move
 * to the axis labels, so the question the old chart answered is still answered.
 *
 * LOADING IS A SHAPE, NOT A SENTENCE (POD-394). A centred "Loading usage…" made
 * a fit-height sheet open at the height of one line and snap to full size when
 * the buckets landed — a page assembling itself in front of you. The instrument
 * is drawn in full from the first frame, and only its READINGS are missing:
 * everything known before the fetch (the window label, the gridlines, the
 * seven day columns and their labels, the composition rows, the table header,
 * the footnote) is real, and the unknown figures show as unfilled slots.
 * Reopening the sheet skips even that — see useUsageFeed.
 */
export function UsageView({ onClose }: { onClose: () => void }): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const feed = useUsageFeed(trpc)
  const ledger = useQuotaLedger(trpc)
  const cold = feed.buckets === null
  const arrived = useArrived(!cold)
  const summary = usageSummary(feed.buckets ?? [], Date.now())

  return (
    <AppSheet
      label="Usage & analytics"
      title="Usage & analytics"
      testId="usage-sheet"
      // One screen of figures, so the sheet ends where they do rather than
      // stretching them to the frame.
      className="app-sheet-fit"
      toolbar={<UsageToolbar summary={summary} cold={cold} feed={feed} />}
      onClose={onClose}
    >
      {cold && feed.failed ? (
        <UsageUnreachable onRetry={feed.retry} />
      ) : feed.buckets?.length === 0 ? (
        /* THIS BRANCH MUST NOT CONSULT THE LEDGER. It is decided on the first
           paint, when the ledger read is still in flight — so a condition
           involving it reads "no strips" from a null answer, paints this message,
           and then swaps to the full body a poll later. That is exactly the
           resize-on-arrival the sheet promises not to do. The ledger renders
           inside the empty state instead, so an operator who did not code this
           week still sees their window history rather than losing it to a message
           about tokens. */
        <div className="usage-body usage-body-empty">
          <div className="usage-empty">No token usage recorded yet.</div>
          <QuotaLedger ledger={ledger.ledger} cold={ledger.ledger === null} feed={ledger} />
        </div>
      ) : (
        <UsageBody
          feed={feed}
          ledger={ledger}
          summary={summary}
          cold={cold}
          arrived={arrived}
        />
      )}
    </AppSheet>
  )
}

function UsageToolbar({
  summary,
  cold,
  feed,
}: {
  summary: UsageSummaryView
  cold: boolean
  feed: UsageFeed
}): JSX.Element {
  return (
    <span className="usage-toolbar">
      <span className="usage-window-span">
        {cold ? <Unfilled ch={22} /> : formatWindowSpan(summary.days)}
      </span>
      <UsageStamp feed={feed} />
    </span>
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
      title="Couldn't reach the daemon for a fresh reading, so these are the last readings. Retrying automatically."
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
  ledger,
  summary,
  cold,
  arrived,
}: {
  feed: UsageFeed
  ledger: QuotaLedgerFeed
  summary: UsageSummaryView
  cold: boolean
  arrived: boolean
}): JSX.Element {
  // The cold pass runs the REAL component over an empty dataset rather than a
  // bespoke skeleton: same readouts, same plot grid, same seven day columns,
  // same composition rows, same table. The layout it holds IS the layout that
  // lands, so there is no second geometry to keep in step with this one — and
  // nothing moves when the answer arrives except the values themselves.
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
      {/* THE FIGURES SCROLL; THE FRAME DOES NOT (POD-755). The sheet ends where
          its content ends and caps at the window (`app-sheet-fit`), so on a
          short display the last region was simply cut off — `.app-sheet-body`
          clips and nothing inside it could scroll, which left the model table
          unreachable rather than merely below the fold. One scroller, holding
          the content regions only: the provenance bar is the frame's bottom
          edge and stays put, the way the sheet's own header does. */}
      <div className="usage-scroll">
        <UsageReadouts summary={summary} cold={cold} />
        <UsageProviders summary={summary} cold={cold} />
        <UsageTrace summary={summary} cold={cold} arrived={arrived} />
        <UsageComposition summary={summary} cold={cold} />
        <UsageModels summary={summary} cold={cold} />
        <QuotaLedger ledger={ledger.ledger} cold={ledger.ledger === null} feed={ledger} />
      </div>
      <UsageProvenance summary={summary} cold={cold} />
    </div>
  )
}

/**
 * Where these numbers come from — the sheet's footer bar.
 *
 * It was a paragraph capped at a 72ch measure under a full-width rule, which
 * left the bottom third of the sheet as one block of text pushed against the
 * left edge and a hand's breadth of nothing beside it. A window does not end
 * that way: it CLOSES (DESIGN.md, The Status Strip). So the fine print became
 * the frame's bottom edge — full-bleed, `--bar` toned and hairline-topped, the
 * mirror of the sheet's own 36px header — carrying the three facts as labelled
 * cells divided into a compact set of labelled readings.
 * The surface opens and closes on the same grammar.
 *
 * Its type does NOT join the Reading Tier the sheet's content uses: chrome never
 * does (POD-407), and a frame whose text grew with its contents stops reading as
 * the frame.
 */
function UsageProvenance({
  summary,
  cold,
}: {
  summary: UsageSummaryView
  cold: boolean
}): JSX.Element {
  const pricing =
    summary.unpricedModels.length === 0
      ? 'Public per-model list price. Every model in this window matched a priced family.'
      : `Public per-model list price. ${formatCount(summary.unpricedModels.length)} ${summary.unpricedModels.length === 1 ? 'model used' : 'models used'} the fallback rate: ${summary.unpricedModels.join(', ')}.`
  const facts = [
    { label: 'Source', value: 'Claude Code, Codex, and Grok sessions on this machine', wide: false },
    {
      label: 'Pricing',
      value: pricing,
      wide: true,
    },
    { label: 'Refreshed', value: 'Every 90s while open', wide: false },
  ]
  return (
    <footer className="usage-provenance">
      {facts.map((f) => (
        <div key={f.label} className="usage-prov" data-wide={f.wide || undefined}>
          <span className="usage-prov-label">{f.label}</span>
          <span className="usage-prov-value">
            {cold && f.label === 'Pricing' ? <Unfilled ch={48} /> : f.value}
          </span>
        </div>
      ))}
    </footer>
  )
}

/**
 * The masthead: one answer, the three readings that size it, one counterfactual.
 *
 * IT IS ONE ROW OF READOUTS, WIDEST FIRST (POD-755). The three supporting rates
 * used to run together in a single dot-separated sentence under the figure —
 * "$974 per active day · 7 of 7 days ran · $387 in the last 5 hours" — which is
 * three separate readings punctuated as prose, in the one region of the sheet
 * that had two thirds of its width empty beside it. They are now cells in a
 * hairline-divided group at the band's right edge, mirroring the figure's own
 * label-over-value structure: the eyebrow IS the leftmost cell's label, so the
 * whole band reads as one instrument whose first reading happens to be 24px.
 * The group is a divided object rather than three loose numbers for the reason
 * the command bar's instrument well is one object — evenly spaced figures on a
 * surface read as a website's account row (DESIGN.md, The Wells).
 *
 * They narrow left to right: the week ran seven days, at this much a day, and
 * this much in the last five hours. The last cell's figures right-align with the
 * provider costs and the ratio column below them, so the sheet has one right
 * edge rather than one per region.
 *
 * ONE HEDGE, NOT THREE. The figure carried a superscript star whose footnote sat
 * directly beneath it — an asterisk earns its keep when the note is somewhere
 * else on the surface, and mine was the very next line — while the eyebrow above
 * said API-EQUIVALENT and the provenance bar said list price a third time. The
 * star and the word "API" come out of the caveat; what stays is the one claim
 * nothing else on the sheet makes: this is not what you were billed.
 */
function UsageReadouts({
  summary,
  cold,
}: {
  summary: UsageSummaryView
  cold: boolean
}): JSX.Element {
  const cacheMultiple =
    summary.cacheSavingsMultiple === null
      ? null
      : summary.cacheSavingsMultiple.toFixed(1).replace(/\.0$/, '')
  const readings = [
    { label: 'Days ran', value: `${summary.activeDayCount} of 7`, ch: 4 },
    {
      label: 'Per active day',
      value: summary.costPerActiveDayUsd === null ? '—' : formatUsd(summary.costPerActiveDayUsd),
      ch: 5,
    },
    { label: 'Last 5 hours', value: formatUsd(summary.fiveHour.estCostUsd), ch: 5 },
  ]
  return (
    <div className="usage-summary">
      <div className="usage-masthead">
        <div className="usage-answer">
          <div className="usage-window-label">Last 7 days · API-equivalent</div>
          <div className="usage-window-value">
            {cold ? <Unfilled ch={6} /> : formatUsd(summary.week.estCostUsd)}
          </div>
        </div>
        <div className="usage-readings">
          {readings.map((reading) => (
            <div key={reading.label} className="usage-reading">
              <span className="usage-reading-label">{reading.label}</span>
              <span className="usage-reading-value">
                {cold ? <Unfilled ch={reading.ch} /> : reading.value}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="usage-window-caveat">
        at list price for the same tokens — not what you were billed
      </div>
      {(cold || summary.cacheSavingsUsd > 0) && (
        <div className="usage-cache-saving">
          {cold ? (
            <Unfilled ch={76} />
          ) : (
            <>
              Cache reads bill at 10% of input —{' '}
              <strong>{formatUsd(summary.cacheSavingsUsd)} less</strong> than the same tokens
              uncached{cacheMultiple === null ? '.' : `, ${cacheMultiple}x the week's whole bill.`}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const PROVIDER_LABEL: Record<UsageProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  other: 'Other',
}

/** Provider is the first useful grouping above individual model ids. */
function UsageProviders({
  summary,
  cold,
}: {
  summary: UsageSummaryView
  cold: boolean
}): JSX.Element {
  const totalCost = summary.providers.reduce((total, provider) => total + provider.estCostUsd, 0)
  const placeholders = [0, 1]

  return (
    <section className="usage-section usage-providers">
      <h3 className="usage-section-head">
        Where it went
        <span className="usage-section-hint">by provider</span>
      </h3>
      <div className="usage-provider-list">
        {cold
          ? placeholders.map((row) => (
              <div key={row} className="usage-provider-row">
                <span className="usage-provider-name">
                  <Unfilled ch={8} />
                </span>
                <ShareTrack pct={0} cold />
                <span className="usage-provider-cost">
                  <Unfilled ch={6} />
                </span>
                <span className="usage-provider-sub">
                  <Unfilled ch={34} />
                </span>
              </div>
            ))
          : summary.providers.map((provider) => {
              const pct = totalCost > 0 ? (provider.estCostUsd / totalCost) * 100 : 0
              return (
                <div key={provider.provider} className="usage-provider-row">
                  <span className="usage-provider-name">{PROVIDER_LABEL[provider.provider]}</span>
                  <ShareTrack pct={pct} cold={false} />
                  <span className="usage-provider-cost">{formatUsd(provider.estCostUsd)}</span>
                  <span className="usage-provider-sub">
                    {formatShare(provider.estCostUsd, totalCost)} of cost ·{' '}
                    {formatTokens(provider.totalTokens)} tokens · {formatCount(provider.messages)}{' '}
                    replies
                  </span>
                </div>
              )
            })}
      </div>
      {!cold && summary.providers.some((provider) => provider.provider === 'xai') && (
        <p className="usage-grok-note">Grok uses last session size, not each reply.</p>
      )}
    </section>
  )
}

/**
 * The week at hour resolution: seven equal day columns of 24 slots each.
 *
 * An hour that ran nothing draws NOTHING — the gap is the reading, and a
 * baseline stub in every empty slot would turn 104 quiet hours into a solid
 * floor the eye reads as data. An hour that ran a little draws a 1.5% minimum so
 * it cannot vanish into the axis. Hours still ahead of the clock are marked
 * separately from empty ones: today's tail has not happened, which is not the
 * same claim as nothing having run.
 */
function UsageTrace({
  summary,
  cold,
  arrived,
}: {
  summary: UsageSummaryView
  cold: boolean
  arrived: boolean
}): JSX.Element {
  const [measure, setMeasure] = useState<'cost' | 'tokens'>('cost')
  const valueOfHour = (hour: { totalTokens: number; estCostUsd: number }): number =>
    measure === 'cost' ? hour.estCostUsd : hour.totalTokens
  const valueOfDay = (day: { totalTokens: number; estCostUsd: number }): number =>
    measure === 'cost' ? day.estCostUsd : day.totalTokens
  const formatMeasure = measure === 'cost' ? formatUsd : formatTokens
  const formatMeasureTick = measure === 'cost' ? formatUsdTick : formatTick
  const peak = summary.days
    .flatMap((day) =>
      day.hours.map((hour) => ({ ...hour, day: day.label, value: valueOfHour(hour) })),
    )
    .reduce<{ value: number; startMs: number; day: string } | null>(
      (best, hour) => (hour.value > (best?.value ?? 0) ? hour : best),
      null,
    )
  const axisMax = niceAxisMax(peak?.value ?? 0)
  // Three lines, not five. A trace needs enough grid to read a value off and no
  // more; denser than this is chart junk competing with the data.
  const ticks = [0, axisMax / 2, axisMax]

  return (
    <figure className="usage-figure">
      <figcaption className="usage-figure-caption">
        <span className="usage-figure-title">
          {measure === 'cost' ? 'Cost per hour' : 'Tokens per hour'}
        </span>
        <fieldset className="usage-measure-toggle" aria-label="Trace measure">
          <button
            type="button"
            className="usage-measure-button"
            data-pressable
            data-active={measure === 'cost' || undefined}
            aria-pressed={measure === 'cost'}
            onClick={() => setMeasure('cost')}
          >
            Cost
          </button>
          <button
            type="button"
            className="usage-measure-button"
            data-pressable
            data-active={measure === 'tokens' || undefined}
            aria-pressed={measure === 'tokens'}
            onClick={() => setMeasure('tokens')}
          >
            Tokens
          </button>
        </fieldset>
        {/* The peak reads out beside the caption rather than as a label pinned
            over its own column: at 168 columns a direct label is 6px wide and
            collides with its neighbours the moment the busiest hour is not at
            the edge. */}
        <span className="usage-figure-peak">
          {cold ? (
            <Unfilled ch={16} />
          ) : peak && peak.value > 0 ? (
            <>
              peak {formatMeasure(peak.value)} · {peak.day} {formatHour(peak.startMs)}
            </>
          ) : null}
        </span>
      </figcaption>
      <div className="usage-plot">
        {/* The scale. aria-hidden because the model table below carries the same
            numbers to a screen reader in a form it can actually read. */}
        <div className="usage-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="usage-axis-tick" style={{ bottom: `${(t / axisMax) * 100}%` }}>
              {/* The gridlines are geometry and hold from the first frame; the
                  numbers ON them are not known until the peak is, and an axis
                  labelled off an empty dataset would read 1 / 0.5 / 0. */}
              {cold ? <Unfilled ch={3.5} /> : formatMeasureTick(t)}
            </span>
          ))}
        </div>
        <div className="usage-trace">
          {ticks.map((t) => (
            <span
              key={t}
              className="usage-gridline"
              style={{ bottom: `${(t / axisMax) * 100}%` }}
              aria-hidden="true"
            />
          ))}
          {summary.days.map((day, di) => (
            <div key={day.day} className="usage-trace-day">
              {day.hours.map((h) => {
                const value = valueOfHour(h)
                if (h.future) return <span key={h.startMs} className="usage-hour" data-future />
                if (value === 0) return <span key={h.startMs} className="usage-hour" />
                return (
                  <span
                    key={h.startMs}
                    className="usage-hour"
                    data-on=""
                    style={
                      {
                        // The bar is the column's ::after, so its height and its
                        // stagger arrive as custom properties rather than as
                        // inline height — a pseudo-element cannot be styled
                        // inline, and the full-height column is what makes a
                        // 4px-wide mark hoverable.
                        '--h': `${Math.max(1.5, (value / axisMax) * 100)}%`,
                        // The sweep runs left to right, the way the axis is read,
                        // one step per DAY rather than per hour: 168 staggered
                        // columns would take three seconds to finish, and a chart
                        // still assembling itself after the numbers are readable
                        // is choreography, not an answer arriving.
                        '--delay': arrived ? `${di * 45}ms` : '0ms',
                      } as CSSProperties
                    }
                    title={`${day.label} ${formatHour(h.startMs)} · ${formatTokens(h.totalTokens)} tokens · ${formatUsd(h.estCostUsd)}`}
                  />
                )
              })}
            </div>
          ))}
        </div>
        <div className="usage-trace-days" aria-hidden="true">
          {summary.days.map((day) => (
            <div key={day.day} className="usage-trace-day-label">
              <span className="usage-day-name">{day.label}</span>
              {/* The day total, kept from the chart this replaced: the trace
                  shows the shape of a day, and this is the one number about it
                  the shape cannot be read off precisely. */}
              <span className="usage-day-total">
                {cold ? (
                  <Unfilled ch={4} />
                ) : valueOfDay(day) > 0 ? (
                  formatMeasure(valueOfDay(day))
                ) : (
                  '—'
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </figure>
  )
}

/**
 * Where the tokens went, and where the MONEY went — the same four billing
 * classes measured twice, as two small multiples on one 0–100% scale.
 *
 * This is the sheet's one genuinely non-obvious reading, and it only exists as a
 * comparison: cache reads are the overwhelming majority of an agent fleet's
 * tokens and a much smaller share of its bill, while output is a rounding error
 * in tokens and a large share of the cost. One stacked rail would have said none
 * of that — at these proportions three of its four segments are slivers.
 *
 * THE ROWS ARE ORDERED BY WHAT A TOKEN IN THEM COSTS (POD-755) — cheapest first,
 * measured, so the third column always reads down the page as a ramp. Sorted by
 * token share it read 0.7x / 9.1x / 6.8x / 38x, and a column of multiples that
 * nearly ramps and then doesn't is the one thing on this surface a reader has to
 * stop and re-check. It is the measured ratio rather than `TOKEN_CLASSES`' own
 * list-price ramp because a provider that does not bill for cache writes at all
 * inverts a tier, and an order that is true of the price list but not of the
 * numbers beside it is no better than no order.
 */
function UsageComposition({
  summary,
  cold,
}: {
  summary: UsageSummaryView
  cold: boolean
}): JSX.Element {
  const totalTokens = summary.composition.reduce((n, c) => n + c.tokens, 0)
  const totalCost = summary.composition.reduce((n, c) => n + c.estCostUsd, 0)
  // A class with no tokens has no ratio, and no claim to a place on the ramp: it
  // sorts to the end rather than to the cheap end, where a `null` read as zero
  // would put it.
  const rows = [...summary.composition].sort(
    (a, b) => (a.costWeightRatio ?? Infinity) - (b.costWeightRatio ?? Infinity),
  )

  return (
    <section className="usage-section">
      <h3 className="usage-section-head">
        Composition
        <span className="usage-section-hint">share of the 7-day window</span>
      </h3>
      <div className="usage-comp">
        <div className="usage-comp-head" aria-hidden="true">
          <span />
          <span className="usage-comp-col">tokens</span>
          <span className="usage-comp-col">cost</span>
          <span className="usage-comp-col usage-comp-ratio-head">cost per token</span>
        </div>
        {rows.map((c) => (
          <div key={c.key} className="usage-comp-row">
            <span className="usage-comp-name">{c.label}</span>
            <CompCell part={c.tokens} whole={totalTokens} cold={cold} />
            <CompCell part={c.estCostUsd} whole={totalCost} cold={cold} />
            {/* "0.7x its weight" left the multiple without a referent under a
                heading that names a price — x what? The quotient is this class's
                per-token cost over the window's blended one, so the cell says
                so. Above average takes Strong ink and below it stays Muted: the
                deviation is the reading, and it is an ink step rather than the
                attention hue, which The Signal Rule reserves for what is asking
                something of the operator. Three of four rows lit gold made a
                token price look like a decision waiting on you. */}
            <span
              className="usage-comp-ratio"
              data-heavy={
                !cold && c.costWeightRatio !== null && c.costWeightRatio > 1 ? '' : undefined
              }
            >
              {cold ? (
                <Unfilled ch={10} />
              ) : c.costWeightRatio === null ? (
                '—'
              ) : (
                <>
                  {formatCostWeightRatio(c.costWeightRatio)} <span>average</span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** One share: a bar on a 0–100% scale and the number it draws. */
function CompCell({
  part,
  whole,
  cold,
}: {
  part: number
  whole: number
  cold: boolean
}): JSX.Element {
  const pct = whole > 0 ? (part / whole) * 100 : 0
  return (
    <span className="usage-comp-cell">
      <ShareTrack pct={pct} cold={cold} />
      <span className="usage-comp-pct">
        {cold ? <Unfilled ch={4} /> : formatShare(part, whole)}
      </span>
    </span>
  )
}

/**
 * One share on a 0–100% scale.
 *
 * NO PERCENTAGE FLOOR (POD-755). A `Math.max(0.6, pct)` minimum drew 0.3% and
 * 0.7% at exactly the same length — two different readings as one mark — and
 * 0.6% of a 570px track is 3.4px, which under the rail's own 2.5px radius is a
 * circle: the token column of a cache-heavy week came out as one long bar and
 * three specks of dirt. The floor is now 2px of CSS `min-width` on the fill, so a
 * sliver keeps its true length wherever it has one and the tiniest marks still
 * differ from each other. The fill's radius tightens with it — a mark this short
 * has to read as a tick, and a pill that narrow reads as a bead.
 */
function ShareTrack({ pct, cold }: { pct: number; cold: boolean }): JSX.Element {
  return (
    <span className="usage-comp-track">
      {!cold && pct > 0 && <span className="usage-comp-fill" style={{ width: `${pct}%` }} />}
    </span>
  )
}

/**
 * The model ranking, sorted by cost — the measure the sheet leads with. The
 * share rail is of COST for the same reason: a rail measuring one thing under a
 * column ordered by another is two answers to one question.
 */
function UsageModels({ summary, cold }: { summary: UsageSummaryView; cold: boolean }): JSX.Element {
  const topCost = Math.max(0, ...summary.models.map((m) => m.estCostUsd))
  // Three rows: the table is the one region whose LENGTH is genuinely unknown
  // before the answer, and holding a plausible few keeps the sheet from growing
  // under the pointer.
  const placeholders = [0, 1, 2]

  return (
    <section className="usage-section">
      <h3 className="usage-section-head">
        By model
        <span className="usage-section-hint">7 days, ranked by cost</span>
      </h3>
      <div className="usage-table-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col" className="usage-th-model">
                Model
              </th>
              <th scope="col" className="usage-th-provider">
                Provider
              </th>
              {/* The rail's header is blank on purpose: it is the same measure
                  as the API-equivalent column, drawn instead of written. */}
              <th scope="col" />
              <th scope="col" className="usage-th-num">
                Tokens
              </th>
              <th scope="col" className="usage-th-num">
                Replies
              </th>
              <th scope="col" className="usage-th-num">
                API-equivalent
              </th>
            </tr>
          </thead>
          <tbody>
            {cold
              ? placeholders.map((r) => (
                  <tr key={r}>
                    <td>
                      <Unfilled ch={14} />
                    </td>
                    <td className="usage-th-provider">
                      <Unfilled ch={7} />
                    </td>
                    <td className="usage-td-share">
                      <span className="usage-share-track" />
                    </td>
                    <td className="usage-th-num">
                      <Unfilled ch={5} />
                    </td>
                    <td className="usage-th-num">
                      <Unfilled ch={5} />
                    </td>
                    <td className="usage-th-num">
                      <Unfilled ch={6} />
                    </td>
                  </tr>
                ))
              : summary.models.map((m) => (
                  <tr key={m.model}>
                    <td className="usage-td-model">{m.model}</td>
                    <td className="usage-th-provider usage-td-provider">
                      {PROVIDER_LABEL[m.provider]}
                    </td>
                    <td className="usage-td-share">
                      <span className="usage-share-track">
                        <span
                          className="usage-share-fill"
                          style={{
                            width: `${topCost > 0 ? (m.estCostUsd / topCost) * 100 : 0}%`,
                          }}
                        />
                      </span>
                    </td>
                    <td className="usage-th-num">{formatTokens(m.totalTokens)}</td>
                    <td className="usage-th-num">{formatCount(m.messages)}</td>
                    <td className="usage-th-num usage-td-cost">{formatUsd(m.estCostUsd)}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * A reading that has not come in yet: an unfilled slot — a rule sitting on the
 * baseline the digits will sit on. Not a soft grey block, which is a shape
 * standing in for content and belongs to a different kind of product; and not a
 * `0` or an `—`, both of which are claims about the number.
 */
