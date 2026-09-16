import { createLogger, type Logger } from '@podium/logger'
import type { ReplicaEvent } from '@podium/sync/replica'

/**
 * THE CLIENT HALF OF A SYNC TRANSFER'S TIMELINE (POD-4071).
 *
 * `apps/server/src/sync/route-support.ts` has logged the server half since
 * POD-3933: one INFO line per transfer with `transferId`, coding, outcome, rows,
 * records, bytes and the capture/first-byte/total milliseconds. What it cannot
 * see is the consumer. A real bootstrap off the operator's Mac sent its first
 * byte at 1516 ms and finished at 17985 ms — 11.8 MB of gzip over ~16.5 s on a
 * LAN — and the server line cannot say whether those sixteen seconds were the
 * network, `JSON.parse`, or the store. Eighteen seconds earlier the SAME
 * principal had opened a bootstrap that emitted not one byte for 12 s before the
 * route cancelled it, and nothing anywhere said why a second one started.
 *
 * So this file exists to answer three questions the server line raises and
 * cannot close:
 *
 *  1. **Why did this bootstrap start at all?** The Replica knows — it has a
 *     {@link RebootstrapCause} — but it is direction-locked (`check-boundaries`
 *     rule 9: `packages/sync/src/replica/` imports nothing but `@podium/model`
 *     and its own directory), so it cannot log. It can only EMIT, and it emits
 *     `{ type: 'heal', rung, cause }` synchronously inside `startRebootstrap`,
 *     strictly before the walk it describes is queued. {@link noteReplicaEvent}
 *     catches that event at the composition root and parks the cause for the
 *     request that is about to open. That ordering is the reason this works, and
 *     it is a property of `replica.ts`, not an assumption about scheduling.
 *
 *  2. **Where did the time go?** Four disjoint intervals, each measured where it
 *     actually happens rather than derived from a model of the pipeline:
 *       - `downloadMs` — time awaited on `reader.read()`, summed by the
 *         {@link SyncReadMeter} the NDJSON reader marks its reads with. This is
 *         the only real I/O wait on the path.
 *       - `decodeMs` — the rest of the pull: UTF-8 decode, line splitting,
 *         `JSON.parse`, the zod record parse and frame validation. Not measured
 *         directly but SUBTRACTED from an interval that strictly contains the
 *         reads, which is why the two are reported side by side.
 *       - `stageMs` — time this source sat suspended at `yield` while the
 *         Replica folded the chunk into its staging map. The consumer's cost,
 *         visible from here precisely because a generator pauses inside it.
 *       - `commitMs` — the install transaction, which happens AFTER the stream
 *         has ended and so is invisible to the source. It is timed from the
 *         `bootstrap-installed` event instead (see {@link noteReplicaEvent}).
 *     Together they are the download/decode/commit split the issue asked for;
 *     `stageMs` is the seam that turned out to exist between decode and commit.
 *
 *  3. **Which server line is this?** Every line here carries the `transferId`
 *     the route put on `Podium-Transfer-Id` (CORS already exposes it, so the
 *     phone can read it too). That is the join key, and it is the whole point:
 *     a client line that cannot be joined to its server line describes an event
 *     nobody can place.
 *
 * WHAT THIS FILE REFUSES TO DO, because instrumentation that changes what it
 * measures is worse than none:
 *
 *  - **No timer.** Progress is emitted from the boundaries the transfer already
 *    crosses — a record decoded, a transport read returned — never from an
 *    interval that would wake the loop it is watching. A stalled transfer
 *    therefore goes quiet, which is itself the finding: the terminal line's
 *    `downloadMs` and `reads` say the stall was the socket.
 *  - **Nothing per row.** A bootstrap carries ~19 000 rows in ~57 records. The
 *    counters move per row; a LINE is emitted per `progressRecords` records or
 *    `progressMs` elapsed, whichever comes first.
 *  - **Debug only.** `info` is the server's level for this; a client that
 *    narrated its own bootstrap at `info` would bury the line it is meant to
 *    explain.
 *  - **Nothing identifying.** Counts, codings, statuses and durations. The
 *    endpoint URL is the user's own server, and the principal stays where the
 *    server already logs it.
 */

/** Records between progress lines. ~57 records in a full bootstrap, so ~5 lines. */
const DEFAULT_PROGRESS_RECORDS = 10
/** Milliseconds between progress lines, for a transfer whose records are fat. */
const DEFAULT_PROGRESS_MS = 2000

