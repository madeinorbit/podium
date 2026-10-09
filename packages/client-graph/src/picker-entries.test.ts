import { describe, expect, it, vi } from 'vitest'
import {
  chatMentionIssues,
  chatReferenceSessions,
  createReferencePicker,
  mentionIssueOrder,
  referenceSessionOrder,
} from './chat-context'
import { issuePages } from './issue-page'
import { menuIssues } from './issue-page-menu.before.test.fixture'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

// POD-5831: pickers keep their opening order as identities and an entry reads
// its own facts when shown. The old whole-catalog answers are the oracles.
const stamp = (minute: number) => `2026-10-09T00:${String(minute).padStart(2, '0')}:00Z`
type Row = Record<string, unknown>
const issue = (id: string, seq: number, patch: Row = {}): Row => ({
  id, seq, title: `Task ${seq}`, repoId: 'repo', repoPath: '/repo', stage: 'in_progress',
  createdAt: stamp(0), updatedAt: stamp(0), labels: [], deps: [], ...patch,
})
const seat = (sessionId: string, issueId: string | undefined, patch: Row = {}): Row => ({
  sessionId, issueId, cwd: '/repo', agentKind: 'codex', status: 'live', title: sessionId,
  createdAt: stamp(0), lastActiveAt: stamp(1), ...patch,
})

/** `parents` tasks, each with three children and two seats, plus orders. */
function catalog(parents: number, extra: { issues?: Row[]; sessions?: Row[] } = {}) {
  const issues: Row[] = [], sessions: Row[] = []
  for (let n = 0; n < parents; n++) {
    issues.push(issue(`p${n}`, n * 4 + 1))
    for (let c = 0; c < 3; c++)
      issues.push(issue(`p${n}-c${c}`, n * 4 + 2 + c, { parentId: `p${n}`, stage: c === 0 ? 'done' : 'planning' }))
    sessions.push(seat(`s${n}-a`, `p${n}`), seat(`s${n}-b`, `p${n}`, { lastActiveAt: stamp(2) }))
  }
  issues.push(...(extra.issues ?? []))
  sessions.push(...(extra.sessions ?? []))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp(0)) })
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'worktree', id: '/repo', value: { path: '/repo', repoId: 'repo', repoPath: '/repo', prefix: 'POD', repoName: 'Repo' } },
      ...issues.map((value) => ({ kind: 'issue' as const, id: value.id as string, value })),
      ...sessions.map((value) => ({ kind: 'session' as const, id: value.sessionId as string, value })),
    ] as never,
  })
  // The server's recency orders, newest first.
  const sessionOrder = [...sessions].reverse().map((row) => row.sessionId as string)
  const issueOrder = [...issues].reverse().map((row) => row.id as string)
  pool.sources.register(['chatSessionOrder', 'chatIssueOrder'], {
    read: (entity) => ({ ids: entity === 'chatSessionOrder' ? sessionOrder : issueOrder }),
    dispose() {},
  })
  return pool
}

function spyReads(pool: MobxPool) {
  const rows = vi.spyOn(pool, 'row')
  const graph = vi.spyOn(pool.graph, 'many')
  const many = vi.spyOn(pool.relations, 'many')
  const size = vi.spyOn(pool.relations, 'size')
  const subset = vi.spyOn(pool.relations, 'subset')
  return {
    /** Entries whose descendants (children or member seats) were resolved. */
    descendants(): Set<string> {
      const out = new Set<string>()
      for (const spy of [graph, many, size, subset])
        for (const [from, id, relation] of spy.mock.calls)
          if (from === 'issue' && ['treeChildren', 'pageSessions', 'missionSessions', 'sessions'].includes(relation))
            out.add(id)
      return out
    },
    rowIds(kind: string): Set<string> {
      return new Set(rows.mock.calls.filter(([entity]) => entity === kind).map(([, id]) => id))
    },
    restore() { for (const spy of [rows, graph, many, size, subset]) spy.mockRestore() },
  }
}

