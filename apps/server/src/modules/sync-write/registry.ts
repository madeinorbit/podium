/**
 * THE SYNC WRITE REGISTRATIONS (ADR 12 D2 and D9, POD-6273).
 *
 * A family supplies three things for each command that writes synced data, and
 * nothing else: its CONTRACT, a TARGET resolver and a HANDLER. The entry point
 * (`entry.ts`) runs every other step — principal, coarse permission, parse, target
 * permission, dedup, provenance, unit of work, receipt — in its fixed order. A
 * handler never sees the request, so it cannot skip one.
 *
 * BOTH DECLARATION FORMATS. Commands are declared today either as an ADR 3
 * `CommandContract` (`name`, `version`, `policy.roleFloor`, `exposure` over
 * `TransportTag`) or as a `defineCommands` entry (`CommandDef`: no name of its own,
 * no version, `action` and an optional `exposure` over `CommandTransport`). The
 * registry normalises both into one {@link SyncCommand} at registration, so the
 * entry point asks one set of questions. A `CommandDef` is version 1 and has the
 * `member` role floor: its format has no field for either, and its `action` is
 * still checked against the role.
 *
 * Task 10 registers the outbox commands here; Task 16 the rest (plan POD-6241).
 */

import type { AnyCommandContract, CommandDef } from '@podium/commands'
import type { AuthTarget, MutationId } from '@podium/model'
import type { Ledger } from '@podium/sync'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import {
  contractFrontDoor,
  defFrontDoor,
  type FrontDoorCommand,
  type FrontDoorTransport,
} from '../front-door'

/** The transports with an adapter onto the entry point (ADR 12 D2): the front
 *  door's, shared with the plain path. */
export type SyncWriteTransport = FrontDoorTransport

/**
 * A resolver's answer for a command that names NO existing record (a create, an
 * append to the caller's own log). The target check then decides on the
 * principal's role and scope alone, the additive case of `authorize`.
 *
 * A named constant rather than `null`, because `undefined` already means "the
 * record is missing or invisible" and must refuse; two falsy spellings for
 * opposite answers is how one gets returned for the other. An object with a
 * declared type rather than a `unique symbol`, because an `async` resolver's
 * inferred return type widens a unique symbol to `symbol`, which no longer
 * matches; a declared interface type survives inference. Compared by identity.
 */
export interface NoTarget {
  readonly syncWriteNoTarget: true
}
export const NO_TARGET: NoTarget = Object.freeze({ syncWriteNoTarget: true })

/** Whether a resolver answered {@link NO_TARGET}. A guard, because comparing an
 *  object-typed constant does not narrow the union. */
export const isNoTarget = (target: SyncWriteTarget): target is NoTarget => target === NO_TARGET

/** `undefined` refuses: the target is missing, or this principal cannot see it.
 *  The two are deliberately one answer (no existence oracle, ADR 3 Amendment D20). */
export type SyncWriteTarget = AuthTarget | NoTarget | undefined

/** What a target resolver may know: who is asking. Never the request. */
export interface SyncTargetContext {
  readonly principal: CommandPrincipal
}

/** The Authority-bound writers of the unit of work. Every change row they append
 *  carries the command's provenance. */
export type SyncWriteLedger = Pick<Ledger, 'commit' | 'capture'>

/**
 * What a handler gets (ADR 12 D9's `SyncWriteContext`). Task 18 makes it the only
 * way to write a synced table.
 */
export interface SyncWriteContext {
  readonly principal: CommandPrincipal
  /** The client-minted id of this command: its dedup key and its provenance. */
  readonly mutationId: MutationId
  /** ADR 3 D13's precondition, as the envelope carried it. The handler compares
   *  it and throws `SyncWriteRefused({ kind: 'conflict' })` when it is stale. */
  readonly expectedRevision: number | undefined
  readonly ledger: SyncWriteLedger
  /**
   * Run non-database work (a daemon call, a socket push) once the unit of work
   * has committed, and never if it rolls back (ADR 2 D10, ADR 12 D5). The step
   * runs outside the command's provenance: it is not part of the write the
   * receipt covers.
   */
  afterCommit(step: () => void | Promise<void>, label: string): void
}

type MaybePromise<T> = T | Promise<T>

/** A registration over an ADR 3 `CommandContract`. */
export interface ContractRegistration<C extends AnyCommandContract, Out> {
  readonly contract: C
  target(input: z.infer<C['input']>, ctx: SyncTargetContext): MaybePromise<SyncWriteTarget>
  handle(ctx: SyncWriteContext, input: z.infer<C['input']>): Promise<Out>
}

/** A registration over a `defineCommands` entry, which carries no name of its own. */
export interface DefRegistration<D extends CommandDef, Out> {
  readonly name: string
  readonly def: D
  target(input: z.infer<D['input']>, ctx: SyncTargetContext): MaybePromise<SyncWriteTarget>
  handle(ctx: SyncWriteContext, input: z.infer<D['input']>): Promise<Out>
}

/** One command as the entry point reads it, whichever format declared it. */
export interface SyncCommand extends FrontDoorCommand {
  readonly name: string
  readonly version: number
  readonly input: z.ZodTypeAny
  target(input: unknown, ctx: SyncTargetContext): MaybePromise<SyncWriteTarget>
  handle(ctx: SyncWriteContext, input: unknown): Promise<unknown>
}

export class SyncWriteRegistry {
  private readonly commands = new Map<string, SyncCommand>()

  register<C extends AnyCommandContract, Out>(registration: ContractRegistration<C, Out>): void
  register<D extends CommandDef, Out>(registration: DefRegistration<D, Out>): void
  register(
    registration:
      | ContractRegistration<AnyCommandContract, unknown>
      | DefRegistration<CommandDef, unknown>,
  ): void {
    const command = normalise(registration)
    if (this.commands.has(command.name)) {
      // Two handlers for one name is two answers to "what does this write do";
      // failing at composition is the only point where nobody has relied on either.
      throw new Error(`sync write: ${command.name} is registered twice`)
    }
    this.commands.set(command.name, command)
  }

  lookup(name: string): SyncCommand | undefined {
    return this.commands.get(name)
  }

  names(): string[] {
    return [...this.commands.keys()]
  }
}

function normalise(
  registration:
    | ContractRegistration<AnyCommandContract, unknown>
    | DefRegistration<CommandDef, unknown>,
): SyncCommand {
  const target = (input: unknown, ctx: SyncTargetContext) =>
    registration.target(input as never, ctx)
  const handle = (ctx: SyncWriteContext, input: unknown) => registration.handle(ctx, input as never)
  if ('contract' in registration) {
    const { contract } = registration
    return {
      ...contractFrontDoor(contract),
      name: contract.name,
      version: contract.version,
      input: contract.input,
      target,
      handle,
    }
  }
  const { def, name } = registration
  return { ...defFrontDoor(def), name, version: 1, input: def.input, target, handle }
}
