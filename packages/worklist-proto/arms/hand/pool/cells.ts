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
 * A CELL THAT READS ITSELF (POD-4582). A recursive rule over data with a
 * cycle (an issue that is its own ancestor: `parent_id` has no cycle
 * constraint, `model/src/entities/cost.ts:327`) reaches a cell that is still
 * running. The read returns the cell's value from BEFORE this run (undefined
 * on its first run), records the dependency as usual and is counted
 * (`cycleReads`): the drain terminates and nothing throws mid-commit. On
 * such a cycle the value is not guaranteed to be the one a single legacy walk
 * gives; the counter says when that happened.
 *
 * COLLECTED WHEN UNREAD (POD-4582). A cell created with `collect` exists only
 * while some cell reads it: when its last reader stops reading it (a re-run
 * that no longer asks, or the reader's disposal), the drain ends by calling
 * `collect`, which disposes it, and the next read builds it again. The
 * worklist's part cells are made this way, so a part nobody consults (a
 * session whose issue left) is not kept up. Cells read from outside any cell
 * (a list slot, a handler) are roots and are made without it.
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
  /** Its body is on the stack (a read now is a cycle). */
  running = false
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
    /** Called once no cell reads this one any more (see the header); it disposes the cell. */
    readonly collect?: () => void,
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
  /** Reads of a cell whose own body was running (a cycle in the data); see the header. */
  cycleReads: number
  /** Cells collected once nothing read them (see the header). */
  cellsCollected: number
}

export class CellGraph {
  readonly counters: CellCounters = {
    cellsCreated: 0,
    cellRuns: 0,
    cellsChanged: 0,
    cycleReads: 0,
    cellsCollected: 0,
  }
  /** The cell whose body is running; reads record into it. */
  private running: Cell<unknown> | null = null
  private runningLevel = 0
  /** Dirty cells awaiting the drain, bucketed by level. */
  private readonly queue: Cell<unknown>[][] = []
  private queued = 0
  private draining = false
  /** Collectable cells that lost a reader; collected at the end of the drain if still unread. */
  private readonly unread = new Set<Cell<unknown>>()

  cell<T>(
    name: string,
    compute: () => T,
    equals: Equals<T>,
    changed?: () => void,
    collect?: () => void,
  ): Cell<T> {
    this.counters.cellsCreated += 1
    return new Cell(name, compute, equals, changed, collect)
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
    if (cell.running) this.counters.cycleReads += 1
    else if (cell.dirty) this.run(cell)
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
      this.collectUnread()
    } finally {
      this.draining = false
    }
  }

  /** Collect every collectable cell that no cell reads any more (and what that frees in turn). */
  private collectUnread(): void {
    while (this.unread.size > 0) {
      const [cell] = this.unread as Set<Cell<unknown>>
      this.unread.delete(cell as Cell<unknown>)
      const held = cell as Cell<unknown>
      if (held.disposed || held.running || held.readers.size > 0) continue
      this.counters.cellsCollected += 1
      held.collect?.()
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
    this.unread.delete(cell)
  }

  /** Dirty cells not yet drained (tests: lifecycle). */
  get pending(): number {
    return this.queued
  }

  /** Forget every queued cell (pool disposal; the cells are dropped with it). */
  clear(): void {
    this.queue.length = 0
    this.queued = 0
    this.unread.clear()
  }

  private run(cell: Cell<unknown>): void {
    this.unlink(cell)
    const outer = this.running
    const outerLevel = this.runningLevel
    this.running = cell
    this.runningLevel = 0
    cell.running = true
    let next: unknown
    try {
      next = cell.compute()
    } finally {
      cell.running = false
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
      if (index === null || index === undefined) {
        const source = sourceKeys[i] as Cell<unknown>
        source.readers.delete(cell)
        if (source.collect !== undefined && source.readers.size === 0) this.unread.add(source)
      } else index.remove(sourceKeys[i], cell)
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
