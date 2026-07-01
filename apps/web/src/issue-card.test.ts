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
