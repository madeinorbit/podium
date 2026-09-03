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
 * ---------------------------------------------------------------------------
 * `forward` DOES NOT WRITE INSIDE THE REQUEST (POD-3167)
 * ---------------------------------------------------------------------------
 * It used to. The argument for it was that the cost lands on the request that
 * carried the batch and on nobody else — which is true of the CPU accounting and
 * false of the latency. The file sink writes SYNCHRONOUSLY and deliberately (a
 * buffered async sink loses precisely the records worth having, and `Sink.write`
 * may not reject), so a 500-record batch — the contract's cap — blocked the one
 * event loop this process serves everything on, and the request that paid for it
 * was whichever one happened to arrive next.
 *
 * So `forward` TAGS and QUEUES, and the writes happen in bounded slices between
 * event-loop turns, through `QueuedRecordWriter` — the same primitive the fleet
 * daemon store uses, with this file's policy: `logs/clients`, a 64-file budget,
 * and the queue budget below. `accepted` is therefore a queue admission rather
 * than a completed write; the records reach disk within a few turns, and all of
 * them reach it before `close()` returns.
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
import type { FileSink } from '@podium/logger/node'
import { type CrashStore, createCrashStore } from '@podium/runtime/crash-store'
import { logDir } from '@podium/runtime/run-registry'
import { QueuedRecordWriter } from './queued-writer'

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

/**
 * Records held across all origins before drop-oldest begins.
 *
 * Ten batches at the contract's cap (`MAX_FORWARDED_RECORDS` is 500), which is
 * the same shape of answer the fleet store gives and for the same reason: a
 * server can be slow at disk or busy at everything, and the answer to either has
 * to be a bound rather than a heap that grows until something else fails. It is
 * stated here rather than shared because it is POLICY — a household of browsers
 * and a fleet of daemons have no reason to spend the same allowance.
 */
const MAX_PENDING_RECORDS = 5000

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
  /**
   * A stored crash, for a composition root that publishes it on the bus
   * (podium-cloud's analytics plugin forwards these to error tracking).
   *
   * Same contract as the telemetry hop in {@link LogIngestService.crash}:
   * best-effort, AFTER the durable write, isolated. It is handed the error and
   * the origin and deliberately NOT `input.snapshot` — the ring buffer is what
   * makes the durable event useful to support here, and it is not something an
   * observer should be able to forward anywhere else.
   */
  onCrash?: (event: {
    origin: LogsCrashInput['origin']
    err: unknown
    crashId?: string
  }) => void
  /** Injected by tests. Production uses the chunk-2 rotating file sink. */
  createSink?: (path: string) => FileSink
  maxOriginFiles?: number
}

export interface ForwardResult {
  /** Records ACCEPTED for writing. Not "written": the writes are deferred off
   *  the request, so this is a queue admission and the only way to be short of
   *  the batch is a service that is already closed. */
  accepted: number
  /** The file they were filed under, so a client can be told where to look. */
  origin: string
  /** Drops the CLIENT reported in this batch — its own bounded queue overflowed,
   *  or a batch went unsendable. A SENDER-side loss. */
  dropped: number
  /** Drops THIS SERVER made for this origin since boot, under its own
   *  backpressure. Reported apart from {@link dropped} because a client that
   *  cannot reach the server and a server that cannot keep up are different
   *  problems with different fixes, and one number would answer neither. */
  serverDropped: number
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
  private readonly crashStore: CrashStore
  private readonly onCrash: LogIngestDeps['onCrash']
  /**
   * THE SHARED PRIMITIVE, configured with this service's policy. Everything
   * about WHEN and HOW MUCH gets written lives there; everything about WHERE and
   * under WHOSE NAME lives here.
   */
  private readonly writer: QueuedRecordWriter

  constructor(deps: LogIngestDeps = {}) {
    this.crashStore = deps.crashStore ?? createCrashStore()
    this.onCrash = deps.onCrash
    this.writer = new QueuedRecordWriter({
      dir: deps.dir ?? join(logDir(), 'clients'),
      kind: 'client',
      maxFiles: deps.maxOriginFiles ?? MAX_ORIGIN_FILES,
      maxPending: MAX_PENDING_RECORDS,
      // ALL LEVELS: the client already applied its own threshold before
      // forwarding (default `warn`+), so a gate here would silently discard the
      // `debug` records an operator turned on for one user's client. The writer
      // sets `minLevel: 'trace'` on the sinks it opens for exactly that reason.
      ...(deps.createSink ? { createSink: deps.createSink } : {}),
    })
  }

  /**
   * Accept one client's batch.
   *
   * NOTHING IS WRITTEN HERE (POD-3167). The records are tagged with the origin
   * the server files them under and queued; the writes happen in bounded slices
   * between event-loop turns, so a 500-record batch costs the next request a
   * slice rather than the batch.
   *
   * THE CLIENT'S DROP COUNT IS WRITTEN INTO THE FILE, not just returned. A gap
   * in a log is ambiguous — a quiet client and an overflowing forwarding queue
   * look identical — and the reader of `clients/web-m1.ndjson` is not holding
   * this process's counters.
   */
  forward(input: LogsForwardInput): ForwardResult {
    const key = originKey(input.origin)
    const dropped = input.dropped ?? 0
    if (this.writer.closed) {
      return { accepted: 0, origin: key, dropped, serverDropped: this.writer.droppedFor(key) }
    }
    if (dropped > 0) {
      this.writer.enqueue(
        key,
        taggedRecord(
          {
            ts: new Date().toISOString(),
            level: 'warn',
            ns: 'server:logs',
            msg: 'client dropped records before this batch',
            dropped,
          },
          input.origin,
        ),
      )
    }
    let accepted = 0
    for (const record of input.records) {
      this.writer.enqueue(key, taggedRecord(record, input.origin))
      accepted += 1
    }
    return { accepted, origin: key, dropped, serverDropped: this.writer.droppedFor(key) }
  }

  /** Drops THIS SERVER made under its own backpressure, for this origin. */
  serverDroppedFor(origin: LogOrigin): number {
    return this.writer.droppedFor(originKey(origin))
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
    // THE BUS HOP, for a composition root that publishes crashes (podium-cloud's
    // analytics plugin). Same shape as the telemetry hop above it and for the
    // same reasons: best-effort, after the durable write, isolated, and the wire
    // error passes through unrebuilt. The SNAPSHOT STAYS HERE — see `onCrash`.
    try {
      this.onCrash?.({
        origin: input.origin,
        err: input.err,
        ...(stored ? { crashId: stored.id } : {}),
      })
    } catch (err) {
      log.warn('crash observer failed', { err })
    }
    return stored ? { id: stored.id } : {}
  }

  /**
   * Drain what is queued and release the per-origin file descriptors. Called
   * from the shutdown drain.
   *
   * The final drain is UNSLICED (see `QueuedRecordWriter.close`): slicing exists
   * to keep a running server's request latency flat, and at shutdown there are
   * no requests left to protect while the tail is the part of a log that
   * explains why the process is stopping.
   */
  async close(): Promise<void> {
    await this.writer.close()
  }
}
