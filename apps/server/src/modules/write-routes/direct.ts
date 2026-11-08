/**
 * THE DIRECT WRITES: the census of exceptions (ADR 12 D9, POD-6593).
 *
 * Every tRPC write is generated from a registration: a sync registration
 * (`sync.ts`) or a plain one (`plain.ts`). The commands named here are neither
 * YET. Each writes synced rows, so it cannot be plain (the plain scope refuses a
 * synced write), but it reaches its service directly, which writes through the
 * writer it was given at composition rather than a command's own: the `client`
 * origins in `write-contexts.ts`. Moving one onto the sync write entry point (a
 * registration with its target check) is its owner issue's work.
 *
 * So this table is to the routes what `SYSTEM_WRITE_ORIGINS` is to the writers:
 * the one place an exception is written down, visible in review, each with what
 * it writes and the issue that removes it. A route for a name not listed here
 * fails at module load; `write-routes/write-routes.test.ts` holds every mutation
 * the server serves to the sync registry, the plain registry or this table.
 */

import type { Context } from '../../trpc'
import {
  buildWriteRoute,
  type ParserIn,
  type ParserOut,
  type RouteMiddleware,
  type RouteParser,
  type WriteRoute,
} from './builder'

export interface DirectWriteSpec {
  readonly what: string
  /** The issue that moves it onto a registration, and removes this entry. */
  readonly owner: string
}

/** The issues that move the census onto registrations; it reaches zero before
 *  the write audits are deleted (POD-6595). It is zero: the issue commands
 *  left it in POD-6603, each a sync registration or an effect record. */
export const DIRECT_WRITE_OWNERS: readonly string[] = []

/** Empty. A new exception is a line here, with what it writes and its owner. */
export const DIRECT_WRITES: Readonly<Record<string, DirectWriteSpec>> = {}

export type DirectWriteName = string

export const isDirectWrite = (name: string): name is DirectWriteName =>
  Object.hasOwn(DIRECT_WRITES, name)

export interface DirectRouteSpec<P extends RouteParser, Out> {
  /** The wire schema. */
  readonly input: P
  readonly use?: readonly RouteMiddleware[]
  readonly run: (call: { readonly ctx: Context; readonly input: ParserOut<P> }) => Promise<Out>
}

/** The route of one direct write in the census (see the header). */
export function directRoute<P extends RouteParser, Out>(
  name: string,
  spec: DirectRouteSpec<P, Out>,
): WriteRoute<ParserIn<P>, Out> {
  if (!isDirectWrite(name)) {
    throw new Error(
      `write routes: ${name} is in neither registry nor the direct-write census (write-routes/direct.ts)`,
    )
  }
  return buildWriteRoute(
    { registration: name, path: 'direct' },
    spec.input,
    spec.use ?? [],
    async ({ ctx, input }) => await spec.run({ ctx, input: input as ParserOut<P> }),
  ) as WriteRoute<ParserIn<P>, Out>
}
