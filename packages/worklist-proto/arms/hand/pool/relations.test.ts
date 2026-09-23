/**
 * POD-4579 (Ha2) — the pool's relations, maintained from the declared schema
 * (`relations.ts`), held to a from-scratch resolution (`scanRelations`,
 * `enumerate.ts`) and to the rules of `docs/plans/pod-4545-round-three-
 * schema.md` §4.
 *
 * Hand-built rows through the pool's own feed path (a replay source, the reads
 * fence ON unless a test says otherwise), so every test sees exactly the
 * relation it names:
 * - per relation: insert attaches both directions, a key change detaches the
 *   old and attaches the new, delete removes from every inverse, evict then
 *   re-add restores (both sides, and a mounted row hears it), the prefix
 *   relation re-resolves on root add and remove, the edge relation follows
 *   `deps`;
 * - the resume-twin collapse (`session.collapse`) in both directions, by hand
 *   and on the corpus against the legacy `dedupeSessions`;
 * - the doc's §4.5 worked example, verbatim;
 * - the reads fence: a lookup costs one read, and each change kind writes
 *   exactly the relation slots it touches (`lastWrites`); upkeep does not
 *   grow with the bucket (M3 F1);
 * - a fixture schema with one EXTRA relation, maintained with no arm code;
 * - seeded random sequences over a small id universe (collisions on
 *   purpose), compared with the scan after every step, and a plant that
 *   proves the comparison can fail.
 */

import { dedupeSessions } from '@podium/client-core/engine'
import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { writeResult } from '../../../harness/src/results'
import {
  createReadFence,
  DISABLED_READ_FENCE,
  type ReadFence,
} from '../../../shared/src/instrument/reads'
import { type SettableLocalsHandle, settableLocals } from '../../../shared/src/locals-source'
import {
  type EntityName,
  type ModelSchema,
  type RelationSpec,
  SCHEMA,
  validateStructure,
} from '../../../shared/src/schema'
import type { RowRecord, RowSourceEvent } from '../../../shared/src/stats'
import { diffRelations } from './enumerate'
import { HandPool } from './pool'

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
  pool: HandPool
  reads: ReadFence
  replay: ReplaySource
  locals: SettableLocalsHandle
  push(...rows: RowRecord[]): void
  /** The engine's answers (collections sorted: a bucket has no order). */
  one(from: EntityName, id: string, relation: string): string | null
  many(from: EntityName, id: string, relation: string): string[]
  /** Relation slots the last push wrote, distinct and sorted. */
  writes(): string[]
  /** The engine against a from-scratch scan of the same tables. */
  check(extra?: Partial<Record<EntityName, string[]>>): void
  dispose(): void
}

