import { DEFAULT_SETTINGS, type PodiumSettings } from '@podium/runtime'
import type { PodiumConfig } from '@podium/runtime/config'
import { describe, expect, it } from 'vitest'
import { getFeatureStates, isFeatureEnabled } from './features'

function settings(experimental: Record<string, boolean> = {}): PodiumSettings {
  return { ...DEFAULT_SETTINGS, experimental }
}

describe('getFeatureStates [spec:SP-f4b9]', () => {
  it('dev mode lists hidden sample-experiment; default off', () => {
    const result = getFeatureStates(settings(), {}, { PODIUM_APP_VERSION: 'dev' })
    expect(result.devMode).toBe(true)
    expect(result.channel).toBe('stable')
    const sample = result.flags.find((f) => f.id === 'sample-experiment')
    expect(sample).toMatchObject({
      listed: true,
      enabled: false,
      source: 'default',
      locked: false,
      visibility: 'hidden',
      name: 'Sample experiment',
    })
  })

  it('production stable does not list hidden flags', () => {
    const result = getFeatureStates(settings({ 'sample-experiment': true }), {}, {
      PODIUM_APP_VERSION: '1.2.3',
    })
    expect(result.devMode).toBe(false)
    const sample = result.flags.find((f) => f.id === 'sample-experiment')
    expect(sample).toMatchObject({
      listed: false,
      enabled: false,
      source: 'default',
      locked: false,
    })
  })

  it('honors user toggle when listed (dev)', () => {
    const result = getFeatureStates(settings({ 'sample-experiment': true }), {}, {
      PODIUM_APP_VERSION: 'dev',
    })
    expect(result.flags.find((f) => f.id === 'sample-experiment')).toMatchObject({
      listed: true,
      enabled: true,
      source: 'user',
      locked: false,
    })
  })

  it('config override force-enables and locks', () => {
    const config: PodiumConfig = { features: { 'sample-experiment': true } }
    const result = getFeatureStates(
      settings({ 'sample-experiment': false }),
      config,
      { PODIUM_APP_VERSION: '1.0.0' },
    )
    expect(result.flags.find((f) => f.id === 'sample-experiment')).toMatchObject({
      listed: false,
      enabled: true,
      source: 'config',
      locked: true,
    })
  })

  it('config force-disables even when user is on and listed', () => {
    const config: PodiumConfig = { features: { 'sample-experiment': false } }
    const result = getFeatureStates(
      settings({ 'sample-experiment': true }),
      config,
      { PODIUM_APP_VERSION: 'dev' },
    )
    expect(result.flags.find((f) => f.id === 'sample-experiment')).toMatchObject({
      listed: true,
      enabled: false,
      source: 'config',
      locked: true,
    })
  })

  it('channel comes from resolveUpdateChannel (env > config)', () => {
    expect(
      getFeatureStates(settings(), { updateChannel: 'edge' }, { PODIUM_APP_VERSION: '1.0.0' })
        .channel,
    ).toBe('edge')
    expect(
      getFeatureStates(
        settings(),
        { updateChannel: 'edge' },
        { PODIUM_APP_VERSION: '1.0.0', PODIUM_UPDATE_CHANNEL: 'stable' },
      ).channel,
    ).toBe('stable')
  })
})

describe('isFeatureEnabled', () => {
  it('returns false by default', () => {
    expect(isFeatureEnabled('sample-experiment', settings(), {}, { PODIUM_APP_VERSION: 'dev' })).toBe(
      false,
    )
  })

  it('returns true when user enabled in dev', () => {
    expect(
      isFeatureEnabled(
        'sample-experiment',
        settings({ 'sample-experiment': true }),
        {},
        { PODIUM_APP_VERSION: 'dev' },
      ),
    ).toBe(true)
  })

  it('returns true when config forces on (even unlisted)', () => {
    expect(
      isFeatureEnabled(
        'sample-experiment',
        settings(),
        { features: { 'sample-experiment': true } },
        { PODIUM_APP_VERSION: '1.0.0' },
      ),
    ).toBe(true)
  })
})
