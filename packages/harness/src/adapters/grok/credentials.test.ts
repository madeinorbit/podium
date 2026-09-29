import { describe, expect, it } from 'vitest'
import { hasValidGrokCredential } from './credentials.js'

function grokAuth(entry: Record<string, unknown>): string {
  return JSON.stringify({ 'https://auth.x.ai::test-client': entry })
}

describe('Grok native credential validity', () => {
  it('treats an expired key with no refresh token as not logged in', () => {
    // POD-4803: the sandbox strips the refresh token on purpose; on a real
    // machine this is a login that lapsed (x.ai key expired 2026-09-26).
    const expiredNoRefresh = grokAuth({
      key: 'expired-access-token',
      auth_mode: 'oidc',
      create_time: '2026-09-25T00:00:00.000Z',
      expires_at: '2026-09-26T00:00:00.000Z',
      email: 'grace@example.com',
    })
    expect(hasValidGrokCredential(expiredNoRefresh)).toBe(false)
  })

  it('keeps an expired key ready when a refresh token can renew it', () => {
    const expiredWithRefresh = grokAuth({
      key: 'expired-access-token',
      refresh_token: 'refresh-token',
      expires_at: '2026-09-26T00:00:00.000Z',
      email: 'grace@example.com',
    })
    expect(hasValidGrokCredential(expiredWithRefresh)).toBe(true)
  })

  it('keeps a fresh key without a refresh token ready', () => {
    const fresh = grokAuth({
      key: 'live-access-token',
      expires_at: '2999-01-01T00:00:00.000Z',
      email: 'grace@example.com',
    })
    expect(hasValidGrokCredential(fresh)).toBe(true)
  })

  it('keeps a key with no expiry marker ready', () => {
    const noExpiry = grokAuth({
      key: 'live-access-token',
      email: 'grace@example.com',
    })
    expect(hasValidGrokCredential(noExpiry)).toBe(true)
  })
})
