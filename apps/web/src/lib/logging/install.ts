import type { LogOrigin, LogsCrashInput, LogsForwardInput } from '@podium/commands'
import {
  addSink,
  createConsoleSink,
  createLogger,
  createRingBufferSink,
  getProcessContext,
  type LogLevel,
  removeSink,
  setLogLevel,
  setProcessContext,
} from '@podium/logger'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { createCrashReporter } from './crash'
import { createForwardingSink } from './forward-sink'
import { setActiveCrashReporter } from './runtime'

/**
 * THE CLIENT COMPOSITION ROOT — where the browser (and the Tauri webview, which
 * ships this same bundle) joins the logger to its server
 * [spec: docs/superpowers/specs/2026-08-11-logging-strategy-plan.md, chunk 4].
 *
 * Three sinks, and the interesting part is that they disagree on purpose:
 *
 * | sink | threshold | what it is for |
 * |------|-----------|----------------|
 * | console | follows config (`warn` by default) | the developer looking now |
 * | ring buffer | `trace`, always | the flight recorder |
 * | forwarding | follows config (`warn` by default) | the operator later |
 *
 * The ring buffer is what makes `debug` worth writing in this codebase: those
 * records cost memory and nothing else until a crash fires, at which point they
 * are the minute of context that explains it. The forwarding sink deliberately
 * pins NO threshold of its own, so `setLogLevel('debug')` raises the console and
 * the forwarding stream together — one knob, per the spec's "default warn+, and
 * raising a client's level to debug forwards debug too", rather than two that
 * can disagree about what a client is currently reporting.
 *
 * `warn` is set here rather than baked into the console sink, per the chunk-1
 * review addendum: the sink follows config, and the browser's default is a
 * boot-time decision this file owns.
 */

export interface LogTransport {
  forward(input: LogsForwardInput): Promise<void>
  crash(input: LogsCrashInput): Promise<void>
}

export interface WebLoggingOptions {
  transport: LogTransport
  /** `web` in a browser, `desktop` in the Tauri webview. Detected when absent. */
  role?: string
  /** App version. Late-resolving is fine — see {@link installWebLogging}. */
  version?: string
  machineId?: string
  /** Client default. Spec: `warn`. */
  level?: LogLevel
  ringCapacity?: number
  /** Off in tests, where a captured record is the assertion. */
  console?: boolean
  batchSize?: number
  flushIntervalMs?: number
}

/** ~500 records is a minute or so of real traffic, in bounded memory. */
const RING_CAPACITY = 500

function detectRole(): string {
  return nativeDesktopBridge() ? 'desktop' : 'web'
}

function detectPlatform(): string | undefined {
  const bridge = nativeDesktopBridge()
  if (bridge) return bridge.platform
  return typeof navigator === 'undefined' ? undefined : navigator.userAgent.slice(0, 128)
}

/**
 * Wire the client's logging and return a disposer.
 *
 * The version may not be known yet when this runs — the build stamp is a fetch,
 * and a crash during boot is exactly the crash worth having — so the origin is
 * read at SEND time rather than captured here. `setProcessContext({ v })` later
 * therefore tags records that were already queued.
 */
export function installWebLogging(options: WebLoggingOptions): () => void {
  const role = options.role ?? detectRole()
  const machineId = options.machineId ?? nativeDesktopBridge()?.machineId
  setProcessContext({
    role,
    ...(options.version ? { v: options.version } : {}),
    ...(detectPlatform() ? { platform: detectPlatform() } : {}),
    ...(machineId ? { machineId } : {}),
  })
  setLogLevel(options.level ?? 'warn')

  const origin = (): LogOrigin => {
    const context = getContextOrigin()
    return {
      role,
      ...(context.v ? { v: context.v } : {}),
      ...(machineId ? { machineId } : {}),
    }
  }

  const ring = createRingBufferSink({ capacity: options.ringCapacity ?? RING_CAPACITY })
  const forwarding = createForwardingSink({
    send: (records) => options.transport.forward({ origin: origin(), records }),
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.flushIntervalMs !== undefined ? { flushIntervalMs: options.flushIntervalMs } : {}),
  })
  const consoleSink = options.console === false ? null : createConsoleSink()

  addSink(ring)
  addSink(forwarding)
  if (consoleSink) addSink(consoleSink)

  const reporter = createCrashReporter({
    log: createLogger('web:crash'),
    snapshot: () => ring.snapshot(),
    send: async (payload) => {
      await options.transport.crash({
        origin: origin(),
        err: payload.err,
        snapshot: payload.snapshot,
        ...(payload.context ? { context: payload.context } : {}),
      })
      // Whatever the forwarding sink was still holding described the run-up to
      // this crash. The crash payload carries the buffer, so this is not a
      // correctness requirement — it is why the per-origin log file and the
      // crash event agree about the last five seconds.
      await forwarding.flush()
    },
  })
  setActiveCrashReporter(reporter)
  const removeHandlers = reporter.installGlobalHandlers(window)

  return () => {
    removeHandlers()
    setActiveCrashReporter(null)
    removeSink(ring)
    removeSink(forwarding)
    if (consoleSink) removeSink(consoleSink)
    void forwarding.close()
  }
}

/**
 * The process context is the authority on `v`, READ each time rather than
 * captured: `setProcessContext({ v })` may land after boot, once the build
 * stamp fetch resolves.
 */
function getContextOrigin(): { v?: string } {
  const { v } = getProcessContext()
  return typeof v === 'string' ? { v } : {}
}
