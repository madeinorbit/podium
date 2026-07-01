import { describe, expect, it } from 'vitest'
import { filterBoardIssues } from './issue-board-filter'
import { makeIssue } from './test-issue'

describe('filterBoardIssues', () => {
  const xs = [
    makeIssue({ id: 'a', title: 'Login bug', priority: 0, type: 'bug', labels: ['ui'] }),
    makeIssue({
      id: 'b',
      title: 'Dark mode',
      priority: 2,
      type: 'feature',
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
})
