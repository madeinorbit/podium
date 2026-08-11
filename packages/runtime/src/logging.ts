/**
 * The composition root for logging in the long-lived Podium processes.
 *
 * `@podium/logger` deliberately knows nothing about where logs go — it is an L0
 * leaf with no dependencies, so it cannot ask this package where the log dir is.
 * Somebody has to join "which sinks" to "which paths", and this is that seam:
 * `bootProcess` calls it once, before anything else can log.
 *
 * ONE SINK OWNS THE STREAM, chosen by how the process is supervised. This is the
 * spec's no-double-writing rule, and it is stricter than "file or stdout":
 *
 *   systemd    → stdout NDJSON. journald captures the unit's stdout and owns
 *                retention, so writing a file too would store every record twice
 *                under two different retention policies.
 *   detached   → the rotating file. The detached spawner still points the
 *                process's stdout/stderr at the legacy `<role>.log` (see
 *                apps/cli/src/cli-spawn.ts), so a console sink here would write
 *                every record into that unbounded file as well — which is the
 *                file this whole chunk exists to stop growing. `<role>.log`
 *                keeps its job as the net for STRAY output: a bun panic, a
 *                library's own printf, anything that never reached the logger.
 *   foreground → the console, pretty. A dev run or the desktop sidecar has a
 *                terminal attached and nothing tailing a file.
 *
 * Level control is untouched by any of this: `PODIUM_LOG_LEVEL` / `PODIUM_LOG`
 * move whichever sink is registered, because none of them pins its own
 * threshold.
 */
import {
  addSink,
  configureLevelsFromEnv,
  createConsoleSink,
  type LogLevel,
  type Sink,
  setLogLevel,
  setProcessContext,
} from '@podium/logger'
import { createFileSink, createStdoutSink } from '@podium/logger/node'
import { type EnvSource, resolveInstanceId, resolveRunRecordMode } from './config'
import { logDir } from './run-registry'

/** How the process is supervised — the sink selector. */
export type LoggingMode = 'systemd' | 'detached' | 'foreground'

export interface ProcessLoggingOptions {
  /** `server` | `daemon` | `janitor` | `all-in-one` | `cli` — names the file too. */
  role: string
  /** Defaults to `resolveRunRecordMode(env)`. */
  mode?: LoggingMode
  /** App version for the `v` field. Defaults to `PODIUM_APP_VERSION`, else `dev`. */
  version?: string
  /** Directory for the file sink. Defaults to `logDir()`. */
  dir?: string
  /**
   * The level this process wants WHEN THE OPERATOR HAS NOT ASKED FOR ONE. The
   * CLI passes `warn` so an ordinary command stays quiet; the server family
   * leaves it unset and takes the logger's `info` default.
   *
   * Applied only when neither `PODIUM_LOG_LEVEL` nor `PODIUM_LOG` is set,
   * because `setLogLevel` is a programmatic override and beats the environment
   * — calling it unconditionally would make `PODIUM_LOG_LEVEL=debug` do nothing,
   * which is the one thing an operator reaches for when something is wrong.
   */
  defaultLevel?: LogLevel
  env?: EnvSource
}

export interface ProcessLogging {
  mode: LoggingMode
  /** The sink actually registered, for tests and for a shutdown drain. */
  sink: Sink
  /** Where records are going, for a boot line a human can act on. */
  destination: string
  /** Settle whatever is buffered; resolves when it is durable. Repeatable. */
  flush(): Promise<void>
  /** Unregister and release the sink; implies a final flush. Repeatable. */
  close(): Promise<void>
}

/** `<dir>/<role>.ndjson` — the live file; rotation appends `.1` … `.4`. */
export function logFilePath(role: string, dir: string = logDir()): string {
  return `${dir}/${role}.ndjson`
}

/**
 * The handle from the most recent call, so a second call can replace the first
 * rather than stack a sink on top of it. The CLI needs exactly that: it
 * configures as `cli` before it knows what it was asked to do, and a `podium
 * janitor` re-configures as `janitor` once it does.
 */
let current: ProcessLogging | undefined

/**
 * Register the one sink this process should have and bind its process context.
 * Returns a handle so shutdown can drain it; the caller owns that lifetime.
 *
 * IDEMPOTENT BY REPLACEMENT: calling it again closes whatever the previous call
 * registered. Without that, the CLI's `cli` sink would still be registered
 * alongside the `janitor` one and every record would be written twice.
 */
export function configureProcessLogging(options: ProcessLoggingOptions): ProcessLogging {
  const env = options.env ?? process.env
  const mode = options.mode ?? resolveRunRecordMode(env)
  const version = options.version ?? env.PODIUM_APP_VERSION ?? 'dev'

  // Fire-and-forget: the previous handle is unregistered synchronously inside
  // close(), and the async tail is only an fd release with nothing to await.
  void current?.close()
  current = undefined

  // Read levels from the SAME env everything else here reads. The logger would
  // otherwise lazily read the ambient `process.env` on its first call, which is
  // identical in production and a different world in a test — and a level
  // decision taken against one env while the sink was chosen against another is
  // the kind of split that only shows up as a mysteriously empty log file.
  configureLevelsFromEnv(env)
  if (options.defaultLevel && !env.PODIUM_LOG_LEVEL && !env.PODIUM_LOG) {
    setLogLevel(options.defaultLevel)
  }

  setProcessContext({
    role: options.role,
    v: version,
    platform: process.platform,
    instance: resolveInstanceId(env),
  })

  const destination =
    mode === 'systemd'
      ? 'stdout (journald)'
      : mode === 'detached'
        ? logFilePath(options.role, options.dir)
        : 'console'
  const sink: Sink =
    mode === 'systemd'
      ? createStdoutSink()
      : mode === 'detached'
        ? createFileSink({ path: logFilePath(options.role, options.dir) })
        : createConsoleSink({ pretty: true })

  const dispose = addSink(sink)
  let closed = false
  const handle: ProcessLogging = {
    mode,
    sink,
    destination,
    // These two go through THIS process's sink rather than the logger core's
    // registry-wide `flushSinks()`/`closeSinks()` on purpose: the handle owns
    // exactly what it registered, so a host that also registered its own sink
    // does not have it torn down by another component's shutdown.
    async flush(): Promise<void> {
      await sink.flush?.()
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      // Unregister FIRST: anything logged during the rest of shutdown should
      // miss a closing sink rather than race it.
      dispose()
      if (current === handle) current = undefined
      await sink.close?.()
    },
  }
  current = handle
  return handle
}