describe('reference picker opening order (POD-5831)', () => {
  const extras = {
    issues: [issue('gone', 900, { deletedAt: stamp(3) }), issue('kept', 901)],
    sessions: [
      // Parked resume twins fold to the more recent; an active group stays whole.
      seat('twin-old', 'kept', { status: 'hibernated', resume: { kind: 'claude', value: 'p' }, lastActiveAt: stamp(1) }),
      seat('twin-new', 'kept', { status: 'hibernated', resume: { kind: 'claude', value: 'p' }, lastActiveAt: stamp(5) }),
      seat('pair-live', 'kept', { status: 'live', resume: { kind: 'claude', value: 'q' } }),
      seat('pair-parked', 'kept', { status: 'hibernated', resume: { kind: 'claude', value: 'q' } }),
      seat('loose', undefined),
    ],
  }
  it('stores the same order as the old catalog answers, with no row reads', () => {
    const pool = catalog(6, extras)
    try {
      const oldSessions = chatReferenceSessions(pool).sessions.map((row) => row.sessionId)
      const oldIssues = chatMentionIssues(pool).issues.map((row) => row.id)
      expect(oldSessions).toContain('twin-new')
      expect(oldSessions).not.toContain('twin-old')
      expect(oldIssues).not.toContain('gone')
      const reads = spyReads(pool)
      try {
        const sessions = referenceSessionOrder(pool), issues = mentionIssueOrder(pool)
        expect(sessions).toEqual({ ids: oldSessions, pending: 0 })
        expect(issues).toEqual({ ids: oldIssues, pending: 0 })
        expect(reads.rowIds('session')).toEqual(new Set())
        expect(reads.rowIds('issue')).toEqual(new Set())
        expect(reads.descendants()).toEqual(new Set())
        expect(() => expect([...sessions.ids].reverse()).toEqual(oldSessions)).toThrow()
        expect(() => expect([...issues.ids, 'gone']).toEqual(oldIssues)).toThrow()
      } finally {
        reads.restore()
      }
    } finally {
      pool.dispose()
    }
  })

  for (const scale of [1, 4])
    it(`opens and searches without resolving other entries at ${scale}x`, () => {
      const pool = catalog(16 * scale, extras)
      const picker = createReferencePicker(pool)
      const reads = spyReads(pool)
      try {
        picker.open()
        expect(picker.sessionIds.length).toBeGreaterThan(30 * scale)
        expect(picker.pending).toBe(0)
        expect(reads.rowIds('session')).toEqual(new Set())
        expect(reads.rowIds('issue')).toEqual(new Set())
        expect(reads.descendants()).toEqual(new Set())
        // A shown entry reads its own row and stays still while open.
        expect(picker.session('s0-a')).toMatchObject({ title: 's0-a' })
        expect(reads.rowIds('session')).toEqual(new Set(['s0-a']))
        // A short result list: only its own rows, and no entry's descendants.
        picker.search('task', 2)
        expect(picker.issueIds).toHaveLength(2)
        const shown = new Set(picker.issueIds)
        expect(picker.issues.map((row) => row.id)).toEqual(picker.issueIds)
        for (const id of reads.rowIds('issue')) expect(shown.has(id)).toBe(true)
        expect(reads.descendants()).toEqual(new Set())
      } finally {
        reads.restore()
        picker.close()
        pool.dispose()
      }
    })
})

describe('issue menu entries read their own facts (POD-5831)', () => {
  it('matches the old enriched catalog on every entry', () => {
    const pool = catalog(5, { sessions: [seat('archived', 'p1', { archived: true })] })
    try {
      const before = menuIssues(pool)
      if (!before || before === LOADING) throw new Error('catalog is loading')
      const facts = (id: string) => {
        const model = pool.issueObject(id)
        return {
          childIds: [...pool.relations.many('issue', id, 'treeChildren')].sort(),
          childCount: model.childCount,
          childDoneCount: model.childDoneCount,
          memberSessionIds: model.memberSessionIds,
        }
      }
      const old = (row: (typeof before)[number]) => ({
        childIds: row.childIds,
        childCount: row.childCount,
        childDoneCount: row.childDoneCount,
        memberSessionIds: row.memberSessionIds,
      })
      expect(before.filter((row) => row.childCount > 0)).toHaveLength(5)
      for (const row of before) expect(facts(row.id)).toEqual(old(row))
      const shifted = { ...facts('p0'), childDoneCount: facts('p0').childDoneCount + 1 }
      expect(() => expect(shifted).toEqual(old(before.find((row) => row.id === 'p0')!))).toThrow()
    } finally {
      pool.dispose()
    }
  })

  for (const scale of [1, 4])
    it(`opens the menu catalog without any entry's descendants at ${scale}x`, () => {
      const pool = catalog(16 * scale)
      const reads = spyReads(pool)
      try {
        const world = issuePages(pool).issues()
        if (!world || world === LOADING) throw new Error('catalog is loading')
        expect(world).toHaveLength(64 * scale)
        expect(reads.descendants()).toEqual(new Set())
        // One shown entry asks for its own progress, and only its own.
        expect(pool.issueObject('p3').childCount).toBe(3)
        expect(reads.descendants()).toEqual(new Set(['p3']))
      } finally {
        reads.restore()
        pool.dispose()
      }
    })
})
