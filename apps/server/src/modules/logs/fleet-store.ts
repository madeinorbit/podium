/**
 * FLEET DAEMON LOG INGESTION — where a remote daemon's records land (POD-3156,
 * chunk of [spec:2026-08-11-logging-strategy-design]).
 *
 * They arrive CONTINUOUSLY at `warn`+ since POD-3184, not only while an operator
 * holds a raise open. The disk budget below is the half of this file that
 * changed with them.
 *
 * ---------------------------------------------------------------------------
 * A SEPARATE STORE FROM `logs/clients`, AND HERE IS WHY
 * ---------------------------------------------------------------------------
 * The obvious move is to reuse {@link LogIngestService}: same file sink, same
 * rotation, same per-origin split, one fewer directory. It was rejected for
 * three reasons, in ascending order of how much they matter.
 *
 *  1. THE BUDGET IS SHARED AND WOULD BE SPENT BY THE WRONG SPENDER. That
 *     service opens at most `MAX_ORIGIN_FILES` (64) files and folds everything
 *     after that into `other.ndjson`. A fleet of machines and a household of
 *     browsers would compete for one allowance, and the loser — silently — is
 *     whichever arrived second. Two stores means a machine can never evict a
 *     browser origin, and the daemon budget can be tuned for a fleet without
 *     changing what a phone gets.
 *
 *  2. THE VOLUME PROFILE IS NOT THE SAME. A browser tab logs while somebody is
 *     looking at it. A daemon logs for weeks. Sharing a rotation policy means
 *     one of the two is wrong, and the disk budget below is the knob that says
 *     which — separately, and out loud. POD-3184 is where that stopped being
 *     hypothetical: a daemon forwards `warn`+ continuously now, so this store's
 *     rotation is set here rather than inherited.
 *
 *  3. THE ATTRIBUTION IS NOT THE SAME, and this is the reason that decides it.
 *     A client's `origin` is a SELF-DESCRIPTION off the wire; the server files
 *     `web-<whatever the client said>` because a `/client` socket offers nothing
 *     better. A daemon's machine comes from the AUTHENTICATED TRANSPORT and
 *     cannot be spoofed by a payload. Those are two different evidentiary
 *     grades, and a reader who found both under one directory would have no way
 *     to tell which one they were holding. Keeping them apart makes the
 *     directory name carry the claim: `logs/clients/…` is what something said
 *     about itself, `logs/fleet/…` is which machine the server authenticated.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SHARED ANYWAY
 * ---------------------------------------------------------------------------
 * The MECHANISM, all of it. `createFileSink` and its 10 MB × 5 rotation live in
 * `@podium/logger/node`; the queue, the slice, the drop-oldest bound and the
 * close-time drain live in `QueuedRecordWriter` beside this file and are shared
 * with client ingestion (POD-3167). What is NOT shared is the half above — the
 * directory, the budget, and which name a record is filed under — which is the
 * part that had to differ, and which this store states as policy in one place.
 *
 * NOTHING HERE THROWS. Same rule as the client ingestion service: this is the
 * logging layer, and a full disk must not turn a daemon's diagnostic batch into
 * a dropped socket. Failures degrade to one server-side line and a truthful
 * count in the result.
 *
 * ---------------------------------------------------------------------------
 * THE WRITES ARE DEFERRED AND SLICED, AND SO ARE THE CLIENT STORE'S
 * ---------------------------------------------------------------------------
 * This store is reached from the DAEMON SOCKET'S MESSAGE CALLBACK, which is the
 * same event loop that serves every request in the process. A batch written
 * there puts its whole cost — up to 50 synchronous appends plus, occasionally, a
 * rotation — in front of whatever arrives next. So `append` only TAGS and
 * QUEUES, and the writes happen in bounded slices between event-loop turns.
 *
 * That machinery is no longer this file's. It lives in `QueuedRecordWriter`
 * (POD-3167), which the client ingestion service uses too — the same slicing,
 * the same drop-oldest bound, the same close-time tail. What is left here is the
 * part that had to differ and is stated as policy below: the directory, the file
 * budget, the queue budget, and the tagging that files a record under the
 * machine the SERVER authenticated.
 *
 * The queue is bounded, so it can drop — and a drop HERE is a different fact
 * from a drop at the daemon, so it is counted separately and reported
 * separately.
 */

import { join } from 'node:path'
import type { LogRecord } from '@podium/logger'
import type { FileSink } from '@podium/logger/node'
import type { MachineId } from '@podium/model'
import type { DaemonLogBatchMessage } from '@podium/protocol/daemon'
import { logDir } from '@podium/runtime/run-registry'
import { QueuedRecordWriter } from './queued-writer'

