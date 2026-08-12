/**
 * CLIENT LOG INGESTION — the service behind `logs.forward` and `logs.crash`
 * (chunk 3 of [spec:2026-08-11-logging-strategy-design]).
 *
 * Two jobs, deliberately in one service because they share the origin tagging
 * and both are "a client's records, landing on the user's own server":
 *
 *  - `forward` appends a batch to a PER-ORIGIN rotating NDJSON file under the
 *    server's log dir, using the same file sink and the same 10 MB × 5 policy
 *    the server's own logs use (chunk 2). Per-origin because a web client and a
 *    phone interleaved in one file are two investigations sharing a haystack.
 *  - `crash` stores the error plus the client's whole ring buffer as a durable
 *    crash event, and then — and only then — offers it to the telemetry crash
 *    tier, which scrubs it and checks consent before anything can leave.
 *
 * ORDER MATTERS AT THE CRASH SEAM. The durable event is written FIRST and the
 * telemetry hop is best-effort after it. The crash event on the user's own disk
 * is the artifact support actually needs (`podium logs export-crash`); the
 * telemetry signature is an anonymous aggregate that may be switched off. A
 * failure in the optional half must never cost the mandatory one.
 *
 * NOTHING HERE THROWS AT THE ENDPOINT for a storage failure. This is the
 * logging layer: a full disk must not turn a client's crash report into a 500,
 * and a client whose crash report failed cannot do anything useful with the
 * error anyway. Failures degrade to a single server-side log line and a truthful
 * count in the response.
 */

import { join } from 'node:path'
import type { LogOrigin, LogsCrashInput, LogsForwardInput } from '@podium/commands'
import { createLogger, type LogRecord } from '@podium/logger'
import { createFileSink, type FileSink } from '@podium/logger/node'
import { type CrashStore, createCrashStore } from '@podium/runtime/crash-store'
import { logDir } from '@podium/runtime/run-registry'

const log = createLogger('server:logs')

/**
 * How many distinct origins get their own file before the rest share one.
 *
 * A bound, not a limit anyone should meet: it stops a client that mints a new
 * `machineId` per launch from turning the log dir into a file-per-session.
 *
 * SAY THE WORST CASE OUT LOUD, because it is the number that matters and it is
 * not small: the spec asks for the same rotation policy as the server's own
 * logs (10 MB × 5), so a fully-populated set of origins is 64 × 50 MB ≈ 3.2 GB
 * of client logs before anything is discarded. That is the ceiling of a fleet
 * of 64 chatty machines all forwarding at `warn`+, not a steady state — a
 * normal install has one or two origins and a few MB. If that ceiling ever
 * proves too generous, the lever is this constant or the per-origin rotation
 * budget, and it should move deliberately rather than be discovered.
 */
export const MAX_ORIGIN_FILES = 64

/** Where records from an origin we have stopped opening files for go. */
const OVERFLOW_ORIGIN = 'other'

/** The telemetry surface this service uses — the crash tier's entry point, and
 *  nothing else. Narrow on purpose: the ingestion path has no business reading
 *  consent, building a usage report, or flushing the queue. */
export interface CrashTelemetry {
  recordCrash(err: unknown): void
}

export interface LogIngestDeps {
  /** Defaults to `<stateDir>/logs/clients`. */
  dir?: string
  crashStore?: CrashStore
  /** Injected by tests. Production uses the chunk-2 rotating file sink. */
  createSink?: (path: string) => FileSink
  maxOriginFiles?: number
}

export interface ForwardResult {
  /** Records written. Less than the batch only when the sink is unavailable. */
  accepted: number
  /** The file they were filed under, so a client can be told where to look. */
  origin: string
}

export interface CrashResult {
  /** The stored event's id, or undefined when the write failed. */
  id?: string
}

/**
 * `web` + `m-1234` → `web-m-1234`; anything exotic → underscores.
 *
 * A filename is built from a CLIENT-SUPPLIED string, which is the classic path
 * traversal shape, so the alphabet is an allowlist rather than a blocklist and
 * `..` cannot survive it. The length cap keeps a hostile 128-char machineId from
 * pushing the path past a filesystem's limit.
 */
export function originKey(origin: LogOrigin): string {
  const raw = origin.machineId ? `${origin.role}-${origin.machineId}` : origin.role
  const safe = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 48)
  return safe.length > 0 ? safe : 'unknown'
}

/**
 * One forwarded record, re-tagged with the origin the SERVER believes in.
 *
 * `role`, `v` and `machineId` are overwritten rather than merged: a client's
 * own process context is what it says about itself in its own file, and the
 * server's copy has to be the one the reader can group by. Everything else the
 * client sent — the reserved keys and every free-form field — is preserved, and
 * a fresh object is built rather than the input mutated, because a sink may not
 * mutate a record and the input is shared with the caller.
 */
export function taggedRecord(record: Record<string, unknown>, origin: LogOrigin): LogRecord {
  return {
    ...record,
    role: origin.role,
    ...(origin.v !== undefined ? { v: origin.v } : {}),
    ...(origin.machineId !== undefined ? { machineId: origin.machineId } : {}),
  } as LogRecord
}

