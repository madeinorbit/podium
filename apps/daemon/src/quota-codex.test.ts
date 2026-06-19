import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeJwtEmail, fetchCodexQuota, parseCodexRateLimits } from './quota-codex'

const now = Date.parse('2026-06-19T18:00:00.000Z')
const rl = {
  primary: { usedPercent: 30, resetsAt: 1_750_356_000 },
  secondary: { usedPercent: 12, resetsAt: 1_750_700_000 },
}
function homeWithAuth(auth: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'podium-xq-'))
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify(auth))
  return home
}
const jwt = (claims: object): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

describe('parseCodexRateLimits', () => {
  it('maps primary→5h, secondary→weekly with unix→ISO reset', () => {
    const w = parseCodexRateLimits(rl)
    expect(w.map((x) => [x.key, x.usedPercent, x.windowMinutes])).toEqual([
      ['5h', 30, 300],
      ['weekly', 12, 10080],
    ])
    expect(w[0]?.resetsAt).toBe(new Date(1_750_356_000 * 1000).toISOString())
  })
})

describe('decodeJwtEmail', () => {
  it('extracts the email claim, undefined on garbage', () => {
    expect(decodeJwtEmail(jwt({ email: 'a@b.com' }))).toBe('a@b.com')
    expect(decodeJwtEmail('not-a-jwt')).toBeUndefined()
    expect(decodeJwtEmail(undefined)).toBeUndefined()
  })
})

describe('fetchCodexQuota', () => {
  it('is unauthenticated without auth.json', async () => {
    const home = mkdtempSync(join(tmpdir(), 'podium-xq-'))
    const r = await fetchCodexQuota({ homeDir: home, now, readImpl: async () => rl })
    expect(r).toMatchObject({ agent: 'codex', status: 'unauthenticated' })
  })

  it('returns ok windows + account email from the JWT', async () => {
    const home = homeWithAuth({ tokens: { id_token: jwt({ email: 'me@example.com' }) } })
    const r = await fetchCodexQuota({ homeDir: home, now, readImpl: async () => rl })
    expect(r.status).toBe('ok')
    expect(r.windows.map((w) => w.key)).toEqual(['5h', 'weekly'])
    expect(r.account?.email).toBe('me@example.com')
  })

  it('maps a reader throw to error', async () => {
    const home = homeWithAuth({ tokens: {} })
    const r = await fetchCodexQuota({
      homeDir: home,
      now,
      readImpl: async () => {
        throw new Error('app-server timed out')
      },
    })
    expect(r.status).toBe('error')
    expect(r.error).toContain('app-server')
  })
})
