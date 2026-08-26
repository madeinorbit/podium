import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  desktopUpdateEndpoint,
  type NativeDesktopBridge,
  nativeDesktopBridge,
  persistNativeDesktopUpdateChannel,
} from './nativeDesktop'

const desktopGlobal = globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }

afterEach(() => {
  delete desktopGlobal.__PODIUM_DESKTOP__
})

describe('nativeDesktopBridge', () => {
  it('is absent in the web app', () => {
    expect(nativeDesktopBridge()).toBeUndefined()
  })

  it('returns the injected desktop bridge', () => {
    const bridge: NativeDesktopBridge = {
      platform: 'windows',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    desktopGlobal.__PODIUM_DESKTOP__ = bridge

    expect(nativeDesktopBridge()).toBe(bridge)
  })

  it('exposes the update commands when the shell provides them', () => {
    const bridge: NativeDesktopBridge = {
      platform: 'linux',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      checkUpdate: vi.fn(async () => null),
      installUpdate: vi.fn(async () => {}),
      claimUpdateOwnership: vi.fn(async () => {}),
    }
    desktopGlobal.__PODIUM_DESKTOP__ = bridge

    expect(nativeDesktopBridge()?.installUpdate).toBeTypeOf('function')
  })

  it('persists dev with this server latest.json and release channels without an endpoint', async () => {
    const persist = vi.fn(async () => {})
    desktopGlobal.__PODIUM_DESKTOP__ = {
      platform: 'linux',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      setUpdateChannel: persist,
    }

    expect(desktopUpdateEndpoint('dev', 'https://podium.test/')).toBe(
      'https://podium.test/updates/feed/dev/latest.json',
    )
    await persistNativeDesktopUpdateChannel('dev', 'https://podium.test/')
    await persistNativeDesktopUpdateChannel('edge', 'https://podium.test/')
    expect(persist).toHaveBeenNthCalledWith(
      1,
      'dev',
      'https://podium.test/updates/feed/dev/latest.json',
    )
    expect(persist).toHaveBeenNthCalledWith(2, 'edge', undefined)
  })

  it('exposes the local daemon connectivity reader when the shell provides it', async () => {
    const status = {
      state: 'unauthorized' as const,
      serverUrl: 'wss://podium.example',
      authorizationReason: 'peerHelloRejected: invalid or expired code',
      updatedAt: '2026-08-26T10:00:00.000Z',
    }
    desktopGlobal.__PODIUM_DESKTOP__ = {
      platform: 'linux',
      launchMode: 'daemon',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      daemonConnectivity: vi.fn(async () => status),
    }

    await expect(nativeDesktopBridge()?.daemonConnectivity?.()).resolves.toEqual(status)
  })

  it('tolerates an older shell that has none of the update commands', () => {
    desktopGlobal.__PODIUM_DESKTOP__ = {
      platform: 'linux',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    const bridge = nativeDesktopBridge()

    expect(bridge).toBeDefined()
    expect(bridge?.installUpdate).toBeUndefined()
  })

  it('rejects an unsupported injected platform', () => {
    desktopGlobal.__PODIUM_DESKTOP__ = {
      platform: 'android',
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as NativeDesktopBridge

    expect(nativeDesktopBridge()).toBeUndefined()
  })
})
