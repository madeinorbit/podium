import {
  formatWindowDuration,
  type QuotaLedgerColumn,
  type QuotaLedgerStrip,
  type QuotaLedgerView,
} from '@podium/client-core/viewmodels'
import type { JSX, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Unfilled } from './Unfilled'
import type { QuotaLedgerFeed } from './useQuotaLedger'

/**
 * THE RESET LEDGER — how much of each weekly pool was spent before it reset.
 *
 * EVERY COLUMN IS A GROOVE, NOT A BAR. The token trace above has no ceiling, so
 * its bars float against an axis. A quota window has a real one — 100% — which
 * means each column can be drawn full height and filled partway, and the EMPTY
 * part is capacity that was paid for and never used. The negative space is the
 * whole message, and it needs no colour to carry it.
 *
 * ONE HUE THROUGHOUT. Identity comes from small multiples — one strip per pool,
 * direct-labelled with the two-letter mark the shell already uses — because
 * Podium has no `--codex` or `--grok` token by design, and because three series
 * of different cadence overlaid in one plot would be unreadable in any palette.
 *
 * AND NO TONE RAMP. The live meter escalates to amber at 75% and red past 90%,
 * where near-full means "about to be cut off". Here the meaning inverts: a
 * window that ended at 95% is the best outcome there is. Reusing that ramp would
 * tell the reader the exact opposite of the truth, so the only reference mark is
 * a hairline at 85% for "well used".
 *
 * COLUMNS ARE WIDTH-CAPPED rather than stretched to fill. A pool with two weeks
 * of history should read as two weeks with room to grow, not as a full chart.
 */

/** Where the "well used" hairline sits. Above it, a window earned its keep. */
const TARGET_PERCENT = 85

/** Days a column is drawn as when the provider reported no duration. See below. */
const UNKNOWN_DAYS = 7

/**
 * THE HOVER CARD FOR ONE WINDOW.
 *
 * This was a `title` attribute holding six facts joined by middots, which is
 * roughly the worst way to present them: the browser chrome renders it in the OS
 * font after a delay it owns, with no structure, so `28% of plan spent · joined
 * mid-window — start not observed · still running` arrived as one unpunctuated
 * line and the reader had to parse it. The facts have shape — a period, a
 * number, and up to two caveats about how much to trust it — and the card gives
 * each of them its own place.
 *
 * THE CAVEATS ARE SENTENCES, not tags. `joined mid-window` names a condition
 * without saying what follows from it; the reader's actual question is whether
 * the number above can be believed, so the note answers that instead.
 */
