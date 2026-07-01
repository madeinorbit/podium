import { describe, expect, it } from 'vitest'
import { makeIssueClient } from './issue-client'

describe('makeIssueClient', () => {
  it('builds a client (smoke)', () => {
    expect(makeIssueClient('http://localhost:1')).toBeDefined()
  })
})
