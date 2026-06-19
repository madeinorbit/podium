import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchClaudeQuota, parseClaudeUsage } from './quota-claude'

function homeWithCreds(creds: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'podium-cq-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(creds))
  return home
}
const okBody = {
  five_hour: { utilization: 0.425, resets_at: '2026-06-19T20:00:00.000Z' },
  seven_day: { utilization: 0.07, resets_at: '2026-06-24T00:00:00.000Z' },
}
const now = Date.parse('2026-06-19T18:00:00.000Z')
const future = now + 3_600_000

describe('parseClaudeUsage', () => {
  it('maps fraction utilization to 0..100 percent + window minutes', () => {
    expect(parseClaudeUsage(okBody)).toEqual([
      { key: '5h', label: '5-hour', usedPercent: 42.5, resetsAt: '2026-06-19T20:00:00.000Z', windowMinutes: 300 },
      { key: 'weekly', label: 'Weekly', usedPercent: 7, resetsAt: '2026-06-24T00:00:00.000Z', windowMinutes: 10080 },
    ])
  })
})

describe('fetchClaudeQuota', () => {
  it('is unauthenticated when no credentials file exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'podium-cq-'))
    const r = await fetchClaudeQuota({ homeDir: home, now })
    expect(r).toMatchObject({ agent: 'claude-code', status: 'unauthenticated', windows: [] })
  })

  it('is expired (no network call) when the token is past expiry', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: now - 1 } })
    let called = false
    const r = await fetchClaudeQuota({
      homeDir: home, now,
      fetchImpl: (async () => { called = true; return new Response('', { status: 200 }) }) as typeof fetch,
    })
    expect(called).toBe(false)
    expect(r.status).toBe('expired')
  })

  it('returns ok windows on a 200 with a valid token', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r = await fetchClaudeQuota({
      homeDir: home, now,
      fetchImpl: (async () => new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.windows.map((w) => w.key)).toEqual(['5h', 'weekly'])
  })

  it('maps 401 to expired and other failures to error', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r401 = await fetchClaudeQuota({ homeDir: home, now, fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch })
    expect(r401.status).toBe('expired')
    const r500 = await fetchClaudeQuota({ homeDir: home, now, fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch })
    expect(r500.status).toBe('error')
  })
})
