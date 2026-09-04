import { DEFAULT_SETTINGS, type PodiumSettings } from '@podium/runtime'
import type { PodiumConfig } from '@podium/runtime/config'
import { describe, expect, it } from 'vitest'
import { getFeatureStates, isFeatureEnabled } from './features'

function settings(experimental: Record<string, boolean> = {}): PodiumSettings {
  return { ...DEFAULT_SETTINGS, experimental }
}

// `shipwright` stands in for the hidden tier throughout this block: the resolve
// rules are per-visibility, not per-flag, and this is the registry's hidden entry.
// If it ever widens, retarget these at whatever is hidden then — the rules under
// test are the tier's, and the exhaustive per-tier matrix lives in
// packages/protocol/src/features.test.ts.
const HIDDEN = 'shipwright'

describe('getFeatureStates [spec:SP-f4b9]', () => {
  it('dev mode lists a hidden flag with its definition copy; default off', () => {
    const result = getFeatureStates(settings(), {}, { PODIUM_APP_VERSION: 'dev' })
    expect(result.devMode).toBe(true)
    expect(result.channel).toBe('stable')
    const hidden = result.flags.find((f) => f.id === HIDDEN)
    expect(hidden).toMatchObject({
      listed: true,
      enabled: false,
      source: 'default',
      locked: false,
      visibility: 'hidden',
    })
    expect(hidden?.name.length ?? 0).toBeGreaterThan(0)
    expect(hidden?.description.length ?? 0).toBeGreaterThan(0)
  })

  it('production stable does not list hidden flags', () => {
    const result = getFeatureStates(
      settings({ [HIDDEN]: true }),
      {},
      {
        PODIUM_APP_VERSION: '1.2.3',
      },
    )
    expect(result.devMode).toBe(false)
    const hidden = result.flags.find((f) => f.id === HIDDEN)
    expect(hidden).toMatchObject({
      listed: false,
      enabled: false,
      source: 'default',
      locked: false,
    })
  })

  it('honors user toggle when listed (dev)', () => {
    const result = getFeatureStates(
      settings({ [HIDDEN]: true }),
      {},
      {
        PODIUM_APP_VERSION: 'dev',
      },
    )
    expect(result.flags.find((f) => f.id === HIDDEN)).toMatchObject({
      listed: true,
      enabled: true,
      source: 'user',
      locked: false,
    })
  })

  it('config override force-enables and locks', () => {
    const config: PodiumConfig = { features: { [HIDDEN]: true } }
    const result = getFeatureStates(settings({ [HIDDEN]: false }), config, {
      PODIUM_APP_VERSION: '1.0.0',
    })
    expect(result.flags.find((f) => f.id === HIDDEN)).toMatchObject({
      listed: false,
      enabled: true,
      source: 'config',
      locked: true,
    })
  })

  it('config force-disables even when user is on and listed', () => {
    const config: PodiumConfig = { features: { [HIDDEN]: false } }
    const result = getFeatureStates(settings({ [HIDDEN]: true }), config, {
      PODIUM_APP_VERSION: 'dev',
    })
    expect(result.flags.find((f) => f.id === HIDDEN)).toMatchObject({
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

describe('runtime-drivers feature', () => {
  const stableRelease = { PODIUM_APP_VERSION: '1.0.0' }
  const stableConfig: PodiumConfig = { updateChannel: 'stable' }

  it('is listed off by default on stable and honors its persisted toggle', () => {
    expect(
      getFeatureStates(settings(), stableConfig, stableRelease).flags.find(
        (flag) => flag.id === 'runtime-drivers',
      ),
    ).toMatchObject({
      visibility: 'stable',
      listed: true,
      enabled: false,
      source: 'default',
      locked: false,
    })
    expect(
      isFeatureEnabled(
        'runtime-drivers',
        settings({ 'runtime-drivers': true }),
        stableConfig,
        stableRelease,
      ),
    ).toBe(true)
  })
})

describe('isFeatureEnabled', () => {
  it('returns false by default', () => {
    expect(isFeatureEnabled(HIDDEN, settings(), {}, { PODIUM_APP_VERSION: 'dev' })).toBe(false)
  })

  it('returns true when user enabled in dev', () => {
    expect(
      isFeatureEnabled(HIDDEN, settings({ [HIDDEN]: true }), {}, { PODIUM_APP_VERSION: 'dev' }),
    ).toBe(true)
  })

  it('returns true when config forces on (even unlisted)', () => {
    expect(
      isFeatureEnabled(
        HIDDEN,
        settings(),
        { features: { [HIDDEN]: true } },
        { PODIUM_APP_VERSION: '1.0.0' },
      ),
    ).toBe(true)
  })
})

describe('draft-sync feature [spec:SP-f4b9] (POD-859)', () => {
  it('is listed on the edge channel and carries its registry metadata', () => {
    const result = getFeatureStates(
      settings(),
      { updateChannel: 'edge' },
      { PODIUM_APP_VERSION: '1.0.0' },
    )
    const flag = result.flags.find((f) => f.id === 'draft-sync')
    expect(flag).toMatchObject({
      id: 'draft-sync',
      visibility: 'edge',
      listed: true,
      enabled: false,
      source: 'default',
    })
    expect(flag?.name.length ?? 0).toBeGreaterThan(0)
    expect(flag?.description.length ?? 0).toBeGreaterThan(0)
  })

  it('is NOT listed on the stable channel in a release build', () => {
    const flag = getFeatureStates(
      settings(),
      { updateChannel: 'stable' },
      { PODIUM_APP_VERSION: '1.0.0' },
    ).flags.find((f) => f.id === 'draft-sync')
    expect(flag).toMatchObject({ listed: false, enabled: false })
  })

  it('user toggle enables it on the edge channel (round-trips through experimental)', () => {
    expect(
      isFeatureEnabled(
        'draft-sync',
        settings({ 'draft-sync': true }),
        { updateChannel: 'edge' },
        { PODIUM_APP_VERSION: '1.0.0' },
      ),
    ).toBe(true)
  })

  it('user toggle is ignored on the stable channel (unlisted edge flag)', () => {
    expect(
      isFeatureEnabled(
        'draft-sync',
        settings({ 'draft-sync': true }),
        { updateChannel: 'stable' },
        { PODIUM_APP_VERSION: '1.0.0' },
      ),
    ).toBe(false)
  })

  it('config override forces it on even on stable/unlisted', () => {
    expect(
      isFeatureEnabled(
        'draft-sync',
        settings(),
        { updateChannel: 'stable', features: { 'draft-sync': true } },
        { PODIUM_APP_VERSION: '1.0.0' },
      ),
    ).toBe(true)
  })
})

describe('merge-queue feature', () => {
  it('is edge-listed, default-off, and enabled by its persisted toggle', () => {
    const env = { PODIUM_APP_VERSION: '1.0.0' }
    const config: PodiumConfig = { updateChannel: 'edge' }

    expect(
      getFeatureStates(settings(), config, env).flags.find((f) => f.id === 'merge-queue'),
    ).toMatchObject({
      listed: true,
      enabled: false,
      source: 'default',
      locked: false,
    })
    expect(isFeatureEnabled('merge-queue', settings({ 'merge-queue': true }), config, env)).toBe(
      true,
    )
  })
})
