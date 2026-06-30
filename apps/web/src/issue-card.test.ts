import { describe, expect, it } from 'vitest'
import type { IssueWire } from '@podium/protocol'
import { issueCardModel } from './issue-card'

const issue = (over: Partial<IssueWire> = {}): IssueWire =>
  ({ id: 'i', repoPath: '/r', seq: 4, title: 'Fix login', description: '', stage: 'in_progress',
     worktreePath: '/r/wt', branch: 'issue/4-fix-login', parentBranch: 'main', defaultAgent: 'claude-code',
     blockedBy: [], createdAt: 't', updatedAt: 't', archived: false,
     priority: 2, type: 'task', pinned: false, labels: [], deps: [], dependents: [], comments: [],
     ready: true, blocked: false, deferred: false, childCount: 0, childDoneCount: 0,
     sessions: [], sessionSummary: { total: 2, byPhase: { working: 1, idle: 1 } }, ...over }) as IssueWire

describe('issueCardModel', () => {
  it('shows seq + repo basename subtitle and session count', () => {
    const m = issueCardModel(issue())
    expect(m.title).toBe('Fix login')
    expect(m.subtitle).toContain('#4')
    expect(m.subtitle).toContain('2 sessions')
  })
  it('flags a pending suggestion', () => {
    expect(issueCardModel(issue({ suggestedStage: 'review' })).hasSuggestion).toBe(true)
    expect(issueCardModel(issue()).hasSuggestion).toBe(false)
  })
})

describe('issueCardModel rich badges (P4)', () => {
  it('derives priority/type labels, status dot, and labels', () => {
    const m = issueCardModel(issue({ priority: 0, type: 'bug', ready: false, blocked: true, labels: ['ui', 'p1'] }))
    expect(m.priorityLabel).toBe('P0')
    expect(m.typeLabel).toBe('bug')
    expect(m.statusDot).toBe('blocked')
    expect(m.labels).toEqual(['ui', 'p1'])
  })
  it('a deferred issue shows the deferred dot; a done issue shows closed', () => {
    expect(issueCardModel(issue({ deferred: true })).statusDot).toBe('deferred')
    expect(issueCardModel(issue({ stage: 'done' })).statusDot).toBe('closed')
  })
})
