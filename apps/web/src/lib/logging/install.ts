import {
  type ClientLoggingOptions,
  installClientLogging,
  type LogTransport,
  type UnloadLogTransport,
} from '@podium/client-core/logging'
import { asMachineId, type MachineId } from '@podium/model/browser'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { pageBuildVersion } from './build-version'
import { installGlobalHandlers } from './global-handlers'
import { unloadLogTransport } from './transport'
import { UPDATE_LOG_FLOORS } from './update-logs'

/**
 * THE WEB'S SHARE of client logging: what only a browser knows.
 *
 * The batching, the bounded queue, the backoff and the crash payload all live in
 * `@podium/client-core/logging`, because `apps/mobile` needs exactly the same
 * behaviour and a second implementation would get the sink's two non-obvious
 * properties only if its author happened to remember them. What is left here is
 * genuinely web-shaped and cannot be shared: which globals produce errors, and
 * how this runtime describes itself.
 *
 * The Tauri webview ships this same bundle, which is why `role` is DETECTED
 * rather than compiled in — one build serves as `web` in a browser and
 * `desktop` behind the shell, and a crash report that lied about which would
 * send an operator looking in the wrong log file.
 *
 * `version` is the product string (`PODIUM_APP_VERSION` or `dev+<sha>`), not
 * the chunk hash. It is resolved synchronously, before the first record —
 * see ./build-version.
 *
 * It also declares {@link UPDATE_LOG_FLOORS}. That is a web decision rather than
 * a client-core one on purpose: the namespaces are this bundle's own, and the
 * phone answers the same questions under different names.
 */

export type { LogTransport, UnloadLogTransport }

export interface WebLoggingOptions
  extends Omit<ClientLoggingOptions, 'role' | 'platform' | 'version'> {
  /** Detected when absent. */
  role?: string
  /** Product version when absent — see ./build-version. */
  version?: string
}

function detectRole(): string {
  return nativeDesktopBridge() ? 'desktop' : 'web'
}

function detectPlatform(): string | undefined {
  const bridge = nativeDesktopBridge()
  if (bridge) return bridge.platform
  return typeof navigator === 'undefined' ? undefined : navigator.userAgent.slice(0, 128)
}

const machineIdOf = (options: WebLoggingOptions): MachineId | undefined => {
  const bridged = nativeDesktopBridge()?.machineId
  return options.machineId ?? (bridged === undefined ? undefined : asMachineId(bridged))
}

/** Wire the browser's logging and return a disposer. */
export function installWebLogging(options: WebLoggingOptions): () => void {
  const platform = detectPlatform()
  const logging = installClientLogging({
    // Before the spread, so a caller may still say something else — a test that
    // wants the floors off, or a future surface with its own set.
    floors: UPDATE_LOG_FLOORS,
    // A page that is going away gets one synchronous hand-off; see
    // `unloadLogTransport`. Before the spread, so a test can replace it.
    unloadTransport: unloadLogTransport(),
    ...options,
    role: options.role ?? detectRole(),
    version: options.version ?? pageBuildVersion(),
    // The desktop bridge hands its machine id over as a plain string, so the
    // brand is asserted at that edge — the shell reads it from the same state
    // file the daemon registers with.
    ...(machineIdOf(options) ? { machineId: machineIdOf(options) } : {}),
    ...(platform ? { platform } : {}),
  })
  const removeHandlers = installGlobalHandlers(window, logging.reporter)
  const removeUnloadFlush = installUnloadFlush(window, document, logging.flushOnUnload)

  return () => {
    removeUnloadFlush()
    removeHandlers()
    logging.dispose()
  }
}

/**
 * FLUSH WHEN THE PAGE IS TAKEN AWAY, whoever takes it (POD-3224 follow-up).
 *
 * Two events, because neither is enough on its own:
 *
 *  - `pagehide` fires for a navigation, a tab close and a bfcache suspend, and
 *    is the reliable one on WebKit — which is the surface this arrived from.
 *  - `visibilitychange` to `hidden` fires first when a tab is merely backgrounded
 *    and, on mobile, is often the LAST event a page gets before it is discarded
 *    without any `pagehide` at all.
 *
 * Both are safe to fire on a page that then carries on living: the sink only
 * empties its queue when the browser accepted the hand-off, so a backgrounded
 * tab that returns has simply shipped early rather than lost anything.
 *
 * `unload` is deliberately NOT among them: listening for it disqualifies a page
 * from the bfcache in every current browser, which would be a real behaviour
 * change made for a log line.
 */
function installUnloadFlush(
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>,
  flush: () => number,
): () => void {
  const onPageHide = (): void => void flush()
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') flush()
  }
  win.addEventListener('pagehide', onPageHide)
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    win.removeEventListener('pagehide', onPageHide)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
