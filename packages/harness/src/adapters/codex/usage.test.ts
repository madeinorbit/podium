import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { codexModelOf, codexUsageFromRecord, scanCodexUsage, fetchCodexQuota, parseWhamUsage, codexSamplesFromEvent } from './usage.js'
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

// ── Codex (POD-570). Shapes below are copied from real
// ~/.codex/sessions/**/rollout-*.jsonl records (codex-cli 0.146.1).

const turnContextLine = (model: string) =>
  JSON.stringify({
    timestamp: '2026-08-06T22:03:51.610Z',
    type: 'turn_context',
    payload: { turn_id: 't1', cwd: '/src/app', model, effort: 'high' },
  })

const tokenCountLine = (
  ts: string,
  last: Record<string, number> | null,
  total?: Record<string, number>,
) =>
  JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        ...(last ? { last_token_usage: last } : {}),
        total_token_usage: total ?? last ?? {},
        model_context_window: 258_400,
      },
    },
  })

const LAST = {
  input_tokens: 21_506,
  cached_input_tokens: 18_176,
  cache_write_input_tokens: 0,
  output_tokens: 445,
  reasoning_output_tokens: 105,
  total_tokens: 21_951,
}

describe('codexModelOf', () => {
  it('reads the model off turn_context and ignores every other record', () => {
    expect(codexModelOf(JSON.parse(turnContextLine('gpt-5.6-sol')))).toBe('gpt-5.6-sol')
    expect(codexModelOf(JSON.parse(tokenCountLine('2026-06-12T10:00:00Z', LAST)))).toBeUndefined()
    expect(codexModelOf({ type: 'turn_context', payload: {} })).toBeUndefined()
    expect(codexModelOf(null)).toBeUndefined()
  })
})
describe('codexUsageFromRecord', () => {
  it('unpacks cached_input_tokens out of input_tokens so it is not billed twice', () => {
    const rec = codexUsageFromRecord(
      JSON.parse(tokenCountLine('2026-06-12T10:01:00.000Z', LAST)),
      'gpt-5.6-sol',
    )
    expect(rec).toEqual({
      tsMs: Date.parse('2026-06-12T10:01:00.000Z'),
      model: 'gpt-5.6-sol',
      // 21506 total input − 18176 cached: the remainder billed at full rate.
      inputTokens: 3_330,
      // reasoning_output_tokens (105) is already inside output_tokens.
      outputTokens: 445,
      cacheReadTokens: 18_176,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
    })
  })

  it('accepts the older cache_read_input_tokens spelling', () => {
    const rec = codexUsageFromRecord(
      JSON.parse(
        tokenCountLine('2026-06-12T10:01:00.000Z', {
          input_tokens: 1_000,
          cache_read_input_tokens: 600,
          output_tokens: 10,
        }),
      ),
      'gpt-5',
    )
    expect(rec).toMatchObject({ inputTokens: 400, cacheReadTokens: 600 })
  })

  it('clamps a cached count that exceeds its input rather than going negative', () => {
    const rec = codexUsageFromRecord(
      JSON.parse(
        tokenCountLine('2026-06-12T10:01:00.000Z', {
          input_tokens: 100,
          cached_input_tokens: 5_000,
          output_tokens: 1,
        }),
      ),
      'gpt-5',
    )
    expect(rec).toMatchObject({ inputTokens: 0, cacheReadTokens: 100 })
  })

  it('ignores a token_count carrying no last_token_usage, and other records', () => {
    expect(
      codexUsageFromRecord(JSON.parse(tokenCountLine('2026-06-12T10:00:00Z', null)), 'gpt-5'),
    ).toBeNull()
    expect(codexUsageFromRecord(JSON.parse(turnContextLine('gpt-5')), 'gpt-5')).toBeNull()
    expect(codexUsageFromRecord({ type: 'response_item' }, 'gpt-5')).toBeNull()
  })
})
describe('scanCodexUsage', () => {
  const writeRollout = (home: string, name: string, lines: string[]): void => {
    const dir = join(home, '.codex', 'sessions', '2026', '06', '12')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), lines.join('\n'))
  }

  it('walks the nested date dirs, carrying the model forward from turn_context', async () => {
    const home = trackTmp('podium-usage-codex-')
    writeRollout(home, 'rollout-a.jsonl', [
      '{"type":"session_meta","payload":{"id":"abc","source":"cli"}}',
      turnContextLine('gpt-5.6-sol'),
      tokenCountLine('2026-06-12T10:01:00.000Z', LAST),
      tokenCountLine('2026-06-12T10:44:00.000Z', LAST),
      tokenCountLine('2026-05-01T10:01:00.000Z', LAST), // before since
      'not json',
    ])
    const buckets = await scanCodexUsage({
      sinceMs: Date.parse('2026-06-10T00:00:00Z'),
      homeDir: home,
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      hour: '2026-06-12T10:00:00.000Z',
      model: 'gpt-5.6-sol',
      inputTokens: 6_660,
      outputTokens: 890,
      cacheReadTokens: 36_352,
      messages: 2,
    })
  })

  it('follows a mid-session model switch', async () => {
    const home = trackTmp('podium-usage-codex-switch-')
    writeRollout(home, 'rollout-b.jsonl', [
      turnContextLine('gpt-5.6-sol'),
      tokenCountLine('2026-06-12T10:01:00.000Z', LAST),
      turnContextLine('gpt-5-mini'),
      tokenCountLine('2026-06-12T10:02:00.000Z', LAST),
    ])
    // Same hour, so both land in one hour with a bucket each — the switch is
    // visible as two models, not one model charged for both turns.
    const buckets = await scanCodexUsage({ sinceMs: 0, homeDir: home })
    expect(buckets.map((b) => b.model).sort()).toEqual(['gpt-5-mini', 'gpt-5.6-sol'])
    expect(buckets.every((b) => b.messages === 1)).toBe(true)
  })

  it('attributes usage to unknown when a rollout names no model at all', async () => {
    const home = trackTmp('podium-usage-codex-nomodel-')
    writeRollout(home, 'rollout-c.jsonl', [tokenCountLine('2026-06-12T10:01:00.000Z', LAST)])
    const buckets = await scanCodexUsage({ sinceMs: 0, homeDir: home })
    expect(buckets[0]).toMatchObject({ model: 'unknown', messages: 1 })
  })

  it('returns [] when no codex dir exists', async () => {
    const home = trackTmp('podium-usage-codex-empty-')
    expect(await scanCodexUsage({ sinceMs: 0, homeDir: home })).toEqual([])
  })
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