/** Same guard `perf/switch-trace.ts` and `socket-transport` use: RN and old webviews. */
const wallClock = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

const round = (ms: number): number => Math.round(ms * 10) / 10

export type SyncTransferMode = 'bootstrap' | 'delta'

/**
 * The transport-read boundary, marked by the NDJSON reader and summed here.
 *
 * The meter owns the clock rather than taking one, so `ndjson-reader.ts` marks
 * where a read begins and ends without acquiring a timebase, a dependency or an
 * opinion about what is being measured.
 */
export interface SyncReadMeter {
  /** A `reader.read()` is about to be awaited. */
  beginRead(): void
  /** That read returned `bytes` (0 at EOF, and 0 when it threw). */
  endRead(bytes: number): void
}

/**
 * Which side of the `yield` the source is on.
 *
 * `pipeline` is everything between asking for the next record and getting it —
 * the read plus the decode. `consumer` is the suspension at `yield`, which is
 * the Replica's staging. They partition the body's wall time exactly, so
 * `pipelineMs + stageMs` reconciles against `totalMs - ttfbMs` and a split that
 * does not add up is visible rather than plausible.
 */
export type SyncTransferPhase = 'pipeline' | 'consumer'

export interface SyncTransferAttempt {
  /** Handed to the NDJSON reader so its reads land in `downloadMs`. */
  readonly meter: SyncReadMeter
  /** HTTP response headers are in. Starts phase accounting. */
  opened(response: Response): void
  /** The `syncMeta` line decoded. Carries the server's own transfer id. */
  noteMeta(transferId: string | undefined, totalRows: number | undefined): void
  /** One data record decoded, carrying `rows` rows. Never logs per row. */
  noteData(rows: number): void
  /** Cross into the named phase, closing the one in progress. */
  enter(phase: SyncTransferPhase): void
  /** Terminal line. Idempotent — the first outcome to arrive is the one that ran. */
  finish(outcome: string, reason?: string): void
}

export interface SyncTransferTelemetryOptions {
  progressRecords?: number
  progressMs?: number
  logger?: Logger
  now?: () => number
}

export interface SyncTransferTelemetry {
  /** Open one attempt. `headers` is what the client itself set, not what the platform adds. */
  begin(mode: SyncTransferMode, url: string, headers?: HeadersInit): SyncTransferAttempt
  /**
   * The Replica's own lifecycle, from the composition root's `onEvent`.
   *
   * Two things come in through here and nowhere else: the CAUSE of the walk that
   * is about to open a request, and the COMMIT that happens after its stream has
   * already ended.
   */
  noteReplicaEvent(event: ReplicaEvent): void
}

/** `Accept-Encoding` is the platform's on web and on RN; report what WE set, honestly. */
function acceptEncodingOf(headers: HeadersInit | undefined): string {
  if (!headers) return 'platform-default'
  const entries: Array<[string, string]> = Array.isArray(headers)
    ? headers.map(([name, value]) => [name ?? '', value ?? ''])
    : headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers as Record<string, string>)
  for (const [name, value] of entries) {
    if (name.toLowerCase() === 'accept-encoding') return value
  }
  return 'platform-default'
}

class TransferAttempt implements SyncTransferAttempt {
  readonly meter: SyncReadMeter
  transferId: string | null = null
  readonly startedAt: number

  private phase: SyncTransferPhase = 'pipeline'
  private phaseAt = 0
  /** Off until the response opens, so TTFB never lands in `pipelineMs`. */
  private accounting = false
  private pipelineMs = 0
  private stageMs = 0
  private downloadMs = 0
  private readAt = 0
  private reads = 0
  private bytes = 0
  private records = 0
  private rows = 0
  private totalRows: number | undefined
  private ttfbMs: number | null = null
  private metaMs: number | null = null
  private firstRecordMs: number | null = null
  private lastProgressAt: number
  private lastProgressRecords = 0
  private done = false

  constructor(
    private readonly log: Logger,
    private readonly now: () => number,
    private readonly progressRecords: number,
    private readonly progressMs: number,
    readonly mode: SyncTransferMode,
    private readonly attemptId: string,
  ) {
    this.startedAt = now()
    this.lastProgressAt = this.startedAt
    this.meter = {
      beginRead: () => {
        this.readAt = this.now()
      },
      endRead: (bytes) => {
        const at = this.now()
        this.downloadMs += at - this.readAt
        this.reads += 1
        this.bytes += bytes
        // A read boundary is a free progress check: `at` is already sampled.
        this.maybeProgress(at)
      },
    }
  }

