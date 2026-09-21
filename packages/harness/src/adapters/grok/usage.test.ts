import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { grokUsageFromSession, scanGrokUsage, fetchGrokQuota, parseGrokBilling, grokSampleFromLogLine } from './usage.js'
import { fileBuckets, mergeBuckets, windowBuckets } from '../../usage-records.js'
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

/** Fold section scans the way the inventory mechanism does (file fold, window, merge). */
async function scanBuckets(opts: { sinceMs: number; homeDir: string }) {
  const scans = await scanGrokUsage(opts)
  return mergeBuckets(scans.flatMap((scan) => windowBuckets(fileBuckets(scan), opts.sinceMs)))
}

function writeGrokSession(
  home: string,
  id: string,
  signals: Record<string, unknown>,
  summary?: Record<string, unknown>,
): void {
  const dir = join(home, '.grok', 'sessions', '%2Fsrc', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'signals.json'), JSON.stringify(signals))
  if (summary) writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary))
}

describe('grokUsageFromSession', () => {
  it('reads context tokens, reply count, model, and last-active from the session snapshot', () => {
    const rec = grokUsageFromSession(
      {
        contextTokensUsed: 50_593,
        assistantMessageCount: 5,
        turnCount: 1,
        primaryModelId: 'grok-4.6',
        modelsUsed: ['grok-4.6'],
      },
      {
        info: { id: 'sess-1' },
        current_model_id: 'grok-4.6-build',
        last_active_at: '2026-08-13T05:46:27.505Z',
      },
      Date.parse('2026-08-13T00:00:00.000Z'),
    )
    expect(rec).toEqual({
      tsMs: Date.parse('2026-08-13T05:46:27.505Z'),
      model: 'grok-4.6',
      inputTokens: 50_593,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      messages: 5,
      responseId: 'grok-session:sess-1',
    })
  })

  it('falls back to current_model_id and file mtime when signals omit them', () => {
    const rec = grokUsageFromSession(
      { contextTokensUsed: 100, turnCount: 2 },
      { current_model_id: 'grok-4.5', updated_at: '2026-08-01T12:00:00.000Z' },
      0,
    )
    expect(rec).toMatchObject({
      model: 'grok-4.5',
      inputTokens: 100,
      messages: 2,
      tsMs: Date.parse('2026-08-01T12:00:00.000Z'),
    })
  })

  it('skips a snapshot with no tokens and no turns', () => {
    expect(grokUsageFromSession({ contextTokensUsed: 0, turnCount: 0 }, {}, 1)).toBeNull()
    expect(grokUsageFromSession(null, {}, 1)).toBeNull()
  })
})
describe('scanGrokUsage', () => {
  it('walks ~/.grok/sessions and keeps sessions inside the window', async () => {
    const home = trackTmp('podium-usage-grok-')
    writeGrokSession(
      home,
      'keep',
      { contextTokensUsed: 1_000, assistantMessageCount: 3, primaryModelId: 'grok-4.6' },
      {
        info: { id: 'keep' },
        last_active_at: '2026-06-12T10:15:00.000Z',
      },
    )
    writeGrokSession(
      home,
      'old',
      { contextTokensUsed: 9_999, assistantMessageCount: 9, primaryModelId: 'grok-4.6' },
      {
        info: { id: 'old' },
        last_active_at: '2026-05-01T10:00:00.000Z',
      },
    )

    const buckets = await scanBuckets({
      sinceMs: Date.parse('2026-06-10T00:00:00Z'),
      homeDir: home,
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      hour: '2026-06-12T10:00:00.000Z',
      model: 'grok-4.6',
      inputTokens: 1_000,
      outputTokens: 0,
      messages: 3,
    })
  })

  it('still harvests a session whose summary.json is missing', async () => {
    const home = trackTmp('podium-usage-grok-nosummary-')
    writeGrokSession(home, 'bare', {
      contextTokensUsed: 40,
      assistantMessageCount: 1,
      primaryModelId: 'grok-4.5',
    })
    const buckets = await scanBuckets({ sinceMs: 0, homeDir: home })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ model: 'grok-4.5', inputTokens: 40, messages: 1 })
  })

  it('returns [] when no grok dir exists', async () => {
    const home = trackTmp('podium-usage-grok-empty-')
    expect(await scanGrokUsage({ sinceMs: 0, homeDir: home })).toEqual([])
  })

  it('does not harvest a signals.json buried in terminal logs', async () => {
    const home = trackTmp('podium-usage-grok-logs-')
    writeGrokSession(home, 'keep', {
      contextTokensUsed: 10,
      assistantMessageCount: 1,
      primaryModelId: 'grok-4.6',
    })
    const decoy = join(home, '.grok', 'sessions', '%2Fsrc', 'keep', 'terminal')
    mkdirSync(decoy, { recursive: true })
    writeFileSync(
      join(decoy, 'signals.json'),
      JSON.stringify({
        contextTokensUsed: 99_999,
        assistantMessageCount: 50,
        primaryModelId: 'grok-4.6',
      }),
    )

    const buckets = await scanBuckets({ sinceMs: 0, homeDir: home })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ inputTokens: 10, messages: 1 })
  })

  it('includes a subagent session snapshot', async () => {
    const home = trackTmp('podium-usage-grok-sub-')
    writeGrokSession(home, 'parent', {
      contextTokensUsed: 20,
      assistantMessageCount: 1,
      primaryModelId: 'grok-4.6',
    })
    const child = join(home, '.grok', 'sessions', '%2Fsrc', 'parent', 'subagents', 'child')
    mkdirSync(child, { recursive: true })
    writeFileSync(
      join(child, 'signals.json'),
      JSON.stringify({
        contextTokensUsed: 30,
        assistantMessageCount: 2,
        primaryModelId: 'grok-4.6',
      }),
    )

    const buckets = await scanBuckets({ sinceMs: 0, homeDir: home })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ model: 'grok-4.6', inputTokens: 50, messages: 3 })
  })
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