describe('codexSamplesFromEvent', () => {
  // A verbatim event from a real rollout on disk, tokens removed.
  const REAL = {
    type: 'token_count',
    info: { total_token_usage: {}, last_token_usage: {}, model_context_window: 258400 },
    rate_limits: {
      limit_id: 'codex',
      limit_name: null,
      primary: { used_percent: 58, window_minutes: 10080, resets_at: 1787206859 },
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' },
      plan_type: 'pro',
    },
  }

  it('reads rate_limits from the payload, where it actually lives', () => {
    // The obvious guess is payload.info.rate_limits. It is wrong, and being wrong
    // is silent: the scan returns zero samples and looks like "no history".
    const samples = codexSamplesFromEvent(REAL, 'a@b.c', 'm1', 1_000)
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      agent: 'codex',
      windowKey: 'weekly',
      usedPercent: 58,
      windowMinutes: 10080,
      plan: 'pro',
      email: 'a@b.c',
    })
  })

  it('converts resets_at from epoch SECONDS', () => {
    const sample = codexSamplesFromEvent(REAL, undefined, 'm1', 1_000)[0]
    expect(sample?.resetsAtMs).toBe(1787206859 * 1000)
  })

  it('still reads a payload that nests rate_limits under info', () => {
    const nested = { info: { rate_limits: REAL.rate_limits } }
    expect(codexSamplesFromEvent(nested, undefined, 'm1', 1_000)).toHaveLength(1)
  })

  it('classifies by the provider duration, not by slot', () => {
    const shortPrimary = {
      rate_limits: {
        primary: { used_percent: 4, window_minutes: 300, resets_at: 1787206859 },
        secondary: { used_percent: 15, window_minutes: 10080, resets_at: 1787806859 },
      },
    }
    const keys = codexSamplesFromEvent(shortPrimary, undefined, 'm1', 1_000).map((s) => s.windowKey)
    expect(keys).toEqual(['5h', 'weekly'])
  })

  it('ignores a null secondary and events with no rate limits at all', () => {
    expect(codexSamplesFromEvent(REAL, undefined, 'm1', 1)).toHaveLength(1)
    expect(codexSamplesFromEvent({ info: {} }, undefined, 'm1', 1)).toEqual([])
    expect(codexSamplesFromEvent(null, undefined, 'm1', 1)).toEqual([])
    expect(codexSamplesFromEvent('nope', undefined, 'm1', 1)).toEqual([])
  })

  it('drops a window with no usable percentage', () => {
    const broken = { rate_limits: { primary: { window_minutes: 10080, resets_at: 1 } } }
    expect(codexSamplesFromEvent(broken, undefined, 'm1', 1)).toEqual([])
  })
})
