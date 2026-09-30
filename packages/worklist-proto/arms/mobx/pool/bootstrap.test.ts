/**
 * POD-4567 (Ma3) — the bootstrap in the count harness, at 1x and 4x: the lazy
 * pool (cold rows stay out) against the same pool holding every row (Ma2's
 * bootstrap), over the same replay feed.
 *
 * COUNTS (always): rows installed per table, cold rows registered, and the
 * observables MobX reports building (`spy` "add" events, per map), with one
 * object per issue the worklist holds (and the sessions those read), no
 * other. Counts need no quiet box.
 *
 * WALLS (`POD_POOL_BOOT_WALLS=1` only): `create()` to a bootstrapped pool,
 * spy off and the reads fence disabled, arms interleaved with the order
 * rotated per round. Every sample records the 1-minute load; a cell whose
 * load exceeded 8 at any sample is FAILED and carries no summary (the
 * methodology's load rule). Take `podium lock acquire bench:ludovico` around
 * the run. Walls are evidence only from a passing cell.
 */

import { loadavg } from 'node:os'
import { spy } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { writeResult } from '../../../harness/src/results'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import { SCHEMA, tableColdRule } from '../../../shared/src/schema'
import type { RowRecord } from '../../../shared/src/stats'
import { harnessMobxPoolArm, tracked } from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { MobxPool } from './pool'

installMobxWarnTrap()

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
function boot(arm: Arm, feed: ReturnType<typeof feedOf>): MobxPool {
  const locals = settableLocals({ selectedIssueId: null, coarseNow: feed.corpus.fixedNow })
  if (arm === 'lazy') {
    return harnessMobxPoolArm.create(feed.replay.source, locals.source, DISABLED_READ_FENCE, {
      schedule: () => () => {},
    }).pool
  }
  const pool = new MobxPool(locals.source.get())
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
  const built: Record<string, number> = {}
  const off = spy((event) => {
    if (event.type !== 'add') return
    const name = String((event as { debugObjectName?: string }).debugObjectName).replace(
      /@\d+$/,
      '',
    )
    built[name] = (built[name] ?? 0) + 1
  })
  const pool = boot(arm, feed)
  off()
  const cell = {
    rows: tracked(() => ({
      issue: pool.tables.issue.size,
      session: pool.tables.session.size,
      worktree: pool.tables.worktree.size,
      repo: pool.tables.repo.size,
    })),
    cold: {
      issue: pool.residency?.size('issue') ?? 0,
      session: pool.residency?.size('session') ?? 0,
    },
    models: pool.modelCount('issue') + pool.modelCount('session'),
    issueModels: pool.modelCount('issue'),
    sessionModels: pool.modelCount('session'),
    held: pool.worklist.size(),
    observables: Object.values(built).reduce((a, b) => a + b, 0),
    tableSlots: (built['pool.issue'] ?? 0) + (built['pool.session'] ?? 0),
    byMap: built,
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
              : entity === 'worktree'
                ? new Map(feed.corpus.sliceWorktrees.map((lane) => [lane.path, lane]))
                : undefined,
        feed.corpus.fixedNow,
      )
      const coldIssues = feed.corpus.sliceIssues.filter((issue) => cold('issue', issue.id)).length
      expect(lazy.rows.issue).toBe(feed.corpus.sliceIssues.length - coldIssues)
      expect(lazy.rows.issue + lazy.cold.issue).toBe(all.rows.issue)
      expect(lazy.rows.session + lazy.cold.session).toBe(all.rows.session)
      // One filing reaction per issue in memory; one object per issue read
      // (those, and the cold ones their walks reach), and the sessions those read.
      expect(lazy.held).toBe(lazy.rows.issue)
      expect(lazy.issueModels).toBeGreaterThanOrEqual(lazy.held)
      expect(lazy.models).toBe(lazy.issueModels + lazy.sessionModels)
      expect(lazy.observables).toBeLessThan(all.observables)
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
    writeResult(WALLS ? 'mobx-pool-bootstrap-walls' : 'mobx-pool-bootstrap-counts', { cells })
  }, 600_000)
})
