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
   * Opens a URL in the OS browser. Needed for the server's OWN URLs: the shell's link shim
   * only diverts cross-origin links, so a same-origin `_blank` lands in an in-app webview
   * window instead of Safari. Absent on shells older than this bridge method.
   */
  openExternal?: (url: string) => Promise<void>
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

/**
 * Sends `url` to the OS browser when the desktop shell needs the page to ask, and reports
 * back whether it did — a caller that gets a promise must suppress its own navigation.
 *
 * Declines (null) in the three cases where asking would be wrong or useless:
 * a plain browser, where the anchor already does the right thing; a shell older than
 * `openExternal`; and a CROSS-origin URL, which the shell's injected link shim already
 * diverts on its own — handing that one over too would open the page twice (all-in-one
 * mode loads the UI from `tauri://localhost`, so every server URL is cross-origin there).
 * What's left is a same-origin URL, which the shim deliberately skips and the webview would
 * answer with an in-app window.
 */
export function openInSystemBrowser(url: string): Promise<void> | null {
  const openExternal = nativeDesktopBridge()?.openExternal
  if (!openExternal || typeof window === 'undefined') return null
  const pageOrigin = window.location.origin
  try {
    if (new URL(url, pageOrigin).origin !== pageOrigin) return null
  } catch {
    return null
  }
  return openExternal(url)
}
