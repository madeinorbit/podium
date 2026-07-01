import { describe, expect, it } from 'vitest'
import { ISSUE_STAGES, IssueStage, IssueWire, RepoOp, ServerMessage } from './messages'

describe('issue protocol types', () => {
  it('has the six ordered stages', () => {
    expect(ISSUE_STAGES).toEqual(['backlog', 'planning', 'in_progress', 'review', 'verifying', 'done'])
    expect(IssueStage.parse('verifying')).toBe('verifying')
  })

  it('parses an IssueWire with derived members', () => {
    const wire = IssueWire.parse({
      id: 'iss_1', repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'backlog',
      worktreePath: null, branch: null, parentBranch: 'main', defaultAgent: 'claude-code',
      blockedBy: [], priority: 2, type: 'task', pinned: false,
      labels: [], deps: [], dependents: [], comments: [],
      ready: true, blocked: false, deferred: false, childCount: 0, childDoneCount: 0,
      createdAt: 't', updatedAt: 't', archived: false,
      sessions: [], sessionSummary: { total: 0, byPhase: {} },
    })
    expect(wire.stage).toBe('backlog')
    expect(wire.worktreePath).toBeNull()
  })

  it('accepts the new write RepoOps', () => {
    expect(RepoOp.parse('rebase')).toBe('rebase')
    expect(RepoOp.parse('mergeFfOnly')).toBe('mergeFfOnly')
    expect(RepoOp.parse('prCreate')).toBe('prCreate')
  })

  it('round-trips issue broadcast messages', () => {
    const issue = IssueWire.parse({
      id: 'iss_1', repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'planning',
      worktreePath: '/r/wt', branch: 'issue/1-x', parentBranch: 'main', defaultAgent: 'claude-code',
      blockedBy: [], priority: 2, type: 'task', pinned: false,
      labels: [], deps: [], dependents: [], comments: [],
      ready: true, blocked: false, deferred: false, childCount: 0, childDoneCount: 0,
      createdAt: 't', updatedAt: 't', archived: false,
      sessions: [], sessionSummary: { total: 0, byPhase: {} },
    })
    expect(ServerMessage.parse({ type: 'issuesChanged', issues: [issue] }).type).toBe('issuesChanged')
    expect(ServerMessage.parse({ type: 'issueUpdated', issue }).type).toBe('issueUpdated')
  })
})
