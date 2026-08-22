import { afterEach, describe, expect, it } from 'vitest'
import {
  captureServerBuildVersion,
  serverBuildSourceDigest,
  serverBuildVersion,
} from './build-version'

const originalVersion = process.env.PODIUM_APP_VERSION
const originalSourceSha = process.env.PODIUM_SOURCE_SHA

afterEach(() => {
  if (originalVersion === undefined) delete process.env.PODIUM_APP_VERSION
  else process.env.PODIUM_APP_VERSION = originalVersion
  if (originalSourceSha === undefined) delete process.env.PODIUM_SOURCE_SHA
  else process.env.PODIUM_SOURCE_SHA = originalSourceSha
})

describe('serverBuildVersion', () => {
  it('keeps the source identity captured at boot when the checkout later moves', () => {
    captureServerBuildVersion({ PODIUM_APP_VERSION: 'dev+abc1234' })
    expect(serverBuildVersion({})).toBe('dev+abc1234')
  })

  it('keeps the baked installed version authoritative', () => {
    process.env.PODIUM_APP_VERSION = '0.4.2'
    process.env.PODIUM_SOURCE_SHA = '47a01e3'
    captureServerBuildVersion({}, '/not-used')
    expect(serverBuildVersion({})).toBe('0.4.2')
    expect(serverBuildSourceDigest({})).toBe('47a01e3')
  })
})
