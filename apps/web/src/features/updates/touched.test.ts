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

  it('touches the app when the source SHA digest differs even if the server is current', () => {
    const t = computeTouched({
      localDigests: { app: 'aaaaaaa' },
      target: {
        version: 'dev+47a01e3',
        critical: false,
        artifacts: { web: { digest: '47a01e3' } },
      } as never,
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(true)
  })

  it('does not touch the app when the source SHA digest matches a current server', () => {
    const t = computeTouched({
      localDigests: { app: '47a01e3' },
      target: {
        version: 'dev+47a01e3',
        critical: false,
        artifacts: { web: { digest: '47a01e3' } },
      } as never,
      fleetBehind: 0,
      serverBehind: false,
    })
    expect(t.app).toBe(false)
  })

  it('touches the browser app when a source dev redeploy rebuilds it with the server', () => {
    const t = computeTouched({
      localDigests: { app: 'web-old' },
      target: { version: 'dev+abc1234', critical: false, artifacts: {} } as never,
      fleetBehind: 2,
      serverBehind: true,
      sourceAppFollowsServer: true,
    })
    expect(t.app).toBe(true)
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

  it('touches the phone only when the server says its phone website is behind', () => {
    const phoneOf = (phoneBehind?: boolean) =>
      computeTouched({
        localDigests: { app: 'web-new' },
        target: target(),
        fleetBehind: 0,
        serverBehind: false,
        ...(phoneBehind === undefined ? {} : { phoneBehind }),
      }).phone
    expect(phoneOf(true)).toBe(true)
    expect(phoneOf(false)).toBe(false)
    // No opinion is "nothing to move here", not "fail toward showing it": unlike
    // this app's digest, a silent phone means the server serves no phone website
    // at all, and a row promising to rebuild one would name a place that is not
    // there (POD-1980).
    expect(phoneOf(undefined)).toBe(false)
  })

  it('keeps the phone off this app: a stale phone does not make this page reload', () => {
    const t = computeTouched({
      localDigests: { app: 'web-new' },
      target: target(),
      fleetBehind: 0,
      serverBehind: false,
      phoneBehind: true,
    })
    expect(t.phone).toBe(true)
    expect(t.app).toBe(false)
    expect(t.server).toBe(false)
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