const weeklyBody = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-07-20T00:00:00+00:00',
      end: '2026-07-27T00:00:00+00:00',
    },
  },
}

const resetWeeklyBody = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-07-27T00:00:00+00:00',
      end: '2026-08-03T00:00:00+00:00',
    },
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

  it('maps the credits response weekly pool to a second window', () => {
    const w = parseGrokBilling({
      config: {
        ...okBody.config,
        ...weeklyBody.config,
      },
    })
    expect(w.map((window) => window.key)).toEqual(['monthly', 'weekly'])
    expect(w[1]).toMatchObject({
      key: 'weekly',
      label: 'Weekly',
      usedPercent: 42.5,
      resetsAt: '2026-07-27T00:00:00+00:00',
      windowMinutes: 10_080,
    })
  })

  it('maps an omitted post-reset weekly percentage to 0%', () => {
    expect(parseGrokBilling(resetWeeklyBody)).toEqual([
      {
        key: 'weekly',
        label: 'Weekly',
        usedPercent: 0,
        resetsAt: '2026-08-03T00:00:00+00:00',
        windowMinutes: 10_080,
      },
    ])
  })

  it('does not infer a weekly window without a weekly period or percentage', () => {
    expect(
      parseGrokBilling({
        config: {
          billingPeriodStart: '2026-07-27T00:00:00+00:00',
          billingPeriodEnd: '2026-08-03T00:00:00+00:00',
        },
      }),
    ).toEqual([])
  })

  it('ignores a non-weekly current period for the weekly window', () => {
    expect(
      parseGrokBilling({
        config: {
          creditUsagePercent: 42,
          currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' },
        },
      }),
    ).toEqual([])
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
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input)
      return new Response(
        JSON.stringify(url.includes('?format=credits') ? weeklyBody : okBody),
        { status: 200 },
      )
    }) as typeof fetch
    const r = await fetchGrokQuota({
      homeDir: home,
      now,
      fetchImpl,
    })
    expect(r.status).toBe('ok')
    expect(r.windows.map((w) => w.key)).toEqual(['monthly', 'weekly'])
    expect(r.windows[0]?.usedPercent).toBe(3.2)
    expect(r.windows[1]?.usedPercent).toBe(42.5)
    expect(r.account?.email).toBe('me@example.com')
  })

  it('returns a 0% weekly window for the post-reset credits response', async () => {
    const home = homeWithAuth(sampleAuth)
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input)
      return new Response(
        JSON.stringify(url.includes('?format=credits') ? resetWeeklyBody : okBody),
        { status: 200 },
      )
    }) as typeof fetch

    const r = await fetchGrokQuota({ homeDir: home, now, fetchImpl })

    expect(r.status).toBe('ok')
    expect(r.windows.map((window) => [window.key, window.usedPercent])).toEqual([
      ['monthly', 3.2],
      ['weekly', 0],
    ])
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

