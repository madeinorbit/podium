/**
 * THE TWO CLOUD QUERIES — `capabilities` and `runtime`.
 *
 * A table rather than read contracts: a `visibility` class describes what a
 * command WRITES and a read writes nothing.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { CloudService } from './service'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface CloudQuery<I extends z.ZodTypeAny, Out> {
  readonly input: I
  readonly exposure: readonly TransportTag[]
  readonly run: (service: CloudService, input: z.infer<I>) => Out
}

const query = <I extends z.ZodTypeAny, Out>(
  input: I,
  run: (service: CloudService, input: z.infer<I>) => Out,
): CloudQuery<I, Out> => ({ input, exposure: SERVED_ON, run })

const noInput = z.object({}).passthrough().optional()

export const CLOUD_QUERIES = {
  /** What this deployment's provider supports. Answers honestly (with everything
   *  false) when no provider is configured, rather than failing — which is what
   *  lets the UI hide the cloud surface instead of erroring in it. */
  capabilities: query(noInput, (service) => service.capabilities()),
  runtime: query(z.object({ id: z.string().min(1) }), (service, input) =>
    service.getRuntime(input.id),
  ),
} as const

export type CloudQueryName = keyof typeof CLOUD_QUERIES
