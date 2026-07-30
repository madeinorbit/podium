import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fetchGrokQuota, parseGrokBilling } from './quota-grok'

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

const now = Date.parse('2026-07-24T18:00:00.000Z')

const okBody = {
  config: {
    monthlyLimit: { val: 20_000 },
    used: { val: 641 },
    onDemandCap: { val: 0 },
    billingPeriodStart: '2026-07-01T00:00:00+00:00',
    billingPeriodEnd: '2026-08-01T00:00:00+00:00',
  },
}

function homeWithAuth(auth: unknown): string {
  const home = trackTmp('podium-gq-')
  mkdirSync(join(home, '.grok'), { recursive: true })
  writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify(auth))
  return home
}

const sampleAuth = {
  'https://auth.x.ai::client-id': {
    key: 'tok',
    email: 'me@example.com',
    expires_at: '2026-07-24T20:00:00.000Z',
    auth_mode: 'oidc',
  },
}

describe('parseGrokBilling', () => {
  it('maps monthly credit pool to one window with period length', () => {
    const w = parseGrokBilling(okBody)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({
      key: 'monthly',
      label: 'Monthly',
      usedPercent: 3.2, // 641/20000
      resetsAt: '2026-08-01T00:00:00+00:00',
    })
    // July has 31 days → 31 * 24 * 60 = 44640 minutes
    expect(w[0]?.windowMinutes).toBe(44_640)
  })

  it('returns empty when config or limit is missing', () => {
    expect(parseGrokBilling({})).toEqual([])
    expect(parseGrokBilling({ config: {} })).toEqual([])
    expect(parseGrokBilling({ config: { monthlyLimit: { val: 0 }, used: { val: 10 } } })).toEqual(
      [],
    )
  })

  it('treats missing used as 0%', () => {
    const w = parseGrokBilling({
      config: {
        monthlyLimit: { val: 100 },
        billingPeriodEnd: '2026-08-01T00:00:00Z',
      },
    })
    expect(w[0]?.usedPercent).toBe(0)
    expect(w[0]?.windowMinutes).toBe(0) // no start → unknown duration
  })

  it('clamps usedPercent to 100', () => {
    const w = parseGrokBilling({
      config: { monthlyLimit: { val: 100 }, used: { val: 250 } },
    })
    expect(w[0]?.usedPercent).toBe(100)
  })
})

describe('fetchGrokQuota', () => {
  it('is unauthenticated without auth.json (fetchImpl not called)', async () => {
    const home = trackTmp('podium-gq-')
    let called = false
    const r = await fetchGrokQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => {
        called = true
        return new Response('', { status: 200 })
      }) as typeof fetch,
    })
    expect(called).toBe(false)
    expect(r).toMatchObject({ agent: 'grok', status: 'unauthenticated', windows: [] })
  })

  it('returns ok windows + email on 200', async () => {
    const home = homeWithAuth(sampleAuth)
    const r = await fetchGrokQuota({
      homeDir: home,
      now,
      fetchImpl: (async () =>
        new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.windows.map((w) => w.key)).toEqual(['monthly'])
    expect(r.windows[0]?.usedPercent).toBe(3.2)
    expect(r.account?.email).toBe('me@example.com')
  })

  it('maps local expires_at in the past to expired without fetching', async () => {
    const home = homeWithAuth({
      'https://auth.x.ai::c': {
        key: 'tok',
        email: 'me@example.com',
        expires_at: '2026-07-24T12:00:00.000Z',
      },
    })
    let called = false
    const r = await fetchGrokQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => {
        called = true
        return new Response('', { status: 200 })
      }) as typeof fetch,
    })
    expect(called).toBe(false)
    expect(r.status).toBe('expired')
    expect(r.account?.email).toBe('me@example.com')
  })

  it('maps 401 to expired', async () => {
    const home = homeWithAuth(sampleAuth)
    const r = await fetchGrokQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch,
    })
    expect(r.status).toBe('expired')
  })

  it('maps non-401 error status to error', async () => {
    const home = homeWithAuth(sampleAuth)
    const r = await fetchGrokQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
    })
    expect(r.status).toBe('error')
    expect(r.error).toContain('500')
  })

  it('maps a thrown fetchImpl to error', async () => {
    const home = homeWithAuth(sampleAuth)
    const r = await fetchGrokQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => {
        throw new Error('network failure')
      }) as typeof fetch,
    })
    expect(r.status).toBe('error')
    expect(r.error).toContain('network failure')
  })
})
