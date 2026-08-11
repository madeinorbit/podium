import { afterEach, describe, expect, it } from 'vitest'
import { captureServerBuildVersion, serverBuildVersion } from './build-version'

const originalVersion = process.env.PODIUM_APP_VERSION

afterEach(() => {
  if (originalVersion === undefined) delete process.env.PODIUM_APP_VERSION
  else process.env.PODIUM_APP_VERSION = originalVersion
})

describe('serverBuildVersion', () => {
  it('keeps the source identity captured at boot when the checkout later moves', () => {
    captureServerBuildVersion({ PODIUM_APP_VERSION: 'dev+abc1234' })
    expect(serverBuildVersion({})).toBe('dev+abc1234')
  })

  it('keeps the baked installed version authoritative', () => {
    process.env.PODIUM_APP_VERSION = '0.4.2'
    captureServerBuildVersion({}, '/not-used')
    expect(serverBuildVersion({})).toBe('0.4.2')
  })
})
