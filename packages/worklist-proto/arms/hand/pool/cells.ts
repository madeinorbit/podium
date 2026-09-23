/**
 * POD-4578 (Ha1) — the hand-rolled pool's derivation cells: a memo that
 * RECORDS what it read, so no derived value carries a list of its inputs.
 *
 * WHY. Round two's hand arm kept hand-maintained sensitivity sets ("input
 * lists by another name", audit §3.3) beside exhaustive delta handlers, and
 * its own rebuild oracle went red on five of them. Here a derived value
 * declares its inputs only by READING them: every read goes through a tracked
 * door (a table slot, a table's membership, the selection, a clock deadline,
 * another cell), and the door records the running cell under that key in a
 * {@link DepIndex}. A change to a key dirties exactly the cells that read it
 * on their last run, whatever they read. Nothing lists dependencies by hand.
 *
 * ONE CHANGE, ONE PASS. The pool turns a feed event into deltas, dirties the
 * readers of each delta's key ({@link CellGraph.invalidate}), then drains once
 * ({@link CellGraph.flush}): dirty cells run lowest level first (a cell's
 * level is one above the deepest cell it read), a cell whose new value equals
 * the old one keeps the old object and stops there, and a changed cell
 * dirties its own readers. The pool notifies afterwards, once per key.
 *
 * LAZY BIRTH, EAGER UPKEEP. A cell is created and first run when something
 * reads it (a mounted row, `snapshot()`, another cell). From then on the
 * drain keeps it current, so nothing is ever read stale outside a drain;
 * disposing its row (or the pool) unlinks it from every index.
 *
 * WHAT IS NOT TRACKED. A read that bypasses the doors — a plain field, a
 * closure, `Date.now()` — is invisible here, which is pitfall (j); the lint
 * fence forbids module state and wall clocks in `pool/`, and the L4b gate's
 * rebuild comparison catches what slips through (a value that depends on
 * history).
 */

/** Anything a cell can be recorded under, apart from another cell. */
export class DepIndex<K> {
  private readonly readers = new Map<K, Set<Cell<unknown>>>()

  constructor(
    readonly name: string,
    private readonly hooks: {
      readonly first?: (key: K) => void
      readonly emptied?: (key: K) => void
    } = {},
  ) {}

  /** Record `cell` under `key`; false when it already was. */
  add(key: K, cell: Cell<unknown>): boolean {
    let set = this.readers.get(key)
    if (set === undefined) {
      set = new Set()
      this.readers.set(key, set)
      this.hooks.first?.(key)
    } else if (set.has(cell)) {
      return false
    }
    set.add(cell)
    return true
  }

  remove(key: K, cell: Cell<unknown>): void {
    const set = this.readers.get(key)
    if (set === undefined || !set.delete(cell) || set.size > 0) return
    this.readers.delete(key)
    this.hooks.emptied?.(key)
  }

  /** The cells that read `key` on their last run. */
  readersOf(key: K): ReadonlySet<Cell<unknown>> | undefined {
    return this.readers.get(key)
  }

  has(key: K): boolean {
    return this.readers.has(key)
  }

  /** Keys with at least one reader (tests: lifecycle). */
  get size(): number {
    return this.readers.size
  }

  clear(): void {
    this.readers.clear()
  }
}

export type Equals<T> = (a: T, b: T) => boolean

export class Cell<T> {
  value: T | undefined = undefined
  /** False until the first run. */
  settled = false
  dirty = true
  disposed = false
  /** One above the deepest cell read on the last run; drain order. */
  level = 0
  /** The last run's reads: `sourceIndexes[i]` is null when `sourceKeys[i]` is a cell. */
  readonly sourceIndexes: (DepIndex<unknown> | null)[] = []
  readonly sourceKeys: unknown[] = []
  /** Cells that read this one on their last run. */
  readonly readers = new Set<Cell<unknown>>()

  /** Held untyped so a `Cell<T>` is a `Cell<unknown>`; only ever called with this cell's values. */
  readonly equals: Equals<unknown>

  constructor(
    readonly name: string,
    readonly compute: () => T,
    equals: Equals<T>,
    /** Called when a re-run changed the value (not on the first run). */
    readonly changed?: () => void,
  ) {
    this.equals = equals as Equals<unknown>
  }
}

/** The graph's own counters (`README.md`, "Stats"). */
export interface CellCounters {
  /** Cells created (first reads). */
  cellsCreated: number
  /** Cell bodies run, first runs included. */
  cellRuns: number
  /** Re-runs whose value differed from the previous one. */
  cellsChanged: number
}

