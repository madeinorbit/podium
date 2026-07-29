import type { MachineQuotaWire } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  QuotaCliError,
  type QuotaClient,
  quotaHelpText,
  renderQuota,
  runQuotaCli,
} from './quota-cli'

const NOW = Date.parse('2026-07-29T10:00:00.000Z')

const machines: MachineQuotaWire[] = [
  {
    machineId: 'm1',
    machineName: 'workstation',
    hostname: 'devbox',
    agents: [
      {
        agent: 'claude-code',
        status: 'ok',
        account: { email: 'claude@example.com', plan: 'max' },
        fetchedAt: '2026-07-29T09:59:00.000Z',
        windows: [
          {
            key: '5h',
            label: '5-hour',
            usedPercent: 42.5,
            resetsAt: '2026-07-29T12:15:00.000Z',
            windowMinutes: 300,
          },
          {
            key: 'weekly:model:opus',
            label: 'Weekly Opus',
            usedPercent: 90,
            resetsAt: '2026-07-31T10:00:00.000Z',
            windowMinutes: 10_080,
            scopeModel: 'Opus',
          },
        ],
      },
      {
        agent: 'codex',
        status: 'unauthenticated',
        windows: [],
        fetchedAt: '2026-07-29T09:59:00.000Z',
      },
      {
        agent: 'grok',
        status: 'error',
        account: { email: 'grok@example.com' },
        windows: [],
        error: 'billing endpoint 503',
        fetchedAt: '2026-07-29T09:59:00.000Z',
      },
    ],
  },
]

function client(result: MachineQuotaWire[] = machines): QuotaClient {
  return { quota: { summary: { query: vi.fn(async () => result) } } }
}

describe('podium quota', () => {
  it('renders every reported harness with account, window, remaining, reset, and status detail', async () => {
    const output = await runQuotaCli([], client(), NOW)

    expect(output).toContain('workstation (devbox)')
    expect(output).toContain('Claude Code (max · claude@example.com)')
    expect(output).toContain(
      '5-hour: 42.5% used · 57.5% left · resets 2026-07-29T12:15:00.000Z (in 2h 15m)',
    )
    expect(output).toContain(
      'Weekly Opus (Opus): 90% used · 10% left · resets 2026-07-31T10:00:00.000Z (in 2d 0h)',
    )
    expect(output).toContain('Codex — not signed in')
    expect(output).toContain('Grok (grok@example.com) — billing endpoint 503')
  })

  it('returns the exact panel payload under data with --json', async () => {
    const output = await runQuotaCli(['--json'], client(), NOW)
    expect(JSON.parse(output)).toEqual({ command: 'quota', ok: true, data: machines })
  })

  it('explains an empty online-machine result', () => {
    expect(renderQuota([], NOW)).toBe('No online Podium daemons reported usage limits.')
  })

  it('renders help without querying quota', async () => {
    const c = client()
    expect(await runQuotaCli(['--help'], c, NOW)).toBe(quotaHelpText())
    expect(c.quota.summary.query).not.toHaveBeenCalled()
  })

  it('rejects unexpected arguments and flags', async () => {
    await expect(runQuotaCli(['refresh'], client(), NOW)).rejects.toThrow(QuotaCliError)
    await expect(runQuotaCli(['--wat'], client(), NOW)).rejects.toThrow("unknown option '--wat'")
  })
})
