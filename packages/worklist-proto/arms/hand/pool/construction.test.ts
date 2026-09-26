/**
 * POD-4588 (Hc3) — what the hand pool builds at bootstrap, counted from
 * OUTSIDE the pool (the coordinator's addendum item 4): every cell
 * construction is observed through a test-side patch of
 * `CellGraph.prototype.cell` (the one method every cell is born through),
 * tabulated by the cell's own name prefix. Nothing here asks the pool what
 * it built; the pool's own `cellsCreated` counter is recorded beside the
 * outside count as a cross-check only (it must agree exactly).
 *
 * DESIGN (the teeth). A row view is a cell per part, created when a mounted
 * row (or `snapshot()`) first reads it (`pool.ts`: "created on first read").
 * A bare bootstrap — `create` + the feed's `replace`, no mount, no read —
 * therefore builds ZERO `view:*` cells. The eager-construction plant (a
 * bootstrap that builds every known issue's view, verified by a temporary
 * copy of `pool.ts`, restored with `cp`) fails that assertion: the count
 * sees per-known-issue view construction when it happens.
 *
 * The per-known-issue table this writes is Hc3's construction evidence
 * (budgets are the lifecycle walls'; this count attributes a miss, like
 * Mc3's §2): filings and visibility part sets are built for every KNOWN
 * issue, cold rows nothing reads included.
 */

import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { writeResult } from '../../../harness/src/results'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import type { Cell } from './cells'
import { CellGraph } from './cells'
import { handPoolArm } from './arm'

/** Cell constructions observed through the patched `cell`, by name prefix. */
function observeConstruction(run: () => void): { names: string[]; byPrefix: Record<string, number> } {
  const names: string[] = []
  const proto = CellGraph.prototype as unknown as {
    cell: (name: string, ...rest: unknown[]) => Cell<unknown>
  }
  const original = proto.cell
  proto.cell = function (this: CellGraph, name: string, ...rest: unknown[]): Cell<unknown> {
    names.push(name)
    return (original as (...args: unknown[]) => Cell<unknown>).call(this, name, ...rest)
  }
  try {
    run()
  } finally {
    proto.cell = original
  }
  const byPrefix: Record<string, number> = {}
  for (const name of names) {
    // Kind prefixes nest (`rollup:fileNest:<id>`): split at the LAST colon so
    // each construction kind tabulates separately.
    const prefix = name.includes(':') ? (name.slice(0, name.lastIndexOf(':') + 1) as string) : `${name}:`
    byPrefix[prefix] = (byPrefix[prefix] ?? 0) + 1
  }
  return { names, byPrefix }
}

describe('bootstrap construction from outside the pool', () => {
  it('builds no row view before first read; tables per-known vs per-visible', () => {
    const corpus = buildCorpus(1)
    const rows = {
      issues: corpus.sliceIssues.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      sessions: corpus.sliceSessions.map((value) => ({
        kind: 'session' as const,
        id: value.sessionId,
        value,
      })),
      worktrees: corpus.sliceWorktrees.map((value) => ({
        kind: 'worktree' as const,
        id: value.path,
        value,
      })),
    }
    const replay = createReplaySource(rows)
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    const knownIssues = corpus.sliceIssues.length

    let pool: ReturnType<typeof handPoolArm.create> | undefined
    const { names, byPrefix } = observeConstruction(() => {
      pool = handPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, {
        schedule: () => () => {},
      })
    })
    const handle = pool as unknown as ReturnType<typeof handPoolArm.create>
    try {
      const visible = handle.pool.order().length
      // The pool's own counter must agree with the outside count exactly
      // (Mc3's cross-check: agreement is evidence the counter is honest; the
      // verdict rests on the outside count).
      expect(names.length).toBe(handle.pool.stats.counters.cellsCreated)
      // DESIGN: no mounted row, no read — no row view exists yet. An eager
      // bootstrap (every known issue's view built up front) fails here.
      const viewCells = names.filter((name) => name.startsWith('view:')).length
      expect(viewCells).toBe(0)
      // Row-state built per KNOWN issue (cold rows included): two filing
      // cells each. Per VISIBLE row: its member, rank and placement cells.
      expect(byPrefix['rollup:fileNest:']).toBe(knownIssues)
      expect(byPrefix['rollup:fileFormal:']).toBe(knownIssues)
      expect(byPrefix['member:']).toBe(handle.pool.tables.issue.size)
      expect(byPrefix['rankOf:']).toBe(visible)
      expect(byPrefix['placement:']).toBe(visible)
      writeResult('hand-pool-bootstrap-outside', {
        knownIssues,
        residentIssues: handle.pool.tables.issue.size,
        visible,
        constructed: names.length,
        byPrefix,
        perKnownIssue: names.length / knownIssues,
        perVisibleRow: names.length / visible,
      })
    } finally {
      handle.dispose()
    }
  }, 300_000)
})
