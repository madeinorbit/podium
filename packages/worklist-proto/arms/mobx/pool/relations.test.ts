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

import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { createReplaySource, type ReplaySource } from '../../../harness/src/count-harness'
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
import { installMobxWarnTrap } from './mobx-trap'
import { MobxPool, tracked } from './pool'

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
  /** Relation slots the last push wrote. */
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
  const pool = new MobxPool(reads, locals.source.get(), options.schema)
  const source = reads.wrapSource(replay.source)
  pool.apply({
    type: 'replace',
    rows: [...source.snapshot('session'), ...source.snapshot('issue'), ...source.snapshot('worktree')],
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
    many: (from, id, relation) => tracked(() => [...pool.graph.many(from, id, relation)]),
    writes: () => [...pool.graph.lastWrites].sort(),
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
      session('S1', { issueId: 'I1', cwd: '/repo', status: 'hibernated', lastActiveAt: at(1), resume: ref }),
      session('S2', { issueId: 'I1', cwd: '/repo', status: 'exited', lastActiveAt: at(5), resume: ref }),
    ])
    try {
      // Rank beats recency: the hibernated row is kept.
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S1'])
      expect(r.many('worktree', '/repo', 'sessions')).toEqual(['S1'])
      expect(r.one('session', 'S2', 'issue')).toBeNull()
      expect(r.one('session', 'S2', 'worktree')).toBeNull()
      r.check()
      // The exited twin comes back live: the group is kept in full.
      r.push(session('S2', { issueId: 'I1', cwd: '/repo', status: 'live', lastActiveAt: at(6), resume: ref }))
      expect(r.many('issue', 'I1', 'sessions')).toEqual(['S1', 'S2'])
      expect(r.many('worktree', '/repo', 'sessions')).toEqual(['S1', 'S2'])
      r.check()
      // It parks again, now more recent at the same rank: it is the one kept.
      r.push(session('S2', { issueId: 'I1', cwd: '/repo', status: 'hibernated', lastActiveAt: at(6), resume: ref }))
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
      expect(r.writes()).toEqual(['issue.sessions:I2', 'session.issue→S2'])

      // 2. I2 is archived: R1 re-evaluates, worktree and repo stay.
      r.push(issue('I2', { parentId: 'I1', worktreePath: Wi2, archived: true }))
      expect(r.many('issue', 'I1', 'children')).toEqual([])
      expect(r.one('issue', 'I2', 'parent')).toBeNull()
      expect(r.one('issue', 'I2', 'worktree')).toBe(Wi2)
      expect(r.one('issue', 'I2', 'repo')).toBe('R')
      expect(r.writes()).toEqual(['issue.children:I1', 'issue.parent→I2'])

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
      ] as const) {
        r.reads.reset()
        expect(tracked(() => fenced.one(from, id, relation)), `${from}.${relation}`).not.toBeNull()
        expect(r.reads.stats().rows, `${from}.${relation}`).toBe(1)
      }
      r.reads.reset()
      expect(tracked(() => [...fenced.many('issue', 'I1', 'children')])).toEqual(['I2', 'I3'])
      expect(r.reads.stats().rows).toBe(2)
      r.reads.reset()
      expect(tracked(() => fenced.size('repo', 'R', 'issues'))).toBe(4)
      expect(r.reads.stats().rows).toBe(0)
    } finally {
      r.dispose()
    }
  })

  /** Each change kind, and exactly the relation slots it may write. */
  const KINDS: { name: string; change: RowRecord[]; writes: string[] }[] = [
    { name: 'heartbeat', change: [session('S2', { issueId: 'I1', cwd: '/repo/y', lastActiveAt: at(3) })], writes: [] },
    { name: 'rename', change: [issue('I4', { title: 'Renamed' })], writes: [] },
    {
      name: 'reparent',
      change: [issue('I2', { parentId: 'I4' })],
      writes: ['issue.children:I1', 'issue.children:I4', 'issue.parent→I2'],
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
      writes: ['session.worktree→S2', 'worktree.sessions:/repo', 'worktree.sessions:/repo/.worktrees/a'],
    },
    {
      name: 'deps change',
      change: [issue('I3', { parentId: 'I1', deps: [{ id: 'I4', type: 'discovered-from' }] })],
      writes: ['issue.discoveredFrom→I3', 'issue.spinOffs:I2', 'issue.spinOffs:I4'],
    },
    {
      name: 'new session',
      change: [session('S9', { issueId: 'I4', cwd: '/repo/z' })],
      writes: ['issue.sessions:I4', 'session.issue→S9', 'session.worktree→S9', 'worktree.sessions:/repo'],
    },
    {
      name: 'remove session',
      change: [gone('session', 'S3')],
      writes: ['issue.sessions:I4', 'session.issue→S3', 'session.worktree→S3', 'worktree.sessions:/repo/.worktrees/a'],
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
        const before = r.pool.stats.indexUpdates
        r.push(...kind.change)
        expect(r.writes()).toEqual([...kind.writes].sort())
        expect(r.pool.stats.indexUpdates - before).toBe(kind.writes.length)
        r.check({ issue: ['I1'] })
      } finally {
        r.dispose()
      }
    })
  }

  it('a bucket the change does not touch keeps its array; a touched one is replaced once', () => {
    const r = rig(rows)
    try {
      const untouched = tracked(() => r.pool.graph.many('worktree', '/repo/.worktrees/a', 'sessions'))
      const touched = tracked(() => r.pool.graph.many('issue', 'I1', 'children'))
      let runs = 0
      const stop = autorun(() => {
        runs += 1
        r.pool.graph.many('issue', 'I1', 'children')
      })
      r.push(issue('I4', { parentId: 'I1' }), issue('I5', { parentId: 'I1' }))
      stop()
      expect(runs).toBe(2)
      expect(tracked(() => r.pool.graph.many('worktree', '/repo/.worktrees/a', 'sessions'))).toBe(untouched)
      expect(tracked(() => r.pool.graph.many('issue', 'I1', 'children'))).not.toBe(touched)
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
      r.push(issue('I2', { coordinatorSessionId: 'S1' }), issue('I1', { coordinatorSessionId: 'S2' }))
      expect(r.many('session', 'S1', 'coordinates')).toEqual(['I2'])
      expect(r.many('session', 'S2', 'coordinates')).toEqual(['I1'])
      r.push(gone('issue', 'I2'))
      expect(r.many('session', 'S1', 'coordinates')).toEqual([])
      r.check()
      // The real schema's pool does not know the relation.
      const real = rig([issue('I1')], { fence: false })
      try {
        expect(() => real.many('session', 'S1', 'coordinates')).toThrow(/not a declared relation/)
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
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const maybe = <T,>(value: T): T | null => (rand() < 0.3 ? null : value)
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
      deps: rand() < 0.5 ? [{ id: pick(ISSUES), type: rand() < 0.8 ? 'discovered-from' : 'blocks' }] : [],
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
            throw new Error(`seed ${seed} step ${step} (${JSON.stringify(event)}):\n${diff.join('\n')}`)
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
