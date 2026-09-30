/**
 * POD-4758 — declared subsets (`HasManySpec.subsets`), maintained by the
 * relation engine with no arm code (`relations.ts`) and held to the
 * from-scratch scan (`enumerate.ts` `diffRelations`, which checks every
 * declared subset from its own test).
 *
 * A fixture subset (`worktree.issues.drafts`) beside the declared one
 * (`worktree.sessions.issueless`): a subset field flipping with no move, a
 * member leaving the collection, a root gained and lost, and an explicit
 * null foreign key (which still claims the session). Its own file so it does
 * not edit the engine's main suite while POD-4755 owns it.
 */

import { describe, expect, it } from 'vitest'
import { createReplaySource } from '../../../harness/src/count-harness'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { settableLocals } from '../../../shared/src/locals-source'
import {
  type EntityName,
  type ModelSchema,
  SCHEMA,
  validateStructure,
} from '../../../shared/src/schema'
import type { RowRecord } from '../../../shared/src/stats'
import { diffRelations } from './enumerate'
import { tracked } from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from './mobx-trap'
import { MobxPool } from './pool'

installMobxWarnTrap()

const T0 = '2026-09-23T00:00:00.000Z'
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

function lane(path: string, repoId = 'R'): RowRecord {
  return {
    kind: 'worktree',
    id: path,
    value: { path, repoId, repoPath: '/repo', prefix: 'POD' } as RowRecord['value'],
  }
}

const gone = (kind: RowRecord['kind'], id: string): RowRecord => ({ kind, id, value: undefined })

/** A pool over `rows` (unfenced: the fence checks names against the real schema). */
function rig(rows: RowRecord[], options: { fence?: boolean; schema?: ModelSchema } = {}) {
  const replay = createReplaySource({
    issues: rows.filter((row) => row.kind === 'issue'),
    sessions: rows.filter((row) => row.kind === 'session'),
    worktrees: rows.filter((row) => row.kind === 'worktree'),
  })
  const locals = settableLocals({ selectedIssueId: null, coarseNow: Date.parse(T0) })
  const pool = new MobxPool(locals.source.get(), options.schema)
  const source = replay.source
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
    push: (...changes: RowRecord[]) => replay.push({ type: 'update', rows: changes }),
    check() {
      const diff = tracked(() => diffRelations(pool.graph, pool.tables, schema))
      expect(diff, 'live relations against the from-scratch scan').toEqual([])
    },
    dispose() {
      off()
      pool.dispose()
      locals.dispose()
    },
  }
}

describe('a subset added to the schema needs no arm code (POD-4758)', () => {
  it('maintains a fixture subset (worktree.issues.drafts) beside the declared one (worktree.sessions.issueless)', () => {
    const issues = SCHEMA.worktree.relations['issues']
    if (issues?.kind !== 'hasMany') throw new Error('unreachable')
    const fixture: ModelSchema = {
      ...SCHEMA,
      worktree: {
        ...SCHEMA.worktree,
        relations: {
          ...SCHEMA.worktree.relations,
          issues: {
            ...issues,
            subsets: {
              drafts: {
                fields: ['draft'],
                test: (row) => row['draft'] === true,
                why: 'fixture: one extra subset',
              },
            },
          },
        },
      },
    }
    expect(validateStructure(fixture)).toEqual([])
    const r = rig(
      [
        lane('/r'),
        issue('I1', { worktreePath: '/r', draft: true }),
        issue('I2', { worktreePath: '/r' }),
        session('S1', { cwd: '/r/x', issueId: undefined }),
        session('S2', { cwd: '/r' }),
      ],
      { fence: false, schema: fixture },
    )
    const subset = (from: EntityName, id: string, relation: string, name: string) =>
      tracked(() => [...r.pool.graph.subset(from, id, relation, name)].sort())
    try {
      expect(subset('worktree', '/r', 'issues', 'drafts')).toEqual(['I1'])
      // A subset field flips with no move: re-decided in place.
      r.push(issue('I2', { worktreePath: '/r', draft: true }), issue('I1', { worktreePath: '/r' }))
      expect(subset('worktree', '/r', 'issues', 'drafts')).toEqual(['I2'])
      // A member leaves the collection: it leaves the subset.
      r.push(issue('I2', { worktreePath: '/elsewhere', draft: true }))
      expect(subset('worktree', '/r', 'issues', 'drafts')).toEqual([])
      r.check()

      // The declared subset: an explicit null still claims the session.
      expect(subset('worktree', '/r', 'sessions', 'issueless')).toEqual(['S1'])
      r.push(session('S2', { cwd: '/r', issueId: undefined }))
      expect(subset('worktree', '/r', 'sessions', 'issueless')).toEqual(['S1', 'S2'])
      // A root gained takes its members' subset membership along.
      r.push(lane('/r/x'))
      expect(subset('worktree', '/r/x', 'sessions', 'issueless')).toEqual(['S1'])
      expect(subset('worktree', '/r', 'sessions', 'issueless')).toEqual(['S2'])
      r.check()
      // ...and a root lost hands it back.
      r.push(gone('worktree', '/r/x'))
      expect(subset('worktree', '/r', 'sessions', 'issueless')).toEqual(['S1', 'S2'])
      r.push(session('S1', { cwd: '/r/x', issueId: 'I1' }))
      expect(subset('worktree', '/r', 'sessions', 'issueless')).toEqual(['S2'])
      r.check()

      // The real schema's pool does not know the fixture subset.
      const real = rig([issue('I1')], { fence: false })
      try {
        expect(() => real.pool.graph.subset('worktree', '/r', 'issues', 'drafts')).toThrow(
          /declares no subset "drafts"/,
        )
      } finally {
        real.dispose()
      }
    } finally {
      r.dispose()
    }
  })
})
