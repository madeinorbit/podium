/**
 * HOW A COST FIGURE IS WORDED (POD-1859).
 *
 * `client-core/viewmodels/cost.ts` deliberately stops at arithmetic — its header
 * says so, and the reason is that a viewmodel which pre-rendered the words would
 * put the same sentence in four surfaces. This is the other half: the rounding
 * and the phrasing, in ONE module, so the panel and the task-detail page cannot
 * quote the same task two ways.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO PRECISIONS, AND THE DIFFERENCE IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * {@link approxUsd} is for a figure the reader is meant to take as a MAGNITUDE —
 * the rollup headline, a session's share, the roster's meta line. It carries `≈`
 * and it never prints cents above $10, because "$225.81" invites arithmetic on a
 * number that is an estimate off a public price list: two decimal places are a
 * claim to the cent that this feature cannot make.
 *
 * {@link exactUsd} is for a figure that has to ADD UP on screen — the two halves
 * of the rollup split, the per-model rows. Those sit next to each other and a
 * reader will check them against the whole, so they are printed as they are,
 * without `≈`. The headline above them is the rounded reading of the same money;
 * that is a rounding, not a disagreement.
 */

import type { CostHarness } from '@podium/model/browser'

/** Above this, cents are noise on an estimate. Below it, they are the figure. */
const CENTS_BELOW_USD = 10

/** Three significant figures start mattering here — "$1,234" over-reads. */
const SIGNIFICANT_FROM_USD = 1000

/**
 * "≈$226", "≈$4.80" — a magnitude, three significant figures, cents only under
 * ten dollars.
 *
 * The `≈` is not decoration: every figure in this feature is API-equivalent cost
 * at list price, and the mark is the shortest possible restatement of the hedge
 * line for a figure that has travelled away from it (a session row, the roster's
 * meta). Zero is NEVER reached through this function by a cold state — the four
 * states are words, not numbers — so a `$0` here is a real, counted zero.
 */
export function approxUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '≈$0'
  if (usd >= SIGNIFICANT_FROM_USD) {
    // 12,345 → 12,300. Round at the third digit rather than truncating to it, so
    // the figure stays the nearest reading rather than always the low one.
    const factor = 10 ** (Math.floor(Math.log10(usd)) - 2)
    const rounded = Math.round(usd / factor) * factor
    return `≈$${rounded.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }
  if (usd >= CENTS_BELOW_USD) return `≈$${Math.round(usd).toLocaleString('en-US')}`
  return `≈$${usd.toFixed(2)}`
}

/**
 * "$225.81", "$0" — a component figure, printed so it can be checked against the
 * others beside it.
 *
 * Bare `$0` rather than `$0.00` for the one place a zero is honest: a parent
 * whose whole figure is its children's spent nothing itself, and the split
 * legend has to say so. `$0.00` there reads as a measurement to the cent of
 * nothing, which is two decimal places of false precision about an absence.
 */
export function exactUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * "2.3× median" — this task's cost per reply against the cohort's.
 *
 * The multiple is NOT computed here. Both surfaces read `rateVsMedian` off the
 * one viewmodel, which builds it from the ROLLUP cost over the ROLLUP replies so
 * that it matches the headline standing beside it. A surface that divided its
 * own two numbers is exactly how the same task came to read 1.97× in the panel
 * and 2.51× in the sheet.
 */
export function rateLabel(rateVsMedian: number): string {
  return `${rateVsMedian.toFixed(1)}× median`
}

/** Harness → the name a person would use for it. */
const HARNESS_NAME: Record<CostHarness, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  grok: 'Grok',
}

/**
 * "≥ floor · all Codex" — the figure is a LOWER BOUND, and why.
 *
 * The mark keys off harness and nothing else: every Claude transcript that
 * carries usage has a segment row, and a good share of Codex rollouts have none,
 * so any non-Claude participation makes the total a floor.
 *
 * THE HARNESSES ARE NAMED, NEVER ASSUMED. "all Codex" over a task that also ran
 * Grok is a lie told confidently, and POD-1484 really does read `[codex, grok]`.
 * One harness gets "all X"; several get them joined, in the alphabetical order
 * the wire sends.
 */
export function floorLabel(harnesses: readonly CostHarness[]): string {
  if (harnesses.length === 0) return '≥ floor'
  const named = harnesses.map((h) => HARNESS_NAME[h])
  return `≥ floor · ${named.length === 1 ? `all ${named[0]}` : named.join(' + ')}`
}

/**
 * "≈$226 over 10" — the fact the ROSTER is missing, in `DockPart`'s meta slot.
 *
 * The roster lists open sessions, which on a finished task is none of them. This
 * one line is what stops it lying by omission: it shows two agents and says
 * there were ten. Both halves are the ROLLUP's, matching the Cost section's own
 * headline directly below rather than counting a different set of sessions.
 */
export function rosterCostMeta(rollupUsd: number, rollupSessionCount: number): string | undefined {
  if (rollupSessionCount <= 0) return undefined
  return `${approxUsd(rollupUsd)} over ${rollupSessionCount}`
}
