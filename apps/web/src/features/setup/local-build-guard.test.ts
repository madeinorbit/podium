import { WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { isTooOldForLocalData, localBuildStamp } from './local-build-guard'

function stubShellStamp(stamp: unknown): void {
  ;(globalThis as { __PODIUM_LOCAL_BUILD__?: unknown }).__PODIUM_LOCAL_BUILD__ = stamp
}

afterEach(() => {
  delete (globalThis as { __PODIUM_LOCAL_BUILD__?: unknown }).__PODIUM_LOCAL_BUILD__
})

describe('local build stamp', () => {
  it('is absent wherever the shell injects nothing', () => {
    expect(localBuildStamp()).toBeUndefined()
    // A browser, a remote desktop mode, a device whose shell never reached its own server:
    // no local history, so nothing this build could be too old for.
    expect(isTooOldForLocalData()).toBe(false)
  })

  it('ignores a stamp that cannot decide anything', () => {
    // No wire version = no comparison. An undecidable stamp must not look like an answer.
    stubShellStamp({ appVersion: '0.1.1' })
    expect(localBuildStamp()).toBeUndefined()
    expect(isTooOldForLocalData()).toBe(false)
    stubShellStamp('not an object')
    expect(localBuildStamp()).toBeUndefined()
  })

  it('reads the fields the decision needs', () => {
    stubShellStamp({
      wireVersion: WIRE_VERSION,
      minSupportedVersion: 1,
      wireSchemaDigest: wireSchemaDigest(),
      appVersion: '0.1.1',
    })
    expect(localBuildStamp()).toMatchObject({ wireVersion: WIRE_VERSION, appVersion: '0.1.1' })
  })
})

describe('is this build too old for the data on this device', () => {
  it('says no when the build that wrote the data is this one', () => {
    stubShellStamp({ wireVersion: WIRE_VERSION, wireSchemaDigest: wireSchemaDigest() })
    expect(isTooOldForLocalData()).toBe(false)
  })

  it('says YES when the data was written by a newer wire version', () => {
    stubShellStamp({ wireVersion: WIRE_VERSION + 1, wireSchemaDigest: 'newer' })
    expect(isTooOldForLocalData()).toBe(true)
  })

  it('says YES when this build is below the minimum that build supported', () => {
    stubShellStamp({
      wireVersion: WIRE_VERSION,
      minSupportedVersion: WIRE_VERSION + 1,
      wireSchemaDigest: wireSchemaDigest(),
    })
    expect(isTooOldForLocalData()).toBe(true)
  })

  it('says no for a digest difference at the same wire version', () => {
    // Wire-compatible builds can decode each other's rows and dev builds differ by digest
    // constantly; grounding the app there would be a cosmetic drift stopping real work.
    // The existing skew notice already speaks to this case.
    stubShellStamp({ wireVersion: WIRE_VERSION, wireSchemaDigest: 'a-different-build' })
    expect(isTooOldForLocalData()).toBe(false)
  })

  it('says no when the data was written by an OLDER build', () => {
    // This build is ahead of what wrote the rows, which is the direction migrations handle.
    stubShellStamp({ wireVersion: WIRE_VERSION - 1, wireSchemaDigest: 'older' })
    expect(isTooOldForLocalData()).toBe(false)
  })
})
