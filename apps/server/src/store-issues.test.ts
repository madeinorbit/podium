import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

const base = () => ({
  id: 'iss_1', repoPath: '/r', seq: 1, title: 'Fix login', description: 'desc',
  stage: 'backlog', worktreePath: null, branch: null, parentBranch: 'main',
  defaultAgent: 'claude-code', linearId: null, linearIdentifier: null, linearUrl: null,
  activityNotes: null, notesUpdatedAt: null, suggestedStage: null, suggestedReason: null,
  blockedBy: [] as string[], dependencyNote: null, prUrl: null,
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
})
