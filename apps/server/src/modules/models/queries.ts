/**
 * THE MODEL-CATALOG QUERY — `catalog`.
 *
 * Stale-while-revalidate: this returns instantly from cache (possibly empty on
 * the very first call) and refreshes in the background; the web merges it over
 * its static catalog and re-reads on the next open. The forced, awaited probe is
 * the `refresh` COMMAND next door.
 *
 * A table rather than a read contract: a `visibility` class describes what a
 * command WRITES and a read writes nothing.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { SettingsService } from '../settings/service'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface ModelQuery<In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (service: SettingsService, input: z.infer<In>) => Out
}

const query = <In extends z.ZodTypeAny, Out>(
  input: In,
  run: (service: SettingsService, input: z.infer<In>) => Out,
): ModelQuery<In, Out> => ({ input, exposure: SERVED_ON, run })

const noInput = z.object({}).passthrough().optional()

export const MODEL_QUERIES = {
  catalog: query(noInput, (service) => service.getModelCatalog()),
} as const

export type ModelQueryName = keyof typeof MODEL_QUERIES

export const isModelQuery = (proc: string): proc is ModelQueryName =>
  Object.hasOwn(MODEL_QUERIES, proc)

export function isModelQueryExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isModelQuery(proc)) return false
  return MODEL_QUERIES[proc].exposure.includes(transport)
}
