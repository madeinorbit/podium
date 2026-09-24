/**
 * POD-4580 (Ha3) — the bootstrap in the count harness, at 1x and 4x: the lazy
 * pool (cold rows stay out) against the same pool holding every row (Ha2's
 * bootstrap), over the same replay feed.
 *
 * COUNTS (always). What a bootstrap builds, per kind: table slots (one per
 * resident row, lane and repo), cold registry entries (an id, and for a
 * session the issue it inherits from), the relation engine's entries (forward
 * entries, bucket `Set`s and members, prefix-index and collapse entries: ids
 * only, and the same whatever the residency), cells and records (none until
 * a read). The hand pool has no per-row observable, so what residency saves
 * at bootstrap is table slots; what it saves after is the cells and records
 * a cold row never gets: `firstRead` reads every listed row's view once (the
 * a1 list's first paint, before any load lands) and counts the cells built.
 * Counts need no quiet box.
 *
 * WALLS (`POD_POOL_BOOT_WALLS=1` only): `create()` to a bootstrapped pool,
 * the reads fence disabled, arms interleaved with the order rotated per
 * round. Every sample records the 1-minute load; a cell whose load exceeded 8
 * at any sample is FAILED and carries no summary (the methodology's load
 * rule). Take the machine's `bench:` lease around the run. Walls are
 * evidence only from a passing cell.
 */

import { loadavg } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { writeResult } from '../../../harness/src/results'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import { SCHEMA, tableColdRule } from '../../../shared/src/schema'
import type { RowRecord } from '../../../shared/src/stats'
import { handPoolArm } from './arm'
import { HandPool } from './pool'
import { ENTITIES } from './tables'

const SCALES = [1, 4] as const
const WALLS = process.env['POD_POOL_BOOT_WALLS'] === '1'
const ROUNDS = 15
const LOAD_LIMIT = 8

type Arm = 'lazy' | 'allResident'

function feedOf(scale: 1 | 4) {
  const corpus = buildCorpus(scale)
  const rows: { issues: RowRecord[]; sessions: RowRecord[]; worktrees: RowRecord[] } = {
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({
      kind: 'session',
      id: value.sessionId,
      value,
    })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  }
  return { corpus, replay: createReplaySource(rows) }
}

/** One bootstrap of `arm`; returns its pool (the caller disposes). */
function boot(arm: Arm, feed: ReturnType<typeof feedOf>): HandPool {
  const locals = settableLocals({ selectedIssueId: null, coarseNow: feed.corpus.fixedNow })
  if (arm === 'lazy') {
    return handPoolArm.create(feed.replay.source, locals.source, DISABLED_READ_FENCE, {
      schedule: () => () => {},
    }).pool
  }
  const pool = new HandPool(DISABLED_READ_FENCE, locals.source.get())
  const { source } = feed.replay
  pool.apply({
    type: 'replace',
    rows: [
      ...source.snapshot('session'),
      ...source.snapshot('issue'),
      ...source.snapshot('worktree'),
    ],
  })
  return pool
}

