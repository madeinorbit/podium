import { describe, expect, it } from 'vitest'
import { buildReport, parseReportFlags, runReportCli } from './session-cli'

const NOW = '2026-07-08T12:00:00.000Z'

const okFetch = (calls: Array<{ url: string; body: unknown }>) =>
  (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ ok: true, result: { attention: 'soon' } }), { status: 200 })
  }) as typeof fetch

describe('parseReportFlags', () => {
  it('parses --flag value, --flag=value, and quoted summaries; last wins', () => {
    expect(
      parseReportFlags([
        '--outcome',
        'partial',
        '--need=decision',
        '--summary',
        'billing needs a call',
        '--outcome',
        'blocked',
      ]),
    ).toEqual({ outcome: 'blocked', need: 'decision', summary: 'billing needs a call' })
  })

  it('treats a flag with no following value as empty (not the next flag)', () => {
    expect(parseReportFlags(['--summary', '--need', 'answer'])).toEqual({ summary: '', need: 'answer' })
  })
})

describe('buildReport', () => {
  it('builds a validated report from the three axes + summary, stamping a placeholder at', () => {
    const r = buildReport(
      ['--outcome', 'done', '--need', 'review', '--attention', 'soon', '--summary', 'PR ready'],
      NOW,
    )
    expect(r).toEqual({
      report: { outcome: 'done', need: 'review', attention: 'soon', summary: 'PR ready', at: NOW },
    })
  })

  it('parses --options into a trimmed non-empty list for decisions', () => {
    const r = buildReport(
      [
        '--outcome',
        'partial',
        '--need',
        'decision',
        '--attention',
        'soon',
        '--summary',
        'pick one',
        '--options',
        'drop now, keep both ,',
      ],
      NOW,
    )
    expect('report' in r && r.report.options).toEqual(['drop now', 'keep both'])
  })

  it('rejects an unknown outcome/need/attention with a usage hint', () => {
    const r = buildReport(
      ['--outcome', 'finished', '--need', 'nope', '--attention', 'urgent', '--summary', 'x'],
      NOW,
    )
    expect('error' in r && r.error).toContain('--outcome must be one of')
    expect('error' in r && r.error).toContain('--need must be one of')
    expect('error' in r && r.error).toContain('--attention must be one of')
  })

  it('requires a non-empty summary', () => {
    const r = buildReport(['--outcome', 'done', '--need', 'none', '--attention', 'whenever'], NOW)
    expect('error' in r && r.error).toContain('--summary is required')
  })
})

describe('runReportCli', () => {
  it('POSTs session.report with the validated report and prints a confirmation', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const out = await runReportCli(
      ['--outcome', 'partial', '--need', 'decision', '--attention', 'soon', '--summary', 'needs a call'],
      { relayEndpoint: 'http://127.0.0.1:1/issue/s1', nowIso: NOW, fetchImpl: okFetch(calls) },
    )
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:1/issue/s1',
        body: {
          router: 'session',
          proc: 'report',
          input: {
            outcome: 'partial',
            need: 'decision',
            attention: 'soon',
            summary: 'needs a call',
            at: NOW,
          },
        },
      },
    ])
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain('partial')
    expect(out.text).toContain('needs a call')
  })

  it('fails with guidance when PODIUM_ISSUE_RELAY is not set', async () => {
    const out = await runReportCli(['--outcome', 'done', '--need', 'none', '--attention', 'whenever', '--summary', 'x'], {
      nowIso: NOW,
    })
    expect(out.exitCode).toBe(1)
    expect(out.text).toContain('PODIUM_ISSUE_RELAY')
  })

  it('does not hit the network for an invalid report — validates locally first', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const out = await runReportCli(['--outcome', 'nope', '--summary', 'x'], {
      relayEndpoint: 'http://127.0.0.1:1/issue/s1',
      nowIso: NOW,
      fetchImpl: okFetch(calls),
    })
    expect(calls).toEqual([])
    expect(out.exitCode).toBe(1)
  })

  it('prints usage with no args and exits non-zero', async () => {
    const out = await runReportCli([], { nowIso: NOW })
    expect(out.exitCode).toBe(1)
    expect(out.text).toContain('usage: podium report')
  })
})
