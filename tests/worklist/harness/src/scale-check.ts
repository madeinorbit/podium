/**
 * POD-4746 — THE work-per-change check: the work a change does does not grow
 * with the amount of data.
 *
 * Every fence scenario (`fence-scenarios.ts`, #1–#10) runs at 1x and at 4x
 * (`buildCorpus`: every collection ×4, the same repos and groups), and each
 * step's work is counted from outside the arm (`CountResult.work`): rows read,
 * derivation bodies run, distinct collection elements iterated. The bound is
 * the changed items' neighbourhood at 4x (`neighbourhood.ts`: their families,
 * and the groups a moved row leaves and enters), read off the corpus for that
 * step's own targets. For each scenario and each count:
 *
 *     count at 4x − count at 1x ≤ neighbourhood at 4x
 *
 * So a change may cost the same at both scales, or more by at most one unit
 * per member of what it changed. Rows and elements are DISTINCT counts (a row
 * read twice, a family walked by a roll-up, a sort and a filter, count once),
 * so a correct store's several passes over what it changed stay inside the
 * bound; the 1x and 4x targets are different rows with different families,
 * which is what the neighbourhood term absorbs. A family roll-up or a scan of
 * the lane a row lands in passes; a walk of the issue table, a re-sort of the
 * whole list or a copy of a corpus-sized bucket does not (a corpus walk grows
 * by three times its 1x size). No per-scenario number is typed in. A failing
 * elements count names the derivations whose walks grew (`elementsBy`).
 *
 * A KNOWN VIOLATION is a named allowance (`RosterAllowances.work`), SIZED
 * (POD-4825): each step names either the derivations whose walks may grow
 * (`parts`, `elements` only) or the most its count may exceed the bound by
 * (`excess`). A step covers a failing verdict only inside that size: with
 * `parts`, every OTHER part must grow by at most the neighbourhood on its
 * own, so a new walk in another derivation still fails; with `excess`, the
 * count must not exceed the bound by more. `applyWorkAllowances` is the one
 * place they are applied.
 *
 * It replaces the fixed per-scenario reads budgets (POD-4557/POD-4609) and
 * G3's wall-clock slope budget. Walls stay a measurement (L5b), not a gate
 * on this question.
 */

import type { CountResult, WorkCell } from './count-harness'
import type { FenceStep } from './fence-scenarios'

export const WORK_KINDS = ['rows', 'derivations', 'elements'] as const
export type WorkKind = (typeof WORK_KINDS)[number]

/** One scenario's work at one scale. */
export interface ScaleCell {
  methodology: string
  scenario: string
  work: WorkCell
  /** Members of the changed items' neighbourhood at this scale. */
  neighbourhood: number
  /** Changed issues that moved in the list (their groups are in the neighbourhood). */
  moved: readonly string[]
}

/** One scenario and one count, compared across the scales. */
export interface ScaleVerdict {
  methodology: string
  scenario: string
  kind: WorkKind
  /**
   * For `elements`: the derivations (or the arm's own code) whose distinct
   * elements grew most, `[part, at 1x, at 4x]`, largest growth first (at most
   * four): where a failing count comes from. Empty for the other kinds.
   */
  parts: [string, number, number][]
  /**
   * POD-4825 — for `elements`: every part whose distinct elements grew, and
   * by how much (4x − 1x). Empty for the other kinds.
   */
  growthBy: Record<string, number>
  at1x: number
  at4x: number
  neighbourhood1x: number
  neighbourhood4x: number
  /** Growth beyond the bound: `at4x − at1x − neighbourhood4x`; > 0 fails. */
  excess: number
}

/** A step's cell, refusing a step that counted no work (a mount without `work`). */
export function scaleCell(step: FenceStep): ScaleCell {
  const { result, neighbourhood } = step
  if (result.work === null || neighbourhood === null) {
    throw new Error(
      `[scale] ${result.methodology} ${result.scenario}: no work cell — mount the arm with { work: true }`,
    )
  }
  return {
    methodology: result.methodology,
    scenario: result.scenario,
    work: result.work,
    neighbourhood: neighbourhood.members.size,
    moved: neighbourhood.moved,
  }
}

/** The parts whose distinct elements grew most from 1x to 4x (at most four). */
function grownParts(one: WorkCell, four: WorkCell): [string, number, number][] {
  const parts = [...new Set([...Object.keys(one.elementsBy), ...Object.keys(four.elementsBy)])]
  return parts
    .map((part): [string, number, number] => [
      part,
      one.elementsBy[part] ?? 0,
      four.elementsBy[part] ?? 0,
    ])
    .filter(([, a, b]) => b > a)
    .sort((x, y) => y[2] - y[1] - (x[2] - x[1]))
    .slice(0, 4)
}

