import { describe, expect, it } from 'vitest'
import { codexSamplesFromEvent, grokSampleFromLogLine } from './quota-history-scan'

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