describe('grokSampleFromLogLine', () => {
  // A verbatim line from ~/.grok/logs/unified.jsonl.
  const LINE = JSON.stringify({
    ts: '2026-08-13T18:41:55.764Z',
    src: 'shell',
    lvl: 'info',
    msg: 'billing: fetched credits config',
    ctx: {
      config: {
        creditUsagePercent: 80.0,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-12T12:35:22.333410+00:00',
          end: '2026-08-19T12:35:22.333410+00:00',
        },
      },
    },
  })

  it('maps the billing config onto a weekly sample', () => {
    const sample = grokSampleFromLogLine(LINE, 'm1')
    expect(sample).toMatchObject({
      agent: 'grok',
      windowKey: 'weekly',
      usedPercent: 80,
      windowMinutes: 10080,
    })
    expect(sample?.resetsAtMs).toBe(Date.parse('2026-08-19T12:35:22.333410+00:00'))
  })

  it('derives the duration from the period Grok actually reports', () => {
    // Grok is the one harness that sends a real window START. Everywhere else the
    // start has to be inferred backwards from the reset.
    expect(grokSampleFromLogLine(LINE, 'm1')?.windowMinutes).toBe(7 * 24 * 60)
  })

  it('refuses a monthly period, matching the live fetcher', () => {
    // The live `format=credits` branch only accepts a weekly period. If this
    // accepted monthly, recovered rows would land in a series live sampling
    // never writes to, and the two halves of one strip would disagree.
    const monthly = LINE.replace('USAGE_PERIOD_TYPE_WEEKLY', 'USAGE_PERIOD_TYPE_MONTHLY')
    expect(grokSampleFromLogLine(monthly, 'm1')).toBeUndefined()
  })

  it('carries the account email so recovered windows join the live series', () => {
    // Without it, `quotaAccountKey` keys backfill `grok::machine:<id>` while live
    // sampling keys the same pool `grok::<email>`. The two never converge and the
    // ledger draws two indistinguishable Grok strips instead of one history.
    expect(grokSampleFromLogLine(LINE, 'm1', 'a@b.c')?.email).toBe('a@b.c')
    expect(grokSampleFromLogLine(LINE, 'm1')?.email).toBeUndefined()
  })

  it('ignores every other line in the log', () => {
    expect(grokSampleFromLogLine('{"msg":"something else"}', 'm1')).toBeUndefined()
    expect(grokSampleFromLogLine('not json', 'm1')).toBeUndefined()
    expect(grokSampleFromLogLine('', 'm1')).toBeUndefined()
  })

  it('clamps a percentage outside 0..100', () => {
    const over = LINE.replace('"creditUsagePercent":80', '"creditUsagePercent":140')
    expect(grokSampleFromLogLine(over, 'm1')?.usedPercent).toBe(100)
  })
})
