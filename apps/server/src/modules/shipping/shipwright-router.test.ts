import { asMachineId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import {
  evaluateShipwrightRouterCase,
  routeShipwright,
  SHIPWRIGHT_ROUTER_EVAL_SET,
} from './shipwright-router'

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
    'claude-code': [{ value: 'claude-opus-5', label: 'Opus', efforts: ['medium', 'high'] }],
    grok: [{ value: 'fast-repair', label: 'Fast repair', efforts: ['medium', 'high'] }],
  },
}

describe('shipwright trait/quota router', () => {
  it('routes mechanic to throughput, solver to frontier, and inspector across families', () => {
    expect(routeShipwright({ settings, catalog, quota: [], level: 'mechanic' })).toMatchObject({
      agent: 'grok',
      model: 'fast-repair',
      effort: 'medium',
      accountId: 'native:grok',
    })
    expect(routeShipwright({ settings, catalog, quota: [], level: 'solver' })).toMatchObject({
      agent: 'claude-code',
      model: 'claude-opus-5',
      effort: 'high',
      accountId: 'native:claude-code',
    })
    expect(
      routeShipwright({
        settings,
        catalog,
        quota: [],
        level: 'inspector',
        priorFamilies: ['anthropic'],
      }),
    ).toMatchObject({ agent: 'grok', model: 'fast-repair', family: 'xai' })
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

  it('does not invent a configured model outside the live no-tools catalog', () => {
    expect(
      routeShipwright({
        settings,
        catalog: { ...catalog, byAgent: { codex: catalog.byAgent.codex } },
        quota: [],
        level: 'solver',
      }),
    ).toBeNull()
  })

  it('keeps a provider-name-free eval corpus for every escalation rung', () => {
    for (const item of SHIPWRIGHT_ROUTER_EVAL_SET) {
      expect(evaluateShipwrightRouterCase(item)).toEqual({
        route: item.expected,
        turnCeiling: item.expectedTurnCeiling,
      })
    }
    expect(JSON.stringify(SHIPWRIGHT_ROUTER_EVAL_SET)).not.toMatch(/codex|claude|gpt|gemini|grok/)
  })
})
