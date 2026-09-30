/**
 * POD-4934 — a census of the hand-rolled pool's tracking objects, taken from
 * OUTSIDE that code (the hand mirror of `mobx-census.ts`).
 *
 * Nothing here asks the pool what it built. The graph's own class is trapped
 * instead: every cell is created through `CellGraph.cell`, so wrapping that
 * method sees each cell exactly once, as it is built; every cell body runs
 * through `CellGraph.run` (private, reached by name as the work meter
 * reaches it), so wrapping it counts every run; every cell goes through
 * `CellGraph.dispose`, so wrapping it sees every death (a collected part, a
 * removed row, the pool's disposal). The wraps are installed by
 * `startHandCensus` and removed by `stop`; cells built outside a census are
 * never seen. Subscriptions are NOT trapped: the pool's subscribe methods
 * are instance properties, not prototype methods, so there is nothing to
 * wrap from outside — the test reads the pool's public listener maps at each
 * checkpoint instead (`pool.listeners`, `pool.groupListeners`,
 * `pool.groupsListeners`, `pool.orderListeners`, `pool.idsListeners`).
 *
 * A cell's NAME is its kind and owner: `view:<id>`, `own:<id>`,
 * `member:<id>`, `rankOf:<id>`, `placement:<id>`, `activity:<id>`,
 * `rollup:<part>:<id>`, `ids:issue`. The snapshot splits each name at its
 * last colon (the part before, the id after) and reports whether the cell is
 * still live. Phases are the caller's: `enter(label)` / `exit()` keep a
 * stack, and every creation and run is charged to the label on
 * top. `handPhaseMethod` wraps a pool method as a phase from outside, as
 * `phaseMethod` does for the MobX pool.
 */

import { CellGraph } from '../../arms/hand/pool/cells'

/** Work one phase did. */
export interface HandPhaseWork {
  /** Cells created (`CellGraph.cell`). */
  cellsBuilt: number
  /** Cell bodies run (`CellGraph.run`, first runs included). */
  cellRuns: number
}

export interface HandCensusEntry {
  /** The cell's full name (`view:<id>`). */
  readonly name: string
  /** The name before its last colon (`view`, `rollup:verdict`). */
  readonly part: string
  /** The name after its last colon (a row id), or null when it has none. */
  readonly id: string | null
  /** The phase that built it. */
  readonly phase: string
  /** False once disposed (a collected part, a removed row). */
  live: boolean
}

export interface HandCensusSnapshot {
  readonly entries: readonly HandCensusEntry[]
  readonly phases: Readonly<Record<string, HandPhaseWork>>
}

export interface HandCensus {
  enter(label: string): void
  exit(): void
  relabel(label: string): void
  /** The label charged now. */
  readonly phase: string
  snapshot(): HandCensusSnapshot
  /** Remove every wrap. Idempotent. */
  stop(): void
}

/** The phase charged before any `enter`. */
export const HAND_OUTSIDE_PHASES = '(no phase)'

function emptyWork(): HandPhaseWork {
  return { cellsBuilt: 0, cellRuns: 0 }
}

function splitName(name: string): { part: string; id: string | null } {
  const at = name.lastIndexOf(':')
  if (at === -1) return { part: name, id: null }
  return { part: name.slice(0, at), id: name.slice(at + 1) }
}

type AnyMethod = (...args: never[]) => unknown

let active: HandCensus | null = null

/**
 * Start a hand census. Wraps `CellGraph.cell` / `run` / `dispose`; every
 * wrap is removed by `stop`.
 */
export function startHandCensus(): HandCensus {
  if (active !== null) throw new Error('[hand-census] a census is already running')
  const entries: HandCensusEntry[] = []
  const byCell = new Map<object, HandCensusEntry>()
  const phases = new Map<string, HandPhaseWork>()
  const stack: string[] = [HAND_OUTSIDE_PHASES]
  const top = (): string => stack[stack.length - 1]!
  const work = (label: string): HandPhaseWork => {
    let entry = phases.get(label)
    if (entry === undefined) {
      entry = emptyWork()
      phases.set(label, entry)
    }
    return entry
  }
  const restores: (() => void)[] = []
  const wrap = (proto: object, method: string, make: (original: AnyMethod) => AnyMethod): void => {
    const host = proto as Record<string, AnyMethod | undefined>
    const original = host[method]
    if (typeof original !== 'function') throw new Error(`[hand-census] no method ${method} to wrap`)
    host[method] = make(original)
    restores.push(() => {
      host[method] = original
    })
  }

  // Every cell, as it is built (all product cells go through `graph.cell`).
  wrap(CellGraph.prototype as unknown as object, 'cell', (original) => {
    const made = (...args: never[]): unknown => {
      const cell = original(...args) as object
      const name = String((args[0] as unknown) ?? '(unnamed)')
      const { part, id } = splitName(name)
      const entry: HandCensusEntry = { name, part, id, phase: top(), live: true }
      entries.push(entry)
      byCell.set(cell, entry)
      work(top()).cellsBuilt += 1
      return cell
    }
    return made
  })
  // Every cell body run (`run` is private: reached by name, as the work meter).
  wrap(CellGraph.prototype as unknown as object, 'run', (original) => {
    const ran = (...args: never[]): unknown => {
      work(top()).cellRuns += 1
      return original(...args)
    }
    return ran
  })
  wrap(CellGraph.prototype as unknown as object, 'dispose', (original) => {
    const gone = (...args: never[]): unknown => {
      const entry = byCell.get(args[0] as object)
      if (entry !== undefined) entry.live = false
      return original(...args)
    }
    return gone
  })

  let stopped = false
  const census: HandCensus = {
    enter(label) {
      stack.push(label)
    },
    exit() {
      if (stack.length === 1) throw new Error('[hand-census] exit without enter')
      stack.pop()
    },
    relabel(label) {
      stack[stack.length - 1] = label
    },
    get phase() {
      return top()
    },
    snapshot() {
      const copy: Record<string, HandPhaseWork> = {}
      for (const [label, value] of phases) copy[label] = { ...value }
      return {
        // Frozen: later disposals must not rewrite an earlier checkpoint.
        entries: entries.map((entry) => ({ ...entry })),
        phases: copy,
      }
    },
    stop() {
      if (stopped) return
      stopped = true
      for (const restore of restores.reverse()) restore()
      active = null
    },
  }
  active = census
  return census
}

/** Wrap `proto[method]` so each call runs as phase `label` (restored by the returned function). */
export function handPhaseMethod(
  census: HandCensus,
  proto: object,
  method: string,
  label: string,
): () => void {
  const host = proto as Record<string, (...args: unknown[]) => unknown>
  const original = host[method]
  if (typeof original !== 'function') throw new Error(`[hand-census] no method ${method} to wrap`)
  host[method] = function (this: unknown, ...args: unknown[]) {
    census.enter(label)
    try {
      return original.apply(this, args)
    } finally {
      census.exit()
    }
  }
  return () => {
    host[method] = original
  }
}