export class CellGraph {
  readonly counters: CellCounters = { cellsCreated: 0, cellRuns: 0, cellsChanged: 0 }
  /** The cell whose body is running; reads record into it. */
  private running: Cell<unknown> | null = null
  private runningLevel = 0
  /** Dirty cells awaiting the drain, bucketed by level. */
  private readonly queue: Cell<unknown>[][] = []
  private queued = 0
  private draining = false

  cell<T>(name: string, compute: () => T, equals: Equals<T>, changed?: () => void): Cell<T> {
    this.counters.cellsCreated += 1
    return new Cell(name, compute, equals, changed)
  }

  /** Record the running cell (if any) as a reader of `key` in `index`. */
  track<K>(index: DepIndex<K>, key: K): void {
    const cell = this.running
    if (cell === null) return
    if (!index.add(key, cell)) return
    cell.sourceIndexes.push(index as DepIndex<unknown>)
    cell.sourceKeys.push(key)
  }

  /** The cell's current value, running it first when dirty; tracked. */
  read<T>(cell: Cell<T>): T {
    if (cell.disposed) throw new Error(`[pool] read of disposed cell ${cell.name}`)
    if (cell.dirty) this.run(cell)
    const reader = this.running
    if (reader !== null && reader !== (cell as Cell<unknown>)) {
      if (!cell.readers.has(reader)) {
        cell.readers.add(reader)
        reader.sourceIndexes.push(null)
        reader.sourceKeys.push(cell)
      }
      if (cell.level + 1 > this.runningLevel) this.runningLevel = cell.level + 1
    }
    return cell.value as T
  }

  /** Dirty every reader of `key` in `index`. */
  invalidateKey<K>(index: DepIndex<K>, key: K): void {
    const readers = index.readersOf(key)
    if (readers === undefined) return
    for (const cell of readers) this.invalidate(cell)
  }

  invalidate(cell: Cell<unknown>): void {
    if (cell.dirty || cell.disposed) return
    cell.dirty = true
    let bucket = this.queue[cell.level]
    while (bucket === undefined) {
      this.queue.push([])
      bucket = this.queue[cell.level]
    }
    bucket.push(cell)
    this.queued += 1
  }

  /** Run every dirty cell, lowest level first, until none is left. */
  flush(): void {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queued > 0) {
        let level = 0
        while ((this.queue[level]?.length ?? 0) === 0) level += 1
        const cell = (this.queue[level] as Cell<unknown>[]).pop() as Cell<unknown>
        this.queued -= 1
        if (cell.dirty && !cell.disposed) this.run(cell)
      }
    } finally {
      this.draining = false
    }
  }

  /** Unlink `cell` from everything it read and dirty its readers. */
  dispose(cell: Cell<unknown>): void {
    if (cell.disposed) return
    this.unlink(cell)
    cell.disposed = true
    cell.value = undefined
    for (const reader of cell.readers) this.invalidate(reader)
    cell.readers.clear()
  }

  /** Dirty cells not yet drained (tests: lifecycle). */
  get pending(): number {
    return this.queued
  }

  /** Forget every queued cell (pool disposal; the cells are dropped with it). */
  clear(): void {
    this.queue.length = 0
    this.queued = 0
  }

  private run(cell: Cell<unknown>): void {
    this.unlink(cell)
    const outer = this.running
    const outerLevel = this.runningLevel
    this.running = cell
    this.runningLevel = 0
    let next: unknown
    try {
      next = cell.compute()
    } finally {
      cell.level = this.runningLevel
      this.running = outer
      this.runningLevel = outerLevel
    }
    cell.dirty = false
    this.counters.cellRuns += 1
    if (!cell.settled) {
      cell.settled = true
      cell.value = next
      return
    }
    if (cell.equals(cell.value, next)) return // keep the old object; readers stay clean
    cell.value = next
    this.counters.cellsChanged += 1
    for (const reader of cell.readers) this.invalidate(reader)
    cell.changed?.()
  }

  private unlink(cell: Cell<unknown>): void {
    const { sourceIndexes, sourceKeys } = cell
    for (let i = 0; i < sourceKeys.length; i += 1) {
      const index = sourceIndexes[i]
      if (index === null || index === undefined)
        (sourceKeys[i] as Cell<unknown>).readers.delete(cell)
      else index.remove(sourceKeys[i], cell)
    }
    sourceIndexes.length = 0
    sourceKeys.length = 0
  }
}

/** Structural equality over plain data (scalars, arrays, plain objects). */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!sameData(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const key of ka) {
    if (!Object.hasOwn(b, key)) return false
    if (!sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false
  }
  return true
}
