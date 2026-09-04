import type { MachineId } from '@podium/model'
import { classifyPodiumLink } from './podium-link'
export type NativeDesktopPlatform = 'macos' | 'windows' | 'linux'

/** The shell's resolved launch mode (bootstrap.rs LaunchAction). Older shells omit it. */
export type NativeDesktopLaunchMode = 'all-in-one' | 'server' | 'daemon' | 'client'
export type NativeDesktopUpdateChannel = 'dev' | 'stable' | 'edge'

export interface NativeDaemonConnectivity {
  state: 'connected' | 'disconnected' | 'unauthorized' | 'blocked'
  serverUrl?: string
  authorizationReason?: string
  blockedReason?: string
  updatedAt: string
}

export interface NativeDesktopUpdateInfo {
  current_version: string
  version: string
  critical: boolean
  notes: string | null
}

export interface NativeDesktopBridge {
  platform: NativeDesktopPlatform
  /** True when the OS window manager owns the title bar and caption controls. */
  nativeDecorations?: boolean
  /** Shell package version. Older shells omit it. */
  currentVersion?: string
  /** Versioned contract for methods and payloads on this injected bridge. */
  bridgeVersion?: number
  launchMode?: NativeDesktopLaunchMode
  /** This device's paired machine id (~/.podium/daemon.json), if it ever paired. [spec:SP-3701] */
  machineId?: MachineId
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  /** Claims the shared update dialog so the shell does not show its native fallback. */
  claimUpdateOwnership?: () => Promise<void>
  /** Checks a production feed; older shells may not expose this command. */
  checkUpdate?: (channel: NativeDesktopUpdateChannel) => Promise<NativeDesktopUpdateInfo | null>
  /**
   * Installs the signed desktop update and restarts the shell.
   *
   * The channel is an ARGUMENT (POD-2135): channel authority belongs to the
   * server the shell is attached to, and passing it here is what stops
   * `install_update`'s own re-check from consulting the shell's config and
   * installing off a different channel than the one that was checked (spec §5).
   * Older shells may omit this command; legacy zero-argument implementations
   * ignore the extra argument when it is present.
   */
  installUpdate?: (
    channel: NativeDesktopUpdateChannel,
    /** Exact operation/feed version; current shells fail closed if the rolling feed moved. */
    expectedVersion?: string,
  ) => Promise<void>
  /** Persists the user's production feed choice for native update checks without a page. */
  setUpdateChannel?: (channel: NativeDesktopUpdateChannel, endpoint?: string) => Promise<void>
  /** Restores the signed seed when the local payload cannot serve its repair grant. */
  repairPayload?: () => Promise<void>
  /**
   * Opens a URL in the OS browser. Needed for the server's OWN URLs: the shell's link shim
   * only diverts cross-origin links, so a same-origin `_blank` lands in an in-app webview
   * window instead of Safari. Absent on shells older than this bridge method.
   */
  openExternal?: (url: string) => Promise<void>
  /**
   * Syncs the native window appearance (NSAppearance on macOS) with the page's resolved
   * theme. The vibrancy material behind the transparent command bar renders with the
   * WINDOW's appearance, which follows the OS — not the page's data-theme/.dark state —
   * so an explicit light/dark choice must be forwarded. `null` returns the window to
   * following the system; REQUIRED for mode=system, because forcing an appearance also
   * flips the webview's prefers-color-scheme, which would lock system mode in place.
   * Absent on shells older than this bridge method.
   */
  setTheme?: (theme: 'light' | 'dark' | null) => Promise<void>
  /**
   * [spec:SP-3701] Present only in client mode: rewrite the local config to daemon mode with a
   * hub-minted pairing code. Caller restarts the shell afterwards (window.__PODIUM_RESTART__).
   */
  enableHosting?: (pairCode: string) => Promise<void>
  /** Reads this shell's daemon-owned durable connection status. */
  daemonConnectivity?: () => Promise<NativeDaemonConnectivity | null>
}

/**
 * A bounded progress report from the shell's own installer (POD-2135,
 * `updater.rs` emits `podium://update-progress`). The Tauri callbacks used to be
 * discarded, which is why the shell's half of an update was the one stretch with
 * no liveness at all — spec §5 and P4 both name it.
 */
export interface NativeDesktopUpdateProgress {
  phase: 'downloading' | 'installing'
  received?: number
  total?: number
  percent?: number
}

/** The shell's typed failure. Same open kebab-case vocabulary as the operation's §7 codes. */
export interface NativeDesktopUpdateError {
  code: string
  message: string
}

export function isNativeDesktopUpdateError(value: unknown): value is NativeDesktopUpdateError {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { code?: unknown; message?: unknown }
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
}

const UPDATE_PROGRESS_EVENT = 'podium://update-progress'

interface TauriInternals {
  invoke: (command: string, payload?: unknown) => Promise<unknown>
  transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number
}

function tauriInternals(): TauriInternals | undefined {
  const internals = (globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> })
    .__TAURI_INTERNALS__
  if (
    typeof internals?.invoke !== 'function' ||
    typeof internals.transformCallback !== 'function'
  ) {
    return undefined
  }
  return internals as TauriInternals
}

