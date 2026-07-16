import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fetchClaudeQuota, parseClaudeUsage } from './quota-claude'

// POD-518 [spec:SP-0be7]: every mkdtemp in this file is tracked and removed when the file's
// tests finish, so a suite run leaves nothing behind in tmp.
const tmpDirs: string[] = []
function trackTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})


function homeWithCreds(creds: unknown): string {
  const home = trackTmp('podium-cq-')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(creds))
  return home
}
const okBody = {
  five_hour: { utilization: 42.5, resets_at: '2026-06-19T20:00:00.000Z' },
  seven_day: { utilization: 7, resets_at: '2026-06-24T00:00:00.000Z' },
}
const genericBody = {
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 42.5,
      resets_at: '2026-06-19T20:00:00.000Z',
      scope: null,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 7,
      resets_at: '2026-06-24T00:00:00.000Z',
      scope: null,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 83,
      resets_at: '2026-06-24T00:00:00.000Z',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
}
const now = Date.parse('2026-06-19T18:00:00.000Z')
const future = now + 3_600_000

describe('parseClaudeUsage', () => {
  it('maps the legacy fixed fields when the generic limits array is absent', () => {
    expect(parseClaudeUsage(okBody)).toEqual([
      {
        key: '5h',
        label: '5-hour',
        usedPercent: 42.5,
        resetsAt: '2026-06-19T20:00:00.000Z',
        windowMinutes: 300,
      },
      {
        key: 'weekly',
        label: 'Weekly',
        usedPercent: 7,
        resetsAt: '2026-06-24T00:00:00.000Z',
        windowMinutes: 10080,
      },
    ])
  })

  it('maps every generic limit and uses the upstream scoped display name', () => {
    expect(parseClaudeUsage(genericBody)).toEqual([
      {
        key: 'session',
        label: '5-hour',
        usedPercent: 42.5,
        resetsAt: '2026-06-19T20:00:00.000Z',
        windowMinutes: 300,
      },
      {
        key: 'weekly-all',
        label: 'Weekly',
        usedPercent: 7,
        resetsAt: '2026-06-24T00:00:00.000Z',
        windowMinutes: 10080,
      },
      {
        key: 'weekly-scoped:model:fable',
        label: 'Fable',
        usedPercent: 83,
        resetsAt: '2026-06-24T00:00:00.000Z',
        windowMinutes: 10080,
      },
    ])
  })

  it('tolerates a removed scoped limit and displays an unknown replacement generically', () => {
    expect(
      parseClaudeUsage({
        limits: [
          genericBody.limits[0],
          {
            kind: 'burst_scoped',
            group: 'burst',
            percent: 12.34,
            resets_at: '2026-06-20T00:00:00.000Z',
            scope: { model: { id: 'model-7', display_name: 'Quasar' } },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ key: 'session', label: '5-hour' }),
      {
        key: 'burst-scoped:model:model-7',
        label: 'Quasar',
        usedPercent: 12.3,
        resetsAt: '2026-06-20T00:00:00.000Z',
        windowMinutes: 0,
      },
    ])
  })

  it('falls back to legacy fields when a malformed limits array has no usable entries', () => {
    expect(parseClaudeUsage({ ...okBody, limits: [null, { kind: 'weekly_scoped' }] })).toEqual(
      parseClaudeUsage(okBody),
    )
  })
})

describe('fetchClaudeQuota', () => {
  it('is unauthenticated when no credentials file exists', async () => {
    const home = trackTmp('podium-cq-')
    const r = await fetchClaudeQuota({ homeDir: home, now })
    expect(r).toMatchObject({ agent: 'claude-code', status: 'unauthenticated', windows: [] })
  })

  it('is expired (no network call) when the token is past expiry', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: now - 1 } })
    let called = false
    const r = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => {
        called = true
        return new Response('', { status: 200 })
      }) as typeof fetch,
    })
    expect(called).toBe(false)
    expect(r.status).toBe('expired')
  })

  it('returns ok windows on a 200 with a valid token', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () =>
        new Response(JSON.stringify(genericBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.windows.map((w) => w.label)).toEqual(['5-hour', 'Weekly', 'Fable'])
  })

  it('maps 401 to expired and other failures to error', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r401 = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch,
    })
    expect(r401.status).toBe('expired')
    const r500 = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
    })
    expect(r500.status).toBe('error')
  })

  it('populates the account email (from ~/.claude.json) and plan (subscriptionType)', async () => {
    const home = homeWithCreds({
      claudeAiOauth: { accessToken: 't', expiresAt: future, subscriptionType: 'max' },
    })
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }),
    )
    const r = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () =>
        new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.account).toEqual({ email: 'me@example.com', plan: 'max' })
  })

  it('still carries the account on an expired token so the overlay can label it', async () => {
    const home = homeWithCreds({
      claudeAiOauth: { accessToken: 't', expiresAt: now - 1, subscriptionType: 'max' },
    })
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }),
    )
    const r = await fetchClaudeQuota({ homeDir: home, now })
    expect(r.status).toBe('expired')
    expect(r.account?.email).toBe('me@example.com')
  })

  it('omits the account when ~/.claude.json is absent and no plan is known', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r = await fetchClaudeQuota({
      homeDir: home,
      now,
      fetchImpl: (async () =>
        new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.account).toBeUndefined()
  })
})
