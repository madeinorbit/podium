/**
 * POD-4707 (hand lazy row construction) — what the hand pool builds at
 * bootstrap, counted from OUTSIDE the pool: every cell construction is
 * observed through a test-side patch of `CellGraph.prototype.cell` (the one
 * method every cell is born through), tabulated by the cell's own name
 * prefix. Nothing here asks the pool what it built; the pool's own
 * `cellsCreated` counter is recorded beside the outside count as a
 * cross-check only (it must agree exactly).
 *
 * DESIGN (the teeth). Filing and visibility state is built only for the
 * lazy closure — the visible rows, their visibility dependencies
 * (ancestors, nest owners, formal subtrees) and anything touched since —
 * computed in one plain pass at bootstrap and materialised on first access
 * after that (the MobX arm's `visible-lazy.test.ts` shape, POD-4705). A bare
 * bootstrap — `create` + the feed's `replace`, no mount, no read — builds:
 * two filing cells (`rollup:fileNest`, `rollup:fileFormal`) per CLOSURE
 * member (never per known issue), a `member` cell per resident closure
 * member, and ZERO `view:*` cells (row views are created on first read by
 * a mounted row or `snapshot()`). The eager-construction plant (today's
 * code before this issue: filings per known issue) fails the strict
 * per-known bounds below.
 *
 * The per-known-issue table this writes is the Hc3 construction evidence
 * carried forward (budgets are the lifecycle walls'; this count attributes
 * a miss, like Mc3's §2): filings and visibility part sets are built for
 * the closure only, cold rows outside it included in nothing.
 */

import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { writeResult } from '../../../harness/src/results'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import type { RowRecord } from '../../../shared/src/stats'
import type { Cell } from './cells'
import { CellGraph } from './cells'
import { harnessHandPoolArm } from '../../../harness/src/adapters/hand-pool'
import type { HandPool } from './pool'

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

function boot(): {
  pool: ReturnType<typeof harnessHandPoolArm.create>
  replay: ReturnType<typeof createReplaySource>
  knownIssues: number
} {
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
  const handle = harnessHandPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, {
    schedule: () => () => {},
  })
  return { pool: handle, replay, knownIssues: corpus.sliceIssues.length }
}

type Corpus = ReturnType<typeof buildCorpus>

function recordsOf(corpus: Corpus): {
  issues: RowRecord[]
  sessions: RowRecord[]
  worktrees: RowRecord[]
} {
  return {
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
}

function bootWith(corpus: Corpus): {
  handle: ReturnType<typeof harnessHandPoolArm.create>
  push: (rows: RowRecord[]) => void
  dispose: () => void
} {
  const replay = createReplaySource(recordsOf(corpus))
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  const handle = harnessHandPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, {
    schedule: () => () => {},
  })
  return {
    handle,
    push: (rows) => replay.push({ type: 'replace', rows }),
    dispose: () => handle.dispose(),
  }
}

function rowsOf(corpus: Corpus): RowRecord[] {
  const { issues, sessions, worktrees } = recordsOf(corpus)
  return [...sessions, ...issues, ...worktrees]
}

/**
 * Every live cell, walked from the pool's held structures (never the pool's
 * own counters: an explicit dispose drops a cell without touching
 * `cellsCollected`, so created-minus-collected overcounts after a replace).
 * The same census the residency bootstrap test names cell by cell.
 */
function liveCells(pool: HandPool): number {
  let cells = 0
  for (const issue of pool.issues.values()) cells += issue.cells.size
  cells += pool.sessionCells.size
  cells += 1 // the id list
  cells += pool.worklist.cellCount()
  cells += pool.groups.held()
  const rollup = pool.rollup.heldCells()
  cells += rollup.filings + rollup.verdicts + rollup.rollupParts
  return cells
}

function census(handle: ReturnType<typeof harnessHandPoolArm.create>): Record<string, number> {
  const pool = handle.pool
  const rollup = pool.rollup.heldCells()
  return {
    residentIssues: pool.tables.issue.size,
    coldIssues: pool.residency?.size('issue') ?? 0,
    residentSessions: pool.tables.session.size,
    coldSessions: pool.residency?.size('session') ?? 0,
    issueCellSets: pool.issues.size,
    sessionActivityCells: pool.sessionCells.size,
    worklistCells: pool.worklist.cellCount(),
    worklistMembers: pool.worklist.held('member'),
    groupPlacements: pool.groups.held(),
    filingCells: rollup.filings,
    verdictCells: rollup.verdicts,
    rollupParts: rollup.rollupParts,
    liveCells: liveCells(pool),
    visible: pool.order().length,
  }
}

