import { describe, expect, it } from 'vitest'
import {
  compareClaudeCredentialFreshness,
  hasValidClaudeCredential,
  readClaudeCredentialFreshness,
} from './credential-freshness.js'

function claude(expiresAt: number, access = 'access', refresh = 'refresh'): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt } })
}

describe('Claude native credential freshness', () => {
  it('orders comparable OAuth bytes and refuses unknown ordering', () => {
    expect(hasValidClaudeCredential(claude(100))).toBe(true)
    expect(readClaudeCredentialFreshness(claude(100))).toBe(100)
    expect(compareClaudeCredentialFreshness(claude(200), claude(100))).toBe(1)
    expect(compareClaudeCredentialFreshness(claude(100), claude(100))).toBe(0)
    expect(compareClaudeCredentialFreshness(claude(50), claude(100))).toBe(-1)
    expect(compareClaudeCredentialFreshness(
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }),
      claude(100),
    )).toBeNull()
  })
})
