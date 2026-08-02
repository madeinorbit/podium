/**
 * THE MODEL-CATALOG QUERY — `catalog`.
 *
 * Stale-while-revalidate: this returns instantly from one machine's cache
 * (possibly empty on the very first call) and refreshes in the background; the
 * web merges it over its static catalog and re-reads on the next open. The
 * forced, awaited probe is the `refresh` COMMAND next door.
 *
 * A table rather than a read contract: a `visibility` class describes what a
 * command WRITES and a read writes nothing. The snapshot is still a per-machine
 * fact (ADR 1 D13.5); `machineId` names which machine's cache to read.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { ModelState } from './registry'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface ModelQuery<In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (state: ModelState, input: z.infer<In>) => Out
}

const query = <In extends z.ZodTypeAny, Out>(
  input: In,
  run: (state: ModelState, input: z.infer<In>) => Out,
): ModelQuery<In, Out> => ({ input, exposure: SERVED_ON, run })

/** Optional machineId — absent means the server's default/host machine, matching
 *  the shipped client that still calls with no input. */
const catalogInput = z.object({ machineId: z.string().optional() }).passthrough().optional()

export const MODEL_QUERIES = {
  catalog: query(catalogInput, (state, input) =>
    state.settings.getModelCatalog(input?.machineId ?? state.defaultMachine()),
  ),
} as const

export type ModelQueryName = keyof typeof MODEL_QUERIES

export const isModelQuery = (proc: string): proc is ModelQueryName =>
  Object.hasOwn(MODEL_QUERIES, proc)

export function isModelQueryExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isModelQuery(proc)) return false
  return MODEL_QUERIES[proc].exposure.includes(transport)
}