describe('bootstrap construction from outside the pool', () => {
  it('builds filing and visibility state for the visible closure, not the corpus', () => {
    let pool: ReturnType<typeof harnessHandPoolArm.create> | undefined
    const { names, byPrefix } = observeConstruction(() => {
      pool = boot().pool
    })
    const handle = pool as unknown as ReturnType<typeof harnessHandPoolArm.create>
    try {
      const visible = handle.pool.order().length
      const knownIssues = handle.pool.tables.issue.size + (handle.pool.residency?.size('issue') ?? 0)
      const residentIssues = handle.pool.tables.issue.size
      // The pool's own counter must agree with the outside count exactly
      // (Mc3's cross-check: agreement is evidence the counter is honest; the
      // verdict rests on the outside count).
      expect(names.length).toBe(handle.pool.stats.counters.cellsCreated)
      // DESIGN: no mounted row, no read — no row view exists yet. An eager
      // bootstrap (every known issue's view built up front) fails here.
      const viewCells = names.filter((name) => name.startsWith('view:')).length
      expect(viewCells).toBe(0)
      // DESIGN: filings follow the closure, never the corpus. Eager
      // construction (today's code before this issue: one filing-cell pair
      // per KNOWN issue) holds 4,867 of each and fails both strict bounds.
      const fileNest = byPrefix['rollup:fileNest:'] ?? 0
      const fileFormal = byPrefix['rollup:fileFormal:'] ?? 0
      expect(fileNest).toBeLessThan(knownIssues)
      expect(fileFormal).toBeLessThan(knownIssues)
      expect(fileFormal).toBe(fileNest)
      // The closure still covers every visible row: each holds its filing
      // pair and its member cell.
      expect(visible).toBeGreaterThan(0)
      for (const id of handle.pool.order()) {
        expect(
          names.includes(`rollup:fileNest:${id}`),
          `visible ${id} holds no nest filing`,
        ).toBe(true)
        expect(
          names.includes(`rollup:fileFormal:${id}`),
          `visible ${id} holds no formal filing`,
        ).toBe(true)
        expect(names.includes(`member:${id}`), `visible ${id} holds no member cell`).toBe(true)
      }
      // Member cells follow the closure's resident members, never the
      // resident table: eager construction holds one per resident issue.
      const member = byPrefix['member:'] ?? 0
      expect(member).toBeLessThan(residentIssues)
      // Some cold row outside the closure holds no cell at all.
      const cold = handle.pool.residency?.ids('issue') ?? []
      expect(cold.length).toBeGreaterThan(0)
      const untouched = cold.filter((id) => !names.some((name) => name.endsWith(`:${id}`)))
      expect(untouched.length, 'a cold issue outside the closure holds no cell').toBeGreaterThan(0)
      writeResult('hand-pool-bootstrap-outside', {
        knownIssues,
        residentIssues,
        visible,
        closureIssues: fileNest,
        constructed: names.length,
        byPrefix,
        perKnownIssue: names.length / knownIssues,
        perVisibleRow: names.length / visible,
      })
    } finally {
      handle.dispose()
    }
  }, 300_000)

  it('a cold heartbeat builds no cell and moves no row', () => {
    const { pool, replay } = boot()
    try {
      const before = pool.pool.stats.counters.cellsCreated
      const orderBefore = [...pool.pool.order()]
      const coldSessions = pool.pool.residency?.ids('session') ?? []
      expect(coldSessions.length).toBeGreaterThan(0)
      const target = replay.source
        .snapshot('session')
        .find((record) => coldSessions.includes(record.id) && record.value !== undefined)
      expect(target, 'a cold session with a value').toBeDefined()
      const value = target!.value as unknown as Record<string, unknown>
      const agentState = (value['agentState'] ?? {}) as Record<string, unknown>
      const phase = agentState['phase']
      // working <-> compacting: the same attention verdict either way, so no
      // visibility input moves; the row still routes through ingest.
      const next = phase === 'working' ? 'compacting' : 'working'
      pool.pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'session',
            id: target!.id,
            value: { ...value, agentState: { ...agentState, phase: next } } as never,
          },
        ],
      })
      expect(pool.pool.stats.counters.cellsCreated).toBe(before)
      expect([...pool.pool.order()]).toEqual(orderBefore)
    } finally {
      pool.dispose()
    }
  }, 300_000)

  it('2x-and-back holds what a fresh 1x bootstrap holds: resident rows and live cells', () => {
    // POD-4706 (Hc3's rescope growth): after a 2x replace and back, the rows
    // the cold rule would keep cold must be evicted with their cells — a
    // fresh 1x bootstrap is the outside-count oracle. On the old
    // resident-stays rule the boundary census fails (about 1,200 extra
    // residents with all their cells, Hc3 §3); it passes once a replace
    // re-partitions by rule.
    //
    // The boundary census runs with NO reads on either arm (no settle, no
    // snapshot): what a replace leaves behind, exactly. Reads after that
    // legitimately hydrate through first access (Ha3: a row a derivation
    // reads stays resident while read), so post-read states carry hysteresis
    // — asserted as snapshot parity plus a reported residue, not equality.
    const one = buildCorpus(1)
    const two = buildCorpus(2)
    const fresh = bootWith(one)
    try {
      const freshBoundary = census(fresh.handle)
      const round = bootWith(one)
      try {
        round.push(rowsOf(two))
        round.push(rowsOf(one))
        const backBoundary = census(round.handle)
        expect(backBoundary).toEqual(freshBoundary)
        // Reads on both: the grown-state parity check materialises the grown
        // rows' cells, then both arms settle and read the 1x list.
        round.handle.settleLoads()
        round.handle.snapshot()
        fresh.handle.settleLoads()
        const freshSnap = fresh.handle.snapshot()
        const backSnap = round.handle.snapshot()
        expect(backSnap).toEqual(freshSnap)
        const backCounts = census(round.handle)
        const freshCounts = census(fresh.handle)
        writeResult('hand-pool-rescope-roundtrip-1x', {
          boundary: { fresh: freshBoundary, back: backBoundary },
          afterReads: { fresh: freshCounts, back: backCounts },
        })
      } finally {
        round.dispose()
      }
    } finally {
      fresh.dispose()
    }
  }, 300_000)
})
