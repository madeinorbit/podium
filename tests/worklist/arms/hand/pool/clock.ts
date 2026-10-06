/**
 * POD-4578 (Ha1) — the coarse clock as deadlines, so a tick dirties only the
 * cells whose answer it changes.
 *
 * A time rule never asks "what time is it"; it asks "has `t` been reached"
 * (`reached(t)`: `coarseNow >= t`), a defer lapsing or a finished row leaving
 * its 24 h grace. The asking cell is recorded under the deadline `t`
 * ({@link DepIndex}), whatever the answer, and `move(now)` dirties the cells
 * of exactly the deadlines whose answer flips between the old and the new
 * time: `min(old, new) < t <= max(old, new)`, found by binary search in the
 * sorted list of deadlines someone waits on. The same test covers a rewind,
 * so there is no second path for a clock that moves backward.
 *
 * `now` is a plain field read inside cells. Every answer it produces is
 * recorded under its deadline, so a change of answer always dirties the
 * reader; this is the one plain read in `pool/`, and `clock.test.ts` pins
 * both directions.
 */

import { type CellGraph, DepIndex } from './cells'

export class DeadlineClock {
  /** Sorted, unique deadlines with at least one reader. */
  private readonly deadlines: number[] = []
  readonly index: DepIndex<number>
  /** Deadlines whose answer a move flipped, since construction. */
  crossings = 0

  constructor(
    private readonly graph: CellGraph,
    private now: number,
  ) {
    this.index = new DepIndex<number>('clock', {
      first: (t) => this.deadlines.splice(this.indexOf(t), 0, t),
      emptied: (t) => {
        const at = this.indexOf(t)
        if (this.deadlines[at] === t) this.deadlines.splice(at, 1)
      },
    })
  }

  /** The current `coarseNow`, untracked (residency reads it inside ingest: `residency.ts` `now`). */
  get current(): number {
    return this.now
  }

  /** Deadlines waited on now (tests; disposal). */
  get waiting(): number {
    return this.deadlines.length
  }

  /** `coarseNow >= t`, recorded under `t`. */
  reached(t: number): boolean {
    this.graph.track(this.index, t)
    return this.now >= t
  }

  /** `coarseNow > t`: `reached` at the next representable instant after `t`. */
  passed(t: number): boolean {
    return this.reached(nextUp(t))
  }

  /** Move the clock and dirty the readers of every deadline it crosses. */
  move(now: number): void {
    const low = Math.min(this.now, now)
    const high = Math.max(this.now, now)
    this.now = now
    if (low === high) return
    const from = this.indexOf(nextUp(low)) // first deadline > low
    const to = this.indexOf(nextUp(high)) // first deadline > high
    // Copy first: a reader re-run later may add or drop deadlines.
    for (const t of this.deadlines.slice(from, to)) {
      this.crossings += 1
      this.graph.invalidateKey(this.index, t)
    }
  }

  clear(): void {
    this.deadlines.length = 0
    this.index.clear()
  }

  /** First index whose deadline is >= t. */
  private indexOf(t: number): number {
    let lo = 0
    let hi = this.deadlines.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((this.deadlines[mid] as number) < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

/** The smallest double greater than `x` (exact, so `now > x` is `now >= nextUp(x)`). */
export function nextUp(x: number): number {
  if (Number.isNaN(x) || x === Number.POSITIVE_INFINITY) return x
  if (x === 0) return Number.MIN_VALUE
  const bits = new Float64Array([x])
  const word = new BigInt64Array(bits.buffer)
  word[0] = (word[0] as bigint) + (x > 0 ? 1n : -1n)
  return bits[0] as number
}
