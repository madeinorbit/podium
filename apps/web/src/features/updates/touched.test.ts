import { describe, expect, it } from 'vitest'
import { computeTouched } from './touched'

const target = (over: Record<string, unknown> = {}) =>
  ({
    version: '0.4.2',
    critical: false,
    artifacts: { web: { digest: 'web-new' }, ...over },
  }) as never

describe('computeTouched', () => {
  it('touches the app when the web digest differs', () => {
    const t = computeTouched({
      localDigests: { app: 'web-old' },
      target: target(),
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(true)
  })

  it('does NOT touch the app when the digest is identical, even though the version moved', () => {
    const t = computeTouched({
      localDigests: { app: 'web-new' },
      target: target(),
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(false)
  })

  it('treats an unknown local digest as touched, failing toward telling the user', () => {
    const t = computeTouched({
      localDigests: {},
      target: target(),
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(true)
  })

  it('does not touch the app when the target advertises no web digest', () => {
    const t = computeTouched({
      localDigests: { app: 'web-old' },
      target: { version: '0.4.2', critical: false, artifacts: {} } as never,
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(false)
  })

  it('touches machines only when some machine is behind', () => {
    expect(
      computeTouched({
        localDigests: { app: 'web-new' },
        target: target(),
        fleetBehind: 0,
        serverBehind: false,
      }).machines,
    ).toBe(false)
    expect(
      computeTouched({
        localDigests: { app: 'web-new' },
        target: target(),
        fleetBehind: 2,
        serverBehind: false,
      }).machines,
    ).toBe(true)
  })

  it('touches the server only when the server is behind its own target', () => {
    expect(
      computeTouched({
        localDigests: { app: 'web-new' },
        target: target(),
        fleetBehind: 0,
        serverBehind: true,
      }).server,
    ).toBe(true)
  })
})
