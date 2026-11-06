/**
 * A SYNC FAMILY (ADR 12 D2 and D9, POD-6412; plan Task 16).
 *
 * The builder that puts a family's writes on the sync write entry point. A family
 * already declares a table of `{ contract, handler }` joined to its service (the
 * derived families, `derived-family.ts`). Here it adds the one thing the entry
 * point asks of it, its TARGET check, and the builder registers every command on
 * `syncWrite.registry`. Every transport then reaches the command through
 * `submit`: `sync.submit` for the apps, and the CLI, MCP and relay adapters with
 * their own transport tags. The handler never sees the request.
 *
 * THE SERVICE IS BUILT FROM THE PRINCIPAL, not from a request. A derived family
 * selects its service from `FamilyState`, which `familyState(ctx)` builds from a
 * tRPC context; the entry point has no such context, and a relay or MCP call
 * never had one. {@link SyncFamilyState} is the part of that bundle that a write
 * may depend on: the composed modules, and who is asking. A family whose
 * selector needs more (the store, the request's repos) is not ready for this
 * builder, and the type says so where its table is declared.
 *
 * THE OLD ROUTES. {@link legacyRouteAdapters} builds the family's per-command
 * tRPC routes as thin adapters onto `submit`, for the shipped clients that still
 * call them (the mobile app, the desktop app's bundled web, an older CLI). A
 * command no shipped client calls gets no route at all: `sync.submit` is its
 * only door.
 */

import type { AnyCommandContract, RoleFloor } from '@podium/commands'
import type { UserId, UserRole } from '@podium/model'
import type { SyncSubmitRefusal } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { t } from '../../trpc'
import type { AnyDerivedCommand, FamilyState, MutationProcedures } from '../derived-family'
import { sessionStatePrincipalFor } from '../sessions/session-state/registry'
import { SyncWriteRefused } from './entry'
import {
  NO_TARGET,
  type SyncTargetContext,
  type SyncWriteContext,
  type SyncWriteRegistry,
  type SyncWriteTarget,
} from './registry'
import { refusalAsTrpcError, submitFromRoute } from './route-adapter'

type MaybePromise<T> = T | Promise<T>

/** What a sync family's service may be selected from (see the header). */
export interface SyncFamilyState {
  readonly modules: RegistryModules
  readonly caller: FamilyState['caller']
  /** Who is asking, whole: a family whose service takes the principal itself
   *  (automations, workflows) reads it here, never from the input. */
  readonly principal: CommandPrincipal
  /** The caller's out-of-scope confirmation, as the target check saw it. */
  readonly confirmed: boolean
  /**
   * The command's own writer, bound to its `sync` write scope
   * (`SyncWriteContext.ledger`, ADR 12 D9). A family's service writes through
   * this, per call, never through a writer of its own.
   */
  readonly writer: SyncWriteContext['ledger']
  /**
   * The unit of work's `afterCommit` (`SyncWriteContext.afterCommit`): work
   * outside the database (a delivery to a daemon) runs once the write has
   * committed, never on a rollback, and outside the write's provenance.
   */
  afterCommit(step: () => void | Promise<void>, label: string): void
  /** An account's role NOW (ADR 3 D16), for a family whose own rules grade by it. */
  roleOf(user: UserId): Promise<UserRole | undefined>
}

/** The parts of a write's context the per-call state carries. */
type WriteContextPart = Pick<SyncWriteContext, 'principal' | 'confirmed' | 'afterCommit' | 'ledger'>

/**
 * The bundle for one call. The principal has a human behind it: every sync
 * family's target check refuses one without ({@link humanWithRoleFloor}), so a
 * principal without reaching here is a wiring fault, not a refusal.
 */
export function syncFamilyState(
  modules: RegistryModules,
  ctx: WriteContextPart,
  roleOf: SyncFamilyState['roleOf'],
): SyncFamilyState {
  const { principal } = ctx
  const userId = onBehalfOfUser(principal)
  if (principal.kind === 'system' || userId === null) {
    throw new Error('sync family: a write reached its handler without a human')
  }
  return {
    modules,
    caller: {
      userId,
      sessionState: sessionStatePrincipalFor(principal),
      actorSessionId: principal.capability.actorSessionId,
    },
    principal,
    confirmed: ctx.confirmed,
    writer: ctx.ledger,
    afterCommit: (step, label) => ctx.afterCommit(step, label),
    roleOf,
  }
}

/** What a family's target check may read: who is asking, the modules, and the
 *  account's role NOW (ADR 3 D16). */
export interface SyncFamilyTargetContext extends SyncTargetContext {
  readonly modules: RegistryModules
  roleOf(user: UserId): Promise<UserRole | undefined>
}

export interface SyncFamily<Svc, C extends Record<string, AnyDerivedCommand>> {
  /** The wire namespace, for messages. Each command registers under its contract's name. */
  readonly family: string
  readonly service: (state: SyncFamilyState) => Svc
  readonly commands: C
  /**
   * Step 4, the target check on the parsed input: the record the command writes,
   * as the target `authorize` decides on; {@link NO_TARGET} when the role
   * decides alone; `undefined` to refuse.
   */
  target(
    contract: AnyCommandContract,
    input: unknown,
    ctx: SyncFamilyTargetContext,
  ): MaybePromise<SyncWriteTarget>
  /**
   * A handler error that is the family's own definitive refusal, as the reply's
   * refusal. `undefined` lets it propagate: a transient failure the outbox
   * retries. The message, when set, is what the caller is shown.
   */
  refusalOf?(error: unknown): SyncSubmitRefusal | undefined
  /**
   * After a refused or failed write rolled back (`ContractRegistration.rolledBack`):
   * a family that keeps a trail of what it refused writes it here, outside the
   * write it is about. It must not change the outcome.
   */
  rolledBack?(
    contract: AnyCommandContract,
    input: unknown,
    error: unknown,
    ctx: SyncFamilyTargetContext,
  ): Promise<void>
}

