import { asIssueId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { issueNeighbors } from './issue-page'

describe('issueNeighbors', () => {
  it('middle / first / last / absent', () => {
    expect(
      issueNeighbors([asIssueId('a'), asIssueId('b'), asIssueId('c')], asIssueId('b')),
    ).toEqual({ prev: 'a', next: 'c' })
    expect(
      issueNeighbors([asIssueId('a'), asIssueId('b'), asIssueId('c')], asIssueId('a')),
    ).toEqual({ next: 'b' })
    expect(
      issueNeighbors([asIssueId('a'), asIssueId('b'), asIssueId('c')], asIssueId('c')),
    ).toEqual({ prev: 'b' })
    expect(
      issueNeighbors([asIssueId('a'), asIssueId('b'), asIssueId('c')], asIssueId('zz')),
    ).toEqual({})
  })
})
