/**
 * POD-7168 — a large list's rows are derived over several tasks, each slice
 * under its budget, before a reading screen settles; a short list and a read
 * no reaction tracks answer at once, as before.
 */
import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import type { LOADING } from './loading'
import { SlicedWarmup } from './sliced-warmup'

const tasks = async (count: number): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A busy-wait standing in for one row's first derivation. */
const spin = (ms: number): void => {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // derive
  }
}

function world(size: number, rowMs = 0) {
  const ids = observable.box<readonly string[] | typeof LOADING>(
    Array.from({ length: size }, (_, at) => `r${at}`),
  )
  const reads = new Map<string, number>()
  const warmup = new SlicedWarmup(
    () => ids.get(),
    (id) => {
      const count = (reads.get(id) ?? 0) + 1
      reads.set(id, count)
      // A row's first derivation costs; reading it again is a cached read.
      if (count === 1) spin(rowMs)
    },
    { budgetMs: 10, minimum: 50 },
  )
  return { ids, reads, warmup }
}

describe('a sliced warm-up (POD-7168)', () => {
  it('answers at once for a read no reaction tracks, deriving nothing itself', () => {
    const { warmup, reads } = world(500)
    expect(warmup.done).toBe(true)
    expect(reads.size).toBe(0)
  })

  it('answers at once for a short list', () => {
    const { warmup, reads } = world(20)
    let done = false
    const stop = autorun(() => {
      done = warmup.done
    })
    expect(done).toBe(true)
    expect(reads.size).toBe(0)
    stop()
    warmup.dispose()
  })

  it('derives a long list over several tasks, each slice within its budget, then stays done', async () => {
    const { ids, warmup, reads } = world(400, 0.2)
    const seen: boolean[] = []
    const stop = autorun(() => {
      seen.push(warmup.done)
    })
    // The first slice ran with the reader's first read, within its budget:
    // some rows, not all.
    expect(seen).toEqual([false])
    expect(reads.size).toBeGreaterThan(0)
    expect(reads.size).toBeLessThan(400)
    for (let round = 0; round < 200 && !seen.at(-1); round += 1) await tasks(1)
    expect(seen).toEqual([false, true])
    // Every row derived, however many slices it took.
    expect(reads.size).toBe(400)
    // A row that arrives later is derived without unsettling the reader.
    runInAction(() => ids.set([...(ids.get() as string[]), 'late']))
    await tasks(5)
    expect(seen.at(-1)).toBe(true)
    expect(reads.has('late')).toBe(true)
    stop()
    warmup.dispose()
  })

  it('stops when no reaction reads it any more', async () => {
    const { warmup, reads } = world(400, 0.2)
    const stop = autorun(() => {
      void warmup.done
    })
    // The first slice ran with the reader's first read; the reader leaves.
    stop()
    const derived = reads.size
    await tasks(10)
    expect(reads.size).toBe(derived)
    expect(derived).toBeLessThan(400)
    warmup.dispose()
  })
})
