import { describe, expect, it } from 'vitest'
import { clearChip, filterBoardIssues, filterChips } from './issue-board-filter'
import { makeIssue } from './test-issue'

describe('filterBoardIssues', () => {
  const xs = [
    makeIssue({ id: 'a', title: 'Login bug', priority: 0, type: 'bug', labels: ['ui'] }),
    makeIssue({
      id: 'b',
      title: 'Dark mode',
      priority: 2,
      type: 'feature',
      stage: 'review',
      blocked: true,
      ready: false,
    }),
  ]
  it('filters by text, priority, type, label, status', () => {
    expect(filterBoardIssues(xs, { text: 'login' }).map((i) => i.id)).toEqual(['a'])
    expect(filterBoardIssues(xs, { priority: 0 }).map((i) => i.id)).toEqual(['a'])
    expect(filterBoardIssues(xs, { type: 'feature' }).map((i) => i.id)).toEqual(['b'])
    expect(filterBoardIssues(xs, { label: 'ui' }).map((i) => i.id)).toEqual(['a'])
    expect(filterBoardIssues(xs, { status: 'blocked' }).map((i) => i.id)).toEqual(['b'])
  })
  it('filters by stage', () => {
    expect(filterBoardIssues(xs, { stage: 'review' }).map((i) => i.id)).toEqual(['b'])
  })

  it('hides archived by default and reveals them only when archived is on', () => {
    const ys = [
      makeIssue({ id: 'live', archived: false }),
      makeIssue({ id: 'gone', archived: true }),
    ]
    expect(filterBoardIssues(ys, {}).map((i) => i.id)).toEqual(['live'])
    expect(
      filterBoardIssues(ys, { archived: true })
        .map((i) => i.id)
        .sort(),
    ).toEqual(['gone', 'live'])
  })
})

describe('filter chips', () => {
  it('one chip per set dimension, text excluded', () => {
    const chips = filterChips({
      text: 'x',
      priority: 1,
      type: 'bug',
      status: 'open',
      label: 'ui',
      stage: 'review',
      archived: true,
    })
    expect(chips.map((c) => c.key).sort()).toEqual([
      'archived',
      'label',
      'priority',
      'stage',
      'status',
      'type',
    ])
    expect(chips.find((c) => c.key === 'priority')?.label).toBe('Priority: P1')
    expect(chips.find((c) => c.key === 'stage')?.label).toBe('Stage: Review')
    expect(chips.find((c) => c.key === 'archived')?.label).toBe('Archived')
  })
  it('clearChip removes exactly that dimension', () => {
    const f = clearChip({ priority: 1, type: 'bug' }, 'priority')
    expect(f.priority).toBeUndefined()
    expect(f.type).toBe('bug')
  })
})