function parseProgress(payload: unknown): NativeDesktopUpdateProgress | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as {
    phase?: unknown
    received?: unknown
    total?: unknown
    percent?: unknown
  }
  if (value.phase !== 'downloading' && value.phase !== 'installing') return undefined
  return {
    phase: value.phase,
    ...(typeof value.received === 'number' ? { received: value.received } : {}),
    ...(typeof value.total === 'number' ? { total: value.total } : {}),
    ...(typeof value.percent === 'number' ? { percent: value.percent } : {}),
  }
}

/**
 * Subscribe to the shell's install progress. Returns an unsubscribe.
 *
 * DELIBERATELY FEATURE-DETECTED AND FULLY SWALLOWED. This runs in four places
 * that are not a Podium shell — a browser tab, a phone, an older shell, a test
 * — and in every one of them the honest behaviour is "no progress events", not
 * an exception on mount. The panel's liveness degrades to the operation's own
 * heartbeat, which is exactly what it does for every other place.
 *
 * The event plugin is reached through `__TAURI_INTERNALS__` rather than
 * `@tauri-apps/api`, because the web bundle is served to browsers too and must
 * not carry a Tauri dependency. The shell grants only the exact event listen
 * and unlisten permissions this bridge needs.
 */
export function onNativeDesktopUpdateProgress(
  handler: (progress: NativeDesktopUpdateProgress) => void,
): () => void {
  const internals = tauriInternals()
  if (!internals) return () => {}
  let disposed = false
  let stop: (() => void) | undefined
  try {
    const callback = internals.transformCallback((event: unknown) => {
      const payload = (event as { payload?: unknown })?.payload ?? event
      const progress = parseProgress(payload)
      if (progress) handler(progress)
    })
    void internals
      .invoke('plugin:event|listen', {
        event: UPDATE_PROGRESS_EVENT,
        target: { kind: 'Any' },
        handler: callback,
      })
      .then((eventId) => {
        const unlisten = (): void => {
          void internals
            .invoke('plugin:event|unlisten', {
              event: UPDATE_PROGRESS_EVENT,
              eventId,
            })
            .catch(() => {})
        }
        if (disposed) unlisten()
        else stop = unlisten
      })
      .catch(() => {})
  } catch {
    return () => {}
  }
  return () => {
    disposed = true
    stop?.()
  }
}

export function desktopUpdateEndpoint(
  channel: NativeDesktopUpdateChannel,
  serverEndpoint: string | undefined,
): string | undefined {
  if (channel !== 'dev') return undefined
  return serverEndpoint
}

export async function persistNativeDesktopUpdateChannel(
  channel: NativeDesktopUpdateChannel,
  serverEndpoint: string | undefined,
): Promise<void> {
  await nativeDesktopBridge()?.setUpdateChannel?.(
    channel,
    desktopUpdateEndpoint(channel, serverEndpoint),
  )
}

export function nativeDesktopBridge(): NativeDesktopBridge | undefined {
  const bridge = (globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }).__PODIUM_DESKTOP__
  if (!bridge || !['macos', 'windows', 'linux'].includes(bridge.platform)) return undefined
  return bridge
}

/**
 * Is this the macOS native shell, as opposed to a browser tab?
 *
 * The gate for Command chords the browser will never hand over. ⌘1…⌘9 switch
 * BROWSER TABS and ⌘N opens a browser window: in a tab those keystrokes never
 * reach the page, so an app that drew ⌘-hold hints there would be advertising
 * shortcuts it cannot honour. Inside the shell the same chords are ours — the
 * webview gets ⌘-digit because no menu item claims it, and ⌘N arrives as a menu
 * accelerator (`File > New Agent`, apps/desktop/src-tauri/src/main.rs).
 */
export function isMacNativeShell(): boolean {
  return nativeDesktopBridge()?.platform === 'macos'
}

/**
 * Sends `url` to the OS browser when the desktop shell needs the page to ask, and reports
 * back whether it did — a caller that gets a promise must suppress its own navigation.
 *
 * THE MIRROR OF THE SHIM'S TEST (POD-1606). The injected link shim
 * (apps/desktop/src-tauri/src/bootstrap.rs) diverts links that leave this Podium; this
 * function covers the opposite half — a URL that IS ours, which the shim deliberately
 * leaves to the webview, and which the webview would answer with an in-app window. So it
 * hands over exactly the links the shim declines, and declines exactly the ones the shim
 * takes; handing over both would open the page twice.
 *
 * The origin test used to be "same origin as the PAGE", which meant the two halves did
 * not meet in all-in-one mode: there the UI loads from `tauri://localhost` while the
 * server is `http://127.0.0.1:<port>`, so a server URL was cross-origin to the page,
 * this function declined it, and the shim took it — correct then, wrong now that the
 * shim keeps our own origins in-app. Both halves now ask the same resolver.
 *
 * Still declines (null) where asking would be wrong or useless: a plain browser, where
 * the anchor already does the right thing, and a shell older than `openExternal`.
 */
export function openInSystemBrowser(url: string): Promise<void> | null {
  const openExternal = nativeDesktopBridge()?.openExternal
  if (!openExternal || typeof window === 'undefined') return null
  if (classifyPodiumLink(url)?.kind === 'internal') return openExternal(url)
  // The resolver only speaks http(s), and the shell's own page origin is not an
  // http origin: in all-in-one mode it is `tauri://localhost`. A caller that
  // built its URL from `window.location.origin` — the fallback every one of them
  // keeps for a client that has not resolved its server yet — would otherwise be
  // refused by both halves and open nothing at all.
  return sameOriginAsPage(url) ? openExternal(url) : null
}

function sameOriginAsPage(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}