function counted(arm: Arm, feed: ReturnType<typeof feedOf>) {
  const pool = boot(arm, feed)
  const bootCells = pool.stats.counters.cellsCreated
  const bootRecords = pool.stats.counters.recordsCreated
  const counters = pool.stats.counters
  // Every cell alive after the bootstrap, by what built it (POD-4582).
  const own = [...pool.issues.values()].reduce((sum, cells) => sum + cells.cells.size, 0)
  const worklist = pool.worklist.cellsByPart()
  const partCells = (tally: Record<string, number>) =>
    Object.values(tally).reduce((a, b) => a + b, 0)
  const liveCells = {
    live: counters.cellsCreated - counters.cellsCollected,
    collected: counters.cellsCollected,
    idList: 1,
    /** Row-view parts: the `own` part of each visible row (its rank reads it). */
    rowViewParts: own,
    rowViewSets: pool.issues.size,
    /** Per-session activity cells the unread and retention parts asked for. */
    sessionActivity: pool.sessionCells.size,
    /** The worklist: one `visible` cell per resident issue, a rank per visible row, and the parts. */
    member: worklist.member,
    rank: worklist.rank,
    /** The groups (POD-4583): one `placement` cell per visible row. */
    placement: pool.groups.held(),
    issuePartSets: pool.worklist.held('issue'),
    issueParts: partCells(worklist.issue),
    sessionPartSets: pool.worklist.held('session'),
    sessionParts: partCells(worklist.session),
    issuePartsByName: worklist.issue,
    sessionPartsByName: worklist.session,
    visible: pool.order().length,
    visibleOwnOnly: [...pool.issues.values()].every(
      (cells) => cells.cells.size === 1 && cells.cells.has('own'),
    ),
    visibleSetIsViewSet: [...pool.issues.keys()].sort().join() === [...pool.order()].sort().join(),
  }
  const rows = Object.fromEntries(ENTITIES.map((entity) => [entity, pool.tables[entity].size]))
  const tableSlots = ENTITIES.reduce((sum, entity) => sum + pool.tables[entity].size, 0)
  const cold = {
    issue: pool.residency?.size('issue') ?? 0,
    session: pool.residency?.size('session') ?? 0,
  }
  const relations = pool.engine.footprint()
  const relationEntries = Object.values(relations).reduce((a, b) => a + b, 0)
  const cell = {
    rows,
    cold,
    tableSlots,
    registryEntries: cold.issue + cold.session,
    relations,
    relationEntries,
    cells: bootCells,
    liveCells,
    records: bootRecords,
    /** Everything the bootstrap built: slots, registry entries, relation entries, cells, records. */
    built: tableSlots + cold.issue + cold.session + relationEntries + bootCells + bootRecords,
    firstRead: { rows: 0, issueCellSets: 0, cells: 0, loadsQueued: 0 },
  }
  const listed = pool.issueIds()
  for (const id of listed) pool.view(id)
  cell.firstRead = {
    rows: listed.length,
    issueCellSets: pool.issues.size,
    cells: pool.stats.counters.cellsCreated,
    loadsQueued: pool.residency?.counters.requests ?? 0,
  }
  pool.dispose()
  return cell
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number
}

