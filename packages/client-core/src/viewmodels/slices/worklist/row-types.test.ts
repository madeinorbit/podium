import type { IssueNavigationModel } from '../issues'
import { describe, expect, it } from 'vitest'
import type { UnifiedIssueRow } from './row-types'
import { reuseUnifiedWorkRows } from './row-types'

const row = (id: string): UnifiedIssueRow => ({
  kind: 'issue',
  issue: { id } as IssueNavigationModel,
  sessions: [],
  activityAt: 0,
})

describe('reuseUnifiedWorkRows', () => {
  it('keeps the previous array when every keyed row is unchanged', () => {
    const previous = [row('a'), row('b')]
    expect(reuseUnifiedWorkRows(previous, [...previous])).toBe(previous)
  })

  it('preserves a pure reorder while reusing the keyed row objects', () => {
    const previous = [row('a'), row('b')]
    const next = [previous[1]!, previous[0]!]
    const reused = reuseUnifiedWorkRows(previous, next)
    expect(reused.every((candidate) => candidate.kind === 'issue')).toBe(true)
    expect(reused.map((candidate) => (candidate.kind === 'issue' ? candidate.issue.id : ''))).toEqual([
      'b',
      'a',
    ])
    expect(reused).not.toBe(previous)
    expect(reused[0]).toBe(previous[1])
    expect(reused[1]).toBe(previous[0])
  })
})
