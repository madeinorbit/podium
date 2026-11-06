/**
 * THE PLAIN WRITE ROUTES (ADR 12 D8 and D9, POD-6593): the tRPC adapters onto
 * the plain entry, generated from the plain registry (`plain-command/commands.ts`;
 * `builder.ts` says why only this directory builds a mutation).
 *
 * A route exists only for a registration whose declaration names tRPC among its
 * transports; asking for one that does not fails at module load. The procedure
 * does not parse: the entry does, after the coarse check, so a refused caller
 * learns nothing from validation errors.
 */

import type { Context } from '../../trpc'
import { PLAIN_COMMANDS } from '../plain-command/commands'
import type { PlainCommandRefusal } from '../plain-command/entry'
import { buildWriteRoute, type RouteMiddleware, unparsed, type WriteRoute } from './builder'
import { plainRefusalAsTrpcError } from './refusals'

/** What a plain route does with a front-door refusal. */
export type PlainRefused = (
  refusal: PlainCommandRefusal,
  call: { readonly ctx: Context; readonly input: unknown },
) => Promise<never> | never

export interface PlainRouteSpec {
  readonly use?: readonly RouteMiddleware[]
  /** The route's own words for a refusal; {@link plainRefusalAsTrpcError} by default. */
  readonly refused?: PlainRefused
  /** A handler error as the route answers it (a redaction, a status code). */
  readonly failed?: (error: unknown, call: { readonly input: unknown }) => unknown
}

/** A route onto the plain entry for the registration named `name`. */
export function plainRoute<In = unknown, Out = unknown>(
  name: string,
  spec: PlainRouteSpec = {},
): WriteRoute<In, Out> {
  const command = PLAIN_COMMANDS.lookup(name)
  if (command === undefined) {
    throw new Error(
      `write routes: ${name} is not in the plain registry (plain-command/commands.ts)`,
    )
  }
  if (!command.door.exposedOn('trpc')) {
    throw new Error(`write routes: ${name} is not exposed on trpc, so it has no tRPC route`)
  }
  return buildWriteRoute(
    { registration: name, path: 'plain' },
    unparsed,
    spec.use ?? [],
    async (call) => {
      let reply: Awaited<ReturnType<typeof PLAIN_COMMANDS.run>>
      try {
        reply = await PLAIN_COMMANDS.run(name, {
          principal: call.ctx.principal,
          transport: 'trpc',
          input: call.input,
          request: call.ctx,
        })
      } catch (error) {
        if (spec.failed === undefined) throw error
        throw spec.failed(error, call)
      }
      if (reply.outcome === 'applied') return reply.result
      if (spec.refused !== undefined) return await spec.refused(reply.refusal, call)
      throw plainRefusalAsTrpcError(name, reply.refusal)
    },
  ) as WriteRoute<In, Out>
}
