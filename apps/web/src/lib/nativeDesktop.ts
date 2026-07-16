export type NativeDesktopPlatform = 'macos' | 'windows' | 'linux'

export interface NativeDesktopBridge {
  platform: NativeDesktopPlatform
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
}

export function nativeDesktopBridge(): NativeDesktopBridge | undefined {
  const bridge = (globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__
  if (!bridge || !['macos', 'windows', 'linux'].includes(bridge.platform)) return undefined
  return bridge
}
