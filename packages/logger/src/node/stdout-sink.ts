import type { LogLevel } from '../levels'
import type { LogRecord } from '../record'
import { toNdjson } from '../record'
import type { Sink } from '../sinks'

/** The one stream method this sink needs. Narrow so a test can fake it. */
export interface WritableLike {
  write(chunk: string): unknown
}

export interface StdoutSinkOptions {
  /** ABSENT follows the namespace's configured level. */
  minLevel?: LogLevel
  /** Defaults to `process.stdout`. */
  stream?: WritableLike
}

/**
 * NDJSON to stdout, one record per line — the systemd sink. journald captures
 * the unit's stdout and owns retention, so nothing here rotates, truncates or
 * knows where the bytes end up.
 *
 * It is the FILE SINK'S ALTERNATIVE, never its companion: under systemd the
 * file sink is not registered, so a record is written exactly once. Registering
 * both is the double-write the spec rules out.
 *
 * A failed write is swallowed. The realistic failure is EPIPE — the reader went
 * away — and there is by definition nowhere to report that to: the console IS
 * this stream. Unlike the file sink there is nothing to degrade TO, so the sink
 * stays registered and keeps trying; if stdout comes back, so does the log.
 */
export function createStdoutSink(options: StdoutSinkOptions = {}): Sink {
  const stream = options.stream ?? process.stdout
  return {
    name: 'stdout',
    ...(options.minLevel ? { minLevel: options.minLevel } : {}),
    write(record: LogRecord): void {
      try {
        stream.write(toNdjson(record))
      } catch {
        // See above: there is no second stream to complain on.
      }
    },
  }
}