/** Every part whose distinct elements grew from 1x to 4x, by how much. */
function growthByPart(one: WorkCell, four: WorkCell): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [part, at4x] of Object.entries(four.elementsBy)) {
    const growth = at4x - (one.elementsBy[part] ?? 0)
    if (growth > 0) out[part] = growth
  }
  return out
}

/** Compare the same scenarios at 1x and 4x, count by count. Throws when the scales ran different scenarios. */
export function scaleVerdicts(
  at1x: readonly ScaleCell[],
  at4x: readonly ScaleCell[],
): ScaleVerdict[] {
  const names = (cells: readonly ScaleCell[]) => cells.map((cell) => cell.methodology).join(' ')
  if (names(at1x) !== names(at4x)) {
    throw new Error(
      `[scale] the scales ran different scenarios: 1x [${names(at1x)}] 4x [${names(at4x)}]`,
    )
  }
  const verdicts: ScaleVerdict[] = []
  at1x.forEach((one, index) => {
    const four = at4x[index]!
    for (const kind of WORK_KINDS) {
      verdicts.push({
        methodology: one.methodology,
        scenario: one.scenario,
        kind,
        parts: kind === 'elements' ? grownParts(one.work, four.work) : [],
        growthBy: kind === 'elements' ? growthByPart(one.work, four.work) : {},
        at1x: one.work[kind],
        at4x: four.work[kind],
        neighbourhood1x: one.neighbourhood,
        neighbourhood4x: four.neighbourhood,
        excess: four.work[kind] - one.work[kind] - four.neighbourhood,
      })
    }
  })
  return verdicts
}

/** The failing verdicts. */
export function scaleFailures(verdicts: readonly ScaleVerdict[]): ScaleVerdict[] {
  return verdicts.filter((verdict) => verdict.excess > 0)
}

/** One line per verdict, for failure messages and logs. */
export function describeVerdict(verdict: ScaleVerdict): string {
  const growth = verdict.at4x - verdict.at1x
  const over = verdict.excess > 0
  return (
    `${verdict.methodology} ${verdict.scenario} ${verdict.kind}: 1x=${verdict.at1x} 4x=${verdict.at4x} ` +
    `(${growth >= 0 ? '+' : ''}${growth}) neighbourhood 1x=${verdict.neighbourhood1x} 4x=${verdict.neighbourhood4x}` +
    (over ? ` — OVER by ${verdict.excess}` : '') +
    (over && verdict.parts.length > 0
      ? `; grew in ${verdict.parts.map(([part, a, b]) => `${part} ${a}→${b}`).join(', ')}`
      : '')
  )
}

/**
 * The table a log shows: per scenario, rows, derivations and total elements
 * (1x → 4x, neighbourhood), then every failing part.
 */
export function describeCells(at1x: readonly ScaleCell[], at4x: readonly ScaleCell[]): string {
  const failing = scaleFailures(scaleVerdicts(at1x, at4x))
  return at1x
    .map((one, index) => {
      const four = at4x[index]!
      const head =
        `${one.methodology} ${one.scenario}: rows ${one.work.rows}→${four.work.rows} ` +
        `derivations ${one.work.derivations}→${four.work.derivations} ` +
        `elements ${one.work.elements}→${four.work.elements} ` +
        `neighbourhood ${one.neighbourhood}→${four.neighbourhood}`
      const over = failing
        .filter((verdict) => verdict.methodology === one.methodology)
        .map((verdict) => `\n    ${describeVerdict(verdict)}`)
        .join('')
      return `  ${head}${over}`
    })
    .join('\n')
}

/**
 * THE check. Throws, naming every failing scenario, count and part with both
 * counts and the bound, when any change's work grew beyond its neighbourhood.
 */
export function assertScaleInvariant(verdicts: readonly ScaleVerdict[]): void {
  const failures = scaleFailures(verdicts)
  if (failures.length === 0) return
  throw new Error(
    `[scale] ${failures.length} count(s) grew with the data beyond the changed items' neighbourhood:\n` +
      failures.map((verdict) => `  ${describeVerdict(verdict)}`).join('\n'),
  )
}

/** A result's call sites, for naming where a count came from (tracing mounts). */
export function describeSites(result: CountResult): string {
  return (result.workSites ?? []).map(([site, count]) => `    ${count}\t${site}`).join('\n')
}

