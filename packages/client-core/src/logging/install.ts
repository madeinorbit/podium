import type { LogOrigin, LogsCrashInput, LogsForwardInput } from '@podium/commands'
import {
  addSink,
  createConsoleSink,
  createLogger,
  createRingBufferSink,
  getProcessContext,
  type LogLevel,
  type LogRecord,
  removeSink,
  setLogLevel,
  setProcessContext,
} from '@podium/logger'
import type { MachineId } from '@podium/model'
import { type CrashReporter, createCrashReporter } from './crash'
import { createForwardingSink } from './forward-sink'
import {
  createLevelController,
  type LevelController,
  setActiveLevelController,
} from './level-command'
import { setActiveCrashReporter } from './runtime'

/**
 * THE CLIENT COMPOSITION ROOT, shared by every client that ships logs to its
 * own server — the browser, the Tauri webview (same bundle), and the Expo app
 * [spec: docs/superpowers/specs/2026-08-11-logging-strategy-design.md,
 * "Client → server forwarding"].
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
 * review addendum: the sink follows config, and a client's default is a
 * boot-time decision this function owns.
 *
 * NO GLOBALS ARE READ HERE. `role`, `platform` and `machineId` are parameters
 * because the answers differ per runtime and only the app knows them — a
 * `navigator` sniff or a `window` check in this file is what would stop the
 * Expo bundle importing it. Global error handlers are the app's job too, for
 * the same reason: this returns the reporter, and the app decides what fires it.
 */

export interface LogTransport {
  forward(input: LogsForwardInput): Promise<void>
  crash(input: LogsCrashInput): Promise<void>
}

export interface ClientLoggingOptions {
  transport: LogTransport
  /** `web` | `desktop` | `mobile`. The client's own self-description. */
  role: string
  /**
   * WHICH BUILD wrote this record. REQUIRED, and that is the point (POD-1965).
   *
   * It was optional, and both web callers omitted it, and every web record
   * shipped with no `v` for months — a defect made of an absent field, which is
   * the kind nothing notices. A client that cannot say which build it is cannot
   * be asked whether it contains a fix, so the composition root has to answer
   * even if the answer is "a dev server". `setProcessContext({ v })` may still
   * refine it later.
   */
  version: string
  /** The machine this client runs on, when it knows — `LogOrigin.machineId`
   *  carries the brand, so the caller resolves it rather than the sink. */
  machineId?: MachineId
  platform?: string
  /** Client default. Spec: `warn`. */
  level?: LogLevel
  ringCapacity?: number
  /** Off in tests, where a captured record is the assertion. */
  console?: boolean
  batchSize?: number
  flushIntervalMs?: number
}

export interface ClientLogging {
  /** Hand this the error from whatever global handler the runtime provides. */
  reporter: CrashReporter
  /**
   * The runtime level knob (POD-1920): what a server-pushed `setLogLevel` lands
   * in, and what a settings affordance drives. Returned as well as registered
   * globally so a caller that holds the installation does not have to reach
   * through module state to read its own status.
   */
  levels: LevelController
  /** The flight recorder's current contents, oldest first. */
  snapshot(): LogRecord[]
  /** Settle whatever the forwarding sink is holding. */
  flush(): Promise<void>
  dispose(): void
}

/** ~500 records is a minute or so of real traffic, in bounded memory. */
const RING_CAPACITY = 500

/**
 * Register the sinks, set the boot level and process context, and build the
 * crash reporter.
 *
 * The version may not be known yet when this runs — on the web it is a fetch of
 * the build stamp, and a crash during boot is exactly the crash worth having —
 * so the origin is read at SEND time rather than captured here.
 * `setProcessContext({ v })` later therefore tags records already queued.
 */
export function installClientLogging(options: ClientLoggingOptions): ClientLogging {
  const { role, machineId } = options
  setProcessContext({
    role,
    v: options.version,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(machineId ? { machineId } : {}),
  })
  const boot = options.level ?? 'warn'
  setLogLevel(boot)
  // The boot level is captured HERE because this is the only place that knows
  // it: an operator's reset says "back to your default" rather than naming one,
  // so a later change to that default cannot strand a stale level in somebody's
  // support instructions (POD-1920).
  const levels = createLevelController({ boot })
  setActiveLevelController(levels)

  const origin = (): LogOrigin => {
    const { v } = getProcessContext()
    return {
      role,
      ...(typeof v === 'string' ? { v } : {}),
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
    log: createLogger(`${role}:crash`),
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

  return {
    reporter,
    levels,
    snapshot: () => ring.snapshot(),
    flush: () => forwarding.flush(),
    dispose: () => {
      setActiveCrashReporter(null)
      setActiveLevelController(null)
      levels.dispose()
      removeSink(ring)
      removeSink(forwarding)
      if (consoleSink) removeSink(consoleSink)
      void forwarding.close()
    },
  }
}
