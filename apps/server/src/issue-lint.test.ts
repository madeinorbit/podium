import { describe, expect, it } from 'vitest'
import { lintIssue } from './issue-lint'

const base = { title: 'T', description: '', acceptance: null } as any

describe('lintIssue', () => {
  it('a task requires acceptance', () => {
    expect(lintIssue({ ...base, type: 'task', description: 'x' })).toEqual([
      'missing acceptance criteria',
    ])
  })
  it('a phase or a decision has no template', () => {
    expect(lintIssue({ ...base, type: 'phase' })).toEqual([])
    expect(lintIssue({ ...base, type: 'decision' })).toEqual([])
  })
  it('a complete task has no findings', () => {
    expect(lintIssue({ ...base, type: 'task', acceptance: 'done when X' })).toEqual([])
  })
  it('missing title is always flagged', () => {
    expect(lintIssue({ ...base, title: '  ', type: 'task', acceptance: 'x' })).toEqual([
      'missing title',
    ])
  })
})
