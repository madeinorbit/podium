export type NativeDesktopPlatform = 'macos' | 'windows' | 'linux'

/** The shell's resolved launch mode (bootstrap.rs LaunchAction). Older shells omit it. */
export type NativeDesktopLaunchMode = 'all-in-one' | 'server' | 'daemon' | 'client'
export type NativeDesktopUpdateChannel = 'stable' | 'edge'

export interface NativeDesktopUpdateInfo {
  current_version: string
  version: string
  critical: boolean
  notes: string | null
}

export interface NativeDesktopBridge {
  platform: NativeDesktopPlatform
  launchMode?: NativeDesktopLaunchMode
  /** This device's paired machine id (~/.podium/daemon.json), if it ever paired. [spec:SP-3701] */
  machineId?: string
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  /** Claims the shared update dialog so the shell does not show its native fallback. */
  claimUpdateOwnership?: () => Promise<void>
  /** Checks a production feed; older shells may not expose this command. */
  checkUpdate?: (
    channel: NativeDesktopUpdateChannel,
  ) => Promise<NativeDesktopUpdateInfo | null>
  /** Installs the signed desktop update and restarts the shell. */
  installUpdate?: () => Promise<void>
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
