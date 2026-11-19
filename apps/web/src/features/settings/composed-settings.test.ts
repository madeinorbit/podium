import { SETTINGS_PATH_TIERS } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import { composedSettings } from './composed-settings'

const MINE = 'from my record'
const INSTANCE = 'from the instance record'

describe('composedSettings', () => {
  const settings = composedSettings(
    () => new Proxy({}, { get: () => INSTANCE }),
    () => new Proxy({}, { get: () => MINE }),
  ) as unknown as Record<string, unknown>
  const groups = (tier: string) =>
    new Set(SETTINGS_PATH_TIERS.filter((f) => f.tier === tier).map((f) => f.path.split('.')[0]!))

  it('reads every personal group from my record, credentialDefaults included', () => {
    expect(groups('personal-preference')).toContain('credentialDefaults')
    for (const group of groups('personal-preference')) expect(settings[group], group).toBe(MINE)
  })

  it('reads every instance group from the instance record', () => {
    const personal = groups('personal-preference')
    for (const group of groups('instance-preference')) {
      if (!personal.has(group)) expect(settings[group], group).toBe(INSTANCE)
    }
  })
})
