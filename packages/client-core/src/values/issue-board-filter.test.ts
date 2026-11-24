import { describe, expect, it } from 'vitest'
import { boardTextMatcher, filterBoardIssues } from './issue-board-filter'

const issue = (title: string, seq: number, displayRef?: string) =>
  ({ title, seq, displayRef, stage: 'in_progress', repoPath: '/r', priority: 2 }) as never

describe('boardTextMatcher', () => {
  it('is null for an empty needle', () => {
    expect(boardTextMatcher('')).toBeNull()
    expect(boardTextMatcher('   ')).toBeNull()
    expect(boardTextMatcher(undefined)).toBeNull()
  })
  it('matches titles case-insensitively and refs in any spelling', () => {
    const matches = boardTextMatcher('Lever')!
    expect(matches(issue('Hidden lever', 1))).toBe(true)
    expect(matches(issue('Other', 1))).toBe(false)
    for (const needle of ['POD-1234', 'pod 1234', '1234'])
      expect(boardTextMatcher(needle)!(issue('x', 1234, 'POD-1234'))).toBe(true)
  })
  it('never matches a ref without a digit', () => {
    expect(boardTextMatcher('pod')!(issue('x', 1234, 'POD-1234'))).toBe(false)
  })
  it('is the text facet of filterBoardIssues', () => {
    const issues = [issue('Hidden lever', 1, 'POD-1'), issue('Other', 2, 'POD-2')]
    expect(filterBoardIssues(issues, { text: 'pod-2' })).toEqual([issues[1]])
    expect(filterBoardIssues(issues, { text: '' })).toEqual(issues)
  })
})
