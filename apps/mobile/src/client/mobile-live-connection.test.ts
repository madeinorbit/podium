import { CLIENT_WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { cookieCredentials } from '@podium/client-core/accounts'
import { describe, expect, it, vi } from 'vitest'
import { mobileVersionObservers } from './mobile-live-connection'

describe('mobile version remedy over the shared observer', () => {
  it('reports unreadable rows immediately and probes only the first refused frame', async () => {
    const fetchVersion = vi.fn(async () => ({
      wireVersion: CLIENT_WIRE_VERSION,
      wireSchemaDigest: wireSchemaDigest(),
    }))
    const report = vi.fn(),
      observer = mobileVersionObservers({ credentials: cookieCredentials, fetchVersion, report })
    observer.onWireSkew!({ quarantined: 1, refusedFrames: 0, since: 1 })
    expect(fetchVersion).not.toHaveBeenCalled()
    expect(report.mock.calls[0]![0]).toContain('1 item')
    observer.onWireSkew!({ quarantined: 1, refusedFrames: 1, since: 1 })
    observer.onWireSkew!({ quarantined: 1, refusedFrames: 2, since: 1 })
    await Promise.resolve()
    expect(fetchVersion).toHaveBeenCalledOnce()
    expect(report.mock.calls[1]![0]).toContain('empty or stuck')
    observer.onWireSkew!({ quarantined: 2, refusedFrames: 0, since: 1 })
    expect(report).toHaveBeenCalledTimes(3)
    observer.dispose()
  })
  it('names the server when the installed phone is ahead of it', async () => {
    const report = vi.fn(),
      observer = mobileVersionObservers({
        credentials: { ...cookieCredentials, delivery: 'native' },
        fetchVersion: async () => ({ wireVersion: CLIENT_WIRE_VERSION - 1 }),
        report,
      })
    observer.onReconnect!()
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
    expect(report.mock.calls[0]![0]).toContain('Update your server to continue.')
    observer.dispose()
  })
  it('keeps refusal severity and the older-server remedy across further unreadable frames', async () => {
    const report = vi.fn(),
      observer = mobileVersionObservers({
        credentials: { ...cookieCredentials, delivery: 'native' },
        fetchVersion: async () => ({ wireVersion: CLIENT_WIRE_VERSION - 1 }),
        report,
      })
    observer.onWireSkew!({ quarantined: 0, refusedFrames: 1, since: 1 })
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2))
    const remedy = report.mock.calls[1]![0]
    expect(remedy).toContain('empty or stuck')
    expect(remedy).toContain('Update your server to continue.')
    expect(remedy).not.toContain('Update Podium on this device')
    observer.onWireSkew!({ quarantined: 0, refusedFrames: 2, since: 1 })
    expect(report.mock.calls[2]![0]).toBe(remedy)
    observer.onWireSkew!({ quarantined: 1, refusedFrames: 0, since: 1 })
    expect(report).toHaveBeenCalledTimes(3)
    observer.dispose()
  })
  it.each([
    'browser',
    'native',
  ] as const)('offers the %s remedy after the server moves to a newer wire', async (delivery) => {
    const report = vi.fn(),
      observer = mobileVersionObservers({
        credentials: { ...cookieCredentials, delivery },
        fetchVersion: async () => ({ wireVersion: CLIENT_WIRE_VERSION + 1 }),
        report,
      })
    observer.onReconnect!()
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
    expect(report.mock.calls[0]![0]).toContain(
      delivery === 'browser' ? 'Reload' : 'Update Podium on this device',
    )
    observer.dispose()
  })
  it('ignores an unavailable version and an in-flight answer from the previous owner', async () => {
    const report = vi.fn(),
      offline = mobileVersionObservers({
        credentials: cookieCredentials,
        fetchVersion: async () => {
          throw new Error('offline')
        },
        report,
      })
    offline.onReconnect!()
    let finish!: (value: unknown) => void
    const pending = mobileVersionObservers({
      credentials: cookieCredentials,
      fetchVersion: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      report,
    })
    pending.onReconnect!()
    pending.dispose()
    finish({ wireVersion: CLIENT_WIRE_VERSION + 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(report).not.toHaveBeenCalled()
    offline.dispose()
  })
})
