import { describe, expect, it } from 'vitest'
import { makeIssueClient } from './issue-client'

describe('makeIssueClient credentials', () => {
  it('builds a client (smoke) with and without creds', () => {
    expect(makeIssueClient('http://localhost:1')).toBeDefined()
    expect(makeIssueClient('http://localhost:1', { token: 't', cwd: '/x' })).toBeDefined()
  })
})