export class LogIngestService {
  private readonly dir: string
  private readonly crashStore: CrashStore
  private readonly makeSink: (path: string) => FileSink
  private readonly maxOriginFiles: number
  private readonly sinks = new Map<string, FileSink>()

  constructor(deps: LogIngestDeps = {}) {
    this.dir = deps.dir ?? join(logDir(), 'clients')
    this.crashStore = deps.crashStore ?? createCrashStore()
    this.maxOriginFiles = deps.maxOriginFiles ?? MAX_ORIGIN_FILES
    this.makeSink =
      deps.createSink ??
      ((path) =>
        createFileSink({
          path,
          // ALL LEVELS: the client already applied its own threshold before
          // forwarding (default `warn`+), so a gate here would silently discard
          // the `debug` records an operator turned on for one user's client.
          //
          // WHAT ACTUALLY GUARANTEES THAT is `write()` being called directly
          // below — `minLevel` is only ever consulted by the logger's dispatch
          // (packages/logger/src/sinks.ts), which these ingestion sinks are
          // never registered with, so the field is inert here. It is set anyway,
          // and honestly: it states the intended threshold for the day one of
          // these sinks IS handed to dispatch, and `trace` is the answer that
          // keeps the no-second-gate property when that happens.
          minLevel: 'trace',
        }))
  }

  /** The rotating file for an origin, opened on first use. */
  private sinkFor(key: string): FileSink | undefined {
    const existing = this.sinks.get(key)
    if (existing) return existing
    const name = this.sinks.size >= this.maxOriginFiles ? OVERFLOW_ORIGIN : key
    const shared = this.sinks.get(name)
    if (shared) return shared
    try {
      const sink = this.makeSink(join(this.dir, `${name}.ndjson`))
      this.sinks.set(name, sink)
      return sink
    } catch (err) {
      // A sink that cannot even be constructed (unwritable log dir) is reported
      // once per batch by the caller; there is nothing to retry here.
      log.warn('client log sink unavailable', { origin: name, err })
      return undefined
    }
  }

  forward(input: LogsForwardInput): ForwardResult {
    const key = originKey(input.origin)
    const sink = this.sinkFor(key)
    if (!sink) return { accepted: 0, origin: key }
    let accepted = 0
    for (const record of input.records) {
      // The sink owns its own failures and never throws (fail-open, chunk 1),
      // so a degraded sink still counts as accepted: the records went
      // somewhere, and the sink emitted its own one-time warning about where.
      sink.write(taggedRecord(record, input.origin))
      accepted += 1
    }
    return { accepted, origin: key }
  }

  /**
   * Store a crash event and offer it to the telemetry crash tier.
   *
   * The telemetry argument is optional because a server can be assembled
   * without an emitter (tests, an embedded caller). No consent check happens
   * here and none may: `recordCrash` re-reads consent per record so that
   * turning the tier off takes effect without a restart, and a second gate here
   * would be a second answer to the same question.
   */
  crash(input: LogsCrashInput, telemetry?: CrashTelemetry): CrashResult {
    const stored = this.crashStore.record({
      origin: input.origin,
      err: input.err,
      snapshot: input.snapshot,
      ...(input.context ? { context: input.context } : {}),
    })
    if (!stored) {
      log.error('crash event could not be stored', {
        origin: input.origin.role,
        err: input.err,
      })
    } else {
      log.warn('client crash reported', {
        crashId: stored.id,
        origin: input.origin.role,
        clientVersion: input.origin.v,
        records: input.snapshot.length,
        err: input.err,
      })
    }
    // THE DORMANT HOP, WIRED (design spec, "Crash capture" step 3). Best-effort
    // and after the durable write: the emitter scrubs and consent-gates inside
    // `recordCrash`, so nothing leaves the installation from this line unless
    // the user turned the crash tier on.
    //
    // THE WIRE OBJECT GOES THROUGH AS IT ARRIVED, and that is a decision rather
    // than laziness. `scrubError` accepts a serialized `{name, message, stack}`
    // (design spec, "Serialized crashes and the scrubber"), so this needs no
    // rebuilt `Error` — and must not build one: mapping names back onto real
    // constructors covers only an enumerated set and reports everything outside
    // it as `Error`, which the closed enum ACCEPTS instead of folding to
    // `Other`. Since `crashSignature` is `errorType@topFrame` and doubles as
    // the rate-limit key, that would let unrelated crash families suppress each
    // other through the cooldown.
    try {
      telemetry?.recordCrash(input.err)
    } catch (err) {
      log.warn('telemetry crash hop failed', { err })
    }
    return stored ? { id: stored.id } : {}
  }

  /** Release the per-origin file descriptors. Called from the shutdown drain. */
  async close(): Promise<void> {
    const open = [...this.sinks.values()]
    this.sinks.clear()
    await Promise.all(open.map((sink) => sink.close().catch(() => undefined)))
  }
}
