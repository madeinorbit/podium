/**
 * THE SEVEN INSTANCE QUERIES — `setup.info · setup.options · setup.commandFor ·
 * setup.channel`, `auth.status`, `telemetry.state · telemetry.preview`.
 *
 * Tables rather than read contracts: a `visibility` class describes what a
 * command WRITES and a read writes nothing. Three tables for the same reason
 * `registry.ts` has three — the wire groups them as three routers.
 *
 * `auth.status` RETURNS ONLY `{ enabled }` and never the password or its hash,
 * which is why a credential-adjacent read is safe to serve at all; that is a
 * property of the service method, checked here by there being nothing else to
 * return.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { InstanceService } from './service'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface InstanceQuery<I extends z.ZodTypeAny, Out> {
  readonly input: I
  readonly exposure: readonly TransportTag[]
  readonly run: (service: InstanceService, input: z.infer<I>) => Out
}

const query = <I extends z.ZodTypeAny, Out>(
  input: I,
  run: (service: InstanceService, input: z.infer<I>) => Out,
): InstanceQuery<I, Out> => ({ input, exposure: SERVED_ON, run })

/** `.optional()` because the shipped procedures had no `.input(...)` at all and
 *  are called with no argument. */
const noInput = z.object({}).passthrough().optional()

export const SETUP_QUERIES = {
  info: query(noInput, (service) => service.info()),
  options: query(noInput, (service) => service.options()),
  commandFor: query(
    z.object({
      option: z.enum(['tailscale-funnel', 'tailscale-serve', 'cloudflare-tunnel', 'manual']),
      port: z.number(),
    }),
    (service, input) => service.commandFor(input.option, input.port),
  ),
  channel: query(noInput, (service) => service.channel()),
} as const

export const AUTH_QUERIES = {
  status: query(noInput, (service) => service.status()),
} as const

export const TELEMETRY_QUERIES = {
  state: query(noInput, (service) => service.telemetryState()),
  preview: query(noInput, (service) => service.previewReport()),
} as const

export type SetupQueryName = keyof typeof SETUP_QUERIES
export type AuthQueryName = keyof typeof AUTH_QUERIES
export type TelemetryQueryName = keyof typeof TELEMETRY_QUERIES
