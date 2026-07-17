export type NativeDesktopPlatform = 'macos' | 'windows' | 'linux'

/** The shell's resolved launch mode (bootstrap.rs LaunchAction). Older shells omit it. */
export type NativeDesktopLaunchMode = 'all-in-one' | 'server' | 'daemon' | 'client'

export interface NativeDesktopBridge {
  platform: NativeDesktopPlatform
  launchMode?: NativeDesktopLaunchMode
  /** This device's paired machine id (~/.podium/daemon.json), if it ever paired. [spec:SP-3701] */
  machineId?: string
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  /**
   * [spec:SP-3701] Present only in client mode: rewrite the local config to daemon mode with a
   * hub-minted pairing code. Caller restarts the shell afterwards (window.__PODIUM_RESTART__).
   */
  enableHosting?: (pairCode: string) => Promise<void>
}

export function nativeDesktopBridge(): NativeDesktopBridge | undefined {
  const bridge = (globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__
  if (!bridge || !['macos', 'windows', 'linux'].includes(bridge.platform)) return undefined
  return bridge
}
