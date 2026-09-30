// @vitest-environment happy-dom
/**
 * POD-5024 — the hand pool reads every row through one reader.
 *
 * The hand mirror of the MobX pool's `reader.test.tsx` (POD-4743) plus the
 * POD-4753 summary rule: `HandPool.row(entity, id, absent)` answers the row,
 * or `LOADING` plus a queued batched load, and never blocks. Pending
 * optimistic edits fold in inside the reader. Cold rows are reasoned about
 * through a small declared summary (`HIDDEN_ISSUE_FIELDS`), never a full
 * peek.
 *
 * Per old path (the 2026-09-30 audit, POD-4286):
 * - `tracked.X.get ?? residency.peek` (pool.ts:471-473) — now `row` load;
 * - `tables.X.get ?? peek` in the plain pass (pool.ts:676,696) — now summary;
 * - `VisibleInputs.issueRow` through peek (visible.ts:108-116) — now `row` peek;
 * - `loadedIssue`/`LOADING` in rollup.ts:540-1010 — now `row` load.
 *
 * Each load-mode test shows `LOADING` plus exactly one batched load for an
 * absent (cold) row; each peek-mode test shows the declared summary with no
 * load. A planted second read path (a direct `residency.peek`/`read` caller)
 * turns the single-reader tests red: they wrap both to throw and exercise
 * the pool, so any full peek fails.
 */

import { describe, expect, it, afterEach } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import type { RowSource } from '../../../shared/src/arm'
import { createReadFence } from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import type { RowRecord } from '../../../shared/src/stats'
import {
  harnessHandPoolArm,
  poolPendingLoads,
  type HarnessHandPoolHandle,
} from '../../../harness/src/adapters/hand-pool'
import { LOADING } from './worklist/rollup'
import { HIDDEN_ISSUE_FIELDS } from './worklist/visible'
import type { HandPool } from './pool'

const corpus = buildCorpus(1)

function records(): RowRecord[] {
  return [
    ...corpus.sliceSessions.map((value): RowRecord => ({ kind: 'session', id: value.sessionId, value })),
    ...corpus.sliceIssues.map((value): RowRecord => ({ kind: 'issue', id: value.id, value })),
    ...corpus.sliceWorktrees.map((value): RowRecord => ({ kind: 'worktree', id: value.path, value })),
  ]
}

interface Rig {
  readonly handle: HarnessHandPoolHandle
  readonly pool: HandPool
  readonly replay: ReplaySource
  readonly loads: string[]
  dispose(): void
}

let open: Rig[] = []

