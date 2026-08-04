import { afterEach, describe, expect, it, vi } from 'vitest'
import { type NativeDesktopBridge, nativeDesktopBridge } from './nativeDesktop'

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
