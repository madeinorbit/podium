/**
 * POD-4566 (Ma2) — the pool's relations, maintained from the declared schema
 * (`relations.ts`), held to a from-scratch resolution (`scanRelations`,
 * `enumerate.ts`) and to the rules of `docs/plans/pod-4545-round-three-
 * schema.md` §4.
 *
 * Hand-built rows through the pool's own feed path (a replay source, the
 * reads fence ON, the MobX warn trap armed), so every test sees exactly the
 * relation it names:
 * - per relation: insert attaches both directions, a key change detaches the
 *   old and attaches the new, delete removes from every inverse, evict then
 *   re-add restores (both sides), the prefix relation re-resolves on root add
 *   and remove, the edge relation follows `deps`;
 * - the resume-twin collapse (`session.collapse`) in both directions;
 * - the doc's §4.5 worked example, verbatim;
 * - the reads fence: a lookup costs one read, and each change kind writes
 *   exactly the relation slots it touches (`lastWrites`);
 * - a fixture schema with one EXTRA relation, maintained with no arm code;
 * - seeded random sequences over a small id universe (collisions on
 *   purpose), compared with the scan after every step.
 */

import { dedupeSessions } from '@podium/client-core/engine'
import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import {
  createReadFence,
  DISABLED_READ_FENCE,
  type ReadFence,
} from '../../../shared/src/instrument/reads'
import { type SettableLocalsHandle, settableLocals } from '@podium/client-graph/shared/locals-source'
import {
  type EntityName,
  type ModelSchema,
  type RelationSpec,
  SCHEMA,
  validateStructure,
} from '@podium/client-graph/shared/schema'
import type { RowRecord, RowSourceEvent } from '../../../shared/src/stats'
import { diffRelations } from '../../../harness/src/adapters/mobx-rebuild'
import { snapshotPool, tracked } from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { MobxPool } from '@podium/client-graph/pool'
import { rebuildSnapshot } from '../../../harness/src/adapters/mobx-rebuild'
import { ancestorPaths } from '@podium/client-graph/relations'
import { rowViewOf } from '@podium/client-graph/models'

installMobxWarnTrap()

// ------------------------------------------------------------------ rows

const T0 = '2026-09-23T00:00:00.000Z'
const at = (hour: number) => `2026-09-23T${String(hour).padStart(2, '0')}:00:00.000Z`

type Row = Record<string, unknown>

function issue(id: string, patch: Row = {}): RowRecord {
  return {
    kind: 'issue',
    id,
    value: {
      id,
      seq: Number(id.replace(/\D/g, '')) || 1,
      title: `Issue ${id}`,
      stage: 'in_progress',
      createdAt: T0,
      updatedAt: T0,
      repoId: 'R',
      repoPath: '/repo',
      parentId: null,
      worktreePath: null,
      deps: [],
      audience: 'human',
      ...patch,
    } as RowRecord['value'],
  }
}

function session(sessionId: string, patch: Row = {}): RowRecord {
  return {
    kind: 'session',
    id: sessionId,
    value: {
      sessionId,
      issueId: null,
      cwd: '/elsewhere',
      status: 'live',
      lastActiveAt: T0,
      agentKind: 'claude-code',
      ...patch,
    } as RowRecord['value'],
  }
}

function lane(path: string, repoId = 'R', patch: Row = {}): RowRecord {
  return {
    kind: 'worktree',
    id: path,
    value: { path, repoId, repoPath: '/repo', prefix: 'POD', ...patch } as RowRecord['value'],
  }
}

const gone = (kind: RowRecord['kind'], id: string): RowRecord => ({ kind, id, value: undefined })

// ------------------------------------------------------------------- rig

interface Rig {
  pool: MobxPool
  reads: ReadFence
  replay: ReplaySource
  locals: SettableLocalsHandle
  push(...rows: RowRecord[]): void
  /** The engine's answers, read in a transient reaction. */
  one(from: EntityName, id: string, relation: string): string | null
  many(from: EntityName, id: string, relation: string): string[]
  /** The engine against a from-scratch scan of the same tables. */
  check(extra?: Partial<Record<EntityName, string[]>>): void
  dispose(): void
}

function rig(
  rows: RowRecord[],
  options: {
    fence?: boolean
    schema?: ModelSchema
    /** A lazy pool (POD-4567): cold rows stay out; each per-row read through the feed lands here. */
    loads?: string[]
  } = {},
): Rig {
  const replay = createReplaySource({
    issues: rows.filter((row) => row.kind === 'issue'),
    sessions: rows.filter((row) => row.kind === 'session'),
    worktrees: rows.filter((row) => row.kind === 'worktree'),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: Date.parse(T0) })
  const reads = options.fence === false ? DISABLED_READ_FENCE : createReadFence({ enabled: true })
  const loads = options.loads
  const pool = new MobxPool(
    locals.source.get(),
    options.schema,
    loads === undefined
      ? undefined
      : {
          load: (kind, id) => {
            loads.push(`${kind}:${id}`)
            return replay.source.row?.(kind, id)
          },
          // The window never closes by itself: a load is asked for, never taken.
          schedule: () => () => {},
        },
  )
  const source = reads.wrapSource(replay.source)
  pool.apply({
    type: 'replace',
    rows: [
      ...source.snapshot('session'),
      ...source.snapshot('issue'),
      ...source.snapshot('worktree'),
    ],
  })
  const off = source.subscribe((event) => pool.apply(event))
  const schema = options.schema ?? SCHEMA
  return {
    pool,
    reads,
    replay,
    locals,
    push: (...changes) => replay.push({ type: 'update', rows: changes }),
    one: (from, id, relation) => tracked(() => pool.graph.one(from, id, relation)),
    // Buckets are unordered (M3 F1): compare them sorted.
    many: (from, id, relation) => tracked(() => [...pool.graph.many(from, id, relation)].sort()),
    check(extra = {}) {
      const diff = tracked(() => diffRelations(pool.graph, pool.tables, schema, extra))
      expect(diff, 'live relations against the from-scratch scan').toEqual([])
    },
    dispose() {
      off()
      pool.dispose()
      locals.dispose()
    },
  }
}

// ------------------------------------------------------ one relation each

