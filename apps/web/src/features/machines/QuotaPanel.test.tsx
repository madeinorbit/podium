import { groupQuotaByAccount } from '@podium/client-core/values'
import { BUNDLED_DESCRIPTORS } from '@podium/harness/browser'
import { type AgentQuotaWire, asMachineId } from '@podium/model'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { QuotaPanel } from './QuotaPanel'

describe('Google plan quota display', () => {
  it('shows independent model pools, reset windows and one shared account credit balance', () => {
    const now = Date.parse('2026-11-23T12:00:00Z')
    const wire: AgentQuotaWire = {
      agent: 'antigravity',
      status: 'ok',
      account: { email: 'person@example.com' },
      credits: { remaining: 1250 },
      fetchedAt: new Date(now).toISOString(),
      windows: [
        {
          key: 'gemini-5h',
          label: 'Gemini Models · 5-hour',
          pool: 'Gemini Models',
          usedPercent: 100,
          resetsAt: '2026-11-23T17:00:00Z',
          windowMinutes: 300,
        },
        {
          key: 'gemini-weekly',
          label: 'Gemini Models · Weekly',
          pool: 'Gemini Models',
          usedPercent: 30,
          resetsAt: '2026-11-30T12:00:00Z',
          windowMinutes: 10080,
        },
        {
          key: '3p-5h',
          label: 'Claude and GPT models · 5-hour',
          pool: 'Claude and GPT models',
          usedPercent: 20,
          resetsAt: '2026-11-23T17:00:00Z',
          windowMinutes: 300,
        },
        {
          key: '3p-weekly',
          label: 'Claude and GPT models · Weekly',
          pool: 'Claude and GPT models',
          usedPercent: 40,
          resetsAt: '2026-11-30T12:00:00Z',
          windowMinutes: 10080,
        },
      ],
    }
    const groups = groupQuotaByAccount([
      {
        machineId: asMachineId('fixture-machine'),
        machineName: 'Desk',
        hostname: 'fixture-host',
        agents: [wire],
      },
    ])
    render(<QuotaPanel groups={groups} now={now} descriptors={BUNDLED_DESCRIPTORS} />)
    expect(screen.getByText('Antigravity · Gemini Models')).toBeTruthy()
    expect(screen.getByText('Antigravity · Claude and GPT models')).toBeTruthy()
    expect(screen.getAllByText('1,250 AI credits remaining')).toHaveLength(1)
    expect(screen.getByText('1 constrained')).toBeTruthy()
    expect(screen.getByText('1 healthy')).toBeTruthy()
    expect(screen.getAllByText('5h')).toHaveLength(2)
    expect(screen.getAllByText('wk')).toHaveLength(2)
  })
})
