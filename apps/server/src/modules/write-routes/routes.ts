/**
 * THE WRITE-ROUTE GENERATOR (ADR 12 D9, POD-6593).
 *
 * Every tRPC mutation the server serves is built HERE, and only here: this module
 * claims the write procedure builder from `trpc.ts` when it loads, and the claim
 * can be made once. A module declares registrations (the sync write registry's,
 * `sync-write/registry.ts`, or the plain registry's, `plain-command/registry.ts`)
 * and asks this module for their routes. It cannot build a write of its own.
 *
 * Every route it builds carries `meta: { registration, path }`: the command the
 * route reaches and which entry runs it. `write-routes.test.ts` walks the served
 * router and holds every mutation to a registration that exists.
 *
 * EXPOSURE IS CHECKED HERE, at build time: a route is generated only for a
 * declaration that names tRPC among its transports. A declaration that does not
 * gets no tRPC adapter; asking for one fails at module load.
 *
 * THE ROUTE KEEPS ONLY ITS WIRE. Many of these are the old per-command routes,
 * kept as LEGACY adapters for the shipped clients that call them (each says when
 * it goes and what removing it breaks). Such a route keeps its input schema and
 * the way it answers a refusal; the write itself is the registration's, through
 * its entry point. A sync route's body gets a `submit` bound to ITS registration:
 * the only write it can make is the one its meta names.
 */

import type { AnyCommandContract, CommandDef } from '@podium/commands'
import { isExposedOn } from '@podium/commands'
import { SyncSubmitInput, type SyncSubmitReply } from '@podium/protocol'
import type { TRPCMutationProcedure } from '@trpc/server'
import type { z } from 'zod'
import {
  ANY_SYNC_REGISTRATION,
  type Context,
  claimWriteProcedureBuilder,
  type RouteMeta,
  type WriteProcedureBuilder,
  type WriteRouteMeta,
} from '../../trpc'
import { familyState } from '../derived-family'
import { PLAIN_COMMANDS } from '../plain-command/commands'
import type { PlainCommandRefusal } from '../plain-command/entry'
import type { DetailedSubmit } from '../sync-write/entry'
import { refusalAsTrpcError, submitFromRoute } from '../sync-write/route-adapter'
import { plainRefusalAsTrpcError } from './refusals'

const writeProcedure: WriteProcedureBuilder = claimWriteProcedureBuilder()

/** A route's input parser: a schema, or a pass-through for an entry that parses. */
export type RouteParser = z.ZodTypeAny | ((raw: unknown) => unknown)

type ParserIn<P> = P extends z.ZodTypeAny ? z.input<P> : unknown
type ParserOut<P> = P extends z.ZodTypeAny ? z.output<P> : unknown

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

function build(
  meta: WriteRouteMeta,
  parser: RouteParser,
  use: readonly RouteMiddleware[],
  resolve: (opts: { ctx: Context; input: unknown }) => Promise<unknown>,
): unknown {
  let builder = writeProcedure.meta(meta)
  for (const middleware of use) builder = builder.use(middleware) as typeof builder
  return builder.input(parser as z.ZodTypeAny).mutation(resolve)
}

// ---------------------------------------------------------------------------
// Sync routes
// ---------------------------------------------------------------------------

/** A sync registration's declaration, in either format the registry takes. */
export type SyncRouteDeclaration =
  | AnyCommandContract
  | { readonly name: string; readonly def: CommandDef }

const declarationName = (declaration: SyncRouteDeclaration): string =>
  'def' in declaration ? declaration.name : declaration.name

const exposedOnTrpc = (declaration: SyncRouteDeclaration): boolean =>
  'def' in declaration
    ? isExposedOn(declaration.def, 'trpc')
    : declaration.exposure.includes('trpc')

/** What a sync route's body gets. */
export interface SyncRouteCall<In> {
  readonly ctx: Context
  readonly input: In
  /**
   * Submit THIS route's registration through the entry point, as this caller:
   * with the route's own input, or with `input` when the route reshapes it.
   */
  submit(input?: unknown): Promise<DetailedSubmit>
}

export interface SyncRouteSpec<P extends RouteParser, Out> {
  /** The registration this route reaches. */
  readonly command: SyncRouteDeclaration
  /** The wire schema; a pass-through by default, and the entry parses. */
  readonly input?: P
  readonly use?: readonly RouteMiddleware[]
  /**
   * How the route answers. By default: the result on `applied`; on a refusal,
   * the family's own error when its handler threw one, else the refusal as the
   * tRPC error the client classifies the same way ({@link answerAsRoute}).
   */
  readonly run?: (call: SyncRouteCall<ParserOut<P>>) => Promise<Out>
}

/** The default answer of a sync route (see {@link SyncRouteSpec.run}). */
export function answerAsRoute(command: string, { reply, cause }: DetailedSubmit): unknown {
  if (reply.outcome === 'applied') return reply.result
  if (cause !== undefined) throw cause
  throw refusalAsTrpcError(command, reply.refusal)
}

/** A route onto the sync write entry point for ONE registration. */
export function syncRoute<P extends RouteParser = typeof unparsed, Out = unknown>(
  spec: SyncRouteSpec<P, Out>,
): WriteRoute<ParserIn<P>, Out> {
  const name = declarationName(spec.command)
  if (!exposedOnTrpc(spec.command)) {
    throw new Error(`write routes: ${name} is not exposed on trpc, so it has no tRPC route`)
  }
  const run = spec.run
  return build(
    { registration: name, path: 'sync' },
    spec.input ?? unparsed,
    spec.use ?? [],
    async ({ ctx, input }) => {
      const submit = async (override?: unknown) =>
        await submitFromRoute(ctx, {
          command: name,
          input: override === undefined ? input : override,
        })
      if (run === undefined) return answerAsRoute(name, await submit())
      return await run({ ctx, input: input as ParserOut<P>, submit })
    },
  ) as WriteRoute<ParserIn<P>, Out>
}

/**
 * `sync.submit` — the tRPC adapter onto the sync write entry point (ADR 12 D2).
 * Thin by design: the transport supplies the principal and the entry point does
 * everything else. Its registration is whichever the envelope names; the
 * command's own input is parsed by the entry point, after the coarse check, so
 * the envelope schema never validates it.
 */
export function syncSubmitRoute(): WriteRoute<z.input<typeof SyncSubmitInput>, SyncSubmitReply> {
  return build(
    { registration: ANY_SYNC_REGISTRATION, path: 'sync' },
    SyncSubmitInput,
    [],
    async ({ ctx, input }) =>
      await familyState(ctx).modules.syncWrite.submit(
        input as z.output<typeof SyncSubmitInput>,
        ctx.principal,
        'trpc',
      ),
  ) as WriteRoute<z.input<typeof SyncSubmitInput>, SyncSubmitReply>
}

// ---------------------------------------------------------------------------
// Plain routes
// ---------------------------------------------------------------------------

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

/**
 * A route onto the plain entry for the registration named `name` in the
 * plain registry. The procedure does not parse: the entry does, after the coarse
 * check, so a refused caller learns nothing from validation errors.
 */
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
  return build({ registration: name, path: 'plain' }, unparsed, spec.use ?? [], async (call) => {
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
  }) as WriteRoute<In, Out>
}