function ColumnTooltip({
  column,
  children,
}: {
  column: QuotaLedgerColumn
  children: ReactNode
}): JSX.Element {
  const percent = Math.max(0, Math.min(100, column.peakPercent))
  const days = column.durationDays
  return (
    <Tooltip>
      <TooltipTrigger render={children as JSX.Element} />
      <TooltipContent
        side="top"
        className="max-w-64 flex-col items-stretch gap-0 px-2.5 py-2 text-left"
      >
        <span className="quota-tip">
          <b className="quota-tip-span">{column.spanLabel}</b>
          <span className="quota-tip-figure">
            <em>{percent.toFixed(0)}%</em>
            <span>of the plan spent</span>
            {/* The unspent half of the same fact. It is the reason the figure
                exists, and it is only a settled number once the window has reset. */}
            {column.closed && percent < 100 ? (
              <i>{(100 - percent).toFixed(0)}% went unused</i>
            ) : null}
          </span>
          {/* A two-column grid of label/value pairs, so the pairs are laid out as
              siblings rather than wrapped — a wrapper would need `display:
              contents` to get out of the grid's way, and that drops its text
              nodes into anonymous boxes. */}
          <span className="quota-tip-rows">
            <b>Ran for</b>
            <span>{days === undefined ? 'not reported' : formatWindowDuration(days)}</span>
            {column.plan ? (
              <>
                <b>Plan</b>
                <span>{column.plan}</span>
              </>
            ) : null}
            <b>State</b>
            <span>{column.closed ? 'reset' : 'still running'}</span>
          </span>
          {column.partial ? (
            <span className="quota-tip-note">
              Sampling started after this window opened, so its peak may understate what was really
              spent.
            </span>
          ) : null}
          {column.planBreak ? (
            <span className="quota-tip-note">
              The plan changed here — the pool is a different size, so this column and the one
              before it are not comparable.
            </span>
          ) : null}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

function Column({ column }: { column: QuotaLedgerColumn }): JSX.Element {
  const percent = Math.max(0, Math.min(100, column.peakPercent))
  const days = column.durationDays
  return (
    <ColumnTooltip column={column}>
      <span
        className="quota-groove"
        data-partial={column.partial || undefined}
        data-now={column.closed ? undefined : true}
        data-plan-break={column.planBreak || undefined}
        // WIDTH IS THE WINDOW'S LENGTH, linearly: seven days is drawn seven times
        // one day. `--days` feeds a flex-basis, so the ratio survives the strip
        // being squeezed — flex shrinks in proportion to basis.
        //
        // A window with no observed or reported duration gets the nominal week
        // and says so through `data-unknown-length`, rather than defaulting to
        // something short and inventing a fact the history never gave us.
        data-unknown-length={days === undefined || undefined}
        style={{ '--days': days ?? UNKNOWN_DAYS } as React.CSSProperties}
      >
        {/* A 1.5% floor so a window that was barely touched still shows a mark
            rather than reading as "no data" — the two are different facts. */}
        <i style={{ '--u': `${Math.max(1.5, percent)}%` } as React.CSSProperties} />
      </span>
    </ColumnTooltip>
  )
}

/**
 * One masthead reading, with the three states kept distinct.
 *
 * `Unfilled` means NOT YET — the read is still in flight — and is reserved for
 * exactly that. A ledger that has loaded and holds no completed window is a
 * different fact: the answer is known, and it is nil. Showing a pending rule for
 * it would claim a number is coming when none is, and showing `0%` would claim
 * the pools were used and came to nothing. So a loaded nil reads as a dash.
 */
function Reading({
  label,
  ch,
  loaded,
  value,
}: {
  label: string
  ch: number
  loaded: boolean
  value: string | number | undefined
}): JSX.Element {
  return (
    <div className="quota-reading">
      <span className="usage-reading-label">{label}</span>
      <span className="usage-reading-value">
        {value !== undefined ? (
          value
        ) : loaded ? (
          <Tooltip>
            <TooltipTrigger render={<span>–</span>} />
            <TooltipContent side="top">No window has completed yet</TooltipContent>
          </Tooltip>
        ) : (
          <Unfilled ch={ch} />
        )}
      </span>
    </div>
  )
}

function Strip({ strip }: { strip: QuotaLedgerStrip }): JSX.Element {
  return (
    <div className="quota-pool">
      <div className="quota-pool-head">
        <span className="quota-mark">{strip.mark}</span>
        <span className="quota-pool-name">{strip.agentLabel}</span>
        {/* Nothing at all when too few windows have closed to know the rhythm —
            a hedge would still be a claim. */}
        {strip.windowLabel && <span className="quota-pool-window">{strip.windowLabel}</span>}
        <span className="quota-pool-stat">
          {strip.completedCount === 0
            ? 'no completed window yet'
            : `${strip.completedCount} window${strip.completedCount === 1 ? '' : 's'} · avg ${Math.round(strip.averagePeak ?? 0)}%`}
        </span>
      </div>
      <div className="quota-strip">
        <div className="quota-axis" aria-hidden="true">
          <span style={{ bottom: '100%' }}>100</span>
          <span style={{ bottom: '50%' }}>50</span>
          <span style={{ bottom: 0 }}>0</span>
        </div>
        <div className="quota-plot">
          <span className="quota-gridline" style={{ bottom: '100%' }} />
          <span className="quota-gridline" data-target style={{ bottom: `${TARGET_PERCENT}%` }} />
          <span className="quota-gridline" style={{ bottom: '50%' }} />
          {strip.columns.map((column) => (
            <Column key={`${column.windowKey}:${column.resetsAt}`} column={column} />
          ))}
        </div>
        <div className="quota-strip-days">
          {strip.columns.map((column) => (
            // The date track carries the same card as the column above it: the
            // container query below hides the text on a narrow column, and a
            // label that has vanished is exactly when someone reaches for it.
            <ColumnTooltip key={`${column.windowKey}:${column.resetsAt}`} column={column}>
              <span
                // The label track mirrors the plot's flex basis exactly, or the
                // dates stop sitting under the columns they name.
                style={{ '--days': column.durationDays ?? UNKNOWN_DAYS } as React.CSSProperties}
              >
                {/* Inner element so the container query below can hide the text on a
                    column too narrow to hold it. */}
                <b>{column.endLabel}</b>
              </span>
            </ColumnTooltip>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * The cold and empty states are the same shape as the filled one, deliberately:
 * the sheet's grammar is that nothing resizes on arrival, so the region holds its
 * own axis and gridlines while the readings are missing.
 *
 * "Empty" here is not a failure and does not read as one. Quota history has to be
 * collected — nothing on this path was ever written down before — so an empty
 * ledger means the sampler has not seen a pool reset yet, which is a fact about
 * elapsed time rather than a fault.
 */
export function QuotaLedger({
  ledger,
  cold,
  feed,
}: {
  ledger: QuotaLedgerView | null
  cold: boolean
  feed?: Pick<QuotaLedgerFeed, 'failed' | 'retry'>
}): JSX.Element {
  const strips = ledger?.strips ?? []
  // A read that keeps failing is not a read that is still arriving. Without this,
  // "Reading the window ledger…" sits there forever with no error and no way to
  // retry — the one state the trace beside it handles and this did not.
  const unreachable = ledger === null && feed?.failed === true
  return (
    <figure className="usage-figure quota-ledger">
      <figcaption className="usage-figure-caption">
        <span className="usage-figure-title">Capacity spent per reset</span>
        <span className="usage-figure-aside">
          {ledger?.bestPeak !== undefined && ledger.bestLabel
            ? `best ${Math.round(ledger.bestPeak)}% · ${ledger.bestLabel}`
            : cold
              ? null
              : 'weekly pools'}
        </span>
      </figcaption>

      <div className="quota-readings">
        <Reading label="Windows" ch={2} loaded={ledger !== null} value={ledger?.completedCount} />
        <Reading
          label="Avg spent"
          ch={3}
          loaded={ledger !== null}
          value={
            ledger?.averagePeak === undefined ? undefined : `${Math.round(ledger.averagePeak)}%`
          }
        />
        <Reading
          label="Left unused"
          ch={6}
          loaded={ledger !== null}
          value={
            ledger?.unusedWindows === undefined
              ? undefined
              : `${ledger.unusedWindows.toFixed(1)} weeks`
          }
        />
      </div>

      {unreachable ? (
        <p className="quota-empty">
          Couldn't read the window ledger.{' '}
          {feed?.retry ? (
            <button data-pressable type="button" className="usage-retry" onClick={feed.retry}>
              Try again
            </button>
          ) : null}
        </p>
      ) : strips.length === 0 ? (
        <p className="quota-empty">
          {cold
            ? 'Reading the window ledger…'
            : 'No pool has reset yet. Each weekly window becomes a column here once it rolls over.'}
        </p>
      ) : (
        strips.map((strip) => <Strip key={strip.key} strip={strip} />)
      )}

      {strips.length > 0 && (
        <div className="quota-legend">
          <span className="quota-legend-item">
            <span className="quota-swatch" data-k="track" />
            Capacity you paid for
          </span>
          <span className="quota-legend-item">
            <span className="quota-swatch" data-k="used" />
            Spent before reset
          </span>
          <span className="quota-legend-item">
            <span className="quota-swatch" data-k="now" />
            Window still running
          </span>
          <span className="quota-legend-item">
            <span className="quota-swatch" data-k="partial" />
            Start not observed
          </span>
        </div>
      )}
    </figure>
  )
}
