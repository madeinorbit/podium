/**
 * THE INTERACTION READS — `list` (every open ask) and `forSession` (one
 * session's history, open and resolved).
 *
 * A query table rather than read contracts in `@podium/commands`, on the line
 * `modules/approvals/queries.ts` drew and POD-386/POD-735 both held: a
 * `CommandContract` requires a `visibility` class, a visibility class describes
 * WHAT A COMMAND WRITES, and a read writes nothing. Declaring one anyway would
 * put a false entry in the audit surface. Read contracts are POD-311's remaining
 * work.
 *
 * WHY `list` EXISTS AT ALL, given the feed carries the same rows: the feed is
 * for replicas, and the headless answering path has none. `podium interactions
 * list` runs on a machine with a tRPC client and no replica, and §4's whole
 * claim — "enumerable ... and answerable without attaching a terminal" —
 * requires an enumeration that does not presuppose a synced client.
 *
 * AUTHORIZATION IS NOT HERE and must not move here. This table decides WHICH
 * READS EXIST AND WHERE THEY ARE SERVED, never who may take them.
 */

import type { TransportTag } from '@podium/commands'
import { asSessionId } from '@podium/model'
import { z } from 'zod'
import type { InteractionService } from './service'

/** `trpc` and `cli`, matching the answer contract: the CLI's list and its answer
 *  have to be served on the same transport or the verb pair is unusable. */
const SERVED_ON: readonly TransportTag[] = ['trpc', 'cli']

export interface InteractionQuery<In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (service: InteractionService, input: z.infer<In>) => Out
}

/** Preserves schema and return types through the object literal below — without
 *  it every entry widens and the web client loses `AppRouter` inference. */
const query = <In extends z.ZodTypeAny, Out>(
  input: In,
  run: (service: InteractionService, input: z.infer<In>) => Out,
): InteractionQuery<In, Out> => ({ input, exposure: SERVED_ON, run })

const listInput = z.object({ sessionId: z.string().min(1).optional() }).optional()

const forSessionInput = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
})

export const INTERACTION_QUERIES = {
  /** Every OPEN ask, optionally narrowed to one session — the enumeration §4
   *  promises, and the backing read for `podium interactions list`. */
  list: query(listInput, (service, input) =>
    service.listOpen(input?.sessionId ? asSessionId(input.sessionId) : undefined),
  ),
  /** One session's asks including resolved ones — the audit read. This is where
   *  "who answered, with what, and how it was delivered" lives; the feed
   *  deliberately carries only the open set. */
  forSession: query(forSessionInput, (service, input) =>
    service.listForSession(asSessionId(input.sessionId), input.limit),
  ),
} as const

export type InteractionQueryName = keyof typeof INTERACTION_QUERIES

export const isInteractionQuery = (proc: string): proc is InteractionQueryName =>
  Object.hasOwn(INTERACTION_QUERIES, proc)

/** ADR 3 D3, default-closed, for the read half. */
export function isInteractionQueryExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isInteractionQuery(proc)) return false
  return INTERACTION_QUERIES[proc].exposure.includes(transport)
}
