/**
 * THE SYNC WRITE ROUTES (ADR 12 D2 and D9, POD-6593): the tRPC adapters onto the
 * sync write entry point, generated from sync registrations (`builder.ts` says
 * why only this directory builds a mutation).
 *
 * EXPOSURE IS CHECKED HERE, at build time: a route is generated only for a
 * declaration that names tRPC among its transports. A declaration that does not
 * gets no tRPC adapter; asking for one fails at module load.
 *
 * THE ROUTE KEEPS ONLY ITS WIRE. Most of these are the old per-command routes,
 * kept as LEGACY adapters for the shipped clients that call them (each says when
 * it goes and what removing it breaks). Such a route keeps its input schema and
 * the way it answers a refusal; the write itself is the registration's, through
 * the entry point. Its body gets a `submit` bound to ITS registration: the
 * write it makes is the one its meta names.
 *
 * THE WIRE AND THE REGISTRATION CAN DIFFER. An old route whose write became an
 * effect record (`files.write`, `interactions.answer`) is still served under its
 * old contract, which decides its exposure and its schema, and reaches
 * `effects.create`; its meta names `effects.create`.
 */

import type { AnyCommandContract, CommandDef } from '@podium/commands'
import { isExposedOn } from '@podium/commands'
import { SyncSubmitInput, type SyncSubmitReply } from '@podium/protocol'
import type { z } from 'zod'
import { ANY_SYNC_REGISTRATION, type Context } from '../../trpc'
import { familyState } from '../derived-family'
import type { DetailedSubmit } from '../sync-write/entry'
import { refusalAsTrpcError, submitFromRoute } from '../sync-write/route-adapter'
import {
  buildWriteRoute,
  type ParserIn,
  type ParserOut,
  type RouteMiddleware,
  type RouteParser,
  unparsed,
  type WriteRoute,
} from './builder'

/** A wire declaration, in either format the registries take. */
export type RouteDeclaration =
  | AnyCommandContract
  | { readonly name: string; readonly def: CommandDef }

const declarationName = (declaration: RouteDeclaration): string => declaration.name

const exposedOnTrpc = (declaration: RouteDeclaration): boolean =>
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
  /** The declaration this route serves: its exposure decides whether the route
   *  exists, and its name is the registration unless `registration` says. */
  readonly command: RouteDeclaration
  /** The sync registration the route submits, when it is not `command`'s own. */
  readonly registration?: string
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
  const wire = declarationName(spec.command)
  if (!exposedOnTrpc(spec.command)) {
    throw new Error(`write routes: ${wire} is not exposed on trpc, so it has no tRPC route`)
  }
  const registration = spec.registration ?? wire
  const run = spec.run
  return buildWriteRoute(
    { registration, path: 'sync' },
    spec.input ?? unparsed,
    spec.use ?? [],
    async ({ ctx, input }) => {
      const submit = async (override?: unknown) =>
        await submitFromRoute(ctx, {
          command: registration,
          input: override === undefined ? input : override,
        })
      if (run === undefined) return answerAsRoute(wire, await submit())
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
  return buildWriteRoute(
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
