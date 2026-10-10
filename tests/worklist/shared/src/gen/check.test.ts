import { referenceState } from '../../../diagnostics/reference-state'
/**
 * POD-4556 (L4b) — the checker can say NO: a planted incremental mistake turns
 * it red on a random run and shrinks to its cause, and the correct arm passes
 * the same run and the shrunk sequence.
 *
 * Two subjects:
 * - a TINY REFERENCE ARM (below): a real incremental pool over the per-row
 *   feed with one index, sessions by issue. Planted: a removed session is
 *   dropped from the table but not from its issue's bucket ("skip index
 *   cleanup on removal", audit §3.3). Its output is not the worklist, so it is
 *   checked against its own rebuild only (`oracleEvery: 0`);
 * - the LEGACY CONTROL, planted deaf to the locals channel: it reads the
 *   clock once at creation, so after a tick the snapshot projects with a
 *   stale clock while the derivation reads the engine's (the coarseNow
 *   hazard; the control itself had it until POD-4608). Checked against its
 *   rebuild and the oracle. The correct control passing the same run is what
 *   shows the checker delivers every tick.
 */

import { describe, expect, it } from 'vitest'
import { referenceArmFor } from '../../../harness/src/reference-arm/arm'
import { snapshotFromStore } from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import type { CheckableArm, CheckableArmHandle, RowSource } from '../arm'
import type { ScenarioEngine } from '../scenarios'
import type { SliceIssue, SliceRow, SliceSession, SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import type { ArmStats, RowRecord } from '../stats'
import { gen } from './changes'
import { checkArm, describeSequence, diffSnapshots } from './check'

// ------------------------------------------------------------------ diff

function snap(
  groups: Record<string, string[]>,
  rows: Record<string, Partial<SliceRow>> = {},
): SliceSnapshot {
  const rowsById: Record<string, SliceRow> = {}
  for (const id of Object.values(groups).flat()) {
    rowsById[id] = {
      id,
      displayRef: `#${id}`,
      title: id,
      phase: 'idle',
      progressDone: 0,
      progressTotal: 0,
      working: false,
      asking: false,
      band: 1,
      repoKey: 'r',
      closed: false,
      ...rows[id],
    } as SliceRow
  }
  return {
    order: {
      pinnedIds: [],
      groups: Object.entries(groups).map(([key, rowIds]) => ({
        key,
        label: key,
        rowIds,
        closedIds: [],
      })),
    },
    rowsById,
  }
}

describe('diffSnapshots', () => {
  it('is null for deep-equal snapshots', () => {
    expect(diffSnapshots(snap({ g: ['a', 'b'] }), snap({ g: ['a', 'b'] }))).toBeNull()
  })

  it('names an order swap inside one group, with its index', () => {
    const diff = diffSnapshots(snap({ g: ['a', 'b', 'c'] }), snap({ g: ['a', 'c', 'b'] }))
    expect(diff).toContain('group g rowIds: first difference at 1 of 3')
  })

  it('names a row field, a missing row and a moved group', () => {
    const diff = diffSnapshots(
      snap({ g: ['a'], h: ['b'] }, { a: { working: true } }),
      snap({ h: ['b'], g: ['a', 'c'] }),
    )
    expect(diff).toContain('rows missing (1): c')
    expect(diff).toContain('row a: working: true (expected false)')
    expect(diff).toContain('group keys: ["g","h"] (expected ["h","g"])')
  })
})

// --------------------------------------------------------- tiny reference arm

function zeroStats(): ArmStats {
  const stats: ArmStats = {
    rowsDerived: 0,
    rollupsDerived: 0,
    indexUpdates: 0,
    notifications: 0,
    reset() {
      stats.rowsDerived = 0
      stats.rollupsDerived = 0
      stats.indexUpdates = 0
      stats.notifications = 0
    },
  }
  return stats
}

interface Pool {
  issues: Map<string, SliceIssue>
  sessions: Map<string, SliceSession>
  /** THE INDEX: issue id → its sessions. */
  byIssue: Map<string, Map<string, SliceSession>>
}

function emptyPool(): Pool {
  return { issues: new Map(), sessions: new Map(), byIssue: new Map() }
}

function bucketAdd(pool: Pool, s: SliceSession): void {
  if (!s.issueId) return
  let bucket = pool.byIssue.get(s.issueId)
  if (!bucket) {
    bucket = new Map()
    pool.byIssue.set(s.issueId, bucket)
  }
  bucket.set(s.sessionId, s)
}

function bucketDrop(pool: Pool, s: SliceSession): void {
  if (!s.issueId) return
  const bucket = pool.byIssue.get(s.issueId)
  bucket?.delete(s.sessionId)
  if (bucket?.size === 0) pool.byIssue.delete(s.issueId)
}

function applyRecord(pool: Pool, record: RowRecord, planted: boolean): void {
  if (record.kind === 'issue') {
    if (record.value === undefined) pool.issues.delete(record.id)
    else pool.issues.set(record.id, record.value as SliceIssue)
    return
  }
  if (record.kind !== 'session') return
  const prior = pool.sessions.get(record.id)
  if (record.value === undefined) {
    pool.sessions.delete(record.id)
    // PLANTED: the bucket keeps the removed session.
    if (prior && !planted) bucketDrop(pool, prior)
    return
  }
  const next = record.value as SliceSession
  if (prior) bucketDrop(pool, prior)
  pool.sessions.set(record.id, next)
  bucketAdd(pool, next)
}

/** The tiny arm's output: one row per issue, from the index. Not the
 *  worklist; a pure function of (issues, index). */
function project(pool: Pool): SliceSnapshot {
  const rowsById: Record<string, SliceRow> = {}
  const open: SliceIssue[] = []
  const closed: SliceIssue[] = []
  for (const issue of pool.issues.values()) {
    const sessions = [...(pool.byIssue.get(issue.id)?.values() ?? [])]
    rowsById[issue.id] = {
      id: issue.id,
      displayRef: `#${issue.seq}`,
      title: issue.title,
      phase: issue.stage,
      progressDone: sessions.filter((s) => s.agentState?.phase === 'idle').length,
      progressTotal: sessions.length,
      working: sessions.some((s) => s.agentState?.phase === 'working'),
      asking: sessions.some((s) => s.offer !== undefined),
      band: 1,
      repoKey: issue.repoId ?? issue.repoPath,
      closed: issue.stage === 'done',
    } as SliceRow
    ;(issue.stage === 'done' ? closed : open).push(issue)
  }
  const bySeq = (a: SliceIssue, b: SliceIssue): number => b.seq - a.seq || a.id.localeCompare(b.id)
  return {
    order: {
      pinnedIds: [],
      groups: [
        {
          key: 'all',
          label: 'All',
          rowIds: open.sort(bySeq).map((i) => i.id),
          closedIds: closed.sort(bySeq).map((i) => i.id),
        },
      ],
    },
    rowsById,
  }
}

function load(pool: Pool, source: RowSource): void {
  for (const kind of ['issue', 'session'] as const) {
    for (const record of source.snapshot(kind)) applyRecord(pool, record, false)
  }
}

function tinyArm(planted: boolean): CheckableArm {
  return {
    create(source: RowSource): CheckableArmHandle {
      const pool = emptyPool()
      load(pool, source)
      const off = source.subscribe((event) => {
        if (event.type === 'replace') {
          pool.issues.clear()
          pool.sessions.clear()
          pool.byIssue.clear()
        }
        for (const record of event.rows) applyRecord(pool, record, planted)
      })
      return {
        snapshot: () => project(pool),
        rebuildFromScratch: () => {
          const fresh = emptyPool()
          load(fresh, source)
          return project(fresh)
        },
        stats: zeroStats(),
        dispose: off,
        mountWeb: () => () => {},
        mountNative: () => {
          throw new Error('tiny arm has no list')
        },
      }
    },
  }
}

describe('checkArm on the tiny reference arm', () => {
  // A random run with the default weights: whatever it draws, the planted
  // bucket leak shows at the first session removal. The run must draw one:
  // the first seed from 7 that does (7 itself stopped drawing one on the
  // live-shaped corpus, POD-4635), asserted below so the test cannot pass
  // on a run with nothing to catch.
  const removesSession = (changes: unknown): boolean =>
    JSON.stringify(changes).includes('"entity":"session"')
  const seed = Array.from({ length: 20 }, (_, k) => 7 + k).find((s) => removesSession(gen(s, 200)))
  const sequence = gen(seed ?? 7, 200)

  it('draws a session removal for the planted leak to show at', () => {
    expect(seed).toBeDefined()
    expect(removesSession(sequence)).toBe(true)
  })

  it('passes the correct arm, fails the planted one and shrinks to at most 5 steps', async () => {
    const correct = await checkArm(tinyArm(false), sequence, { oracleEvery: 0 })
    expect(
      correct.ok,
      correct.ok ? '' : `${correct.diff}\n${describeSequence(correct.shrunk)}`,
    ).toBe(true)
    expect(correct.counts.rebuildChecks).toBe(sequence.length + 1)

    const planted = await checkArm(tinyArm(true), sequence, { oracleEvery: 0 })
    if (planted.ok) throw new Error('the planted bucket leak passed the checker')
    expect(planted.against).toBe('rebuild')
    expect(planted.change).toMatchObject({ kind: 'remove', entity: 'session' })
    expect(planted.diff).toMatch(/progressTotal: \d+ \(expected \d+\)/)
    expect(planted.shrunk.length).toBeLessThanOrEqual(5)
    expect(planted.shrunkDivergence?.against).toBe('rebuild')
    writeResult('check-tiny', { correct, planted })

    // The correct arm passes the shrunk sequence too: the failure is the arm's.
    const control = await checkArm(tinyArm(false), planted.shrunk, { oracleEvery: 0 })
    expect(control.ok).toBe(true)
  }, 300_000)
})

// -------------------------------------------------------------- legacy control

/** The control deaf to the locals channel: it reads `locals.get()` once, at
 *  creation (the failure POD-4608's contract names), so after a tick it
 *  projects with a stale clock while the derivation reads the engine's. With
 *  `rebuildToo`, its rebuild is stale the same way: self-consistent, so only
 *  the oracle can see it. */
function staleClockControl(rebuildToo: boolean): (ctx: ScenarioEngine) => CheckableArm {
  return (ctx) => {
    const arm = referenceArmFor(ctx.engine)
    return {
      create(source, locals, reads) {
        const handle = arm.create(source, locals, reads)
        const frozen = locals.get()
        const frozenNow = frozen.coarseNow ?? referenceState(ctx.engine).coarseNow
        const stale = (): SliceSnapshot =>
          snapshotFromStore(referenceState(ctx.engine), {
            selectedIssueId: null,
            coarseNow: frozenNow,
          })
        return { ...handle, snapshot: stale, ...(rebuildToo ? { rebuildFromScratch: stale } : {}) }
      },
    }
  }
}

describe('checkArm on the legacy control', () => {
  // Default weights, one more seed: the random run meets a decaying tick.
  const sequence = gen(3, 120)
  // The control's snapshot and rebuild are each a whole legacy derivation:
  // checkpoints every 10 steps, as the CI run (check-ci.test.ts).
  const sampled = { rebuildEvery: 10, oracleEvery: 10 }

  it('passes the control; the stale-clock control fails and shrinks to at most 5 steps', async () => {
    const correct = await checkArm((ctx) => referenceArmFor(ctx.engine), sequence, sampled)
    expect(
      correct.ok,
      correct.ok ? '' : `${correct.diff}\n${describeSequence(correct.shrunk)}`,
    ).toBe(true)
    expect(correct.counts.rebuildChecks).toBe(sequence.length / 10 + 1)
    expect(correct.counts.oracleChecks).toBe(sequence.length / 10 + 1)

    const planted = await checkArm(staleClockControl(false), sequence, sampled)
    if (planted.ok) throw new Error('the stale-clock control passed the checker')
    // Noticed at a checkpoint, named at the step: the dense re-run of the
    // prefix reports the tick itself, not the checkpoint after it.
    expect(planted.change?.kind).toBe('clockTick')
    expect((planted.step + 1) % 10).not.toBe(0)
    expect(planted.shrunk.length).toBeLessThanOrEqual(5)
    expect(planted.shrunkDivergence).not.toBeNull()
    writeResult('check-control', { correct, planted })
    const control = await checkArm(
      (ctx) => referenceArmFor(ctx.engine),
      planted.shrunk,
      sampled,
    )
    expect(control.ok).toBe(true)
  }, 600_000)

  it('a stale arm whose rebuild is stale too passes its rebuild; the oracle fails it', async () => {
    const planted = await checkArm(staleClockControl(true), sequence, sampled)
    if (planted.ok) throw new Error('the self-consistent stale control passed the checker')
    expect(planted.against).toBe('oracle')
    expect(planted.change?.kind).toBe('clockTick')
    expect(planted.shrunk.length).toBeLessThanOrEqual(5)
    expect(planted.shrunkDivergence?.against).toBe('oracle')
    writeResult('check-control-oracle', { planted })
  }, 600_000)
})
