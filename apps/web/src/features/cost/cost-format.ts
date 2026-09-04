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
 * NOTHING HERE ROUNDS OR NAMES A HARNESS ITSELF. Every function below delegates
 * to `client-core/viewmodels`, which the coordinator made binding for all four
 * cost surfaces: `formatCostRounded`, `formatCostExact`, `costHarnessLabel` and
 * the sheet's own `formatCostWeightRatio`. A second implementation of the same
 * rounding is how one task comes to read two prices — the defect this feature
 * exists to make impossible. What stays here is the WORDING this surface adds
 * around those figures, and nothing else.
 *
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

import {
  costHarnessLabel,
  formatCostExact,
  formatCostRounded,
  formatCostWeightRatio,
} from '@podium/client-core/viewmodels'
import type { CostHarness } from '@podium/model/browser'

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
  // The nil case is this surface's, not the formatter's: a session that cost
  // nothing still occupies a row here, and `≈$0` is the reading for it.
  if (!Number.isFinite(usd) || usd <= 0) return '≈$0'
  return `≈${formatCostRounded(usd)}`
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
  return formatCostExact(usd)
}

/**
 * "2.3x median" — this task's cost per reply against the cohort's.
 *
 * The multiple is NOT computed here, and it is NOT formatted here either. Both
 * surfaces read `rateVsMedian` off the one viewmodel, which builds it from the
 * ROLLUP cost over the ROLLUP replies so that it matches the headline standing
 * beside it. A surface that divided its own two numbers is exactly how the same
 * task came to read 1.97x in the panel and 2.51x in the sheet.
 *
 * The digits come from the sheet's own `formatCostWeightRatio`, which the
 * composition ramp has printed for as long as this sheet has existed. Spelling
 * the same multiple `2.3×` here and `2.3x` two surfaces away is a smaller lie
 * than a wrong number and still a reason for a reader to wonder whether the two
 * readings are the same reading.
 */
export function rateLabel(rateVsMedian: number): string {
  return `${formatCostWeightRatio(rateVsMedian)} median`
}

/**
 * "≥ floor · all Codex" — the figure is a LOWER BOUND, and why.
 *
 * TWO REASONS, AND THEY DO NOT READ ALIKE. A figure is a floor because some of
 * it ran on a harness whose rollouts are not all linked (every Claude transcript
 * that carries usage has a segment row; a good share of Codex ones have none),
 * or because sessions in scope have never been harvested at all. "may be
 * undercounted" and "most of this has not been counted yet" are different facts
 * to an operator, so both are named and neither stands in for the other.
 *
 * THE HARNESSES ARE NAMED, NEVER ASSUMED. "all Codex" over a task that also ran
 * Grok is a lie told confidently, and POD-1484 really does read `[codex, grok]`.
 * One harness gets "all X"; several get them joined, in the alphabetical order
 * the wire sends.
 */
export function floorLabel(
  harnesses: readonly CostHarness[],
  /** Sessions in scope with no cost row yet — `TaskCostView.uncostedSessionCount`. */
  uncostedSessionCount = 0,
): string {
  const parts: string[] = []
  // A wholly-Claude task now reaches this label (its floor can come from the
  // unread count alone) and "all Claude" would state a reason that is never
  // true, so the harness clause is drawn only when a non-Claude harness ran.
  const named = harnesses.some((h) => h !== 'claude-code') ? costHarnessLabel(harnesses) : ''
  if (named !== '') parts.push(named)
  if (uncostedSessionCount > 0)
    parts.push(`${uncostedSessionCount} session${uncostedSessionCount === 1 ? '' : 's'} unread`)
  return parts.length === 0 ? '≥ floor' : `≥ floor · ${parts.join(' · ')}`
}

/**
 * "≈$226 across 10 sessions" — the fact the ROSTER is missing, in `DockPart`'s
 * meta slot.
 *
 * The roster lists open sessions, which on a finished task is none of them. This
 * one line is what stops it lying by omission: it shows two agents and says
 * there were ten.
 *
 * IT SAYS ITS OWN SCOPE, which the first draft did not. "≈$226 over 10" sat
 * directly above a disclosure reading "6 sessions" and listing six — two numbers
 * visible at once that no reader could reconcile without knowing the schema,
 * which is the same lie the line was added to prevent, pointing the other way.
 * Both halves are the ROLLUP's, matching the Cost section's headline below; the
 * own count is named separately when there are descendants, so the reader can
 * chain "38 sessions, 6 on this task" to the fold's "2 of 6" by reading.
 */
export function rosterCostMeta(
  rollupUsd: number,
  rollupSessionCount: number,
  ownSessionCount?: number,
): string | undefined {
  if (rollupSessionCount <= 0) return undefined
  const noun = `${rollupSessionCount} session${rollupSessionCount === 1 ? '' : 's'}`
  // Only when the two counts actually differ: "10 sessions, 10 on this task"
  // spends a whole clause restating the number beside it.
  if (ownSessionCount === undefined || ownSessionCount === rollupSessionCount) {
    return `${approxUsd(rollupUsd)} across ${noun}`
  }
  // TERSER WHEN IT CARRIES BOTH, because this string shares a 340px head row
  // with a section title and its rule, and `DockPart` gives it no room to wrap:
  // the long form ("… across 38 sessions, 6 on this task") rendered as "6 on
  // thi…", which relates the two counts by truncating one of them. `6 own`
  // chains to the fold's own "2 of 6" and fits.
  return `${approxUsd(rollupUsd)} · ${noun}, ${ownSessionCount} own`
}
