/**
 * FLEET DAEMON LOG CAPTURE — the two daemon-plane frames that give an operator
 * on the coordinating server the same reach into a remote DAEMON that
 * `setLogLevel` already gives them into a running browser, desktop or mobile
 * CLIENT (POD-3156, under [spec:2026-08-11-logging-strategy-design]).
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE NOT IN `./logs.ts`
 * ---------------------------------------------------------------------------
 * `./logs.ts` is in the common barrel, so its schemas are in every browser
 * bundle that imports `@podium/protocol`. These two are daemon-plane only and
 * are exported from `@podium/protocol/daemon`, for exactly the reason that
 * barrel exists: a browser has no daemon socket and must not carry its schemas.
 * The shape is deliberately the same as the client family's next door, because
 * an operator should be reading one vocabulary, not two.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT IS DIFFERENT, AND IT IS THE IMPORTANT ONE
 * ---------------------------------------------------------------------------
 * A client SAYS who it is: `logs.forward` carries a `logOrigin` in its payload,
 * and the server files the records under that self-description because there is
 * nothing better available on a `/client` socket.
 *
 * A daemon does not, and MUST NOT. There is no machine field on
 * {@link DaemonLogBatchMessage} and there must never be one: the daemon socket
 * is authenticated per machine, the mux resolves a `MachinePrincipal` from the
 * TRANSPORT (never from a frame body — see `gateway/daemon-mux.ts`), and that
 * principal is what names the file the records land in. A `machineId` on this
 * frame would be a payload-supplied identity for records the server is about to
 * file by identity, which is the shape D17 refuses. The version the records were
 * written by IS on the frame, because a build is a property of the batch rather
 * than of the connection and a daemon may update under a live socket.
 *
 * ---------------------------------------------------------------------------
 * DROPS ARE ON THE WIRE, NOT INFERRED FROM A GAP
 * ---------------------------------------------------------------------------
 * The daemon's queue is bounded and drops oldest when the link is down or the
 * daemon is louder than the socket. `dropped` reports how many records were lost
 * since the last batch that carried one, so the central file can say so in-band.
 * Without it a reader cannot tell "this daemon went quiet" from "this daemon's
 * queue overflowed", and those are opposite diagnoses.
 */

import { z } from 'zod'
import { ClientLogLevel, MAX_LOG_LEVEL_TTL_MS } from './logs'

/** Longest single text field accepted, matching the client family's `MAX_TEXT`. */
const MAX_TEXT = 8192

/** A serialized error, as `@podium/logger`'s record shape carries it. */
export const DaemonLogError = z.object({
  name: z.string().max(256),
  message: z.string().max(MAX_TEXT),
  stack: z
    .string()
    .max(MAX_TEXT * 4)
    .optional(),
})
export type DaemonLogError = z.infer<typeof DaemonLogError>

/**
 * ONE DAEMON LOG RECORD, in the logger's own NDJSON shape.
 *
 * `.catchall` for the reason `forwardedLogRecord` is one: the free-form fields
 * a call site bound (`sessionId`, `durationMs`, a machine's own `role`) are the
 * context that makes a record worth having, and a closed object would drop
 * precisely them. The whole-batch cap below is what bounds them.
 */
export const DaemonLogRecord = z
  .object({
    ts: z.string().min(1).max(64),
    level: ClientLogLevel,
    ns: z.string().min(1).max(256),
    msg: z.string().max(MAX_TEXT),
    err: DaemonLogError.optional(),
  })
  .catchall(z.unknown())
export type DaemonLogRecord = z.infer<typeof DaemonLogRecord>

/**
 * The batch cap, matching `MAX_FORWARDED_RECORDS`. The daemon flushes at 50, so
 * this is ten flushes of headroom for one draining a backlog after a reconnect
 * and still a bound on a single frame.
 */
export const MAX_DAEMON_LOG_RECORDS = 500

/**
 * daemon -> server: a batch of this daemon's own records.
 *
 * WHICH MACHINE IS NOT HERE. See the header — it comes from the authenticated
 * transport, and adding it to this frame would be the bug.
 */
export const DaemonLogBatchMessage = z.object({
  type: z.literal('daemonLogBatch'),
  records: z.array(DaemonLogRecord).min(1).max(MAX_DAEMON_LOG_RECORDS),
  /** Records lost to the bounded queue since the last batch that reported some.
   *  Absent means none — see the header on why this is in-band. */
  dropped: z.number().int().nonnegative().optional(),
  /** The build that wrote these records. On the BATCH rather than taken from the
   *  connection, because a daemon can self-update under a live socket and the
   *  records either side of that are from two different programs. */
  v: z.string().max(64).optional(),
})
export type DaemonLogBatchMessage = z.infer<typeof DaemonLogBatchMessage>

/**
 * server -> one daemon: run at this level for this long, and forward what you
 * emit.
 *
 * SAME ONE-KNOB RULE as `setLogLevel` next door: `level` is the daemon's whole
 * verbosity, the forwarding sink pins no threshold of its own, and there is
 * deliberately no second field for the forwarding side. Two controls that can
 * disagree about what a daemon is currently reporting is the failure the client
 * design already refuses, and a daemon is the worse place to have it — nobody
 * reloads a daemon to find out.
 *
 * THE TTL MATTERS MORE HERE THAN IT DOES FOR A CLIENT. A browser tab at `debug`
 * is put back by the next page load; a daemon runs for weeks. So the expiry is
 * not a safety net behind three other ways back — it IS the way back, and
 * `level: null` is the only other one. `ttlMs` is a DURATION rather than a
 * deadline for the client family's reason: a remote host's clock is not this
 * server's, and a skewed `expiresAt` either never applies or never lifts.
 */
export const SetDaemonLogLevelMessage = z.object({
  type: z.literal('setDaemonLogLevel'),
  /** `null` restores the daemon's boot default and stops forwarding. */
  level: ClientLogLevel.nullable(),
  /** How long the raise lasts, from arrival. Absent takes the daemon's own
   *  default, because the daemon is the thing holding the timer. Ignored when
   *  `level` is `null`. */
  ttlMs: z.number().int().positive().max(MAX_LOG_LEVEL_TTL_MS).optional(),
})
export type SetDaemonLogLevelMessage = z.infer<typeof SetDaemonLogLevelMessage>
