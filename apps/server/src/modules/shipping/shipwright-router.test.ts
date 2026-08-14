import { asMachineId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import type { ModelCatalogSnapshot } from '../../model-catalog'
import {
  evaluateShipwrightRouterCase,
  routeShipwright,
  SHIPWRIGHT_ROUTER_EVAL_SET,
} from './shipwright-router'

const machineId = asMachineId('machine:shipwright')
const settings = normalizeSettings({
  roles: {
    shipwright: {
      accountId: 'native:claude-code',
      model: 'family-a/frontier',
      effort: 'high',
      harness: 'claude-code',
    },
  },
})
const catalog: ModelCatalogSnapshot = {
  machineId,
  fetchedAt: Date.now(),
  byAgent: {
    'claude-code': [
      { value: 'family-a/frontier', label: 'Frontier', efforts: ['medium', 'high'] },
      { value: 'family-b/fast', label: 'Fast', efforts: ['low', 'medium'] },
    ],
    codex: [],
    grok: [{ value: 'fast-repair', label: 'Fast repair', efforts: ['medium', 'high'] }],
  },
}

describe('shipwright trait/quota router', () => {
  const resolveAccount = (agent: string) => `native:${agent}:fingerprint` as never

  it('routes mechanic to throughput, solver to frontier, and inspector across families', () => {
    expect(
      routeShipwright({ settings, catalog, quota: [], level: 'mechanic', resolveAccount }),
    ).toMatchObject({
      agent: 'claude-code',
      model: 'family-b/fast',
      effort: 'medium',
      accountId: 'native:claude-code:fingerprint',
    })
    expect(
      routeShipwright({ settings, catalog, quota: [], level: 'solver', resolveAccount }),
    ).toMatchObject({
      agent: 'claude-code',
      model: 'family-a/frontier',
      effort: 'high',
      accountId: 'native:claude-code:fingerprint',
    })
    expect(
      routeShipwright({
        settings,
        catalog,
        quota: [],
        level: 'inspector',
        priorFamilies: ['family-a'],
        resolveAccount,
      }),
    ).toMatchObject({ agent: 'claude-code', model: 'family-b/fast', family: 'family-b' })
  })

  it('does not route onto exhausted live quota', () => {
    const route = routeShipwright({
      settings,
      catalog,
      level: 'solver',
      quota: [
        {
          agent: 'claude-code',
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
      resolveAccount,
    })
    expect(route).toBeNull()
  })

  it('does not invent a configured model outside the live no-tools catalog', () => {
    expect(
      routeShipwright({
        settings,
        catalog: { ...catalog, byAgent: { codex: catalog.byAgent.codex } },
        quota: [],
        level: 'solver',
        resolveAccount,
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
    expect(
      new Set(SHIPWRIGHT_ROUTER_EVAL_SET.map((item) => item.expectedTurnCeiling)).size,
    ).toBeGreaterThan(1)
    expect(JSON.stringify(SHIPWRIGHT_ROUTER_EVAL_SET)).not.toMatch(/codex|claude|gpt|gemini|grok/)
  })

  it('refuses an unsupported configured harness instead of silently rerouting', () => {
    const unsupported = normalizeSettings({
      roles: { shipwright: { accountId: 'native:grok', harness: 'grok', model: 'fast-repair' } },
    })
    expect(
      routeShipwright({
        settings: unsupported,
        catalog,
        quota: [],
        level: 'mechanic',
        resolveAccount,
      }),
    ).toBeNull()
  })
})
