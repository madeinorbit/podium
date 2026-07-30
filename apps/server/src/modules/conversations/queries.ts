/**
 * THE CONVERSATION QUERY — `search`.
 *
 * A table rather than a read contract, for the reason `modules/workflows/queries.ts`
 * gives and POD-386 and POD-735 both held: a `visibility` class describes what a
 * command WRITES, and a read writes nothing. Declaring one anyway would put a
 * graded value in the audit surface for a row the query does not touch — a FALSE
 * entry, not a missing one.
 *
 * Authorization is not here and must not move here: `run` is one call into the
 * service. This table decides WHICH READS EXIST AND WHERE THEY ARE SERVED, never
 * who may take them.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { ConversationsService } from './service'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface ConversationQuery<In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (service: ConversationsService, input: z.infer<In>) => Out
}

/** Preserves the schema and return types through the object literal — without it
 *  the entry widens to `ZodTypeAny`/`unknown` and the web client loses
 *  `AppRouter` inference on the read. */
const query = <In extends z.ZodTypeAny, Out>(
  input: In,
  run: (service: ConversationsService, input: z.infer<In>) => Out,
): ConversationQuery<In, Out> => ({ input, exposure: SERVED_ON, run })

export const CONVERSATION_QUERIES = {
  /** Keyword search over the durable index (FTS5 where available). An empty query
   *  browses by recency; `projectPath` narrows to a repo/worktree subtree. The
   *  schema is the shipped one, transcribed field for field. */
  search: query(
    z.object({
      query: z.string().optional(),
      projectPath: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    (service, input) => service.searchConversations(input),
  ),
} as const

export type ConversationQueryName = keyof typeof CONVERSATION_QUERIES

export const isConversationQuery = (proc: string): proc is ConversationQueryName =>
  Object.hasOwn(CONVERSATION_QUERIES, proc)

/** ADR 3 D3, default-closed, for the read half. */
export function isConversationQueryExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isConversationQuery(proc)) return false
  return CONVERSATION_QUERIES[proc].exposure.includes(transport)
}
