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
