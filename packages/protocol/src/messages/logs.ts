/**
 * THE OPERATOR'S REACH INTO A RUNNING CLIENT — `setLogLevel`
 * (chunk 7 of [spec:2026-08-11-logging-strategy-design]).
 *
 * The whole forwarding design exists to serve one scenario: a problem on one
 * user's machine, diagnosed without shipping them a new build. Everything up to
 * here builds the pipe — the logger, the three client sinks, ingestion, the
 * per-origin files. This is the valve. Without it the pipe carries `warn` and
 * above forever and nobody can ask for more.
 *
 * ---------------------------------------------------------------------------
 * ONE KNOB, AND THIS MESSAGE CARRIES EXACTLY ONE
 * ---------------------------------------------------------------------------
 * `level` is the client's whole verbosity, not a forwarding threshold. On the
 * client it lands in `setLogLevel`, and the forwarding sink pins no `minLevel`
 * of its own, so console and forwarded stream move together — the spec's
 * "raising a client to `debug` forwards `debug` too" is one control rather than
 * two that can silently disagree about what a client is currently reporting.
 * There is deliberately no second field here for the forwarding side; adding one
 * is how that property would be lost.
 *
 * ---------------------------------------------------------------------------
 * A WAY BACK IS PART OF THE MESSAGE, NOT AN OPERATOR'S GOOD INTENTIONS
 * ---------------------------------------------------------------------------
 * A client left at `debug` forever is a bug: it forwards a firehose from a
 * user's machine that nobody asked for and nobody is reading. So the raise
 * EXPIRES. `ttlMs` is a DURATION rather than a deadline on purpose — a client's
 * clock is not the server's, and an `expiresAt` in the past (or a year out) from
 * a skewed clock would either never apply or never lift.
 *
 * The explicit way back is `level: null`, which restores the client's boot
 * default rather than naming a level: the operator does not have to know what
 * this build boots at, and a future default change cannot leave a `warn` written
 * into somebody's support instructions.
 */

import { MachineIdField } from '@podium/model'
import { z } from 'zod'

/**
 * How a client describes ITSELF on the wire, so an operator can address it.
 *
 * Deliberately the same three fields the ingestion contract's `logOrigin`
 * carries, and named the same, because they are what the server files forwarded
 * records under: the operator reading
 * `~/.podium/logs/clients/<role>-<machine>.ndjson` sees exactly this tuple, and
 * an addressing scheme that did not match it would make them translate between
 * two vocabularies for one client.
 *
 * A restatement rather than an import: `@podium/commands` depends on
 * `@podium/protocol`, so the shape cannot travel the other way. Bounds are
 * restated with it — an unbounded string on a socket frame is a socket frame
 * that can be made arbitrarily large.
 */
export const ClientLogOrigin = z.object({
  /** `web` | `desktop` | `mobile` | whatever a future runtime calls itself. */
  role: z.string().min(1).max(64),
  /** The client's app version, so a raise can be read against a build. */
  v: z.string().max(64).optional(),
  machineId: z.string().max(128).pipe(MachineIdField).optional(),
})
export type ClientLogOrigin = z.infer<typeof ClientLogOrigin>

/** The five levels, restated for the same reason `ClientLogOrigin` is. */
export const ClientLogLevel = z.enum(['error', 'warn', 'info', 'debug', 'trace'])
export type ClientLogLevel = z.infer<typeof ClientLogLevel>

/**
 * The longest a raise may last: 24 hours.
 *
 * Not a policy about what an operator wants — it is the bound that makes "there
 * is always a way back" true even if every other one fails. An operator who
 * needs longer re-issues the command, which is a smaller cost than a phone
 * quietly forwarding `trace` for a fortnight.
 */
export const MAX_LOG_LEVEL_TTL_MS = 24 * 60 * 60 * 1000

/** Server -> one client: run at this level for this long. */
export const SetLogLevelMessage = z.object({
  type: z.literal('setLogLevel'),
  /** `null` restores the client's boot default — see the header. */
  level: ClientLogLevel.nullable(),
  /**
   * How long the raise lasts, from arrival. Absent means "until the client's
   * default TTL runs out"; the client, not the wire, owns that default, because
   * it is the thing holding the timer. Ignored when `level` is `null`.
   */
  ttlMs: z.number().int().positive().max(MAX_LOG_LEVEL_TTL_MS).optional(),
})
export type SetLogLevelMessage = z.infer<typeof SetLogLevelMessage>