/**
 * How many machines get their own file before the rest share one.
 *
 * SAY THE WORST CASE OUT LOUD, as the client store does: at the rotation below,
 * 32 machines is 32 × 20 MB = 640 MB before anything is discarded.
 */
export const MAX_FLEET_FILES = 32

/**
 * THE DISK BUDGET, RE-SIZED FOR A STEADY STREAM (POD-3184).
 *
 * It used to be the inherited 10 MB × 5 = 50 MB per machine, and the reason it
 * could be that large was written down next to it: forwarding was OFF until an
 * operator raised a machine, a raise expires, and a normal install spent nothing
 * here at all. That sentence is no longer true. A daemon now ships `warn`+
 * continuously, so whatever this budget is, a fleet occupies it eventually
 * rather than only during an incident.
 *
 * THE NUMBER THIS HAS TO SERVE IS NOT THE STEADY STATE. Continuous `warn`+ is
 * kilobytes a day from a healthy daemon — the threshold is what makes the
 * default affordable, and no plausible rotation budget is the binding constraint
 * on it. What actually fills these files is the two loud cases: a raise at
 * `debug`/`trace`, and a daemon stuck in a warning loop. So the budget is sized
 * to hold a raise, and then bounded because it is now permanent.
 *
 * 10 MiB × 2 = 20 MiB per machine. The FILE size is unchanged, so a raised
 * window still lands contiguously and an operator reading `<machine>.ndjson`
 * sees the same span they did before; what came off is the ARCHIVE depth, which
 * was retention of old incidents and is the part a continuously-forwarding fleet
 * cannot be given for free. 640 MB is the ceiling of 32 machines all pathological
 * at once, against 1.6 GB before.
 *
 * A user who wants deeper fleet history has the daemon's own journal on each
 * machine, which this store never replaced — it adds a central copy, and removes
 * nothing.
 */
export const FLEET_ROTATE_BYTES = 10 * 1024 * 1024
export const FLEET_ROTATE_FILES = 2

export interface FleetLogStoreDeps {
  /** Defaults to `<stateDir>/logs/fleet`. */
  dir?: string
  /** Injected by tests. Production uses the rotating file sink. */
  createSink?: (path: string) => FileSink
  maxMachineFiles?: number
}

/** One record as the wire delivered it — the schema's own inferred shape, so a
 *  change to `DaemonLogRecord` reaches this file as a type error. */
export type DaemonLogRecordWire = DaemonLogBatchMessage['records'][number]

export interface FleetIngestResult {
  /** Records ACCEPTED for writing. Not "written": the writes are deferred off
   *  the socket callback, so this is a queue admission and the only way to be
   *  short of the batch is a store that is already closed. */
  accepted: number
  /** The file they were filed under, so an operator can be told where to look. */
  file: string
  /** Drops the DAEMON reported in this batch — see {@link FleetLogStore.append}.
   *  A SENDER-side loss: a lossy link, its own bounded queue. */
  dropped: number
  /** Drops THIS SERVER made for this machine since boot, under its own
   *  backpressure. Reported apart from {@link dropped} because a lossy link and
   *  a saturated server are different problems with different fixes, and one
   *  number would answer neither. */
  serverDropped: number
}

/**
 * `mach_abc123` → `mach_abc123`; anything exotic → underscores.
 *
 * A MachineId is minted, not typed, so this is belt and braces rather than the
 * load-bearing check the client store's `originKey` is — but it is the same
 * shape of problem (a filename built from an id) and gets the same allowlist,
 * because "it cannot contain a slash today" is a property of a generator that
 * could change and not of this code.
 */
export function machineFileKey(machineId: string): string {
  const safe = machineId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 48)
  return safe.length > 0 ? safe : 'unknown'
}

/**
 * One forwarded record, re-tagged with what the SERVER knows.
 *
 * `machineId` IS OVERWRITTEN, always. It is the field these records are FILED
 * by, and the server's answer is the authenticated one — so a record that
 * arrived claiming another machine is corrected on the way to disk rather than
 * filed under a lie.
 *
 * `role` IS NOT, and the difference is deliberate. It is descriptive rather than
 * load-bearing (nothing routes, files or authorizes on it), and the record
 * already carries the truthful one from its own process context — which on an
 * all-in-one install is `all-in-one`, not `daemon`, because there the daemon
 * shares a process with the server and the forwarded stream legitimately
 * includes both. Stamping `daemon` over that would make the one field that says
 * WHICH PROGRAM wrote a line report the same answer for two of them. `daemon` is
 * the fallback for a record that carries no role at all.
 *
 * `v` is taken from the BATCH when it carried one — a daemon can self-update
 * under a live socket, and the batch is the finest grain at which that is
 * knowable.
 */