  /** Every line joins on this. `transferId` is null only before the response opens. */
  private base(): Record<string, unknown> {
    return { attemptId: this.attemptId, transferId: this.transferId, mode: this.mode }
  }

  private elapsed(at = this.now()): number {
    return round(at - this.startedAt)
  }

  enter(phase: SyncTransferPhase): void {
    if (!this.accounting) return
    const at = this.now()
    if (this.phase === 'pipeline') this.pipelineMs += at - this.phaseAt
    else this.stageMs += at - this.phaseAt
    this.phase = phase
    this.phaseAt = at
  }

  opened(response: Response): void {
    this.transferId = response.headers.get('podium-transfer-id')
    const at = this.now()
    this.ttfbMs = at - this.startedAt
    this.accounting = true
    this.phase = 'pipeline'
    this.phaseAt = at
    this.log.debug('sync transfer opened', {
      ...this.base(),
      status: response.status,
      contentEncoding: response.headers.get('content-encoding') ?? 'identity',
      contentLength: response.headers.get('content-length'),
      // A buffered body is a real possibility on RN, and it changes what every
      // number below means: `downloadMs` for a buffered body is one read of the
      // whole payload, so the download/decode split stops separating anything.
      streaming: typeof response.body?.getReader === 'function',
      ttfbMs: round(this.ttfbMs),
    })
  }

  noteMeta(transferId: string | undefined, totalRows: number | undefined): void {
    // The header is authoritative; this is the fallback for a transport that
    // strips response headers, and a cross-check when both are present.
    if (transferId && this.transferId === null) this.transferId = transferId
    this.totalRows = totalRows
    this.metaMs ??= this.elapsed()
  }

  noteData(rows: number): void {
    this.records += 1
    this.rows += rows
    if (this.firstRecordMs === null) {
      const at = this.now()
      this.firstRecordMs = round(at - this.startedAt)
      // The line the issue asked for: everything before it is open+network,
      // everything after it is throughput.
      this.log.debug('sync transfer first record', {
        ...this.base(),
        firstRecordMs: this.firstRecordMs,
        metaMs: this.metaMs,
        ttfbMs: this.ttfbMs === null ? null : round(this.ttfbMs),
        rows,
      })
      this.lastProgressAt = at
      this.lastProgressRecords = this.records
      return
    }
    this.maybeProgress(this.now())
  }

  private maybeProgress(at: number): void {
    if (this.done || this.firstRecordMs === null) return
    if (
      this.records - this.lastProgressRecords < this.progressRecords &&
      at - this.lastProgressAt < this.progressMs
    ) return
    this.lastProgressAt = at
    this.lastProgressRecords = this.records
    this.log.debug('sync transfer progress', { ...this.base(), ...this.counters(at) })
  }

  private counters(at: number): Record<string, unknown> {
    // `decodeMs` is the pull interval minus the reads inside it. Reported next to
    // both of its terms so a reader can check the subtraction rather than trust it.
    const pipelineMs = this.pipelineMs + (this.accounting && this.phase === 'pipeline' ? at - this.phaseAt : 0)
    const stageMs = this.stageMs + (this.accounting && this.phase === 'consumer' ? at - this.phaseAt : 0)
    return {
      elapsedMs: this.elapsed(at),
      records: this.records,
      rows: this.rows,
      totalRows: this.totalRows ?? null,
      // Bytes off `reader.read()`, which is AFTER the platform undid the
      // Content-Encoding — so this is directly comparable to the server line's
      // `bytesIn` (51.7 MB in the motivating sample), never to its `bytesOut`.
      decodedBytes: this.bytes,
      reads: this.reads,
      downloadMs: round(this.downloadMs),
      decodeMs: round(Math.max(0, pipelineMs - this.downloadMs)),
      stageMs: round(stageMs),
    }
  }

  finish(outcome: string, reason?: string): void {
    if (this.done) return
    this.done = true
    const at = this.now()
    const counters = this.counters(at)
    this.log.debug('sync transfer finished', {
      ...this.base(),
      outcome,
      reason: reason ?? null,
      ...counters,
      // The same number as `elapsedMs`, under the name the terminal line is
      // read by and the name the server's own line uses. A reader joining the
      // two halves should not have to know which side called it which.
      totalMs: counters.elapsedMs,
      ttfbMs: this.ttfbMs === null ? null : round(this.ttfbMs),
      firstRecordMs: this.firstRecordMs,
    })
  }
}