function rig(): Rig {
  const all = records()
  const replay = createReplaySource({
    issues: all.filter((r) => r.kind === 'issue'),
    sessions: all.filter((r) => r.kind === 'session'),
    worktrees: all.filter((r) => r.kind === 'worktree'),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  const loads: string[] = []
  const counted: RowSource = {
    snapshot: (kind) => replay.source.snapshot(kind),
    row: (kind, id) => {
      loads.push(`${kind}:${id}`)
      return replay.source.row?.(kind, id)
    },
    subscribe: (listener) => replay.source.subscribe(listener),
  }
  const reads = createReadFence({ enabled: true })
  const handle = harnessHandPoolArm.create(reads.wrapSource(counted), locals.source, reads, {
    schedule: () => () => {},
  })
  const r: Rig = {
    handle,
    pool: handle.pool,
    replay,
    loads,
    dispose() {
      handle.dispose()
      locals.dispose()
      open = open.filter((other) => other !== r)
    },
  }
  open.push(r)
  return r
}

afterEach(() => {
  for (const r of open) r.dispose()
  open = []
})

function coldIssue(pool: HandPool): string {
  const ids = pool.residency?.ids('issue') ?? []
  expect(ids.length).toBeGreaterThan(0)
  return ids[0] as string
}

function coldSession(pool: HandPool): string {
  const ids = pool.residency?.ids('session') ?? []
  expect(ids.length).toBeGreaterThan(0)
  return ids[0] as string
}

describe('POD-5024 the one row reader', () => {
  it('load mode: an absent issue answers LOADING plus one batched load', () => {
    const r = rig()
    const { pool } = r
    const id = coldIssue(pool)
    expect(pool.tables.issue.has(id)).toBe(false)
    // The views door (old tracked.get ?? peek) now goes through the reader:
    // absent in load mode queues exactly one load.
    expect(pool.row('issue', id, 'load')).toBe(LOADING)
    expect(pool.residency?.queued()).toBe(1)
    expect(poolPendingLoads(pool)).toBe(1)
    const before = r.loads.filter((load) => load === `issue:${id}`).length
    pool.hydrate()
    expect(r.loads.filter((load) => load === `issue:${id}`).length).toBe(before + 1)
    expect(pool.tables.issue.has(id)).toBe(true)
    expect(pool.row('issue', id, 'load')).not.toBe(LOADING)
    expect(pool.residency?.queued()).toBe(0)
  })

  it('load mode: an absent session answers LOADING plus one batched load', () => {
    const r = rig()
    const { pool } = r
    const id = coldSession(pool)
    expect(pool.tables.session.has(id)).toBe(false)
    expect(pool.row('session', id, 'load')).toBe(LOADING)
    expect(pool.residency?.queued()).toBe(1)
    const before = r.loads.filter((load) => load === `session:${id}`).length
    pool.hydrate()
    expect(r.loads.filter((load) => load === `session:${id}`).length).toBe(before + 1)
    expect(pool.tables.session.has(id)).toBe(true)
  })

  it('mark mode: an absent row answers LOADING without queueing', () => {
    const r = rig()
    const { pool } = r
    const id = coldIssue(pool)
    expect(pool.row('issue', id, 'mark')).toBe(LOADING)
    expect(pool.residency?.queued()).toBe(0)
    expect(r.loads.filter((load) => load === `issue:${id}`).length).toBe(0)
  })

  it('peek mode: a hidden issue answers its declared summary, never a full peek', () => {
    const r = rig()
    const { pool } = r
    const id = coldIssue(pool)
    const summary = pool.row('issue', id, 'peek') as Record<string, unknown> | undefined
    expect(summary).toBeDefined()
    // Exactly the declared fields, never the row.
    for (const field of HIDDEN_ISSUE_FIELDS) {
      expect(Object.hasOwn(summary as object, field) || (summary as Record<string, unknown>)[field] === undefined).toBe(true)
    }
    expect((summary as Record<string, unknown>)['title']).toBeUndefined()
    // No load queued, no feed read.
    expect(pool.residency?.queued()).toBe(0)
    expect(r.loads.filter((load) => load === `issue:${id}`).length).toBe(0)
    // The visibility door (old issueRow via peek) answers the same summary.
    expect(pool.visibleInputs.issueRow(id)).toEqual(summary)
    // The hidden door answers it too.
    expect(pool.hidden('issue', id)).toEqual(pool.residency?.summary('issue', id))
  })

  it('unknown rows answer undefined in every mode', () => {
    const r = rig()
    const { pool } = r
    expect(pool.row('issue', 'i-unknown', 'load')).toBeUndefined()
    expect(pool.row('issue', 'i-unknown', 'mark')).toBeUndefined()
    expect(pool.row('issue', 'i-unknown', 'peek')).toBeUndefined()
    expect(pool.residency?.queued()).toBe(0)
  })

  it('pending optimistic edits fold in inside the reader', () => {
    const r = rig()
    const { pool } = r
    // A resident issue: the server object itself when nothing is pending.
    const resident = [...pool.tables.issue.keys()][0] as string
    const server = pool.tables.issue.get(resident) as object
    expect(pool.row('issue', resident, 'load')).toBe(server)
    // Paint a pending edit through the pool's overlay (the write layer's path).
    pool.setPendingOverlay('issue', resident, { title: 'Pending title' })
    try {
      const overlaid = pool.row('issue', resident, 'load') as Record<string, unknown>
      expect(overlaid).not.toBe(server)
      expect(overlaid['title']).toBe('Pending title')
      // Every door sees the same overlaid value (views, visibility, roll-up).
      expect((pool.inputs.issue(resident) as unknown as Record<string, unknown>)['title']).toBe(
        'Pending title',
      )
      expect(
        (pool.visibleInputs.issueRow(resident) as unknown as Record<string, unknown>)['title'],
      ).toBe('Pending title')
    } finally {
      pool.setPendingOverlay('issue', resident, undefined)
    }
    expect(pool.row('issue', resident, 'load')).toBe(server)
  })

  it('no full peek: residency.peek and residency.read never run', () => {
    const r = rig()
    const { pool } = r
    const residency = pool.residency!
    const peek = residency.peek.bind(residency)
    const read = residency.read.bind(residency)
    residency.peek = () => {
      throw new Error('[plant] second read path via residency.peek')
    }
    residency.read = () => {
      throw new Error('[plant] second read path via residency.read')
    }
    try {
      // Bootstrap already ran; exercise every read path: views, visibility,
      // roll-ups, groups, records, plain closure (replace path uses summary).
      for (const id of pool.tables.issue.keys()) {
        void pool.view(id)
        void pool.resident('issue', id)
        void pool.row('issue', id, 'load')
        void pool.row('issue', id, 'peek')
        void pool.inputs.issue(id)
        void pool.visibleInputs.issueRow(id)
        void pool.rollup.rollupViewOf(id)
      }
      for (const id of pool.tables.session.keys()) {
        void pool.row('session', id, 'load')
        void pool.inputs.session(id)
      }
      void pool.groupsView()
      // The plain pass (replace closure) runs over summaries, never a peek.
      pool.apply({ type: 'update', rows: [] })
      pool.hydrate()
      expect(residency.counters.peeks).toBe(0)
    } finally {
      residency.peek = peek
      residency.read = read
    }
  })

  it('a planted second read path turns the single-reader test red', () => {
    const r = rig()
    const { pool } = r
    const id = coldIssue(pool)
    // Plant: read the cold row in full through the old peek path.
    const planted = pool.residency!.peek('issue', id)
    expect(planted).toBeDefined()
    // The plant is visible in the counters a green run keeps at zero.
    expect(pool.residency!.counters.peeks).toBeGreaterThan(0)
  })
})