function rig(rows: RowRecord[], options: { fence?: boolean; schema?: ModelSchema } = {}): Rig {
  const replay = createReplaySource({
    issues: rows.filter((row) => row.kind === 'issue'),
    sessions: rows.filter((row) => row.kind === 'session'),
    worktrees: rows.filter((row) => row.kind === 'worktree'),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: Date.parse(T0) })
  const reads = options.fence === false ? DISABLED_READ_FENCE : createReadFence({ enabled: true })
  const pool = new HandPool(reads, locals.source.get(), options.schema)
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
    one: (from, id, relation) => pool.engine.one(from, id, relation),
    many: (from, id, relation) => [...pool.engine.many(from, id, relation)].sort(),
    writes: () =>
      [...new Set(pool.engine.lastWrites.map((write) => `${write.relation}:${write.id}`))].sort(),
    check(extra = {}) {
      const diff = diffRelations(pool.engine, pool.tables, schema, extra)
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
      r.push(issue('I3', { parentId: 'I2' }))
      expect(r.one('issue', 'I3', 'parent')).toBe('I2')
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      expect(r.many('issue', 'I2', 'children')).toEqual(['I3'])
      r.push(issue('I3', { parentId: null }))
      expect(r.one('issue', 'I3', 'parent')).toBeNull()
      expect(r.many('issue', 'I2', 'children')).toEqual([])
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
      r.push(issue('I2', { parentId: 'I1', deletedAt: T0 }))
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      r.push(issue('I2', { parentId: 'I1' }))
      expect(r.one('issue', 'I2', 'parent')).toBe('I1')
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2'])
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('delete removes the row from every inverse; the holder of a deleted target keeps its reference', () => {
    const r = rig([
      issue('I1'),
      issue('I2', { parentId: 'I1', deps: [{ id: 'I1', type: 'discovered-from' }] }),
      session('S1', { issueId: 'I2' }),
    ])
    try {
      r.push(gone('issue', 'I2'))
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      expect(r.many('issue', 'I1', 'spinOffs')).toEqual([])
      expect(r.many('repo', 'R', 'issues')).toEqual(['I1'])
      // S1 still names I2: it keeps the reference and loses the resolution.
      expect(r.one('session', 'S1', 'issue')).toBeNull()
      expect(r.many('issue', 'I2', 'sessions')).toEqual(['S1'])
      r.check({ issue: ['I2'] })
    } finally {
      r.dispose()
    }
  })

  it('evict then re-add restores the relation from either side (the round-two hand bug)', () => {
    const r = rig([issue('I1'), issue('I2', { parentId: 'I1' })])
    try {
      r.push(gone('issue', 'I1'))
      expect(r.one('issue', 'I2', 'parent')).toBeNull()
      r.push(issue('I1'))
      expect(r.one('issue', 'I2', 'parent')).toBe('I1')
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2'])
      r.push(gone('issue', 'I2'))
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      r.push(issue('I2', { parentId: 'I1' }))
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2'])
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('a reference that arrives before its target resolves when the target lands', () => {
    const r = rig([issue('I2', { parentId: 'I1' })])
    try {
      expect(r.one('issue', 'I2', 'parent')).toBeNull()
      r.push(issue('I1'))
      expect(r.one('issue', 'I2', 'parent')).toBe('I1')
      expect(r.many('issue', 'I1', 'children')).toEqual(['I2'])
      r.check()
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
      r.push(session('S1', { issueId: 'I2' }))
      expect(r.many('issue', 'I2', 'sessions')).toEqual(['S1'])
      r.push(gone('session', 'S1'))
      expect(r.many('issue', 'I2', 'sessions')).toEqual([])
      r.check()
    } finally {
      r.dispose()
    }
  })
})

describe('session.worktree / worktree.sessions (prefix, R3)', () => {
  const REPO = '/repo'
  const A = '/repo/.worktrees/a'
  it('takes the longest containing root, never a sibling that merely shares a prefix', () => {
    const r = rig([
      lane(REPO),
      lane(A),
      lane('/repo/.worktrees/ab'),
      session('S1', { cwd: `${A}/src` }),
      session('S2', { cwd: '/repo/.worktrees/abc' }),
      session('S3', { cwd: '/nowhere' }),
    ])
    try {
      expect(r.one('session', 'S1', 'worktree')).toBe(A)
      expect(r.one('session', 'S2', 'worktree')).toBe(REPO)
      expect(r.one('session', 'S3', 'worktree')).toBeNull()
      expect(r.many('worktree', A, 'sessions')).toEqual(['S1'])
      expect(r.many('worktree', REPO, 'sessions')).toEqual(['S2'])
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('a new root takes the sessions under it from a shorter root and from none, not from a longer root', () => {
    const deep = `${A}/pkg`
    const r = rig([
      lane('/other'),
      lane(deep),
      session('S1', { cwd: `${A}/x` }),
      session('S2', { cwd: `${deep}/y` }),
      session('S3', { cwd: `${REPO}/z` }),
    ])
    try {
      expect(r.one('session', 'S1', 'worktree')).toBeNull()
      r.push(lane(REPO))
      expect(r.one('session', 'S1', 'worktree')).toBe(REPO)
      expect(r.one('session', 'S3', 'worktree')).toBe(REPO)
      r.push(lane(A))
      expect(r.one('session', 'S1', 'worktree')).toBe(A)
      expect(r.one('session', 'S2', 'worktree')).toBe(deep)
      expect(r.one('session', 'S3', 'worktree')).toBe(REPO)
      expect(r.many('worktree', REPO, 'sessions')).toEqual(['S3'])
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('a removed root hands its sessions to the next-longest root, or to none', () => {
    const r = rig([
      lane(REPO),
      lane(A),
      session('S1', { cwd: `${A}/x` }),
      session('S2', { cwd: A }),
    ])
    try {
      r.push(gone('worktree', A))
      expect(r.one('session', 'S1', 'worktree')).toBe(REPO)
      expect(r.one('session', 'S2', 'worktree')).toBe(REPO)
      expect(r.many('worktree', REPO, 'sessions')).toEqual(['S1', 'S2'])
      expect(r.many('worktree', A, 'sessions')).toEqual([])
      r.push(gone('worktree', REPO))
      expect(r.one('session', 'S1', 'worktree')).toBeNull()
      expect(r.many('worktree', REPO, 'sessions')).toEqual([])
      r.check({ worktree: [A, REPO] })
    } finally {
      r.dispose()
    }
  })

  it('follows a cwd change, and treats `a` and `a/` as one root', () => {
    const r = rig([lane(`${REPO}/`), lane(A), session('S1', { cwd: `${A}/x` })])
    try {
      r.push(session('S1', { cwd: `${REPO}/src` }))
      expect(r.one('session', 'S1', 'worktree')).toBe(`${REPO}/`)
      r.push(session('S1', { cwd: REPO }))
      expect(r.one('session', 'S1', 'worktree')).toBe(`${REPO}/`)
      expect(r.many('worktree', A, 'sessions')).toEqual([])
      r.check()
    } finally {
      r.dispose()
    }
  })
})

describe('issue.discoveredFrom / issue.spinOffs (edge, R4)', () => {
  const from = (id: string, type = 'discovered-from') => ({ deps: [{ id, type }] })

  it('points the spin-off OUT at its origin and lists it IN on the origin; follows deps changes', () => {
    const r = rig([issue('I1'), issue('I2'), issue('I3', from('I1'))])
    try {
      expect(r.one('issue', 'I3', 'discoveredFrom')).toBe('I1')
      expect(r.many('issue', 'I1', 'spinOffs')).toEqual(['I3'])
      // Direction: the origin has no origin, the spin-off no spin-offs.
      expect(r.one('issue', 'I1', 'discoveredFrom')).toBeNull()
      expect(r.many('issue', 'I3', 'spinOffs')).toEqual([])
      r.push(issue('I3', from('I2')))
      expect(r.many('issue', 'I1', 'spinOffs')).toEqual([])
      expect(r.many('issue', 'I2', 'spinOffs')).toEqual(['I3'])
      // An edge of another type is not this relation.
      r.push(issue('I3', from('I2', 'blocks')))
      expect(r.one('issue', 'I3', 'discoveredFrom')).toBeNull()
      expect(r.many('issue', 'I2', 'spinOffs')).toEqual([])
      r.push(issue('I3', from('I1')), gone('issue', 'I1'))
      expect(r.one('issue', 'I3', 'discoveredFrom')).toBeNull()
      r.push(issue('I1'))
      expect(r.one('issue', 'I3', 'discoveredFrom')).toBe('I1')
      expect(r.many('issue', 'I1', 'spinOffs')).toEqual(['I3'])
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
      lane('/b', 'RB'),
      issue('I1', { worktreePath: '/repo' }),
      issue('I2', { repoId: 'RB', worktreePath: '/b' }),
    ])
    try {
      expect(r.many('worktree', '/repo', 'issues')).toEqual(['I1'])
      expect(r.many('repo', 'R', 'issues')).toEqual(['I1'])
      expect(r.many('repo', 'RB', 'issues')).toEqual(['I2'])
      expect(r.many('repo', 'R', 'worktrees')).toEqual(['/repo'])
      r.push(issue('I1', { repoId: 'RB', worktreePath: '/b' }))
      expect(r.many('worktree', '/b', 'issues')).toEqual(['I1', 'I2'])
      expect(r.many('repo', 'R', 'issues')).toEqual([])
      r.push(lane('/b', 'R'))
      expect(r.many('repo', 'R', 'worktrees')).toEqual(['/b', '/repo'])
      expect(r.many('repo', 'RB', 'worktrees')).toEqual([])
      r.check()
    } finally {
      r.dispose()
    }
  })

  it('a repo whose lane leaves is held by another lane of it, found in repo.worktrees; it leaves with the last', () => {
    const r = rig([lane('/a'), lane('/b'), lane('/c', 'RC'), issue('I1')])
    try {
      const held = r.pool.tables.repo.get('R')
      r.push(gone('worktree', held === r.pool.tables.worktree.get('/a') ? '/a' : '/b'))
      expect(r.pool.tables.repo.has('R')).toBe(true)
      expect(r.one('issue', 'I1', 'repo')).toBe('R')
      const left = r.many('repo', 'R', 'worktrees')
      expect(left).toHaveLength(1)
      expect(r.pool.tables.repo.get('R')).toBe(r.pool.tables.worktree.get(left[0] as string))
      r.push(gone('worktree', left[0] as string))
      expect(r.pool.tables.repo.has('R')).toBe(false)
      expect(r.one('issue', 'I1', 'repo')).toBeNull()
      expect(r.many('repo', 'R', 'issues')).toEqual(['I1'])
      r.push(lane('/a'))
      expect(r.one('issue', 'I1', 'repo')).toBe('R')
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
        status: 'exited',
        lastActiveAt: at(1),
        resume: ref,
      }),
      session('S2', {
        issueId: 'I1',
        cwd: '/repo',
        status: 'hibernated',
        lastActiveAt: at(0),
        resume: ref,
      }),
    ])
    try {
      // hibernated outranks exited, whatever the recency.
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S2'])
      expect(r.many('worktree', '/repo', 'sessions')).toEqual(['S2'])
      expect(r.pool.engine.isCollapsed('session', 'S1')).toBe(true)
      expect(r.one('session', 'S1', 'issue')).toBeNull()
      // The exited twin comes back live: the group is kept in full.
      r.push(
        session('S1', {
          issueId: 'I1',
          cwd: '/repo',
          status: 'live',
          lastActiveAt: at(2),
          resume: ref,
        }),
      )
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S1', 'S2'])
      expect(r.pool.engine.isCollapsed('session', 'S1')).toBe(false)
      // Its heartbeat decides nothing (the group stays whole) and writes no slot.
      r.push(
        session('S1', {
          issueId: 'I1',
          cwd: '/repo',
          status: 'live',
          lastActiveAt: at(3),
          resume: ref,
        }),
      )
      expect(r.writes()).toEqual([])
      // It exits again: the hibernated twin wins once more.
      r.push(
        session('S1', {
          issueId: 'I1',
          cwd: '/repo',
          status: 'exited',
          lastActiveAt: at(3),
          resume: ref,
        }),
      )
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S2'])
      // The kept row leaves: its twin is the only row, so it is back.
      r.push(gone('session', 'S2'))
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S1'])
      expect(r.pool.engine.isCollapsed('session', 'S1')).toBe(false)
      r.check()
    } finally {
      r.dispose()
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
          expect(r.pool.engine.isCollapsed('session', id), id).toBe(!legacy.includes(id))
        }
        directions.add(kept.length < group.sessionIds.length ? 'collapsed' : 'kept in full')
      }
      // Both directions occur: all-inactive groups collapse, a group with a live row does not.
      expect([...directions].sort()).toEqual(['collapsed', 'kept in full'])
      // And nothing else in the corpus collapses that the legacy keeps (or the reverse).
      const collapsedByPool = corpus.sliceSessions
        .map((row) => row.sessionId)
        .filter((id) => r.pool.engine.isCollapsed('session', id))
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
      expect(r.writes()).toEqual(['issue.sessions:I2', 'session.issue:S2'])

      // 2. I2 is archived: R1 re-evaluates, worktree and repo stay.
      r.push(issue('I2', { parentId: 'I1', worktreePath: Wi2, archived: true }))
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      expect(r.one('issue', 'I2', 'parent')).toBeNull()
      expect(r.one('issue', 'I2', 'worktree')).toBe(Wi2)
      expect(r.one('issue', 'I2', 'repo')).toBe('R')
      expect(r.writes()).toEqual(['issue.children:I1', 'issue.parent:I2'])

      // 3. Wi2 is removed: I2 keeps its reference id, S2 moves to W.
      r.push(gone('worktree', Wi2))
      expect(r.one('issue', 'I2', 'worktree')).toBeNull()
      expect(r.one('session', 'S2', 'worktree')).toBe(W)
      expect(r.many('worktree', W, 'sessions')).toEqual(['S1', 'S2'])
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

  it('a single-valued lookup costs one read; a collection one per member; a size none', () => {
    const r = rig(rows)
    try {
      const fenced = r.pool.relations
      for (const [from, id, relation] of [
        ['issue', 'I2', 'parent'],
        ['issue', 'I3', 'discoveredFrom'],
        ['issue', 'I1', 'repo'],
        ['session', 'S1', 'worktree'],
        ['session', 'S1', 'issue'],
        ['worktree', '/repo', 'repo'],
      ] as const) {
        r.reads.reset()
        expect(fenced.one(from, id, relation), `${from}.${relation}`).not.toBeNull()
        expect(r.reads.stats().rows, `${from}.${relation}`).toBe(1)
      }
      r.reads.reset()
      expect([...fenced.many('issue', 'I1', 'children')].sort()).toEqual(['I2', 'I3'])
      expect(r.reads.stats().rows).toBe(2)
      r.reads.reset()
      expect(fenced.size('repo', 'R', 'issues')).toBe(4)
      expect(r.reads.stats().rows).toBe(0)
    } finally {
      r.dispose()
    }
  })

  /** Each change kind, and exactly the relation slots it may write. */
  const KINDS: { name: string; change: RowRecord[]; writes: string[] }[] = [
    {
      name: 'heartbeat',
      change: [session('S2', { issueId: 'I1', cwd: '/repo/y', lastActiveAt: at(3) })],
      writes: [],
    },
    { name: 'rename', change: [issue('I4', { title: 'Renamed' })], writes: [] },
    {
      name: 'new issue',
      change: [issue('I9')],
      writes: ['issue.repo:I9', 'repo.issues:R'],
    },
    {
      name: 'reparent',
      change: [issue('I2', { parentId: 'I4' })],
      writes: ['issue.children:I1', 'issue.children:I4', 'issue.parent:I2'],
    },
    {
      name: 'archive',
      change: [issue('I2', { parentId: 'I1', archived: true })],
      writes: ['issue.children:I1', 'issue.parent:I2'],
    },
    {
      name: 'session moves issue',
      change: [session('S2', { issueId: 'I4', cwd: '/repo/y' })],
      writes: ['issue.sessions:I1', 'issue.sessions:I4', 'session.issue:S2'],
    },
    {
      name: 'session moves lane',
      change: [session('S2', { issueId: 'I1', cwd: '/repo/.worktrees/a/q' })],
      writes: [
        'session.worktree:S2',
        'worktree.sessions:/repo',
        'worktree.sessions:/repo/.worktrees/a',
      ],
    },
    {
      name: 'deps change',
      change: [issue('I3', { parentId: 'I1', deps: [{ id: 'I4', type: 'discovered-from' }] })],
      writes: ['issue.discoveredFrom:I3', 'issue.spinOffs:I2', 'issue.spinOffs:I4'],
    },
    {
      name: 'new session',
      change: [session('S9', { issueId: 'I4', cwd: '/repo/z' })],
      writes: [
        'issue.sessions:I4',
        'session.issue:S9',
        'session.worktree:S9',
        'worktree.sessions:/repo',
      ],
    },
    {
      name: 'remove session',
      change: [gone('session', 'S3')],
      writes: [
        'issue.sessions:I4',
        'session.issue:S3',
        'session.worktree:S3',
        'worktree.sessions:/repo/.worktrees/a',
      ],
    },
    {
      name: 'new lane',
      change: [lane('/repo/.worktrees/b')],
      writes: ['repo.worktrees:R', 'worktree.repo:/repo/.worktrees/b'],
    },
    {
      name: 'new lane over sessions',
      change: [lane('/repo/y')],
      writes: [
        'repo.worktrees:R',
        'session.worktree:S2',
        'worktree.repo:/repo/y',
        'worktree.sessions:/repo',
        'worktree.sessions:/repo/y',
      ],
    },
    {
      name: 'remove lane',
      change: [gone('worktree', '/repo/.worktrees/a')],
      writes: [
        'repo.worktrees:R',
        'session.worktree:S1',
        'session.worktree:S3',
        'worktree.repo:/repo/.worktrees/a',
        'worktree.sessions:/repo',
        'worktree.sessions:/repo/.worktrees/a',
      ],
    },
    {
      name: 'evict a parent',
      change: [gone('issue', 'I1')],
      writes: ['issue.repo:I1', 'repo.issues:R'],
    },
  ]

  const cells: { kind: string; slots: number; elements: number; rowsRead: number }[] = []

  for (const kind of KINDS) {
    it(`${kind.name} writes only the slots it touches`, () => {
      const r = rig(rows)
      try {
        const before = r.pool.stats.indexUpdates
        r.reads.reset()
        r.push(...kind.change)
        expect(r.writes()).toEqual([...kind.writes].sort())
        const elements = r.pool.stats.indexUpdates - before
        if (kind.writes.length === 0) expect(elements).toBe(0)
        cells.push({
          kind: kind.name,
          slots: kind.writes.length,
          elements,
          rowsRead: r.reads.stats().rows,
        })
        r.check({ issue: ['I1'] })
      } finally {
        r.dispose()
      }
    })
  }

  it('records the per-kind cells', () => {
    expect(cells).toHaveLength(KINDS.length)
    writeResult('hand-pool-relation-writes', { cells })
  })

  it('a relation write dirties only the cells that read that slot, and the row that changed is told', () => {
    const r = rig([
      issue('I1', { updatedAt: at(0) }),
      issue('I2', { updatedAt: at(0) }),
      session('S1', { issueId: 'I1', lastActiveAt: at(5) }),
    ])
    try {
      const heard: string[] = []
      const offs = ['I1', 'I2'].map((id) =>
        r.pool.subscribe(id, () => {
          heard.push(id)
        }),
      )
      expect(r.pool.view('I1')?.activityAt).toBe(Date.parse(at(5)))
      expect(r.pool.view('I2')?.activityAt).toBe(Date.parse(at(0)))
      const runs = r.pool.stats.counters.cellRuns
      // S2 joins I2: I2's `activityAt` re-runs (and its view); nothing of I1 does.
      r.push(session('S2', { issueId: 'I2', lastActiveAt: at(7) }))
      expect(heard).toEqual(['I2'])
      expect(r.pool.view('I2')?.activityAt).toBe(Date.parse(at(7)))
      // sessionIds:I2 (the one reader of the bucket, POD-4581), activity:S2
      // (the new member's contribution, its first run), activityAt:I2,
      // loading:I2 (POD-4580: it asks each member's residency) and view:I2
      // only: a non-draft's title reads no member.
      expect(r.pool.stats.counters.cellRuns - runs).toBe(5)
      // Evict S1 then re-add it: I1 falls back to its own time and comes back.
      heard.length = 0
      r.push(gone('session', 'S1'))
      expect(r.pool.view('I1')?.activityAt).toBe(Date.parse(at(0)))
      r.push(session('S1', { issueId: 'I1', lastActiveAt: at(5) }))
      expect(r.pool.view('I1')?.activityAt).toBe(Date.parse(at(5)))
      expect(heard).toEqual(['I1', 'I1'])
      // Evict the ISSUE then re-add it: its sessions were kept under its id.
      heard.length = 0
      r.push(gone('issue', 'I1'))
      expect(r.pool.view('I1')).toBeUndefined()
      r.push(issue('I1', { updatedAt: at(0) }))
      expect(r.pool.view('I1')?.activityAt).toBe(Date.parse(at(5)))
      expect(heard).toEqual(['I1', 'I1'])
      for (const off of offs) off()
    } finally {
      r.dispose()
    }
  })

  it('upkeep does not grow with the bucket: one new issue in a repo of 1,000 touches what it does in a repo of 1', () => {
    const cost = (size: number): { elements: number; rowsRead: number; sameBucket: boolean } => {
      const r = rig(Array.from({ length: size }, (_, i) => issue(`I${i + 1}`)))
      try {
        const bucket = r.pool.engine.members('repo', 'R', 'issues')
        const before = r.pool.stats.indexUpdates
        r.reads.reset()
        r.push(issue('I99999'))
        return {
          elements: r.pool.stats.indexUpdates - before,
          rowsRead: r.reads.stats().rows,
          sameBucket: r.pool.engine.members('repo', 'R', 'issues') === bucket,
        }
      } finally {
        r.dispose()
      }
    }
    const small = cost(1)
    const large = cost(1_000)
    expect(large).toEqual(small)
    expect(large.sameBucket).toBe(true)
    expect(large.elements).toBeLessThanOrEqual(4)
  })

  /**
   * M3 F1's bound, on the live shape (one repo holds 4,574 of 5,170 issues):
   * one add to and one remove from a bucket of b members touch O(1) elements,
   * independent of b. Counted twice: by the engine (`indexUpdates`, at most 4
   * per edge: the member and the forward entry, detach or attach), and by an
   * instrument the engine cannot under-report to — every `Set` add, delete
   * and iterator step, every `Map` set, delete and iterator step (POD-4580,
   * the coordinator's G3: a claim counted from outside patches plain `Map`
   * too), and every element an `Array.prototype.sort` is handed,
   * process-wide, for the ingest. The same count at b = 4,000 and b = 8,000
   * is the O(1) claim; the planted copy-and-sort (the MobX shape) and a
   * planted copy of the forward `Map` must each break it.
   */
  describe('bucket upkeep is O(1) in the bucket (M3 F1)', () => {
    /** Elements any `Set`, `Map` or sort touched while `run` ran. */
    function elementOps(run: () => void): number {
      type Method = (this: unknown, ...args: unknown[]) => unknown
      type Patched = { [name: string]: Method }
      const targets: [Patched, string, (self: unknown) => number][] = [
        [Set.prototype as unknown as Patched, 'add', () => 1],
        [Set.prototype as unknown as Patched, 'delete', () => 1],
        [Object.getPrototypeOf(new Set<unknown>().values()) as Patched, 'next', () => 1],
        [Map.prototype as unknown as Patched, 'set', () => 1],
        [Map.prototype as unknown as Patched, 'delete', () => 1],
        [Object.getPrototypeOf(new Map<unknown, unknown>().entries()) as Patched, 'next', () => 1],
        [Array.prototype as unknown as Patched, 'sort', (self) => (self as unknown[]).length],
      ]
      let ops = 0
      const saved = targets.map(([proto, name, weight]) => {
        const original = proto[name] as Method
        proto[name] = function (this: unknown, ...args: unknown[]) {
          ops += weight(this)
          return original.apply(this, args)
        }
        return () => {
          proto[name] = original
        }
      })
      try {
        run()
      } finally {
        for (const restore of saved) restore()
      }
      return ops
    }

    type Edit = { elements: number; ops: number }

    /** One add of a new issue to repo R's bucket of `size`, then one remove of an old member. */
    function upkeep(size: number, plant?: (r: Rig) => void): { add: Edit; remove: Edit } {
      const r = rig(
        Array.from({ length: size }, (_, i) => issue(`I${i + 1}`)),
        { fence: false },
      )
      try {
        plant?.(r)
        expect(r.pool.engine.members('repo', 'R', 'issues').size).toBe(size)
        const measure = (change: RowRecord): Edit => {
          const before = r.pool.stats.indexUpdates
          const ops = elementOps(() => r.push(change))
          return { elements: r.pool.stats.indexUpdates - before, ops }
        }
        const add = measure(issue('I99999'))
        const remove = measure(gone('issue', `I${Math.ceil(size / 2)}`))
        expect(r.pool.engine.members('repo', 'R', 'issues').size).toBe(size)
        r.check()
        return { add, remove }
      } finally {
        r.dispose()
      }
    }

    /** The MobX shape: every membership change copies and re-sorts the buckets it touched. */
    function copyAndSort(r: Rig): void {
      type Bucketed = { buckets: Map<string, Set<string>>; forward: Map<string, string> }
      const engine = r.pool.engine as unknown as {
        point(link: Bucketed, id: string, target: string | null): void
      }
      const point = engine.point.bind(engine)
      engine.point = (link, id, target) => {
        const old = link.forward.get(id)
        point(link, id, target)
        for (const key of [old, target]) {
          const bucket = key == null ? undefined : link.buckets.get(key)
          if (key != null && bucket !== undefined)
            link.buckets.set(key, new Set([...bucket].sort()))
        }
      }
    }

    /** A `Map`-shaped copy: every membership change rebuilds the link's forward map. */
    function forwardCopy(r: Rig): void {
      type Linked = { forward: Map<string, string> }
      const engine = r.pool.engine as unknown as {
        point(link: Linked, id: string, target: string | null): void
      }
      const point = engine.point.bind(engine)
      engine.point = (link, id, target) => {
        point(link, id, target)
        const copy = new Map(link.forward)
        link.forward.clear()
        for (const [key, value] of copy) link.forward.set(key, value)
      }
    }

    it('one add and one remove in a bucket of 4,000 touch what they touch in one of 8,000, at most 4 elements each', () => {
      const at4k = upkeep(4_000)
      const at8k = upkeep(8_000)
      expect(at8k).toEqual(at4k)
      expect(at4k.add.elements).toBeLessThanOrEqual(4)
      expect(at4k.remove.elements).toBeLessThanOrEqual(4)
      // Independent of the engine's own count: a small constant, nowhere near b.
      expect(at4k.add.ops).toBeLessThan(100)
      expect(at4k.remove.ops).toBeLessThan(100)
      writeResult('hand-pool-bucket-upkeep', { bound: 'O(1) per edge', at4k, at8k })
    })

    it('the planted copy-and-sort fails the bound', () => {
      const at4k = upkeep(4_000, copyAndSort)
      const at8k = upkeep(8_000, copyAndSort)
      expect(at4k.add.ops).toBeGreaterThan(4_000)
      expect(at4k.remove.ops).toBeGreaterThan(4_000)
      expect(at8k.add.ops).toBeGreaterThan(at4k.add.ops)
      writeResult('hand-pool-bucket-upkeep-plant', { plant: 'copy-and-sort', at4k, at8k })
    })

    it('a planted copy of the forward Map fails the bound (the Map patch is armed)', () => {
      const at4k = upkeep(4_000, forwardCopy)
      const at8k = upkeep(8_000, forwardCopy)
      expect(at4k.add.ops).toBeGreaterThan(4_000)
      expect(at4k.remove.ops).toBeGreaterThan(4_000)
      expect(at8k.add.ops).toBeGreaterThan(at4k.add.ops)
      writeResult('hand-pool-bucket-upkeep-map-plant', { plant: 'forward-map copy', at4k, at8k })
    })
  })
})

// ------------------------------------------- row views resolve through one() (M3 F2)

describe('row views resolve single-valued relations through the engine (M3 F2)', () => {
  const rows = [
    lane('/repo'),
    lane('/other', 'R2', { repoPath: '/other', prefix: 'OTH' }),
    issue('I1'),
    issue('I2', { deps: [{ id: 'I1', type: 'discovered-from' }] }),
    issue('I3', { repoId: 'R2', repoPath: '/other' }),
  ]

  it('a planted wrong forward entry is what the row view shows, and the scan names it', () => {
    const truth = rig(rows)
    const planted = rig(rows)
    try {
      expect(truth.pool.view('I1')?.displayRef).toBe('POD-1')
      expect(truth.pool.view('I2')?.originTick?.ref).toBe('POD-1')
      truth.check()
      // Plant before any view of the planted pool is read: its cells are born on the lie.
      const links = (
        planted.pool.engine as unknown as { links: Map<string, { forward: Map<string, string> }> }
      ).links
      links.get('issue.repo')?.forward.set('I1', 'R2')
      links.get('issue.discoveredFrom')?.forward.set('I2', 'I3')
      // A view that re-resolved from its own row (relationRef + a table read) would still say POD-1.
      expect(planted.pool.view('I1')?.displayRef).toBe('OTH-1')
      expect(planted.pool.view('I2')?.originTick?.id).toBe('I3')
      expect(planted.pool.view('I2')?.originTick?.ref).toBe('OTH-3')
      const diff = diffRelations(planted.pool.engine, planted.pool.tables)
      expect(diff).toEqual([
        'issue:I1.repo: live "R2", scan "R"',
        'issue:I2.discoveredFrom: live "I3", scan "I1"',
      ])
    } finally {
      truth.dispose()
      planted.dispose()
    }
  })

  it("a mounted row hears its repo's prefix change and its repo leaving", () => {
    const r = rig(rows)
    try {
      const refs: (string | undefined)[] = [r.pool.view('I1')?.displayRef]
      const off = r.pool.subscribe('I1', () => refs.push(r.pool.view('I1')?.displayRef))
      r.push(lane('/repo', 'R', { prefix: 'NEW' }))
      r.push(gone('worktree', '/repo'))
      off()
      expect(refs).toEqual(['POD-1', 'NEW-1', '#1'])
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
      expect(r.writes()).toContain('session.coordinates:S2')
      r.push(gone('issue', 'I2'))
      expect(r.many('session', 'S1', 'coordinates')).toEqual([])
      r.check()
      // The real schema's pool does not know the relation.
      const real = rig([issue('I1')], { fence: false })
      try {
        expect(() => real.pool.engine.many('session', 'S1', 'coordinates')).toThrow(
          /not a declared relation/,
        )
      } finally {
        real.dispose()
      }
    } finally {
      r.dispose()
    }
  })

  it('refuses a schema whose collection nothing maintains', () => {
    const broken: ModelSchema = {
      ...SCHEMA,
      repo: {
        ...SCHEMA.repo,
        relations: {
          ...SCHEMA.repo.relations,
          orphans: { kind: 'hasMany', to: 'issue', inverse: 'nothing', lazy: true, why: 'x' },
        },
      },
    }
    expect(
      () => new HandPool(DISABLED_READ_FENCE, { selectedIssueId: null, coarseNow: 0 }, broken),
    ).toThrow(/repo\.orphans is a collection no relation maintains/)
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
          const diff = diffRelations(r.pool.engine, r.pool.tables, SCHEMA, universe)
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

  it('the check can fail: a row removed behind the engine diverges', () => {
    const r = rig([issue('I1'), issue('I2', { parentId: 'I1' })], { fence: false })
    try {
      r.pool.tables.issue.delete('I2')
      const diff = diffRelations(r.pool.engine, r.pool.tables)
      expect(diff.join('\n')).toMatch(/issue:I1\.children: live \["I2"\], scan \[\]/)
    } finally {
      r.dispose()
    }
  })
})
