import { describe, expect, it } from 'vitest'
import { lintIssue } from './issue-lint'

const base = { title: 'T', description: '', acceptance: null } as any

describe('lintIssue', () => {
  it('bug requires description + acceptance', () => {
    expect(lintIssue({ ...base, type: 'bug' })).toEqual([
      'bug missing reproduction (description)',
      'bug missing acceptance criteria',
    ])
  })
  it('feature requires acceptance only', () => {
    expect(lintIssue({ ...base, type: 'feature', description: 'x' })).toEqual([
      'missing acceptance criteria',
    ])
  })
  it('a complete task has no findings', () => {
    expect(lintIssue({ ...base, type: 'task', acceptance: 'done when X' })).toEqual([])
  })
  it('missing title is always flagged', () => {
    expect(lintIssue({ ...base, title: '  ', type: 'task', acceptance: 'x' })).toEqual(['missing title'])
  })
})
