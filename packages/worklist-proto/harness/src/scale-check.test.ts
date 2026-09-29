// POD-4825 — the work check's allowances are SIZED (`scale-check.ts`): a step
// covers a failing count only inside the derivations it names (`parts`) or up
// to the excess it names (`excess`). A new walk in another derivation fails.
import { describe, expect, it } from 'vitest'
import {
  applyWorkAllowances,
  assertScaleInvariantWith,
  type ScaleCell,
  scaleVerdicts,
  type WorkAllowance,
} from './scale-check'

/** One scenario's cell: `rows` read, and distinct elements per derivation. */
function cell(
  methodology: string,
  rows: number,
  elementsBy: Record<string, number>,
  neighbourhood: number,
): ScaleCell {
  const elements = Object.values(elementsBy).reduce((sum, n) => sum + n, 0)
  return {
    methodology,
    scenario: `scenario ${methodology}`,
    work: { rows, derivations: 4, elements, elementsBy, visits: elements },
    neighbourhood,
    moved: [],
  }
}

// #5 at 1x and 4x: `GroupNode@#.baseRowIds` walks its whole lane (it grows
// by 400 with the corpus); `IssueModel@i#.rowRollup` walks the family (flat).
const base1x = { 'GroupNode@#.baseRowIds': 100, 'IssueModel@i#.rowRollup': 12 }
const base4x = { 'GroupNode@#.baseRowIds': 500, 'IssueModel@i#.rowRollup': 13 }
const NEIGHBOURHOOD = 20

const LANE_WALK: WorkAllowance = {
  issue: 'POD-9999',
  steps: [{ methodology: '#5', kind: 'elements', parts: ['GroupNode@#.baseRowIds'] }],
}

function verdictsOf(at4x: Record<string, number>, rows4x = 2) {
  return scaleVerdicts(
    [cell('#5', 2, base1x, NEIGHBOURHOOD)],
    [cell('#5', rows4x, at4x, NEIGHBOURHOOD)],
  )
}

describe('sized work allowances (POD-4825)', () => {
  it('covers growth in the allowed part', () => {
    const verdicts = verdictsOf(base4x)
    expect(applyWorkAllowances(verdicts, [LANE_WALK])).toEqual({
      unexplained: [],
      stale: [],
      applied: ['POD-9999: #5 elements'],
    })
  })

  it('fails a NEW walk in another derivation, naming it, though the allowed part still grows', () => {
    // The plant: `IssueModel@i#.presence` now walks every issue too.
    const planted = { ...base4x, 'IssueModel@i#.presence': 400 }
    const verdicts = scaleVerdicts(
      [cell('#5', 2, { ...base1x, 'IssueModel@i#.presence': 3 }, NEIGHBOURHOOD)],
      [cell('#5', 2, planted, NEIGHBOURHOOD)],
    )
    const { unexplained } = applyWorkAllowances(verdicts, [LANE_WALK])
    expect(unexplained.map(({ verdict }) => `${verdict.methodology} ${verdict.kind}`)).toEqual([
      '#5 elements',
    ])
    expect(unexplained[0]?.why).toEqual([
      "POD-9999's allowance: outside the allowed [GroupNode@#.baseRowIds]: IssueModel@i#.presence +397 (bound 20 per part)",
    ])
    expect(() => assertScaleInvariantWith(verdicts, [LANE_WALK])).toThrow(
      /#5 scenario #5 elements: .*OVER.*\n.*IssueModel@i#\.presence \+397/,
    )
    // The unsized allowance it replaces (scenario and count only) let it through.
    const unsized = (verdict: { methodology: string; kind: string }) =>
      verdict.methodology === '#5' && verdict.kind === 'elements'
    expect(unexplained.every(({ verdict }) => unsized(verdict))).toBe(true)
  })

  it('covers a count up to its excess and fails past it', () => {
    const allowance: WorkAllowance = {
      issue: 'POD-9998',
      steps: [{ methodology: '#5', kind: 'rows', excess: 30 }],
    }
    // rows 2 -> 52: over the bound of 20 by 30.
    const at = verdictsOf(base1x, 52)
    expect(applyWorkAllowances(at, [allowance]).unexplained).toEqual([])
    const past = verdictsOf(base1x, 53)
    expect(applyWorkAllowances(past, [allowance]).unexplained[0]?.why).toEqual([
      "POD-9998's allowance: over by 31, past the allowed 30",
    ])
  })

  it('names an allowance whose count passes now, and refuses a malformed one', () => {
    const verdicts = verdictsOf(base1x)
    expect(applyWorkAllowances(verdicts, [LANE_WALK]).stale).toEqual([
      "POD-9999's allowance for #5 elements passes now: delete it",
    ])
    expect(() => assertScaleInvariantWith(verdicts, [LANE_WALK])).toThrow(/passes now: delete it/)
    const bad = [{ issue: 'POD-1', steps: [{ methodology: '#5', kind: 'rows', parts: ['x'] }] }]
    expect(() => applyWorkAllowances(verdicts, bad as unknown as WorkAllowance[])).toThrow(
      /malformed allowance/,
    )
  })
})