export interface SyncFamilyDeps {
  /** The composed modules, read per call: handlers reach services composed later. */
  modules(): RegistryModules
  roleOf(user: UserId): Promise<UserRole | undefined>
}

/** Register every command of `family` on the entry point. */
export function registerSyncFamily<Svc, C extends Record<string, AnyDerivedCommand>>(
  registry: SyncWriteRegistry,
  family: SyncFamily<Svc, C>,
  deps: SyncFamilyDeps,
): void {
  for (const { contract, handler } of Object.values(family.commands)) {
    registry.register({
      contract,
      target: async (input, ctx) =>
        await family.target(contract, input, {
          ...ctx,
          modules: deps.modules(),
          roleOf: deps.roleOf,
        }),
      handle: async (ctx, input) => {
        const service = family.service(syncFamilyState(deps.modules(), ctx, deps.roleOf))
        try {
          return await handler(service, input)
        } catch (error) {
          const refusal = family.refusalOf?.(error)
          if (refusal === undefined) throw error
          throw new SyncWriteRefused(refusal, { cause: error })
        }
      },
      ...(family.rolledBack === undefined
        ? {}
        : {
            rolledBack: async (ctx, input, error) =>
              await family.rolledBack?.(contract, input, error, {
                ...ctx,
                modules: deps.modules(),
                roleOf: deps.roleOf,
              }),
          }),
    })
  }
}

const ROLE_RANK: Readonly<Record<UserRole, number>> = { member: 1, admin: 2 }

/**
 * The common target check for a family whose records belong to the deployment or
 * to the caller alone: a human behind the principal, whose account holds the
 * contract's role floor NOW. Then the role decides ({@link NO_TARGET}). A
 * disabled account has no role and is refused.
 */
export async function humanWithRoleFloor(
  contract: AnyCommandContract,
  ctx: SyncFamilyTargetContext,
): Promise<SyncWriteTarget> {
  const actor = onBehalfOfUser(ctx.principal)
  if (actor === null) return undefined
  const role = await ctx.roleOf(actor)
  return role !== undefined && meetsFloor(role, contract.policy.roleFloor) ? NO_TARGET : undefined
}

const meetsFloor = (role: UserRole, floor: RoleFloor): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[floor]

/**
 * A handler's `TRPCError` as a refusal, with its message. Only a 4xx is a
 * refusal; anything else propagates. The message was already shown to this
 * caller by the old route, after the same permission checks.
 */
export function trpcErrorRefusal(error: unknown): SyncSubmitRefusal | undefined {
  if (!(error instanceof TRPCError)) return undefined
  const { message } = error
  switch (error.code) {
    case 'FORBIDDEN':
    case 'UNAUTHORIZED':
      return { kind: 'unauthorized', message }
    case 'NOT_FOUND':
      return { kind: 'target-not-found', message }
    case 'CONFLICT':
      return { kind: 'conflict', message }
    case 'BAD_REQUEST':
      return { kind: 'invalid', message }
    case 'PRECONDITION_FAILED':
      return { kind: 'confirmation-required', message }
    default:
      return undefined
  }
}

/** The input is parsed by the entry point, after the coarse check. */
const unparsed = (raw: unknown): unknown => raw

/**
 * LEGACY(remove-after: 2027-03): the old per-command tRPC routes of `keep`, as
 * thin adapters onto `submit`, for shipped clients that still call them.
 * Removing one breaks that client's write.
 *
 * The route answers as it did: the result on `applied`; on a refusal, the
 * family's own error when the handler threw one, else the refusal as the tRPC
 * error the client classifies the same way. It does not parse: the entry point
 * does, after the coarse check, so a schema with a transform is applied once.
 */
export function legacyRouteAdapters<
  Svc,
  C extends Record<string, AnyDerivedCommand>,
  K extends keyof C & string,
>(family: SyncFamily<Svc, C>, keep: readonly K[]): MutationProcedures<Pick<C, K>> {
  const built: Record<string, unknown> = {}
  for (const key of keep) {
    const command = family.commands[key]
    if (command === undefined) throw new Error(`sync family ${family.family}: no command ${key}`)
    const { contract } = command
    if (!contract.exposure.includes('trpc')) {
      throw new Error(`sync family ${family.family}: ${contract.name} is not served on tRPC`)
    }
    built[key] = t.procedure.input(unparsed).mutation(async ({ ctx, input }) => {
      const { reply, cause } = await submitFromRoute(ctx, { command: contract.name, input })
      if (reply.outcome === 'applied') return reply.result
      if (cause !== undefined) throw cause
      throw refusalAsTrpcError(contract.name, reply.refusal)
    })
  }
  return built as MutationProcedures<Pick<C, K>>
}
