import { describe, expect, it } from 'vitest'
import {
  CLOSED_ISSUE_MAX_BACKOFF_PASSES,
  CLOSED_ISSUE_SWEEP_MAX_PER_PASS,
  ClosedIssueRefusals,
} from './closed-issue-refusals'

/** The passes, out of `passes`, in which the sweep asks `id`, refused the same way each time. */
function askedPasses(
  refusals: ClosedIssueRefusals,
  id: string,
  passes: number,
  fingerprint = 'dirty: a.ts',
) {
  const asked: number[] = []
  for (let pass = 1; pass <= passes; pass += 1) {
    if (refusals.beginPass([id]).includes(id)) {
      asked.push(pass)
      refusals.refusedWith(id, fingerprint)
    }
  }
  return asked
}

describe('ClosedIssueRefusals (POD-7036)', () => {
  it('backs a repeated refusal off exponentially, up to the cap', () => {
    const asked = askedPasses(new ClosedIssueRefusals(), 'iss_a', 40)
    // Sits out 1, 3, 7, 15 passes after each refusal.
    expect(asked).toEqual([1, 3, 7, 15, 31])
    const capped = askedPasses(new ClosedIssueRefusals(), 'iss_a', 600)
    const gaps = capped.slice(1).map((pass, index) => pass - (capped[index] ?? 0))
    expect(Math.max(...gaps)).toBe(CLOSED_ISSUE_MAX_BACKOFF_PASSES + 1)
  })

  it('reports a refusal as a change only when its fingerprint differs', () => {
    const refusals = new ClosedIssueRefusals()
    refusals.beginPass(['iss_a'])
    expect(refusals.refusedWith('iss_a', 'dirty: a.ts')).toBe(true)
    expect(refusals.refusedWith('iss_a', 'dirty: a.ts')).toBe(false)
    expect(refusals.refusedWith('iss_a', 'dirty: a.ts b.ts')).toBe(true)
  })

  it('a changed refusal starts the wait over', () => {
    const refusals = new ClosedIssueRefusals()
    for (const _ of [1, 2, 3]) refusals.refusedWith('iss_a', 'dirty: a.ts')
    // Three repeats: sits out 7 passes.
    expect(refusals.beginPass(['iss_a'])).toEqual([])
    refusals.refusedWith('iss_a', 'dirty: b.ts')
    // Changed: sits out one pass, then is asked again.
    expect(refusals.beginPass(['iss_a'])).toEqual([])
    expect(refusals.beginPass(['iss_a'])).toEqual(['iss_a'])
  })

  it('a stop that goes through, or an issue that stops being a candidate, is forgotten', () => {
    const refusals = new ClosedIssueRefusals()
    refusals.beginPass(['iss_a', 'iss_b'])
    refusals.refusedWith('iss_a', 'dirty')
    refusals.refusedWith('iss_b', 'dirty')
    refusals.succeeded('iss_a')
    expect(refusals.beginPass(['iss_a', 'iss_b'])).toEqual(['iss_a'])
    // iss_b reopened: not a candidate, so its refusal goes.
    refusals.beginPass(['iss_a'])
    expect(refusals.size).toBe(0)
    expect(refusals.beginPass(['iss_b'])).toEqual(['iss_b'])
  })

  it('caps one pass, asking never-refused issues first and then the longest-waiting refused ones', () => {
    const refusals = new ClosedIssueRefusals()
    const ids = Array.from({ length: CLOSED_ISSUE_SWEEP_MAX_PER_PASS + 5 }, (_, i) => `iss_${i}`)
    const first = refusals.beginPass(ids)
    expect(first).toEqual(ids.slice(0, CLOSED_ISSUE_SWEEP_MAX_PER_PASS))
    for (const id of first) refusals.refusedWith(id, 'dirty')
    // Next pass: the five never asked go first; the refused ones are sitting out.
    expect(refusals.beginPass(ids)).toEqual(ids.slice(CLOSED_ISSUE_SWEEP_MAX_PER_PASS))
    // The pass after: the refused ones are due again, oldest first.
    expect(refusals.beginPass(ids)).toEqual(
      ids
        .slice(CLOSED_ISSUE_SWEEP_MAX_PER_PASS, ids.length)
        .concat(first)
        .slice(0, CLOSED_ISSUE_SWEEP_MAX_PER_PASS),
    )
  })
})
