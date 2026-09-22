/**
 * POD-4555 (L4a) — the shrinker returns a minimal failing subsequence, on a
 * pure predicate and on a real engine run with a planted mistake.
 */

import { describe, expect, it } from 'vitest'
import type { RowSourceEvent } from '../stats'
import { type Change, gen } from './changes'
import { type GenRun, startGenRun } from './run'
import { shrink, shrinkSequence } from './shrink'

describe('shrinkSequence', () => {
  it('finds the two elements that fail together, in order', async () => {
    const input = Array.from({ length: 200 }, (_, k) => k)
    const fails = (xs: readonly number[]): boolean => {
      const a = xs.indexOf(37)
      const b = xs.indexOf(151)
      return a >= 0 && b > a
    }
    const { result, prefixLength } = await shrinkSequence(input, fails)
    expect(prefixLength).toBe(152)
    expect(result).toEqual([37, 151])
  })

  it('is 1-minimal when three elements are needed', async () => {
    const input = Array.from({ length: 64 }, (_, k) => k)
    const need = [3, 30, 60]
    const { result } = await shrinkSequence(input, (xs) => need.every((n) => xs.includes(n)))
    expect(result).toEqual(need)
  })

  it('refuses an input that does not fail', async () => {
    await expect(shrinkSequence([1, 2, 3], () => false)).rejects.toThrow(/does not fail/)
  })

  it('never runs a candidate twice', async () => {
    const seen = new Set<string>()
    let repeats = 0
    await shrinkSequence(
      Array.from({ length: 50 }, (_, k) => k),
      (xs) => {
        const key = xs.join(',')
        if (seen.has(key)) repeats += 1
        seen.add(key)
        return xs.includes(7) && xs.includes(40)
      },
    )
    expect(repeats).toBe(0)
  })
})

/**
 * A consumer of the feed that mirrors issue titles by id. PLANTED MISTAKE
 * (audit §3.3, "an evicted row re-added: relations never re-seated"): the
 * buggy mirror keeps a tombstone for a row that left and ignores it when it
 * comes back. The correct mirror is the control.
 */
interface TitleMirror {
  bootstrap(): void
  apply(event: RowSourceEvent): void
  /** True when the mirror equals the feed's current issue rows. */
  check(): boolean
}

function titleMirror(run: GenRun, buggy: boolean): TitleMirror {
  const titles = new Map<string, string>()
  const gone = new Set<string>()
  const bootstrap = (): void => {
    titles.clear()
    for (const row of run.feed().source.snapshot('issue')) {
      if (row.value) titles.set(row.id, (row.value as { title: string }).title)
    }
  }
  const apply = (event: RowSourceEvent): void => {
    if (event.type === 'replace') titles.clear()
    for (const row of event.rows) {
      if (row.kind !== 'issue') continue
      if (row.value === undefined) {
        titles.delete(row.id)
        gone.add(row.id)
        continue
      }
      if (buggy && gone.has(row.id)) continue
      titles.set(row.id, (row.value as { title: string }).title)
    }
  }
  bootstrap()
  return {
    bootstrap,
    apply,
    check() {
      const truth = run.feed().source.snapshot('issue')
      if (truth.length !== titles.size) return false
      return truth.every((row) => titles.get(row.id) === (row.value as { title: string } | undefined)?.title)
    },
  }
}

/** Run `changes` on a fresh engine with a title mirror fed step by step;
 *  true when the mirror disagrees with the feed at the end. */
async function mirrorFails(changes: readonly Change[], buggy: boolean): Promise<boolean> {
  let mirror: TitleMirror | null = null
  const run = await startGenRun({
    onStep: (step) => {
      if (step.change.kind === 'refresh') mirror?.bootstrap()
      else for (const event of step.events) mirror?.apply(event)
    },
  })
  mirror = titleMirror(run, buggy)
  try {
    for (const change of changes) await run.apply(change)
    return !(mirror as TitleMirror).check()
  } finally {
    run.dispose()
  }
}

describe('shrink on the engine', () => {
  it(
    'cuts a random run that trips the planted re-add mistake to evict + re-add of one row',
    async () => {
      // No named shapes: the evict/re-add pair must come from the random draw.
      const changes = gen(11, 120, { shapes: 0 })
      expect(await mirrorFails(changes, true), 'the buggy mirror fails the random run').toBe(true)
      expect(await mirrorFails(changes, false), 'the correct mirror (control) passes it').toBe(false)

      const { result, prefixLength, runs } = await shrink(changes, (candidate) => mirrorFails(candidate, true))
      expect(result).toHaveLength(2)
      const [first, second] = result as [Change, Change]
      expect(first).toMatchObject({ kind: 'evict' })
      expect(second).toMatchObject({ kind: 'reAdd', id: (first as { id: string }).id })
      expect(prefixLength).toBeLessThanOrEqual(changes.length)
      expect(runs).toBeGreaterThan(0)
      // The shrunk sequence still fails the buggy mirror and passes the control.
      expect(await mirrorFails(result, true)).toBe(true)
      expect(await mirrorFails(result, false)).toBe(false)
    },
    600_000,
  )
})