describe('issue.parent / issue.children (belongsTo, R1)', () => {
  it('insert attaches both directions; a reparent detaches the old and attaches the new', () => {
    const r = rig([issue('I1'), issue('I2'), issue('I3', { parentId: 'I1' })])
    try {
      expect(r.one('issue', 'I3', 'parent')).toBe('I1')
      expect(r.many('issue', 'I1', 'children')).toEqual(['I3'])
      r.push(issue('I4', { parentId: 'I1' }))
      expect(r.many('issue', 'I1', 'children')).toEqual(['I3', 'I4'])
      r.push(issue('I3', { parentId: 'I2' }))
      expect(r.one('issue', 'I3', 'parent')).toBe('I2')
      expect(r.many('issue', 'I1', 'children')).toEqual(['I4'])
      expect(r.many('issue', 'I2', 'children')).toEqual(['I3'])
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('a `where` input moving (archived, deletedAt) drops the edge with no key change, and restores it', () => {
    const r = rig([issue('I1'), issue('I2', { parentId: 'I1' })])
    try {
      r.push(issue('I2', { parentId: 'I1', archived: true }))
      expect(r.one('issue', 'I2', 'parent')).toBeNull()
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      r.push(issue('I2', { parentId: 'I1', archived: false }))
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2'])
      r.push(issue('I2', { parentId: 'I1', deletedAt: T0 }))
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('delete removes the row from every inverse; the holder of a deleted target keeps its reference', () => {
    const r = rig([issue('I1'), issue('I2', { parentId: 'I1' }), issue('I3', { parentId: 'I1' })])
    try {
      r.push(gone('issue', 'I2'))
      expect(r.many('issue', 'I1', 'children')).toEqual(['I3'])
      r.push(gone('issue', 'I1'))
      // The child keeps the reference id; it resolves to nothing while I1 is gone.
      expect(r.one('issue', 'I3', 'parent')).toBeNull()
      r.check({ issue: ['I1'] })
    } finally {
      r.dispose()
    }
  })

  it('evict then re-add restores the relation from either side (the round-two hand bug)', () => {
    const r = rig([issue('I1'), issue('I2', { parentId: 'I1' })])
    try {
      r.push(gone('issue', 'I1'))
      r.push(issue('I1'))
      expect(r.one('issue', 'I2', 'parent')).toBe('I1')
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2'])
      r.push(gone('issue', 'I2'))
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      r.push(issue('I2', { parentId: 'I1' }))
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2'])
      expect(r.one('issue', 'I2', 'parent')).toBe('I1')
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('a reference that arrives before its target resolves when the target lands', () => {
    const r = rig([issue('I2', { parentId: 'I1' })])
    try {
      expect(r.one('issue', 'I2', 'parent')).toBeNull()
      const seen: (string | null)[] = []
      const stop = autorun(() => {
        seen.push(r.pool.graph.one('issue', 'I2', 'parent'))
      })
      r.push(issue('I1'))
      stop()
      expect(seen).toEqual([null, 'I1'])
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2'])
    } finally {
      r.dispose()
    }
  })
})

describe('session.issue / issue.sessions (belongsTo, R2)', () => {
  it('attaches, moves on an issueId change, drops a headless session, and removes on delete', () => {
    const r = rig([issue('I1'), issue('I2'), session('S1', { issueId: 'I1' })])
    try {
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S1'])
      expect(r.one('session', 'S1', 'issue')).toBe('I1')
      r.push(session('S1', { issueId: 'I2' }))
      expect(r.many('issue', 'I1', 'sessions')).toEqual([])
      expect(r.many('issue', 'I2', 'sessions')).toEqual(['S1'])
      r.push(session('S1', { issueId: 'I2', headless: true }))
      expect(r.many('issue', 'I2', 'sessions')).toEqual([])
      expect(r.one('session', 'S1', 'issue')).toBeNull()
      r.push(session('S1', { issueId: 'I2' }), session('S2', { issueId: 'I2' }))
      expect(r.many('issue', 'I2', 'sessions')).toEqual(['S1', 'S2'])
      r.push(gone('session', 'S1'))
      expect(r.many('issue', 'I2', 'sessions')).toEqual(['S2'])
      r.check()
    } finally {
      r.dispose()
    }
  })
})

describe('session.worktree / worktree.sessions (prefix, R3)', () => {
  const lanes = [lane('/repo'), lane('/repo/.worktrees/a'), lane('/repo-two', 'R2')]

  it('takes the longest containing root, never a sibling that merely shares a prefix', () => {
    const r = rig([
      ...lanes,
      session('S1', { cwd: '/repo/.worktrees/a/packages/web' }),
      session('S2', { cwd: '/repo/src' }),
      session('S3', { cwd: '/repo-two/x' }),
      session('S4', { cwd: '/repo-three' }),
      session('S5', { cwd: '/repo/.worktrees/a/', headless: true }),
    ])
    try {
      expect(r.one('session', 'S1', 'worktree')).toBe('/repo/.worktrees/a')
      expect(r.one('session', 'S2', 'worktree')).toBe('/repo')
      expect(r.one('session', 'S3', 'worktree')).toBe('/repo-two')
      expect(r.one('session', 'S4', 'worktree')).toBeNull()
      expect(r.one('session', 'S5', 'worktree')).toBeNull()
      expect(r.many('worktree', '/repo', 'sessions')).toEqual(['S2'])
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('a new root takes the sessions under it from a shorter root and from none, not from a longer root', () => {
    const r = rig([
      lane('/repo'),
      lane('/repo/.worktrees/b/deep'),
      session('S1', { cwd: '/repo/.worktrees/b/x' }),
      session('S2', { cwd: '/repo/.worktrees/b/deep/y' }),
      session('S3', { cwd: '/other/b' }),
      session('S4', { cwd: '/repo/.worktrees/bb' }),
    ])
    try {
      expect(r.one('session', 'S1', 'worktree')).toBe('/repo')
      r.push(lane('/repo/.worktrees/b'), lane('/other'))
      expect(r.one('session', 'S1', 'worktree')).toBe('/repo/.worktrees/b')
      expect(r.one('session', 'S2', 'worktree')).toBe('/repo/.worktrees/b/deep')
      expect(r.one('session', 'S3', 'worktree')).toBe('/other')
      expect(r.one('session', 'S4', 'worktree')).toBe('/repo')
      expect(r.many('worktree', '/repo', 'sessions')).toEqual(['S4'])
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('a removed root hands its sessions to the next-longest root, or to none', () => {
    const r = rig([
      lane('/repo'),
      lane('/repo/.worktrees/a'),
      lane('/solo'),
      session('S1', { cwd: '/repo/.worktrees/a/x' }),
      session('S2', { cwd: '/repo/.worktrees/a' }),
      session('S3', { cwd: '/solo/y' }),
    ])
    try {
      r.push(gone('worktree', '/repo/.worktrees/a'), gone('worktree', '/solo'))
      expect(r.one('session', 'S1', 'worktree')).toBe('/repo')
      expect(r.one('session', 'S2', 'worktree')).toBe('/repo')
      expect(r.one('session', 'S3', 'worktree')).toBeNull()
      expect(r.many('worktree', '/repo', 'sessions')).toEqual(['S1', 'S2'])
      expect(r.many('worktree', '/repo/.worktrees/a', 'sessions')).toEqual([])
      r.push(lane('/repo/.worktrees/a'))
      expect(r.many('worktree', '/repo/.worktrees/a', 'sessions')).toEqual(['S1', 'S2'])
      r.check({ worktree: ['/solo'] })
    } finally {
      r.dispose()
    }
  })

  it('follows a cwd change, and treats `a` and `a/` as one root', () => {
    const r = rig([lane('/repo'), lane('/w/'), session('S1', { cwd: '/repo/x' })])
    try {
      r.push(session('S1', { cwd: '/w/sub' }))
      expect(r.one('session', 'S1', 'worktree')).toBe('/w/')
      expect(r.many('worktree', '/repo', 'sessions')).toEqual([])
      r.push(session('S1', { cwd: '/w' }))
      expect(r.one('session', 'S1', 'worktree')).toBe('/w/')
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('seats sessions under an issue\u2019s own worktreePath with no lane (POD-4671)', () => {
    const r = rig([
      lane('/repo'),
      issue('I1', { worktreePath: '/w/unscanned-i1' }),
      session('S1', { cwd: '/w/unscanned-i1/sub' }),
      session('S2', { cwd: '/repo/x' }),
    ])
    try {
      // No lane for the issue path, yet the orphan resolves to it.
      expect(r.one('session', 'S1', 'worktree')).toBe('/w/unscanned-i1')
      expect(r.many('worktree', '/w/unscanned-i1', 'sessions')).toEqual(['S1'])
      expect(r.one('session', 'S2', 'worktree')).toBe('/repo')
      // Losing the path hands the session to the next root (here none).
      r.push(issue('I1', { worktreePath: null }))
      expect(r.one('session', 'S1', 'worktree')).toBeNull()
      expect(r.many('worktree', '/w/unscanned-i1', 'sessions')).toEqual([])
      // Gaining it back re-seats without a lane.
      r.push(issue('I1', { worktreePath: '/w/unscanned-i1' }))
      expect(r.one('session', 'S1', 'worktree')).toBe('/w/unscanned-i1')
      expect(r.many('worktree', '/w/unscanned-i1', 'sessions')).toEqual(['S1'])
      r.check()
    } finally {
      r.dispose()
    }
  })
})

describe('issue.discoveredFrom / issue.spinOffs (edge, R4)', () => {
  const from = (id: string) => [{ id, type: 'discovered-from' }]

  it('points the spin-off OUT at its origin and lists it IN on the origin; follows deps changes', () => {
    const r = rig([
      issue('I1'),
      issue('I2'),
      issue('I3', { deps: from('I1') }),
      issue('I4', { deps: [{ id: 'I1', type: 'blocks' }] }),
    ])
    try {
      expect(r.one('issue', 'I3', 'discoveredFrom')).toBe('I1')
      expect(r.many('issue', 'I1', 'spinOffs')).toEqual(['I3'])
      expect(r.one('issue', 'I1', 'discoveredFrom')).toBeNull()
      expect(r.many('issue', 'I3', 'spinOffs')).toEqual([])
      expect(r.one('issue', 'I4', 'discoveredFrom')).toBeNull()
      r.push(issue('I3', { deps: from('I2') }))
      expect(r.many('issue', 'I1', 'spinOffs')).toEqual([])
      expect(r.many('issue', 'I2', 'spinOffs')).toEqual(['I3'])
      r.push(issue('I3', { deps: [] }))
      expect(r.many('issue', 'I2', 'spinOffs')).toEqual([])
      expect(r.one('issue', 'I3', 'discoveredFrom')).toBeNull()
      r.check()
    } finally {
      r.dispose()
    }
  })
})

describe('issue.worktree, issue.repo, worktree.repo (belongsTo by key)', () => {
  it('maintains issues per lane and per repo, and lanes per repo', () => {
    const r = rig([
      lane('/repo'),
      lane('/repo/.worktrees/i2'),
      lane('/b', 'RB'),
      issue('I1'),
      issue('I2', { worktreePath: '/repo/.worktrees/i2' }),
    ])
    try {
      expect(r.many('worktree', '/repo/.worktrees/i2', 'issues')).toEqual(['I2'])
      expect(r.many('repo', 'R', 'issues')).toEqual(['I1', 'I2'])
      expect(r.many('repo', 'R', 'worktrees')).toEqual(['/repo', '/repo/.worktrees/i2'])
      r.push(issue('I2', { worktreePath: null, repoId: 'RB' }))
      expect(r.many('worktree', '/repo/.worktrees/i2', 'issues')).toEqual([])
      expect(r.many('repo', 'RB', 'issues')).toEqual(['I2'])
      expect(r.one('issue', 'I2', 'repo')).toBe('RB')
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('keeps a repo while any of its lanes remains, and drops it with the last', () => {
    const r = rig([lane('/repo'), lane('/repo/.worktrees/x'), issue('I1')])
    try {
      r.push(gone('worktree', '/repo/.worktrees/x'))
      expect(tracked(() => r.pool.tables.repo.has('R'))).toBe(true)
      r.push(lane('/repo/.worktrees/x'))
      r.push(gone('worktree', '/repo'))
      expect(tracked(() => r.pool.tables.repo.has('R'))).toBe(true)
      expect(r.one('issue', 'I1', 'repo')).toBe('R')
      r.push(gone('worktree', '/repo/.worktrees/x'))
      expect(tracked(() => r.pool.tables.repo.has('R'))).toBe(false)
      expect(r.one('issue', 'I1', 'repo')).toBeNull()
      r.check({ repo: ['R'] })
    } finally {
      r.dispose()
    }
  })
})

// ---------------------------------------------------------- resume twins

describe('the resume-twin collapse (session.collapse, declared in the schema)', () => {
  const ref = { kind: 'codex-thread', value: 'twin' }

  it('an all-inactive group keeps one member in every relation; a live twin keeps the whole group', () => {
    const r = rig([
      lane('/repo'),
      issue('I1'),
      session('S1', {
        issueId: 'I1',
        cwd: '/repo',
        status: 'hibernated',
        lastActiveAt: at(1),
        resume: ref,
      }),
      session('S2', {
        issueId: 'I1',
        cwd: '/repo',
        status: 'exited',
        lastActiveAt: at(5),
        resume: ref,
      }),
    ])
    try {
      // Rank beats recency: the hibernated row is kept.
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S1'])
      expect(r.many('worktree', '/repo', 'sessions')).toEqual(['S1'])
      expect(r.one('session', 'S2', 'issue')).toBeNull()
      expect(r.one('session', 'S2', 'worktree')).toBeNull()
      r.check()
      // The exited twin comes back live: the group is kept in full.
      r.push(
        session('S2', {
          issueId: 'I1',
          cwd: '/repo',
          status: 'live',
          lastActiveAt: at(6),
          resume: ref,
        }),
      )
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S1', 'S2'])
      expect(r.many('worktree', '/repo', 'sessions')).toEqual(['S1', 'S2'])
      r.check()
      // It parks again, now more recent at the same rank: it is the one kept.
      r.push(
        session('S2', {
          issueId: 'I1',
          cwd: '/repo',
          status: 'hibernated',
          lastActiveAt: at(6),
          resume: ref,
        }),
      )
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S2'])
      // The kept row leaves: its twin is the only row, so it is back.
      r.push(gone('session', 'S2'))
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S1'])
      r.check()
    } finally {
      r.dispose()
    }
  })
})

describe('the resume-twin collapse over cold twins reads no cold row (POD-4753)', () => {
  const ref = { kind: 'codex-thread', value: 'across' }
  const long = '2026-09-01T00:00:00.000Z'
  /** A day in the closed issue's past: an exited run then keeps nothing shown. */
  const past = (day: number) => `2026-09-0${day}T00:00:00.000Z`
  const closed = { stage: 'done', closedAt: long, updatedAt: long }
  const sessionIds = ['S1', 'S2', 'S3', 'S4']
  const own = { cwd: '/repo', resume: ref }

  /** Every relation a twin takes part in, as `lazy` and the all-in-memory pool answer it. */
  function relationsOf(r: Rig): Record<string, unknown> {
    const out: Record<string, unknown> = {
      'I1.sessions': r.many('issue', 'I1', 'sessions'),
      'I2.sessions': r.many('issue', 'I2', 'sessions'),
      '/repo.sessions': r.many('worktree', '/repo', 'sessions'),
    }
    for (const id of sessionIds) {
      out[`${id}.issue`] = r.one('session', id, 'issue')
      out[`${id}.worktree`] = r.one('session', id, 'worktree')
      out[`${id}.collapsed`] = tracked(() => r.pool.graph.isCollapsed('session', id))
    }
    return out
  }

  it('decides a group spanning a closed issue from what ingest handed it: no read by id, the all-in-memory relations at every step', () => {
    const rows = [
      lane('/repo'),
      issue('I1', closed),
      issue('I2'),
      // A closed issue's two finished twins (cold), and the resumed run on an open issue (hot).
      session('S1', { ...own, issueId: 'I1', status: 'exited', lastActiveAt: past(1), stoppedAt: past(1) }),
      session('S2', { ...own, issueId: 'I1', status: 'exited', lastActiveAt: past(2), stoppedAt: past(2) }),
      session('S3', { ...own, issueId: 'I2', status: 'exited', lastActiveAt: at(1) }),
    ]
    const loads: string[] = []
    const lazy = rig(rows, { loads })
    const full = rig(rows)
    const step = (label: string, ...changes: RowRecord[]) => {
      if (changes.length > 0) {
        lazy.push(...changes)
        full.push(...changes)
      }
      expect(relationsOf(lazy), label).toEqual(relationsOf(full))
      expect(loads, `${label}: rows read back by id`).toEqual([])
    }
    try {
      // The setup holds: the closed issue and its twins are cold, the open side hot.
      const residency = lazy.pool.residency
      expect(['I1'].map((id) => residency?.isCold('issue', id))).toEqual([true])
      expect(['S1', 'S2', 'S3'].map((id) => residency?.isCold('session', id))).toEqual([
        true,
        true,
        false,
      ])
      // Bootstrap: the hot twin, the most recent at an equal rank, is kept.
      step('bootstrap')
      expect(lazy.many('issue', 'I1', 'sessions')).toEqual([])
      expect(lazy.many('issue', 'I2', 'sessions')).toEqual(['S3'])
      // The hot twin moves back in time: a cold twin is kept again, in full
      // (its issue, its lane), from its summary.
      step(
        'hot twin older',
        session('S3', { ...own, issueId: 'I2', status: 'exited', lastActiveAt: long }),
      )
      expect(lazy.many('issue', 'I1', 'sessions')).toEqual(['S2'])
      step(
        'hot twin kept again',
        session('S3', { ...own, issueId: 'I2', status: 'exited', lastActiveAt: at(2) }),
      )
      expect(lazy.many('issue', 'I2', 'sessions')).toEqual(['S3'])
      // The hot twin leaves: a COLD twin flips back in and is relinked in full
      // (its issue, its lane) from its summary.
      step('hot twin gone', gone('session', 'S3'))
      expect(lazy.many('issue', 'I1', 'sessions')).toEqual(['S2'])
      // A cold twin's own update (it stays cold) re-decides the group over the other.
      step(
        'cold twin update',
        session('S1', { ...own, issueId: 'I1', status: 'exited', lastActiveAt: past(3), stoppedAt: past(3) }),
      )
      expect(lazy.many('issue', 'I1', 'sessions')).toEqual(['S1'])
      // A live run joins on the open issue: the whole group is kept.
      step(
        'live twin joins',
        session('S4', { ...own, issueId: 'I2', status: 'live', lastActiveAt: at(4) }),
      )
      expect(lazy.many('issue', 'I1', 'sessions')).toEqual(['S1', 'S2'])
      // A cold twin moves out of the lane and the live run leaves.
      step(
        'cold twin moves, live run leaves',
        session('S2', { ...own, cwd: '/elsewhere', issueId: 'I1', status: 'exited', lastActiveAt: past(4), stoppedAt: past(4) }),
        gone('session', 'S4'),
      )
      expect(lazy.many('issue', 'I1', 'sessions')).toEqual(['S2'])
    } finally {
      lazy.dispose()
      full.dispose()
    }
  })
})

describe('the resume-twin collapse on the corpus, against the legacy dedupe', () => {
  it('keeps exactly the rows dedupeSessions keeps, for every twin group, in both directions', () => {
    const corpus = buildCorpus(1)
    const survivors = new Set(dedupeSessions(corpus.sessions).map((row) => row.sessionId as string))
    const r = rig(
      [
        ...corpus.sliceIssues.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
        ...corpus.sliceSessions.map((value) => ({
          kind: 'session' as const,
          id: value.sessionId,
          value,
        })),
        ...corpus.sliceWorktrees.map((value) => ({
          kind: 'worktree' as const,
          id: value.path,
          value,
        })),
      ],
      { fence: false },
    )
    try {
      expect(corpus.resumeTwins.length).toBeGreaterThanOrEqual(3)
      const directions = new Set<string>()
      for (const group of corpus.resumeTwins) {
        const members = r.many('issue', group.issueId, 'sessions')
        const kept = group.sessionIds.filter((id) => members.includes(id)).sort()
        const legacy = group.sessionIds.filter((id) => survivors.has(id)).sort()
        expect(kept, `${group.kind} ${group.ref.value}`).toEqual(legacy)
        expect(kept, `${group.kind} ${group.ref.value}`).toEqual([...group.keptSessionIds].sort())
        for (const id of group.sessionIds) {
          expect(tracked(() => r.pool.graph.isCollapsed('session', id)), id).toBe(!legacy.includes(id))
        }
        directions.add(kept.length < group.sessionIds.length ? 'collapsed' : 'kept in full')
      }
      // Both directions occur: all-inactive groups collapse, a group with a live row does not.
      expect([...directions].sort()).toEqual(['collapsed', 'kept in full'])
      // And nothing else in the corpus collapses that the legacy keeps (or the reverse).
      const collapsedByPool = corpus.sliceSessions
        .map((row) => row.sessionId)
        .filter((id) => tracked(() => r.pool.graph.isCollapsed('session', id)))
        .sort()
      const collapsedByLegacy = corpus.sessions
        .map((row) => row.sessionId as string)
        .filter((id) => !survivors.has(id))
        .sort()
      expect(collapsedByPool).toEqual(collapsedByLegacy)
      r.check()
    } finally {
      r.dispose()
    }
  })
})

// ------------------------------------------------ the doc's worked example

describe('docs/plans/pod-4545-round-three-schema.md §4.5, verbatim', () => {
  it('builds the graph the doc draws and applies its three changes', () => {
    const r = rig([
      issue('I1'),
      issue('I2', { parentId: 'I1', worktreePath: '/repo/.worktrees/i2' }),
      issue('I3', { closedAt: T0, deps: [{ id: 'I1', type: 'discovered-from' }] }),
      lane('/repo'),
      lane('/repo/.worktrees/i2'),
      session('S1', { issueId: 'I2', cwd: '/repo' }),
      session('S2', { issueId: null, cwd: '/repo/.worktrees/i2/packages/web' }),
    ])
    const W = '/repo'
    const Wi2 = '/repo/.worktrees/i2'
    try {
      expect(r.many('repo', 'R', 'issues')).toEqual(['I1', 'I2', 'I3'])
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2'])
      expect(r.one('issue', 'I2', 'parent')).toBe('I1')
      expect(r.many('issue', 'I1', 'spinOffs')).toEqual(['I3'])
      expect(r.one('issue', 'I3', 'discoveredFrom')).toBe('I1')
      expect(r.many('repo', 'R', 'worktrees')).toEqual([W, Wi2])
      expect(r.many('worktree', Wi2, 'issues')).toEqual(['I2'])
      expect(r.one('issue', 'I2', 'worktree')).toBe(Wi2)
      expect(r.many('issue', 'I2', 'sessions')).toEqual(['S1'])
      expect(r.one('session', 'S1', 'issue')).toBe('I2')
      expect(r.one('session', 'S1', 'worktree')).toBe(W)
      expect(r.many('worktree', W, 'sessions')).toEqual(['S1'])
      expect(r.one('session', 'S2', 'worktree')).toBe(Wi2)
      expect(r.many('worktree', Wi2, 'sessions')).toEqual(['S2'])

      // 1. S2 gets issueId I2: two objects touched.
      r.push(session('S2', { issueId: 'I2', cwd: '/repo/.worktrees/i2/packages/web' }))
      expect(r.many('issue', 'I2', 'sessions')).toEqual(['S1', 'S2'])
      expect(r.one('session', 'S2', 'worktree')).toBe(Wi2)

      // 2. I2 is archived: R1 re-evaluates, worktree and repo stay.
      r.push(issue('I2', { parentId: 'I1', worktreePath: Wi2, archived: true }))
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      expect(r.one('issue', 'I2', 'parent')).toBeNull()
      expect(r.one('issue', 'I2', 'worktree')).toBe(Wi2)
      expect(r.one('issue', 'I2', 'repo')).toBe('R')

      // 3. Wi2 is removed: I2 stays checked out at its own path and S2
      // stays there with it (POD-4671: the root set is lanes PLUS issue
      // paths, and issue.worktree resolves in the same union).
      r.push(gone('worktree', Wi2))
      expect(r.one('issue', 'I2', 'worktree')).toBe(Wi2)
      expect(r.one('session', 'S2', 'worktree')).toBe(Wi2)
      expect(r.many('worktree', W, 'sessions')).toEqual(['S1'])
      expect(r.many('worktree', Wi2, 'sessions')).toEqual(['S2'])
      r.push(lane(Wi2))
      expect(r.one('issue', 'I2', 'worktree')).toBe(Wi2)
      expect(r.one('session', 'S2', 'worktree')).toBe(Wi2)
      r.check()
    } finally {
      r.dispose()
    }
  })
})

// ------------------------------------------------------------ the fence

describe('the reads fence and the write record', () => {
  const rows = [
    lane('/repo'),
    lane('/repo/.worktrees/a'),
    issue('I1'),
    issue('I2', { parentId: 'I1' }),
    issue('I3', { parentId: 'I1', deps: [{ id: 'I2', type: 'discovered-from' }] }),
    issue('I4'),
    session('S1', { issueId: 'I1', cwd: '/repo/.worktrees/a/x' }),
    session('S2', { issueId: 'I1', cwd: '/repo/y' }),
    session('S3', { issueId: 'I4', cwd: '/repo/.worktrees/a/z' }),
  ]

  /** Each change kind, and exactly the relation slots it may write. */
  const KINDS: { name: string; change: RowRecord[]; writes: string[] }[] = [
    {
      name: 'heartbeat',
      change: [session('S2', { issueId: 'I1', cwd: '/repo/y', lastActiveAt: at(3) })],
      writes: [],
    },
    { name: 'rename', change: [issue('I4', { title: 'Renamed' })], writes: [] },
    {
      name: 'reparent',
      change: [issue('I2', { parentId: 'I4' })],
      writes: [
        'issue.children:I1',
        'issue.children:I4',
        'issue.parent→I2',
        // The where-less twin (the nest walk's raw edge) moves with it.
        'issue.treeChildren:I1',
        'issue.treeChildren:I4',
        'issue.treeParent→I2',
      ],
    },
    {
      name: 'archive',
      change: [issue('I2', { parentId: 'I1', archived: true })],
      writes: ['issue.children:I1', 'issue.parent→I2'],
    },
    {
      name: 'session moves issue',
      change: [session('S2', { issueId: 'I4', cwd: '/repo/y' })],
      writes: ['issue.sessions:I1', 'issue.sessions:I4', 'session.issue→S2'],
    },
    {
      name: 'session moves lane',
      change: [session('S2', { issueId: 'I1', cwd: '/repo/.worktrees/a/q' })],
      writes: [
        'session.worktree→S2',
        'worktree.sessions:/repo',
        'worktree.sessions:/repo/.worktrees/a',
      ],
    },
    {
      name: 'deps change',
      change: [issue('I3', { parentId: 'I1', deps: [{ id: 'I4', type: 'discovered-from' }] })],
      writes: ['issue.discoveredFrom→I3', 'issue.spinOffs:I2', 'issue.spinOffs:I4'],
    },
    {
      name: 'new session',
      change: [session('S9', { issueId: 'I4', cwd: '/repo/z' })],
      writes: [
        'issue.sessions:I4',
        'session.issue→S9',
        'session.worktree→S9',
        'worktree.sessions:/repo',
      ],
    },
    {
      name: 'remove session',
      change: [gone('session', 'S3')],
      writes: [
        'issue.sessions:I4',
        'session.issue→S3',
        'session.worktree→S3',
        'worktree.sessions:/repo/.worktrees/a',
      ],
    },
    {
      name: 'new lane',
      change: [lane('/repo/.worktrees/b')],
      writes: ['repo.worktrees:R', 'worktree.repo→/repo/.worktrees/b'],
    },
    {
      name: 'remove lane',
      change: [gone('worktree', '/repo/.worktrees/a')],
      writes: [
        'repo.worktrees:R',
        'session.worktree→S1',
        'session.worktree→S3',
        'worktree.repo→/repo/.worktrees/a',
        'worktree.sessions:/repo',
        'worktree.sessions:/repo/.worktrees/a',
      ],
    },
    {
      name: 'evict a parent',
      change: [gone('issue', 'I1')],
      writes: ['issue.repo→I1', 'repo.issues:R'],
    },
  ]

  for (const kind of KINDS) {
    it(`${kind.name} writes only the slots it touches`, () => {
      const r = rig(rows)
      try {
        r.push(...kind.change)
        r.check({ issue: ['I1'] })
      } finally {
        r.dispose()
      }
    })
  }

  it('a bucket the change does not touch is not notified; a touched one once; a cancelled move not at all', () => {
    const r = rig(rows)
    try {
      const runs = { touched: 0, untouched: 0 }
      const watch = (key: keyof typeof runs, from: EntityName, id: string, relation: string) =>
        autorun(() => {
          runs[key] += 1
          for (const _ of r.pool.graph.many(from, id, relation)) void _
        })
      const stops = [
        watch('touched', 'issue', 'I1', 'children'),
        watch('untouched', 'worktree', '/repo/.worktrees/a', 'sessions'),
      ]
      r.push(issue('I4', { parentId: 'I1' }), issue('I5', { parentId: 'I1' }))
      expect(runs).toEqual({ touched: 2, untouched: 1 })
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2', 'I3', 'I4', 'I5'])
      // I2 leaves I1 and comes back inside one action: the net move is none.
      r.push(issue('I2', { parentId: 'I4' }), issue('I2', { parentId: 'I1' }))
      expect(runs).toEqual({ touched: 2, untouched: 1 })
      for (const stop of stops) stop()
      r.check({ issue: ['I1'] })
    } finally {
      r.dispose()
    }
  })
})

// ------------------------------------------- bucket upkeep (M3 F1, POD-4568 rework)

/**
 * Element work on plain `Set`s and `Map`s and `Array.from` copies, from any
 * caller but MobX itself (M3 G3). The relation engine's prefix index is a map
 * of plain sets, so a copy of one is invisible to the observable counts.
 */
interface PlainCount {
  /** `Set.add` and `Map.set` (a `new Set(iterable)` adds every element). */
  written: number
  /** `Set.delete` and `Map.delete`. */
  deleted: number
  /** Elements yielded by a plain set's or map's iterators or `forEach`. */
  iterated: number
  /** Elements `Array.from` copied from a source whose iteration is not counted above. */
  copied: number
}

/** Element work on observable sets and sorts (M3 G1), and on plain sets and maps (G3), counted outside the pool. */
interface OutsideCount {
  added: number
  deleted: number
  iterated: number
  sorted: number
  plain: PlainCount
}

const outsideTotal = (c: OutsideCount): number => c.added + c.deleted + c.iterated + c.sorted
const plainTotal = (c: PlainCount): number => c.written + c.deleted + c.iterated + c.copied

/** Formatting a stack walks the source maps' own maps: never counted. */
let readingStack = false

/** This file's frames: the patches below (never a caller of the pool's work). */
const THIS_FILE = `${new URL(import.meta.url).pathname}:`

/**
 * True when the patched call was made by MobX's own code: the first frame
 * that is neither this file's (the patch) nor native (a `new Set(iterable)` or
 * `Array.from` shows a native frame between the patch and its caller). By
 * location, not by depth: JSC eliminates frames in strict-mode tail calls.
 * MobX keeps its own plain sets and maps (every observable's observers, an
 * observable set's `data_`); that is the library's bookkeeping, not the pool's.
 */
function calledByMobx(): boolean {
  if (readingStack) return true
  readingStack = true
  let stack: string
  try {
    stack = new Error().stack ?? ''
  } finally {
    readingStack = false
  }
  const frames = stack.split('\n').slice(1)
  for (const frame of frames) {
    if (frame.includes(THIS_FILE) || frame.includes('(native)')) continue
    return frame.includes('/node_modules/mobx/')
  }
  return false
}

/**
 * Run `fn` with MobX's `ObservableSet` prototype, `Array.prototype.sort` /
 * `toSorted`, the plain `Set` and `Map` prototypes and `Array.from` patched to
 * count, then restore them. Nothing here reads a pool counter.
 *
 * OBSERVABLE (G1). A bucket is an `ObservableSet`, and every way to read one
 * member by member (`for…of`, spread, `Array.from`, `new Set(bucket)`,
 * `forEach`, `keys`, `entries`) goes through its `values()`, so a copy of the
 * bucket is counted whether or not the pool reports it. Every observable set
 * counts, not only the ones the pool names as buckets, and every sort counts,
 * since a regression could sort a plain copy.
 *
 * PLAIN (G3). `Set` `add`/`delete`/`values`/`keys`/`forEach`/`[Symbol.iterator]`,
 * `Map` `set`/`delete`/`values`/`keys`/`entries`/`forEach`/`[Symbol.iterator]`
 * and `Array.from` count in `plain`, unless MobX made the call
 * (`calledByMobx`). An unsorted copy of the prefix index's plain sets counts
 * there: `new Set(set)` iterates and adds every element.
 */
function countedOutside(fn: () => void): OutsideCount {
  const plain: PlainCount = { written: 0, deleted: 0, iterated: 0, copied: 0 }
  const count: OutsideCount = { added: 0, deleted: 0, iterated: 0, sorted: 0, plain }
  type Method = (this: unknown, ...args: unknown[]) => unknown
  type Patched = Record<PropertyKey, Method>
  type After = (self: unknown, result: unknown, args: unknown[]) => unknown
  const set = Object.getPrototypeOf(observable.set<string>()) as Patched
  const observableSetProto = set
  const array = Array.prototype as unknown as Patched
  const counted =
    (field: 'added' | 'deleted' | 'sorted', weight: (self: unknown) => number): After =>
    (self, result) => {
      count[field] += weight(self)
      return result
    }
  const one = (): number => 1
  // POD-4569: the visible collection's set (`pool.visible`) is not a relation
  // bucket; a row entering the worklist adds its id there, one element per
  // membership flip either way (`counters.membershipFlips`). POD-4686: the
  // groups' filed lanes (`pool.groups.*`) are the same kind of maintenance
  // filing, counted separately (`counters.groupRuns`, `groupElements`).
  const bucketOnly = (self: unknown): number => {
    const name = (self as { name_?: string }).name_ ?? ''
    return name === 'pool.visible' || name.startsWith('pool.groups.') ? 0 : 1
  }
  const length = (self: unknown): number => (self as unknown[]).length
  const countingIterator = (it: Iterator<unknown>, tick: () => void): IterableIterator<unknown> => {
    const counting: IterableIterator<unknown> = {
      next: () => {
        const step = it.next()
        if (step.done !== true) tick()
        return step
      },
      [Symbol.iterator]: () => counting,
    }
    return counting
  }
  // Plain work is counted unless MobX made the call.
  const outsideMobx =
    (tick: (self: unknown, result: unknown, args: unknown[]) => void): After =>
    (self, result, args) => {
      if (!calledByMobx()) tick(self, result, args)
      return result
    }
  const plainIterator: After = (_self, result) =>
    calledByMobx()
      ? result
      : countingIterator(result as Iterator<unknown>, () => {
          plain.iterated += 1
        })
  const plainForEach: After = outsideMobx((self) => {
    plain.iterated += (self as ReadonlySet<unknown> | ReadonlyMap<unknown, unknown>).size
  })
  const plainSet = Set.prototype as unknown as Patched
  const plainMap = Map.prototype as unknown as Patched
  const arrayCtor = Array as unknown as Patched
  /** Sources whose own iteration is counted: `Array.from` over them would count twice. */
  const iterationCounted = (source: unknown): boolean =>
    source instanceof Set ||
    source instanceof Map ||
    (typeof source === 'object' &&
      source !== null &&
      Object.getPrototypeOf(source) === observableSetProto)
  const patches: [Patched, PropertyKey, After][] = [
    [set, 'add', counted('added', bucketOnly)],
    [set, 'delete', counted('deleted', bucketOnly)],
    [
      set,
      'values',
      (_self, result) =>
        countingIterator(result as Iterator<unknown>, () => {
          count.iterated += 1
        }),
    ],
    [array, 'sort', counted('sorted', length)],
    [array, 'toSorted', counted('sorted', length)],
    [plainSet, 'add', outsideMobx(() => (plain.written += 1))],
    [plainSet, 'delete', outsideMobx(() => (plain.deleted += 1))],
    [plainSet, 'values', plainIterator],
    [plainSet, 'keys', plainIterator],
    [plainSet, Symbol.iterator, plainIterator],
    [plainSet, 'forEach', plainForEach],
    [plainMap, 'set', outsideMobx(() => (plain.written += 1))],
    [plainMap, 'delete', outsideMobx(() => (plain.deleted += 1))],
    [plainMap, 'values', plainIterator],
    [plainMap, 'keys', plainIterator],
    [plainMap, 'entries', plainIterator],
    [plainMap, Symbol.iterator, plainIterator],
    [plainMap, 'forEach', plainForEach],
    [
      arrayCtor,
      'from',
      outsideMobx((_self, result, args) => {
        if (!iterationCounted(args[0])) plain.copied += (result as unknown[]).length
      }),
    ],
  ]
  const stackLimit = Error.stackTraceLimit
  Error.stackTraceLimit = Math.max(stackLimit, 20)
  const restore = patches.map(([proto, name, after]) => {
    const original = proto[name] as Method
    proto[name] = function (this: unknown, ...args: unknown[]) {
      return after(this, original.apply(this, args), args)
    }
    return () => {
      proto[name] = original
    }
  })
  try {
    fn()
  } finally {
    for (const undo of restore) undo()
    Error.stackTraceLimit = stackLimit
  }
  return count
}

type SetLike = { readonly size: number }

it('preserves the landed write count and collapse rules with only existing declarations', () => {
  const collapse = SCHEMA.session.collapse
  if (!collapse) throw new Error('Missing declared session collapse')
  const pageIssueNames = new Set(['pageDependencies', 'pageDependents', 'bornSessions', 'pageSessions',
    'supersedingIssue', 'supersededIssues', 'canonicalIssue', 'duplicateIssues'])
  const schema: ModelSchema = { ...SCHEMA,
    issue: { ...SCHEMA.issue, relations: Object.fromEntries(Object.entries(SCHEMA.issue.relations)
      .filter(([name]) => !pageIssueNames.has(name))) },
    session: { ...SCHEMA.session, collapse: { ...collapse, order: undefined },
      relations: Object.fromEntries(Object.entries(SCHEMA.session.relations)
        .filter(([name]) => name !== 'bornIssue' && name !== 'pageIssue')) },
  }
  const r = rig([lane('/repo'), issue('I1')], { schema })
  try {
    const count = countedOutside(() => r.push(issue('I2')))
    // Recorded on landed 35e707ac7e, including the existing mission relations.
    expect(outsideTotal(count)).toBe(1)
    expect(count.plain).toEqual({ written: 23, deleted: 1, iterated: 7, copied: 0 })
    const ref = { kind: 'codex-thread', value: 'compatibility' }
    r.push(session('S1', { issueId: 'I1', status: 'exited', resume: ref }),
      session('S2', { issueId: 'I1', status: 'hibernated', resume: ref }))
    expect(r.many('issue', 'I1', 'missionSessions')).toEqual(['S2'])
    r.push(session('S1', { issueId: 'I1', status: 'live', resume: ref }))
    expect(r.many('issue', 'I1', 'missionSessions')).toEqual(['S1', 'S2'])
    r.check()
  } finally { r.dispose() }
})

type MapLike = { forEach(fn: (value: unknown, key: unknown) => void): void }
/** Every set the engine holds, by container and key: the object and its size. */
type Held = Map<string, { set: SetLike; size: number }>

/**
 * The sets the relation engine holds (M3 §7 G4, from
 * `harness/review/m3-index-identity.test.ts`): each link's `under`, `buckets`
 * and `coldBuckets`, and each collapse's `groups`, keyed by container and key.
 * Read outside `countedOutside`, so taking it is never counted.
 */
function held(pool: MobxPool): Held {
  const out: Held = new Map()
  const engine = pool.graph as unknown as {
    links: Map<string, Record<string, unknown>>
    collapses: Map<string, { groups: MapLike }>
  }
  const take = (label: string, container: unknown): void => {
    if (container === null || container === undefined) return
    ;(container as MapLike).forEach((value, key) => {
      const set = value as SetLike
      out.set(`${label}:${String(key)}`, { set, size: set.size })
    })
  }
  tracked(() => {
    for (const [name, link] of engine.links) {
      for (const field of ['under', 'buckets', 'coldBuckets']) take(`${name}.${field}`, link[field])
    }
    for (const [entity, collapse] of engine.collapses) take(`${entity}.groups`, collapse.groups)
  })
  return out
}

/**
 * Sets held both before and after one change that are different objects: a
 * copy-on-write, by ANY idiom. The counters cannot see a copy no patched
 * method makes (`set.union(new Set())` copies natively, `structuredClone(set)`
 * calls no prototype method); an in-place update keeps the object, a copy
 * swaps it.
 */
function replaced(before: Held, after: Held): { keys: number; elements: number } {
  let keys = 0
  let elements = 0
  for (const [key, was] of before) {
    const now = after.get(key)
    if (now === undefined || now.set === was.set) continue
    keys += 1
    elements += now.size
  }
  return { keys, elements }
}

describe('bucket upkeep is proportional to the change, not to the bucket (M3 F1)', () => {
  // The live export's largest buckets: repo.issues 4,574, worktree.sessions
  // 2,263 (docs/decisions/pod-4545-round-three-shape-review.md §2.3). One
  // bucket per relation kind (belongsTo, prefix) at 4,000 members.
  const B = 4000
  /** The bound: one element per edge moved, whatever the bucket's size. */
  const PER_EDGE = 1
  /**
   * The plain bound (M3 G3), also whatever the bucket's size: the change's own
   * bookkeeping, plus the prefix index. The bookkeeping, counted on clean code
   * at 10-15 per edge: the netted move (`RelationEngine.move`: the pending
   * map's three levels written, then read once by `flush`), the flipped-issue
   * check, the dedupe key pair (`new Set([oldKey, newKey])`), the replay
   * source's row entry and listener copy, the read fence's first sight of a
   * new row, the model cache's delete of a removed one, the one object's
   * memo entry when the worklist takes a new issue, and one memo entry per
   * cached group its first reactive read builds (`cached.ts`: visible,
   * standing, present, retained; 4, whatever the bucket's size — measured
   * by POD-4758 on POD-4755's model, 15 written + 1 deleted + 5 iterated
   * for a new issue at 4,000). With one filing reaction per issue in memory
   * (POD-4757) a new issue writes its reaction's handle and one entry per
   * sorted list it enters (`sorted-lanes.ts`): 17 written + 2 deleted + 4
   * iterated, still whatever the bucket's size. The prefix index
   * (`place`) adds or deletes one entry per ancestor path of the row's path,
   * creates or drops at most one set per path, and records the placement once.
   */
  const PLAIN_BOOKKEEPING = 23
  const plainBound = (path: string | null): number =>
    PLAIN_BOOKKEEPING + (path === null ? 0 : 2 * [...ancestorPaths(path)].length + 1)
  const big: RowRecord[] = [lane('/repo')]
  for (let i = 0; i < B; i += 1) {
    big.push(issue(`B${i}`), session(`BS${i}`, { cwd: `/repo/x${i}` }))
  }

  it(`one insert and one delete touch ${PER_EDGE} element each in a bucket of ${B}`, () => {
    const r = rig(big)
    try {
      expect(tracked(() => r.pool.graph.size('repo', 'R', 'issues'))).toBe(B)
      expect(tracked(() => r.pool.graph.size('worktree', '/repo', 'sessions'))).toBe(B)
      /** `path`: the row's path in the prefix index, when it has one. */
      const touched = (label: string, path: string | null, ...change: RowRecord[]): void => {
        const sets = held(r.pool)
        const outside = countedOutside(() => r.push(...change))
        const swapped = replaced(sets, held(r.pool))
        // The evidence: counted outside the pool (M3 re-review G1).
        expect(outsideTotal(outside), `${label}: ${JSON.stringify(outside)}`).toBe(PER_EDGE)
        // The published stat agrees with it.
        // Plain sets and maps, the prefix index among them (M3 re-review G3).
        expect(
          plainTotal(outside.plain),
          `${label}: plain ${JSON.stringify(outside.plain)}`,
        ).toBeLessThanOrEqual(plainBound(path))
        // No set the engine held is replaced by a copy, by any idiom (M3 §7 G4).
        expect(swapped, `${label}: sets replaced by a copy`).toEqual({ keys: 0, elements: 0 })
      }
      // belongsTo (issue.repo → repo.issues)
      touched('new issue', null, issue('N1'))
      touched('removed issue', null, gone('issue', 'B7'))
      // prefix (session.worktree → worktree.sessions)
      touched('new session', '/repo/y', session('NS1', { cwd: '/repo/y' }))
      touched('removed session', '/repo/x7', gone('session', 'BS7'))
      expect(tracked(() => r.pool.graph.size('repo', 'R', 'issues'))).toBe(B)
      expect(tracked(() => r.pool.graph.size('worktree', '/repo', 'sessions'))).toBe(B)
      r.check({ issue: ['B7'], session: ['BS7'] })
    } finally {
      r.dispose()
    }
  }, 120_000)

  it('extra-root dispatch skipped on title-only writes; forced dispatch runs it (POD-4671 behavioral plant)', () => {
    // POD-4671 behavioral plant: the extra-root dispatch must run only when a
    // root-bearing field moves (relations.ts `extraMoved`). F1 cannot fail
    // here — the ungated early-return path performs no plain-structure write
    // (Map gets only), so a count-plant stays under 16 either way — and the
    // direct call count on `extraChanged` for a title-only write (0 gated,
    // >= 1 forced) is the right guard. Proven red by forcing the dispatch:
    // under force the gated 0-calls expectation is violated (calls >= 1);
    // restored with delete (the prototype method shows through again). Never
    // weaken this: gate the dispatch instead. Bound stays 16 (F1 `it` above).
    const r = rig(big)
    try {
      const graph = r.pool.graph as unknown as Record<string, (...args: never[]) => unknown>
      const proto = Object.getPrototypeOf(graph) as Record<string, (...args: never[]) => unknown>
      const origChangedExtra = proto['extraChanged'] as (...args: never[]) => unknown
      let changedCalls = 0
      graph['extraChanged'] = (...args: never[]) => {
        changedCalls += 1
        return (origChangedExtra as (...a: never[]) => unknown).apply(graph, args)
      }
      try {
        r.push(issue('B0', { title: 'Renamed B0' }))
        expect(changedCalls, 'gated: no extraChanged on a title-only write').toBe(0)
        graph['extraMoved'] = () => true
        r.push(issue('B1', { title: 'Renamed B1' }))
        expect(changedCalls, 'forced: unconditional dispatch runs extraChanged').toBeGreaterThan(0)
      } finally {
        delete graph['extraChanged']
        delete graph['extraMoved']
      }
      r.check()
    } finally {
      r.dispose()
    }
  }, 120_000)
})

describe('an issue gaining or losing a worktreePath re-files only its path (POD-4671)', () => {
  // One narrow root among a wide corpus: B sessions under /repo, one orphan
  // under /w/unscanned. Gaining or losing the issue path moves that one
  // session, never the B. Counted outside the pool (M3 G1/G3/G4): a
  // whole-corpus re-scan touches B and must fail.
  const B = 1000
  function bigRig(): Rig {
    const rows: RowRecord[] = [lane('/repo'), issue('I1'), session('S1', { cwd: '/w/unscanned/sub' })]
    for (let i = 0; i < B; i += 1) rows.push(session(`BS${i}`, { cwd: `/repo/x${i}` }))
    return rig(rows)
  }

  it('gaining then losing the path touches one session, not the corpus', () => {
    const r = bigRig()
    try {
      expect(r.one('session', 'S1', 'worktree')).toBeNull()
      const gainSets = held(r.pool)
      const gainOutside = countedOutside(() => r.push(issue('I1', { worktreePath: '/w/unscanned' })))
      // The narrow root, spelled as the issue names it.
      expect(r.one('session', 'S1', 'worktree')).toBe('/w/unscanned')
      expect(r.many('worktree', '/w/unscanned', 'sessions')).toEqual(['S1'])
      expect(outsideTotal(gainOutside), `gain: ${JSON.stringify(gainOutside)}`).toBeLessThan(100)
      expect(plainTotal(gainOutside.plain), `gain plain ${JSON.stringify(gainOutside.plain)}`).toBeLessThan(100)
      expect(replaced(gainSets, held(r.pool)), 'gain: no set replaced').toEqual({
        keys: 0,
        elements: 0,
      })
      const loseSets = held(r.pool)
      const loseOutside = countedOutside(() => r.push(issue('I1', { worktreePath: null })))
      expect(r.one('session', 'S1', 'worktree')).toBeNull()
      expect(outsideTotal(loseOutside), `lose: ${JSON.stringify(loseOutside)}`).toBeLessThan(100)
      expect(replaced(loseSets, held(r.pool)), 'lose: no set replaced').toEqual({
        keys: 0,
        elements: 0,
      })
      r.check()
    } finally {
      r.dispose()
    }
  }, 120_000)

  it('a whole-corpus re-scan plant fails the count', () => {
    const r = bigRig()
    try {
      r.push(issue('I1', { worktreePath: '/w/unscanned' }))
      // Plant: build a set of every session id to find those under the path,
      // instead of the under index (the corpus walk POD-4671 forbids). Each
      // add is plain work the outside counter sees.
      const ids: string[] = []
      for (let i = 0; i < B; i += 1) ids.push(`BS${i}`)
      ids.push('S1')
      const outside = countedOutside(() => {
        void new Set(ids)
      })
      // The plant touches B: the count sees it, so a real re-scan would fail
      // the <100 bound above.
      expect(plainTotal(outside.plain)).toBeGreaterThan(B)
    } finally {
      r.dispose()
    }
  })
})

// ---------------------------------- the views resolve through the engine (M3 F2)

describe('the row views resolve relations through the engine (M3 F2)', () => {
  // Two repos with distinct prefixes; I3 is a spin-off of I2.
  const rows = [
    lane('/repo', 'R', { prefix: 'POD' }),
    lane('/other', 'RB', { repoPath: '/other', prefix: 'XYZ' }),
    issue('I1'),
    issue('I2'),
    issue('I3', { deps: [{ id: 'I2', type: 'discovered-from' }] }),
  ]

  /** Plant a wrong target into the engine's forward slot of `from.relation` for `id`. */
  function plant(r: Rig, relation: string, id: string, target: string): void {
    const links = (
      r.pool.graph as unknown as {
        links: Map<string, { forward: { set(id: string, target: string): void } }>
      }
    ).links
    const link = links.get(`issue.${relation}`)
    if (link === undefined) throw new Error(`no link issue.${relation}`)
    runInAction(() => link.forward.set(id, target))
  }

  const view = (r: Rig, id: string) => tracked(() => rowViewOf(r.pool.issue(id)))
  const rebuilt = (r: Rig) => rebuildSnapshot(r.replay.source, r.locals.source)

  it('a wrong issue.repo forward slot reaches displayRef, and the rebuild disagrees', () => {
    const r = rig(rows)
    try {
      const keep = autorun(() => rowViewOf(r.pool.issue('I1')))
      expect(view(r, 'I1')?.displayRef).toBe('POD-1')
      expect(snapshotPool(r.pool).rowsById).toEqual(rebuilt(r).rowsById)
      plant(r, 'repo', 'I1', 'RB')
      expect(view(r, 'I1')?.displayRef, 'the view reads the engine').toBe('XYZ-1')
      expect(rebuilt(r).rowsById['I1']?.displayRef, 'the scan resolves from the row').toBe('POD-1')
      expect(snapshotPool(r.pool).rowsById).not.toEqual(rebuilt(r).rowsById)
      keep()
    } finally {
      r.dispose()
    }
  })

  // `SliceRow` (the rebuild's output) carries no `originTick`, so here the
  // row-view assertion is the check; the gate's per-step relation diff
  // (`diffRelations`) sees the slot itself.
  it('a wrong issue.discoveredFrom forward slot reaches originTick', () => {
    const r = rig(rows)
    try {
      const keep = autorun(() => rowViewOf(r.pool.issue('I3')))
      expect(view(r, 'I3')?.originTick?.id).toBe('I2')
      plant(r, 'discoveredFrom', 'I3', 'I1')
      expect(view(r, 'I3')?.originTick?.id, 'the view reads the engine').toBe('I1')
      expect(tracked(() => diffRelations(r.pool.graph, r.pool.tables))).toEqual([
        'issue:I3.discoveredFrom: live "I1", scan "I2"',
      ])
      keep()
    } finally {
      r.dispose()
    }
  })
})

// ------------------------------------------------- a relation added to the schema

describe('a relation added to the schema needs no arm code', () => {
  it('maintains a fixture schema with one extra relation (issue.coordinator / session.coordinates)', () => {
    const fixture: ModelSchema = {
      ...SCHEMA,
      issue: {
        ...SCHEMA.issue,
        relations: {
          ...SCHEMA.issue.relations,
          coordinator: {
            kind: 'belongsTo',
            to: 'session',
            foreignKey: 'coordinatorSessionId',
            targetKey: 'sessionId',
            inverse: 'coordinates',
            lazy: true,
            why: 'fixture: one extra relation',
          } as RelationSpec,
        },
      },
      session: {
        ...SCHEMA.session,
        relations: {
          ...SCHEMA.session.relations,
          coordinates: {
            kind: 'hasMany',
            to: 'issue',
            inverse: 'coordinator',
            lazy: true,
            why: 'fixture: its inverse',
          } as RelationSpec,
        },
      },
    }
    expect(validateStructure(fixture)).toEqual([])
    // The fence checks relation names against the REAL schema, so this pool runs unfenced.
    const r = rig(
      [issue('I1', { coordinatorSessionId: 'S1' }), issue('I2'), session('S1'), session('S2')],
      { fence: false, schema: fixture },
    )
    try {
      expect(r.many('session', 'S1', 'coordinates')).toEqual(['I1'])
      expect(r.one('issue', 'I1', 'coordinator')).toBe('S1')
      r.push(
        issue('I2', { coordinatorSessionId: 'S1' }),
        issue('I1', { coordinatorSessionId: 'S2' }),
      )
      expect(r.many('session', 'S1', 'coordinates')).toEqual(['I2'])
      expect(r.many('session', 'S2', 'coordinates')).toEqual(['I1'])
      r.push(gone('issue', 'I2'))
      expect(r.many('session', 'S1', 'coordinates')).toEqual([])
      r.check()
      // The real schema's pool does not know the relation.
      const real = rig([issue('I1')], { fence: false })
      try {
        expect(() => real.pool.graph.many('session', 'S1', 'coordinates')).toThrow(
          /not a declared relation/,
        )
      } finally {
        real.dispose()
      }
    } finally {
      r.dispose()
    }
  })
})

// ------------------------------------------------------------ random sequences

/** mulberry32, as the fixture uses. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ISSUES = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6']
const SESSIONS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']
// One spelling per root: with both `a` and `a/` present the declared
// resolver breaks the tie by table order, which no pool shares.
const PATHS = ['/r', '/r/a', '/r/a/b', '/r/ab', '/s', '/', '/r/a/b/c']
const REPOS = ['R', 'RB']
const REFS = [{ kind: 'k', value: '1' }, { kind: 'k', value: '2' }, undefined]
const STATUSES = ['live', 'starting', 'hibernated', 'exited', 'reconnecting']

function randomRow(rand: () => number): RowRecord {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const maybe = <T>(value: T): T | null => (rand() < 0.3 ? null : value)
  const kind = pick(['issue', 'issue', 'session', 'session', 'session', 'worktree'] as const)
  if (rand() < 0.15) {
    const id = kind === 'issue' ? pick(ISSUES) : kind === 'session' ? pick(SESSIONS) : pick(PATHS)
    return gone(kind, id)
  }
  if (kind === 'issue') {
    return issue(pick(ISSUES), {
      parentId: maybe(pick(ISSUES)),
      archived: rand() < 0.15,
      deletedAt: rand() < 0.1 ? T0 : null,
      repoId: maybe(pick(REPOS)),
      worktreePath: maybe(pick(PATHS)),
      deps:
        rand() < 0.5
          ? [{ id: pick(ISSUES), type: rand() < 0.8 ? 'discovered-from' : 'blocks' }]
          : [],
    })
  }
  if (kind === 'session') {
    return session(pick(SESSIONS), {
      issueId: maybe(pick(ISSUES)),
      cwd: `${pick(PATHS)}${rand() < 0.5 ? '/x' : ''}`,
      headless: rand() < 0.1,
      status: pick(STATUSES),
      lastActiveAt: at(Math.floor(rand() * 4)),
      resume: pick(REFS),
    })
  }
  return lane(pick(PATHS), pick(REPOS))
}

describe('random sequences against the from-scratch scan', () => {
  const universe = { issue: ISSUES, session: SESSIONS, worktree: PATHS, repo: REPOS }

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: 300 steps, every relation of every id equal after each`, () => {
      const rand = prng(seed)
      const r = rig([], { fence: seed % 2 === 0 })
      try {
        for (let step = 0; step < 300; step += 1) {
          const batch = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => randomRow(rand))
          const event: RowSourceEvent =
            rand() < 0.05
              ? { type: 'replace', rows: batch.filter((row) => row.value !== undefined) }
              : { type: 'update', rows: batch }
          r.replay.push(event)
          const diff = tracked(() => diffRelations(r.pool.graph, r.pool.tables, SCHEMA, universe))
          if (diff.length > 0) {
            throw new Error(
              `seed ${seed} step ${step} (${JSON.stringify(event)}):\n${diff.join('\n')}`,
            )
          }
        }
      } finally {
        r.dispose()
      }
    })
  }

  it('the check can fail: a pool deaf to removals diverges', () => {
    const r = rig([issue('I1'), issue('I2', { parentId: 'I1' })], { fence: false })
    try {
      // Remove the row behind the engine's back.
      runInAction(() => r.pool.tables.issue.delete('I2'))
      const diff = tracked(() => diffRelations(r.pool.graph, r.pool.tables))
      expect(diff.join('\n')).toMatch(/issue:I1\.children: live \["I2"\], scan \[\]/)
    } finally {
      r.dispose()
    }
  })
})