/**
 * POD-4825 — one step of a named work allowance, sized: the derivations whose
 * walks may grow (`parts`, for `elements`), or the most the count may exceed
 * its bound by (`excess`).
 */
export type WorkAllowanceStep =
  | { readonly methodology: string; readonly kind: 'elements'; readonly parts: readonly string[] }
  | { readonly methodology: string; readonly kind: WorkKind; readonly excess: number }

/** A roster arm's known work violations, per issue that fixes them. */
export interface WorkAllowance {
  readonly issue: string
  readonly steps: readonly WorkAllowanceStep[]
}

const stepOf = (step: WorkAllowanceStep): string => `${step.methodology} ${step.kind}`

/**
 * Why `verdict` is outside `step`'s size, or null when the step covers it.
 * A step for another scenario or count never covers it.
 */
export function outsideAllowance(step: WorkAllowanceStep, verdict: ScaleVerdict): string | null {
  if (step.methodology !== verdict.methodology || step.kind !== verdict.kind)
    return `not ${stepOf(step)}`
  if ('excess' in step) {
    return verdict.excess <= step.excess
      ? null
      : `over by ${verdict.excess}, past the allowed ${step.excess}`
  }
  const allowed = new Set(step.parts)
  const others = Object.entries(verdict.growthBy)
    .filter(([part, growth]) => !allowed.has(part) && growth > verdict.neighbourhood4x)
    .sort((a, b) => b[1] - a[1])
  return others.length === 0
    ? null
    : `outside the allowed [${step.parts.join(', ')}]: ${others
        .map(([part, growth]) => `${part} +${growth}`)
        .join(', ')} (bound ${verdict.neighbourhood4x} per part)`
}

/**
 * The allowances applied to one arm's verdicts: `unexplained`, the failing
 * verdicts no step covers (each with why, when a step for it exists), and
 * `stale`, the steps whose count passes now (a fix takes its allowance with
 * it). Throws for a malformed step: `parts` on a count other than `elements`,
 * an empty `parts`, or a negative `excess`.
 */
export function applyWorkAllowances(
  verdicts: readonly ScaleVerdict[],
  allowances: readonly WorkAllowance[],
): { unexplained: { verdict: ScaleVerdict; why: string[] }[]; stale: string[]; applied: string[] } {
  for (const allowance of allowances)
    for (const step of allowance.steps) {
      const bad =
        'excess' in step ? !(step.excess >= 0) : step.kind !== 'elements' || step.parts.length === 0
      if (bad)
        throw new Error(`[scale] ${allowance.issue}: malformed allowance ${JSON.stringify(step)}`)
    }
  const failing = scaleFailures(verdicts)
  const unexplained: { verdict: ScaleVerdict; why: string[] }[] = []
  const applied: string[] = []
  for (const verdict of failing) {
    const why: string[] = []
    let covered = false
    for (const allowance of allowances)
      for (const step of allowance.steps) {
        if (step.methodology !== verdict.methodology || step.kind !== verdict.kind) continue
        const outside = outsideAllowance(step, verdict)
        if (outside === null) {
          covered = true
          applied.push(`${allowance.issue}: ${stepOf(step)}`)
        } else why.push(`${allowance.issue}'s allowance: ${outside}`)
      }
    if (!covered) unexplained.push({ verdict, why })
  }
  const stale = allowances.flatMap((allowance) =>
    allowance.steps
      .filter(
        (step) =>
          !failing.some(
            (verdict) => verdict.methodology === step.methodology && verdict.kind === step.kind,
          ),
      )
      .map((step) => `${allowance.issue}'s allowance for ${stepOf(step)} passes now: delete it`),
  )
  return { unexplained, stale, applied }
}

/**
 * THE check with the arm's named allowances: throws naming every failing
 * count no allowance covers (and why each allowance for it does not), then
 * every stale allowance.
 */
export function assertScaleInvariantWith(
  verdicts: readonly ScaleVerdict[],
  allowances: readonly WorkAllowance[],
): string[] {
  const { unexplained, stale, applied } = applyWorkAllowances(verdicts, allowances)
  if (unexplained.length > 0) {
    throw new Error(
      `[scale] ${unexplained.length} count(s) grew with the data beyond the changed items' neighbourhood:\n` +
        unexplained
          .map(
            ({ verdict, why }) =>
              `  ${describeVerdict(verdict)}${why.map((line) => `\n      ${line}`).join('')}`,
          )
          .join('\n'),
    )
  }
  if (stale.length > 0) throw new Error(`[scale] ${stale.join('; ')}`)
  return applied
}
