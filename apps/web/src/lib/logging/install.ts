import {
  type ClientLoggingOptions,
  installClientLogging,
  type LogTransport,
} from '@podium/client-core/logging'
import { asMachineId, type MachineId } from '@podium/model'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { installGlobalHandlers } from './global-handlers'

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
 */

export type { LogTransport }

export interface WebLoggingOptions extends Omit<ClientLoggingOptions, 'role' | 'platform'> {
  /** Detected when absent. */
  role?: string
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
    ...options,
    role: options.role ?? detectRole(),
    // The desktop bridge hands its machine id over as a plain string, so the
    // brand is asserted at that edge — the shell reads it from the same state
    // file the daemon registers with.
    ...(machineIdOf(options) ? { machineId: machineIdOf(options) } : {}),
    ...(platform ? { platform } : {}),
  })
  const removeHandlers = installGlobalHandlers(window, logging.reporter)

  return () => {
    removeHandlers()
    logging.dispose()
  }
}