export function createSyncTransferTelemetry(
  options: SyncTransferTelemetryOptions = {},
): SyncTransferTelemetry {
  const log = options.logger ?? createLogger('client-core:sync-transfer')
  const now = options.now ?? wallClock
  const progressRecords = options.progressRecords ?? DEFAULT_PROGRESS_RECORDS
  const progressMs = options.progressMs ?? DEFAULT_PROGRESS_MS
  // Per mode, so a bootstrap id and a delta id never collide in a joined log.
  const counters = { bootstrap: 0, delta: 0 }
  /**
   * The cause the Replica emitted for the walk that has not opened its request
   * yet. Kept per mode because rung 1 ('gap') leads to `changesRange` and every
   * other rung leads to `bootstrap`; one slot would have handed a bootstrap the
   * cause of the heal that preceded it.
   */
  const pending: { bootstrap: string | null; delta: string | null } = { bootstrap: null, delta: null }
  /** The bootstrap whose install is still outstanding; its stream has already ended. */
  let installing: { attemptId: string; transferId: string | null; startedAt: number; endedAt: number } | null = null

  return {
    begin(mode, url, headers) {
      counters[mode] += 1
      const attemptId = `${mode === 'bootstrap' ? 'b' : 'd'}${counters[mode]}`
      const cause = pending[mode]
      pending[mode] = null
      const attempt = new TransferAttempt(log, now, progressRecords, progressMs, mode, attemptId)
      log.debug('sync transfer started', {
        attemptId,
        transferId: null,
        mode,
        url,
        acceptEncoding: acceptEncodingOf(headers),
        // The Replica's own word for why, or null when this source was driven by
        // something that is not a Replica walk (a test, a legacy caller).
        cause,
        // 'cold-start' is the Replica's cause for "no persisted cursor", which is
        // exactly first boot. Every other cause is a re-bootstrap over a store
        // that already had one.
        coldStart: mode === 'bootstrap' ? cause === 'cold-start' : null,
        attempt: counters[mode],
      })
      if (mode === 'bootstrap') {
        installing = null
      }
      return {
        meter: attempt.meter,
        opened: (response) => attempt.opened(response),
        noteMeta: (transferId, totalRows) => attempt.noteMeta(transferId, totalRows),
        noteData: (rows) => attempt.noteData(rows),
        enter: (phase) => attempt.enter(phase),
        finish: (outcome, reason) => {
          attempt.finish(outcome, reason)
          // Only a stream that reached its end can be followed by an install.
          if (mode === 'bootstrap' && outcome === 'complete') {
            installing = {
              attemptId,
              transferId: attempt.transferId,
              startedAt: attempt.startedAt,
              endedAt: now(),
            }
          }
        },
      }
    },
    noteReplicaEvent(event) {
      if (event.type === 'heal') {
        // Emitted synchronously in `startRebootstrap`/`startHeal`, BEFORE the walk
        // is queued — so the request this describes has not opened yet.
        if (event.cause === 'gap') pending.delta = event.cause
        else pending.bootstrap = event.cause
        return
      }
      if (event.type === 'bootstrap-installed') {
        const open = installing
        installing = null
        const at = now()
        log.debug('sync bootstrap installed', {
          attemptId: open?.attemptId ?? null,
          transferId: open?.transferId ?? null,
          mode: 'bootstrap',
          cause: event.cause,
          snapshotSeq: event.snapshotSeq,
          entityCount: event.entityCount,
          bufferedFramesApplied: event.bufferedFramesApplied,
          // The store write, which the source cannot see: it happens after the
          // last chunk has been handed over and the stream has already ended.
          commitMs: open ? round(at - open.endedAt) : null,
          // Start of the request to a renderable store — the number a user feels.
          totalMs: open ? round(at - open.startedAt) : null,
        })
        return
      }
      if (event.type === 'bootstrap-failed') {
        const open = installing
        installing = null
        log.debug('sync bootstrap failed', {
          attemptId: open?.attemptId ?? null,
          transferId: open?.transferId ?? null,
          mode: 'bootstrap',
          cause: event.cause,
          attempts: event.attempts,
          error: event.error,
          totalMs: open ? round(now() - open.startedAt) : null,
        })
      }
    },
  }
}
