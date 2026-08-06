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

import { asUserId, SessionIdField } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { mayReadOwned } from '../../issue-authz'
import type { FamilyState } from '../derived-family'
import { defineQuery } from '../query-table'

const q = defineQuery<FamilyState>()

// THE decision comes from the model (POD-335). This used to spell the rule out
// here — `owner === caller.userId || grants.includes(caller.userId)` — which is
// a second authorization surface (docs/multi-user-readiness.md §3.2) and, over
// an absent owner and an absent caller, compared `undefined === undefined` and
// answered ALLOW. `mayReadOwned` refuses an unowned entity by construction.
function mayReadSession(state: FamilyState, sessionId: string): boolean {
  const target = state.modules.sessions.sessionOwner(sessionId as never)
  if (target === undefined) return false
  return mayReadOwned(state.caller.userId, {
    id: sessionId,
    owner: target.owner,
    grants: target.grants,
  })
}

function assertMayReadSession(state: FamilyState, sessionId: string): void {
  if (!mayReadSession(state, sessionId)) throw new TRPCError({ code: 'NOT_FOUND' })
}

export const SESSION_QUERIES = {
  list: q(z.object({}).passthrough().optional(), (s) =>
    s.modules.sessions.listSessions().filter((session) => mayReadSession(s, session.sessionId)),
  ),
  /** Fleet-wide 12-hour concurrency samples for the global shell status strip. */
  concurrencyHistory: q(z.object({}).passthrough().optional(), (s) =>
    s.modules.sessions.agentConcurrencyHistory(),
  ),
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
    (s, input) => {
      assertMayReadSession(s, input.sessionId)
      return s.modules.rpc.readTranscript(input, { kind: 'user', id: asUserId(s.caller.userId) })
    },
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
    (s, input) => {
      assertMayReadSession(s, input.sessionId)
      return s.modules.readToolkit.read(input, s.caller.actorSessionId ?? 'operator')
    },
  ),
  /** Read toolkit tier 3 (#237) [spec:SP-34d7 read-toolkit]: server-side recap
   *  since a watermark — repeated check-ins pay only for the delta (the watermark
   *  persists per (reader, target)). */
  recap: q(z.object({ sessionId: SessionIdField, since: z.string().optional() }), (s, input) => {
    assertMayReadSession(s, input.sessionId)
    return s.modules.readToolkit.recap(input, s.caller.actorSessionId ?? 'operator')
  }),
} as const

export const SYNC_QUERIES = {
  /** Metadata-oplog catch-up (docs/spec/oplog-read-path.md): null cursor =
   *  bootstrap snapshot; a valid cursor = the changes after it; a
   *  compacted/future cursor falls back to snapshot. The client heals every WS
   *  (re)connect through this. */
  changesSince: q(z.object({ cursor: z.number().int().nonnegative().nullable() }), (s, input) =>
    s.modules.sessions.syncChangesSince(input.cursor, s.publicationAuthority),
  ),
  /**
   * WIRE v2 CATCH-UP (POD-376) — rung 1 of the kernel Replica's D7 ladder.
   *
   * A SIBLING OF `changesSince`, NOT A REPLACEMENT, for the length of the
   * rollout window: the two serve the two wire versions, and both read the same
   * Authority through the same principal, so neither can see rows the other
   * cannot. `changesSince` disappears with the v1 edge adapter it serves.
   *
   * The cursor is the D1 TRIPLE and not a bare integer. That is the difference
   * that makes this query answerable at all — a `seq` alone names a position on
   * an unnamed number line, and the honest answer to a cursor from another feed
   * is "re-bootstrap", which this shape can express and the v1 one cannot.
   */
  feedChangesSince: q(
    z.object({
      cursor: z
        .object({
          feedId: z.string().min(1),
          epoch: z.string().min(1),
          seq: z.number().int().nonnegative(),
        })
        .nullable(),
    }),
    (s, input) =>
      s.modules.funnel.feedChangesSince(
        input.cursor,
        s.feedPrincipal ??
          (() => {
            throw new Error('authenticated feed principal required')
          })(),
      ),
  ),
  /**
   * THE AUTHORITY'S OWN VIEW OF THIS PRINCIPAL'S SLICE (POD-376).
   *
   * A DIAGNOSTIC READ, and the third snapshot of the shadow comparison. It exists
   * so the comparison can classify an absence against what the Authority says
   * rather than suppress it — see
   * `docs/agents/pod-376-shadow-comparison-basis.md` §2.2.
   *
   * It leaks nothing the feed does not already deliver: it is
   * `AuthorityPort.bootstrap` for the SAME principal, evaluated through the SAME
   * policy object, reduced to keys. A principal that may not see a row does not
   * receive its key here either — which is exactly the property that makes it
   * usable as the comparison's basis.
   */
  feedSlice: q(z.object({}).optional(), (s) =>
    s.modules.funnel.feedSlice(
      s.feedPrincipal ??
        (() => {
          throw new Error('authenticated feed principal required')
        })(),
    ),
  ),
} as const

const noInput = z.object({}).passthrough().optional()

/** PER-USER STATE (POD-380): each list is the CALLER's, not the instance's. */
export const PIN_QUERIES = {
  list: q(noInput, (s) => s.modules.sessions.state.listPins(s.caller.sessionState)),
} as const

export const SNOOZE_QUERIES = {
  list: q(noInput, (s) => s.modules.sessions.state.listSnoozes(s.caller.sessionState)),
} as const

export const TAB_QUERIES = {
  listOrders: q(noInput, (s) => s.modules.sessions.state.listTabOrders(s.caller.sessionState)),
} as const