export function taggedDaemonRecord(
  record: DaemonLogRecordWire,
  machineId: MachineId,
  version?: string,
): LogRecord {
  return {
    ...record,
    role: typeof record.role === 'string' && record.role.length > 0 ? record.role : 'daemon',
    machineId,
    ...(version !== undefined ? { v: version } : {}),
  } as LogRecord
}

/**
 * Records held across all machines before drop-oldest begins.
 *
 * Ten batches at the wire's cap. A server can be slow at disk or busy at
 * everything, and the answer to either has to be a bound rather than a heap that
 * grows until something else fails — the same reasoning as the daemon's own
 * queue, at the other end of the same pipe.
 *
 * UNCHANGED BY POD-3184, and that is a finding rather than an omission. This
 * bounds a BURST against a slow disk, not a total: continuous `warn`+ arrives at
 * a rate a drain of 16 records per event-loop turn does not notice, and the
 * burst this was sized against — a reconnecting daemon draining its backlog in
 * 500-record frames — is the same burst it was before.
 */
const MAX_PENDING_RECORDS = 5000

export class FleetLogStore {
  /**
   * THE SHARED PRIMITIVE, configured with this store's policy. Everything about
   * WHEN and HOW MUCH gets written lives there; everything about WHERE and under
   * WHOSE NAME lives here.
   */
  private readonly writer: QueuedRecordWriter
  /** Drops the DAEMON reported, per machine, since boot. Kept here rather than
   *  in the writer because they are the SENDER's losses: the writer counts only
   *  what this server itself dropped, and the two must not be confusable. */
  private readonly daemonDropped = new Map<string, number>()

  constructor(deps: FleetLogStoreDeps = {}) {
    this.writer = new QueuedRecordWriter({
      dir: deps.dir ?? join(logDir(), 'fleet'),
      kind: 'fleet',
      maxFiles: deps.maxMachineFiles ?? MAX_FLEET_FILES,
      maxPending: MAX_PENDING_RECORDS,
      rotateBytes: FLEET_ROTATE_BYTES,
      rotateFiles: FLEET_ROTATE_FILES,
      ...(deps.createSink ? { createSink: deps.createSink } : {}),
    })
  }

  /**
   * Accept one authenticated daemon's batch.
   *
   * NOTHING IS WRITTEN HERE, and that is the point. This runs in the daemon
   * socket's message callback, on the same event loop that is serving every
   * request in the process; a batch that wrote its 50 records inline would put
   * the whole of that work — rotation included — in front of whatever request
   * arrived next. The records are tagged and queued, and the writes happen in
   * bounded slices between event-loop turns.
   *
   * THE DAEMON'S DROP COUNT IS WRITTEN INTO THE FILE, not just counted in
   * memory. A gap in a log is ambiguous — a quiet daemon and an overflowing
   * queue look identical — and the whole point of the daemon reporting its own
   * drops is to end that ambiguity for the person reading the file, who is not
   * holding this process's counters.
   */
  append(
    machineId: MachineId,
    batch: { records: readonly DaemonLogRecordWire[]; dropped?: number; v?: string },
  ): FleetIngestResult {
    const key = machineFileKey(machineId)
    const name = this.writer.assign(key)
    const file = `logs/fleet/${name}.ndjson`
    const dropped = batch.dropped ?? 0
    if (dropped > 0) this.daemonDropped.set(key, (this.daemonDropped.get(key) ?? 0) + dropped)
    if (this.writer.closed) {
      return { accepted: 0, file, dropped, serverDropped: this.writer.droppedFor(key) }
    }
    if (dropped > 0) {
      this.writer.enqueue(
        key,
        taggedDaemonRecord(
          {
            ts: new Date().toISOString(),
            level: 'warn',
            ns: 'server:logs',
            msg: 'daemon dropped records before this batch',
            dropped,
          },
          machineId,
          batch.v,
        ),
      )
    }
    let accepted = 0
    for (const record of batch.records) {
      this.writer.enqueue(key, taggedDaemonRecord(record, machineId, batch.v))
      accepted += 1
    }
    return { accepted, file, dropped, serverDropped: this.writer.droppedFor(key) }
  }

  /** Records waiting to be written. Zero once the drain has caught up. */
  pendingWrites(): number {
    return this.writer.pendingWrites()
  }

  /** Drops the DAEMON reported for this machine since the server booted. */
  droppedFor(machineId: MachineId): number {
    return this.daemonDropped.get(machineFileKey(machineId)) ?? 0
  }

  /** Drops THIS SERVER made under its own backpressure, for this machine. */
  serverDroppedFor(machineId: MachineId): number {
    return this.writer.droppedFor(machineFileKey(machineId))
  }

  /** Drain what is queued — unsliced, there is no request left to protect — and
   *  release the per-machine file descriptors. */
  async close(): Promise<void> {
    await this.writer.close()
  }
}
