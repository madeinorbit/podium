import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

const base = () => ({
  id: 'iss_1', repoPath: '/r', seq: 1, title: 'Fix login', description: 'desc',
  stage: 'backlog', worktreePath: null, branch: null, parentBranch: 'main',
  defaultAgent: 'claude-code', linearId: null, linearIdentifier: null, linearUrl: null,
  activityNotes: null, notesUpdatedAt: null, suggestedStage: null, suggestedReason: null,
  blockedBy: [] as string[], dependencyNote: null, prUrl: null,
  priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
  notes: null, dueAt: null, deferUntil: null, closedReason: null, supersededBy: null,
  duplicateOf: null, pinned: false, estimateMin: null,
  needsHuman: false, humanQuestion: null,
  createdAt: 't0', updatedAt: 't0', archived: false,
})

describe('store issues', () => {
  it('round-trips an issue', () => {
    const s = new SessionStore(':memory:')
    s.upsertIssue(base())
    const got = s.getIssue('iss_1')
    expect(got?.title).toBe('Fix login')
    expect(got?.worktreePath).toBeNull()
    expect(got?.blockedBy).toEqual([])
    expect(got?.archived).toBe(false)
  })

  it('updates on conflict and preserves JSON blockedBy', () => {
    const s = new SessionStore(':memory:')
    s.upsertIssue(base())
    s.upsertIssue({ ...base(), stage: 'planning', worktreePath: '/r/wt', branch: 'issue/1-x', blockedBy: ['iss_2'] })
    const got = s.getIssue('iss_1')
    expect(got?.stage).toBe('planning')
    expect(got?.worktreePath).toBe('/r/wt')
    expect(got?.blockedBy).toEqual(['iss_2'])
  })

  it('lists by repo and increments seq per repo', () => {
    const s = new SessionStore(':memory:')
    expect(s.nextIssueSeq('/r')).toBe(1)
    s.upsertIssue({ ...base(), id: 'a', repoPath: '/r', seq: 1 })
    s.upsertIssue({ ...base(), id: 'b', repoPath: '/r', seq: 2 })
    s.upsertIssue({ ...base(), id: 'c', repoPath: '/other', seq: 1 })
    expect(s.nextIssueSeq('/r')).toBe(3)
    expect(s.nextIssueSeq('/other')).toBe(2)
    expect(s.listIssueRows('/r').map((i) => i.id).sort()).toEqual(['a', 'b'])
    expect(s.listIssueRows().length).toBe(3)
  })

  it('deletes', () => {
    const s = new SessionStore(':memory:')
    s.upsertIssue(base())
    s.deleteIssue('iss_1')
    expect(s.getIssue('iss_1')).toBeNull()
  })

  it('rejects an invalid stage on write but allows the auto defaultAgent sentinel', () => {
    const s = new SessionStore(':memory:')
    expect(() => s.upsertIssue({ ...base(), stage: 'bogus' })).toThrow(/stage/i)
    // 'auto' is a legal defaultAgent (AgentChoice sentinel) — it must NOT be rejected;
    // it is resolved to a concrete kind only at spawn time.
    expect(() => s.upsertIssue({ ...base(), defaultAgent: 'auto' })).not.toThrow()
  })

  it('normalizes a non-array blockedBy to [] on write', () => {
    const s = new SessionStore(':memory:')
    s.upsertIssue({ ...base(), blockedBy: 'nope' as unknown as string[] })
    expect(s.getIssue('iss_1')?.blockedBy).toEqual([])
  })

  it('tolerates a corrupt blocked_by column instead of crashing the whole load', () => {
    // A row whose blocked_by holds non-JSON (legacy/externally-corrupted data) must
    // NOT throw out of mapIssueRow — that would abort listIssueRows, which runs in
    // IssueService's constructor at boot, crash-looping the server. Quarantine the
    // bad field (blockedBy -> []) and keep the row.
    const s = new SessionStore(':memory:')
    s.upsertIssue(base())
    rawDb(s).prepare('UPDATE issues SET blocked_by = ? WHERE id = ?').run('{not json', 'iss_1')

    expect(() => s.listIssueRows()).not.toThrow()
    expect(s.getIssue('iss_1')?.blockedBy).toEqual([])
    expect(s.listIssueRows().map((i) => i.id)).toContain('iss_1')
  })

  it('quarantines a non-array blocked_by JSON value', () => {
    const s = new SessionStore(':memory:')
    s.upsertIssue(base())
    // Valid JSON, wrong shape (an object, not a string[]).
    rawDb(s).prepare('UPDATE issues SET blocked_by = ? WHERE id = ?').run('{"a":1}', 'iss_1')
    expect(s.getIssue('iss_1')?.blockedBy).toEqual([])
  })
})

/** White-box seam: reach the store's own SQLite connection to inject corrupt rows. */
function rawDb(s: SessionStore): {
  prepare(q: string): { run(...a: unknown[]): unknown }
} {
  return (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
}
