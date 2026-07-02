import { describe, expect, it } from 'vitest'
import { issueCardModel } from './issue-card'
import { makeIssue as issue } from './test-issue'

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
  it('surfaces needsHuman on the card model', () => {
    expect(issueCardModel(issue({ needsHuman: true })).needsHuman).toBe(true)
    expect(issueCardModel(issue({ needsHuman: false })).needsHuman).toBe(false)
  })
})

describe('issueCardModel Linear anatomy', () => {
  it('derives seq label, assignee, session count', () => {
    const m = issueCardModel(issue({ seq: 12, assignee: 'mike' }))
    expect(m.seqLabel).toBe('#12')
    expect(m.assignee).toBe('mike')
    expect(m.sessionCount).toBe(2)
  })
  it('sub-issue progress only when children exist', () => {
    expect(issueCardModel(issue()).subProgress).toBeUndefined()
    expect(issueCardModel(issue({ childCount: 3, childDoneCount: 1 })).subProgress).toEqual({ done: 1, total: 3 })
  })
  it('blocked/blocking flags from wire state + dependents', () => {
    const m = issueCardModel(issue({ blocked: true, dependents: [{ id: 'x', type: 'blocks' }] }))
    expect(m.isBlocked).toBe(true)
    expect(m.isBlocking).toBe(true)
    expect(issueCardModel(issue()).isBlocking).toBe(false)
  })
  it('formats due date and estimate when present', () => {
    const m = issueCardModel(issue({ dueAt: '2026-07-12T12:00:00Z', estimateMin: 90 }))
    expect(m.dueLabel).toBe('Jul 12')
    expect(m.estimateLabel).toBe('90m')
    expect(issueCardModel(issue()).dueLabel).toBeUndefined()
  })
})
