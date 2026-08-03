import { describe, expect, it } from 'vitest'
import { clearChip, filterBoardIssues, filterChips } from './issue-board-filter'
import { makeIssue } from '@/lib/test-issue'

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
  it('matches the issue ref, however the user types it', () => {
    const ys = [
      makeIssue({ id: 'a', seq: 1234, displayRef: 'POD-1234', title: 'Login bug' }),
      makeIssue({ id: 'b', seq: 7, displayRef: 'POD-7', title: 'Dark mode' }),
    ]
    const ids = (text: string): string[] => filterBoardIssues(ys, { text }).map((i) => i.id)
    expect(ids('POD-1234')).toEqual(['a'])
    expect(ids('pod-1234')).toEqual(['a'])
    expect(ids('pod 1234')).toEqual(['a'])
    expect(ids('1234')).toEqual(['a'])
    expect(ids('#1234')).toEqual(['a'])
    expect(ids('POD-9999')).toEqual([])
  })

  it('falls back to the #seq ref when the issue has no displayRef', () => {
    const ys = [makeIssue({ id: 'a', seq: 42, title: 'Login bug' })]
    expect(filterBoardIssues(ys, { text: '#42' }).map((i) => i.id)).toEqual(['a'])
    expect(filterBoardIssues(ys, { text: '42' }).map((i) => i.id)).toEqual(['a'])
    expect(filterBoardIssues(ys, { text: '43' })).toEqual([])
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

  it('hides deleted issues by default and shows them in the deleted view', () => {
    const ys = [
      makeIssue({ id: 'live' }),
      makeIssue({ id: 'gone', deletedAt: '2026-07-13T10:00:00.000Z' }),
      makeIssue({ id: 'archived-gone', archived: true, deletedAt: '2026-07-13T10:00:00.000Z' }),
    ]
    expect(filterBoardIssues(ys, {}).map((i) => i.id)).toEqual(['live'])
    expect(filterBoardIssues(ys, { deleted: true }).map((i) => i.id)).toEqual([
      'live',
      'gone',
      'archived-gone',
    ])
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
      deleted: true,
    })
    expect(chips.map((c) => c.key).sort()).toEqual([
      'archived',
      'deleted',
      'label',
      'priority',
      'stage',
      'status',
      'type',
    ])
    expect(chips.find((c) => c.key === 'priority')?.label).toBe('Priority: P1')
    expect(chips.find((c) => c.key === 'stage')?.label).toBe('Stage: Review')
    expect(chips.find((c) => c.key === 'archived')?.label).toBe('Archived')
    expect(chips.find((c) => c.key === 'deleted')?.label).toBe('Deleted')
  })
  it('clearChip removes exactly that dimension', () => {
    const f = clearChip({ priority: 1, type: 'bug' }, 'priority')
    expect(f.priority).toBeUndefined()
    expect(f.type).toBe('bug')
  })
})
