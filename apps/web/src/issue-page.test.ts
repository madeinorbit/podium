import { describe, expect, it } from 'vitest'
import { issueNeighbors } from './issue-page'

describe('issueNeighbors', () => {
  it('middle / first / last / absent', () => {
    expect(issueNeighbors(['a', 'b', 'c'], 'b')).toEqual({ prev: 'a', next: 'c' })
    expect(issueNeighbors(['a', 'b', 'c'], 'a')).toEqual({ next: 'b' })
    expect(issueNeighbors(['a', 'b', 'c'], 'c')).toEqual({ prev: 'b' })
    expect(issueNeighbors(['a', 'b', 'c'], 'zz')).toEqual({})
  })
})
