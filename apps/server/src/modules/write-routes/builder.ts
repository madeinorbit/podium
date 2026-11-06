/**
 * THE WRITE-ROUTE BUILDER (ADR 12 D9, POD-6593).
 *
 * Every tRPC mutation the server serves is built by this directory, and only
 * here: this module claims the write procedure builder from `trpc.ts` when it
 * loads, and the claim can be made once. Modules get a QUERY-only builder
 * (`t.procedure` has no `.mutation`, by type). A module declares registrations
 * (the sync write registry's, `sync-write/registry.ts`, or the plain registry's,
 * `plain-command/registry.ts`) and asks `sync.ts` or `plain.ts` for their routes.
 *
 * Every route built here carries `meta: { registration, path }`: the command the
 * route reaches and which entry runs it. `sync-write/write-routes.test.ts` walks
 * the served router and holds every mutation to a registration that exists.
 */

import type { TRPCMutationProcedure } from '@trpc/server'
import type { z } from 'zod'
import {
  type Context,
  claimWriteProcedureBuilder,
  type RouteMeta,
  type WriteProcedureBuilder,
  type WriteRouteMeta,
} from '../../trpc'

const writeProcedure: WriteProcedureBuilder = claimWriteProcedureBuilder()

/** A route's input parser: a schema, or a pass-through for an entry that parses. */
export type RouteParser = z.ZodTypeAny | ((raw: unknown) => unknown)

export type ParserIn<P> = P extends z.ZodTypeAny ? z.input<P> : unknown
export type ParserOut<P> = P extends z.ZodTypeAny ? z.output<P> : unknown

/** A middleware a route runs before its parser (the issue guard, the hub role). */
export type RouteMiddleware = Parameters<WriteProcedureBuilder['use']>[0]

/** A generated write route, as the router serves it. */
export type WriteRoute<In, Out> = TRPCMutationProcedure<{
  meta: RouteMeta
  input: In
  output: Out
}>

/** The input is parsed by the entry point, after the coarse check. */
export const unparsed = (raw: unknown): unknown => raw

/** Build one write route. For `sync.ts` and `plain.ts` only. */
export function buildWriteRoute(
  meta: WriteRouteMeta,
  parser: RouteParser | undefined,
  use: readonly RouteMiddleware[],
  resolve: (opts: { ctx: Context; input: unknown }) => Promise<unknown>,
): unknown {
  let builder = writeProcedure.meta(meta)
  for (const middleware of use) builder = builder.use(middleware) as typeof builder
  // No parser at all: the procedure takes no input (`updates.converge`).
  if (parser === undefined) return builder.mutation(resolve)
  return builder.input(parser as z.ZodTypeAny).mutation(resolve)
}