describe('bootstrap in the count harness', () => {
  it('counts at 1x and 4x (and walls when asked)', () => {
    const cells = []
    const perKnown: number[] = []
    for (const scale of SCALES) {
      const feed = feedOf(scale)
      const lazy = counted('lazy', feed)
      const all = counted('allResident', feed)
      // Resident = what the schema's rule keeps (POD-4665), over the corpus at the pool's clock.
      const cold = tableColdRule(
        SCHEMA,
        (entity) =>
          entity === 'issue'
            ? new Map(feed.corpus.sliceIssues.map((issue) => [issue.id, issue]))
            : entity === 'session'
              ? new Map(feed.corpus.sliceSessions.map((session) => [session.sessionId, session]))
              : undefined,
        feed.corpus.fixedNow,
      )
      const coldIssues = feed.corpus.sliceIssues.filter((issue) => cold('issue', issue.id)).length
      expect(lazy.rows['issue']).toBe(feed.corpus.sliceIssues.length - coldIssues)
      expect(lazy.rows['issue']! + lazy.cold.issue).toBe(all.rows['issue'])
      expect(lazy.rows['session']! + lazy.cold.session).toBe(all.rows['session'])
      // Relations hold every row's ids either way; only the tables shrink.
      expect(lazy.relations).toEqual(all.relations)
      // CELLS (POD-4582, Hb1; placements POD-4583, Hb2): the worklist is
      // built at bootstrap, as MobX builds one IssueNode per known issue
      // (Mb1: 4,867 / 19,468). Every live cell is named: the id list, the
      // `own` part of each visible row and nothing else of the views, a
      // session activity cell per member asked about, a `visible` cell per
      // RESIDENT issue, a rank and a placement per visible row, and the
      // visibility parts of the known issues and sessions the rule reached
      // (at most one set per known row; a cold row's set only when a
      // resident one's rule asked).
      for (const [arm, c] of [
        ['lazy', lazy],
        ['allResident', all],
      ] as const) {
        const l = c.liveCells
        expect(l.live, arm).toBe(
          l.idList +
            l.rowViewParts +
            l.sessionActivity +
            l.member +
            l.rank +
            l.placement +
            l.issueParts +
            l.sessionParts,
        )
        expect(l.member, arm).toBe(c.rows['issue'])
        expect(l.rank, arm).toBe(l.visible)
        expect(l.placement, arm).toBe(l.visible)
        expect(l.visibleOwnOnly && l.visibleSetIsViewSet, arm).toBe(true)
        expect(l.rowViewParts, arm).toBe(l.visible)
        expect(l.issuePartSets, arm).toBeLessThanOrEqual(all.rows['issue']!)
        expect(l.sessionPartSets, arm).toBeLessThanOrEqual(all.rows['session']!)
        expect(l.sessionActivity, arm).toBeLessThanOrEqual(all.rows['session']!)
        // No part is built twice for one row.
        for (const n of Object.values(l.issuePartsByName))
          expect(n).toBeLessThanOrEqual(l.issuePartSets)
        for (const n of Object.values(l.sessionPartsByName))
          expect(n).toBeLessThanOrEqual(l.sessionPartSets)
      }
      // The same rule over the same rows builds the same collection either way.
      expect(lazy.liveCells.visible).toBe(all.liveCells.visible)
      // Every row resident, the rule reaches every known issue once: one part
      // set per issue, MobX's IssueNode count (Mb1: 4,867 / 19,468). Lazily,
      // only the sets a resident row's rule asked for (1x: 3,240).
      expect(all.liveCells.issuePartSets).toBe(all.rows['issue'])
      expect(lazy.liveCells.issuePartSets).toBeLessThan(all.liveCells.issuePartSets)
      perKnown.push(lazy.liveCells.live / all.rows['issue']!)
      expect(lazy.records).toBe(0)
      expect(lazy.tableSlots).toBeLessThan(all.tableSlots)
      // First read: cells for resident rows only.
      expect(lazy.firstRead.issueCellSets).toBe(lazy.rows['issue'])
      expect(lazy.firstRead.cells).toBeLessThan(all.firstRead.cells)
      const cell: Record<string, unknown> = { scale, counts: { lazy, allResident: all } }
      if (WALLS) {
        const samples: Record<Arm, number[]> = { lazy: [], allResident: [] }
        const loads: number[] = []
        for (let round = 0; round < ROUNDS; round += 1) {
          const order: Arm[] = round % 2 === 0 ? ['lazy', 'allResident'] : ['allResident', 'lazy']
          for (const arm of order) {
            loads.push(loadavg()[0] as number)
            const start = performance.now()
            const pool = boot(arm, feed)
            samples[arm].push(performance.now() - start)
            pool.dispose()
          }
        }
        const maxLoad = Math.max(...loads)
        const failed = maxLoad > LOAD_LIMIT
        cell['walls'] = {
          rounds: ROUNDS,
          loads,
          maxLoad,
          status: failed ? `FAILED: load ${maxLoad.toFixed(2)} > ${LOAD_LIMIT}` : 'ok',
          ...(failed
            ? {}
            : Object.fromEntries(
                (['lazy', 'allResident'] as const).map((arm) => {
                  const sorted = [...samples[arm]].sort((a, b) => a - b)
                  return [
                    arm,
                    {
                      p50: quantile(sorted, 0.5),
                      p90: quantile(sorted, 0.9),
                      samples: samples[arm],
                    },
                  ]
                }),
              )),
        }
      }
      cells.push(cell)
    }
    // Cells grow with the known rows, not faster: live cells per known issue
    // at 4x within 10% of 1x (about 7.4 at 1x and 4x, Hb2 counting the
    // placement per visible row; a per-row walk or a per-pair cell would
    // break it).
    expect(perKnown[1]!).toBeLessThanOrEqual(perKnown[0]! * 1.1)
    writeResult(WALLS ? 'hand-pool-bootstrap-walls' : 'hand-pool-bootstrap-counts', { cells })
  }, 600_000)
})
