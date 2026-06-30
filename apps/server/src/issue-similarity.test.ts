import { describe, expect, it } from 'vitest'
import { jaccard, tokenize } from './issue-similarity'

describe('issue-similarity', () => {
  it('tokenize lowercases and drops short tokens', () => {
    expect([...tokenize('Fix the Login BUG')].sort()).toEqual(['bug', 'fix', 'login', 'the'])
  })
  it('jaccard is intersection over union; 0 for disjoint, 1 for equal', () => {
    expect(jaccard(tokenize('login bug fix'), tokenize('login bug fix'))).toBe(1)
    expect(jaccard(tokenize('login bug'), tokenize('logout flow'))).toBe(0)
    expect(jaccard(new Set(), new Set())).toBe(0)
  })
})
