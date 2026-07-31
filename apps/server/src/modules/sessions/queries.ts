/**
 * THE SESSION-FAMILY READS (POD-314) — the queries that sat beside POD-382's
 * derived writes in `router.ts`, moved into the module that owns the service.
 *
 * FOUR ROUTERS, because the wire groups them that way: `sessions` (the reads),
 * `sync` (metadata-oplog catch-up), and the three per-user lists `pins`,
 * `snoozes` and `tabs`.
 *
 * NOT CONTRACTS. A `visibility` class describes what a command WRITES and these
 * write nothing — the same line POD-382 drew when it left them hand-written, and
 * `scripts/audit-session-commands.ts` checks procedure TYPE so a write cannot
 * rejoin them by being spelled as a query. What changes here is only WHERE they
 * are declared.
 *
 * THE THREE PER-USER LISTS READ `state.caller.userId`, which POD-380 established
 * is the whole point of them: the list is the CALLER's pins, not the instance's.
 * The bundle carries a two-field identity — a user id and an actor session id —
 * and NOT the capability, so these can name whose rows they want without being
 * able to decide whether they may have them.
 */

import { SessionIdField } from '@podium/model'
import { z } from 'zod'
import { defineQuery } from '../query-table'
import type { FamilyState } from '../derived-family'

const q = defineQuery<FamilyState>()

export const SESSION_QUERIES = {
  list: q(z.object({}).passthrough().optional(), (s) => s.modules.sessions.listSessions()),
  /** On-demand transcript window for the chat view — a pure disk read via the
   *  daemon (disk = source of truth). `anchor` is a cursor; `direction` reads the
   *  `limit` items before (older) or after (newer) it. No anchor = the latest
   *  window. Serves both initial load and scroll-to-top paging, for live AND
   *  parked sessions alike — independent of the server's recent-delta cache. */
  transcriptRead: q(
    z.object({
      sessionId: SessionIdField,
      anchor: z.string().optional(),
      direction: z.enum(['before', 'after']),
      limit: z.number().int().positive().max(2000),
    }),
    (s, input) => s.modules.rpc.readTranscript(input),
  ),
  /** Read toolkit tiers 1–2 (#237) [spec:SP-34d7]: structured status (phase,
   *  issue stage/todos, last commits, files touched, unacked count — NO
   *  transcript text). The /trpc surface is operator-authority; agents reach the
   *  same procs via the daemon relay's scope-gated sessions arm. Every read is
   *  event-logged by the toolkit. */
  status: q(z.object({ ref: z.string() }), (s, input) =>
    s.modules.readToolkit.status(input.ref, s.caller.actorSessionId ?? 'operator'),
  ),
  read: q(
    z.object({
      sessionId: SessionIdField,
      turns: z.coerce.number().int().positive().optional(),
      cursor: z.string().optional(),
    }),
    (s, input) => s.modules.readToolkit.read(input, s.caller.actorSessionId ?? 'operator'),
  ),
  /** Read toolkit tier 3 (#237) [spec:SP-34d7 read-toolkit]: server-side recap
   *  since a watermark — repeated check-ins pay only for the delta (the watermark
   *  persists per (reader, target)). */
  recap: q(
    z.object({ sessionId: SessionIdField, since: z.string().optional() }),
    (s, input) => s.modules.readToolkit.recap(input, s.caller.actorSessionId ?? 'operator'),
  ),
} as const

export const SYNC_QUERIES = {
  /** Metadata-oplog catch-up (docs/spec/oplog-read-path.md): null cursor =
   *  bootstrap snapshot; a valid cursor = the changes after it; a
   *  compacted/future cursor falls back to snapshot. The client heals every WS
   *  (re)connect through this. */
  changesSince: q(
    z.object({ cursor: z.number().int().nonnegative().nullable() }),
    (s, input) => s.modules.sessions.syncChangesSince(input.cursor, s.publicationAuthority),
  ),
} as const

const noInput = z.object({}).passthrough().optional()

/** PER-USER STATE (POD-380): each list is the CALLER's, not the instance's. */
export const PIN_QUERIES = {
  list: q(noInput, (s) => s.store.sessions.listPins(s.caller.userId)),
} as const

export const SNOOZE_QUERIES = {
  list: q(noInput, (s) => s.store.sessions.listSnoozes(s.caller.userId)),
} as const

export const TAB_QUERIES = {
  listOrders: q(noInput, (s) => s.store.sessions.listTabOrders(s.caller.userId)),
} as const
