import { asMachineId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { routeShipwright, SHIPWRIGHT_ROUTER_EVAL_SET } from './shipwright-router'

const machineId = asMachineId('machine:shipwright')
const settings = normalizeSettings({
  roles: {
    shipwright: {
      accountId: 'native:codex',
      model: 'gpt-5.6-codex',
      effort: 'high',
      harness: 'codex',
    },
  },
})
const catalog = {
  machineId,
  fetchedAt: Date.now(),
  byAgent: {
    codex: [
      { value: 'gpt-5.6-codex', label: 'Codex', efforts: ['medium', 'high'] },
      { value: 'gpt-5-mini', label: 'Mini', efforts: ['low', 'medium'] },
    ],
    'claude-code': [
      { value: 'claude-opus-5', label: 'Opus', efforts: ['medium', 'high'] },
    ],
  },
}

describe('shipwright trait/quota router', () => {
  it('routes mechanic to throughput, solver to frontier, and inspector across families', () => {
    expect(routeShipwright({ settings, catalog, quota: [], level: 'mechanic' })).toMatchObject({
      agent: 'codex',
      model: 'gpt-5-mini',
      effort: 'medium',
    })
    expect(routeShipwright({ settings, catalog, quota: [], level: 'solver' })).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.6-codex',
      effort: 'high',
    })
    expect(
      routeShipwright({
        settings,
        catalog,
        quota: [],
        level: 'inspector',
        priorFamilies: ['openai'],
      }),
    ).toMatchObject({ agent: 'claude-code', model: 'claude-opus-5', family: 'anthropic' })
  })

  it('does not route onto exhausted live quota', () => {
    const route = routeShipwright({
      settings,
      catalog,
      level: 'solver',
      quota: [
        {
          agent: 'codex',
          status: 'ok',
          windows: [
            {
              key: 'weekly',
              label: 'Weekly',
              usedPercent: 100,
              resetsAt: '',
              windowMinutes: 10_080,
            },
          ],
          fetchedAt: new Date().toISOString(),
        },
      ],
    })
    expect(route).toMatchObject({ agent: 'claude-code', family: 'anthropic' })
  })

  it('keeps a provider-name-free eval corpus for every escalation rung', () => {
    expect(SHIPWRIGHT_ROUTER_EVAL_SET.map((item) => item.expectedFirst ?? item.expectedEscalation))
      .toEqual(['mechanic', 'mechanic', 'solver', 'inspector'])
    expect(JSON.stringify(SHIPWRIGHT_ROUTER_EVAL_SET)).not.toMatch(/codex|claude|gpt|gemini|grok/)
  })
})
