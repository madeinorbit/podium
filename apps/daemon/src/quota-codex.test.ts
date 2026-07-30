import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fetchCodexQuota, parseWhamUsage } from './quota-codex'

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


const now = Date.parse('2026-06-19T18:00:00.000Z')

const okBody = {
  email: 'me@example.com',
  plan_type: 'prolite',
  rate_limit: {
    primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1781887992 },
    secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_at: 1782357709 },
  },
}

function homeWithAuth(auth: unknown): string {
  const home = trackTmp('podium-xq-')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify(auth))
  return home
}

describe('parseWhamUsage', () => {
  it('maps primary_window→5h, secondary_window→weekly with unix→ISO reset', () => {
    const w = parseWhamUsage(okBody)
    expect(w.map((x) => [x.key, x.usedPercent, x.windowMinutes])).toEqual([
      ['5h', 4, 300],
      ['weekly', 15, 10080],
    ])
    expect(w[0]?.resetsAt).toBe(new Date(1781887992 * 1000).toISOString())
    expect(w[1]?.resetsAt).toBe(new Date(1782357709 * 1000).toISOString())
  })

  it('omits secondary_window when absent', () => {
    const body = {
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1781887992 },
      },
    }
    const w = parseWhamUsage(body)
    expect(w.map((x) => x.key)).toEqual(['5h'])
  })

  it('classifies a weekly-sized primary_window as weekly (5h limit disabled)', () => {
    const body = {
      rate_limit: {
        primary_window: { used_percent: 19, limit_window_seconds: 604800, reset_at: 1784524870 },
        secondary_window: null as unknown as undefined,
      },
    }
    const w = parseWhamUsage(body)
    expect(w.map((x) => [x.key, x.label, x.windowMinutes])).toEqual([
      ['weekly', 'Weekly', 10080],
    ])
  })

  it('classifies a 5h-sized secondary_window as 5h if windows are swapped', () => {
    const body = {
      rate_limit: {
        primary_window: { used_percent: 15, limit_window_seconds: 604800, reset_at: 1782357709 },
        secondary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1781887992 },
      },
    }
    expect(parseWhamUsage(body).map((x) => x.key)).toEqual(['weekly', '5h'])
  })

  it('returns empty array when rate_limit is absent', () => {
    expect(parseWhamUsage({})).toEqual([])
  })
})

describe('fetchCodexQuota', () => {
  it('is unauthenticated without auth.json (fetchImpl not called)', async () => {
    const home = trackTmp('podium-xq-')
    let called = false
    const r = await fetchCodexQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => {
        called = true
        return new Response('', { status: 200 })
      }) as typeof fetch,
    })
    expect(called).toBe(false)
    expect(r).toMatchObject({ agent: 'codex', status: 'unauthenticated', windows: [] })
  })

  it('returns ok windows + account on 200', async () => {
    const home = homeWithAuth({ tokens: { access_token: 'tok', account_id: 'acct123' } })
    const r = await fetchCodexQuota({
      homeDir: home,
      now,
      fetchImpl: (async () =>
        new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.windows.map((w) => w.key)).toEqual(['5h', 'weekly'])
    expect(r.windows[0]?.usedPercent).toBe(4)
    expect(r.windows[1]?.usedPercent).toBe(15)
    expect(r.account?.email).toBe('me@example.com')
    expect(r.account?.plan).toBe('prolite')
  })

  it('maps 401 to expired', async () => {
    const home = homeWithAuth({ tokens: { access_token: 'tok' } })
    const r = await fetchCodexQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch,
    })
    expect(r.status).toBe('expired')
  })

  it('maps non-401 error status to error', async () => {
    const home = homeWithAuth({ tokens: { access_token: 'tok' } })
    const r = await fetchCodexQuota({
      homeDir: home,
      now,
      fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
    })
    expect(r.status).toBe('error')
    expect(r.error).toContain('500')
  })

  it('maps a thrown fetchImpl to error', async () => {
    const home = homeWithAuth({ tokens: { access_token: 'tok' } })
    const r = await fetchCodexQuota({
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
