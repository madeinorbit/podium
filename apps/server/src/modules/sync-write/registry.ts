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
import type { SyncSubmitRefusal } from '@podium/protocol'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { SyncCommandWriter } from '../../write-contexts'
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

/**
 * A resolver's refusal IN THE FAMILY'S OWN WORDS (POD-6418): the target check
 * decided no, and the family says why, as its handler would have. For a family
 * whose callers read the reason (the workflow CLI turns "approval required" into
 * an approval request). The words must not tell a missing record from an
 * invisible one (ADR 3 Amendment 1 D20.2): one answer for both, as `undefined`.
 */
export interface TargetRefused {
  readonly syncWriteRefused: SyncSubmitRefusal
}
export const refuseTarget = (refusal: SyncSubmitRefusal): TargetRefused => ({
  syncWriteRefused: refusal,
})
export const isTargetRefused = (target: SyncWriteTarget): target is TargetRefused =>
  typeof target === 'object' && target !== null && 'syncWriteRefused' in target

/** `undefined` refuses: the target is missing, or this principal cannot see it.
 *  The two are deliberately one answer (no existence oracle, ADR 3 Amendment D20). */
export type SyncWriteTarget = AuthTarget | NoTarget | TargetRefused | undefined

/** What a target resolver may know: who is asking. Never the request. */
export interface SyncTargetContext {
  readonly principal: CommandPrincipal
  /**
   * The caller's out-of-scope confirmation (ADR 3 D8 outcome 3), as the envelope
   * carried it: an agent's `--outside-scope`. A family whose own scope rule reads
   * it (the workflows' agent scope arm) decides with it, as `authorize` does.
   */
  readonly confirmed: boolean
}

/** The Authority-bound writers of the unit of work, bound to the command's own
 *  write scope (ADR 12 D9). Every change row they append carries the command's
 *  provenance. */
export type SyncWriteLedger = SyncCommandWriter

/**
 * What a handler gets (ADR 12 D9's `SyncWriteContext`). Its `ledger` is the only
 * writer bound to a `sync` scope: the entry point mints one per call
 * (`write-contexts.ts`).
 */
export interface SyncWriteContext {
  readonly principal: CommandPrincipal
  /** The client-minted id of this command: its dedup key and its provenance. */
  readonly mutationId: MutationId
  /** ADR 3 D13's precondition, as the envelope carried it. The handler compares
   *  it and throws `SyncWriteRefused({ kind: 'conflict' })` when it is stale. */
  readonly expectedRevision: number | undefined
  /** The caller's out-of-scope confirmation, as the envelope carried it. The
   *  target check has already honoured it; a family whose service decides
   *  scope again (shipping) reads it here. */
  readonly confirmed: boolean
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

/**
 * Called when the handler threw, AFTER its unit of work rolled back, with what it
 * threw. For a family that keeps a trail of refused writes (the settings audit,
 * POD-421): a trail row written inside the unit would roll back with the write
 * it records. It runs outside any unit; it must not change the outcome.
 */
type RolledBack<In> = (ctx: SyncTargetContext, input: In, error: unknown) => Promise<void>

/** A registration over an ADR 3 `CommandContract`. */
export interface ContractRegistration<C extends AnyCommandContract, Out> {
  readonly contract: C
  target(input: z.infer<C['input']>, ctx: SyncTargetContext): MaybePromise<SyncWriteTarget>
  handle(ctx: SyncWriteContext, input: z.infer<C['input']>): Promise<Out>
  readonly rolledBack?: RolledBack<z.infer<C['input']>>
}

/** A registration over a `defineCommands` entry, which carries no name of its own. */
export interface DefRegistration<D extends CommandDef, Out> {
  readonly name: string
  readonly def: D
  target(input: z.infer<D['input']>, ctx: SyncTargetContext): MaybePromise<SyncWriteTarget>
  handle(ctx: SyncWriteContext, input: z.infer<D['input']>): Promise<Out>
  readonly rolledBack?: RolledBack<z.infer<D['input']>>
}

/** One command as the entry point reads it, whichever format declared it. */
export interface SyncCommand extends FrontDoorCommand {
  readonly name: string
  readonly version: number
  readonly input: z.ZodTypeAny
  target(input: unknown, ctx: SyncTargetContext): MaybePromise<SyncWriteTarget>
  handle(ctx: SyncWriteContext, input: unknown): Promise<unknown>
  rolledBack?(ctx: SyncTargetContext, input: unknown, error: unknown): Promise<void>
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
  const hook = registration.rolledBack as RolledBack<unknown> | undefined
  const rolledBack =
    hook === undefined
      ? {}
      : {
          rolledBack: (ctx: SyncTargetContext, input: unknown, error: unknown) =>
            hook(ctx, input, error),
        }
  if ('contract' in registration) {
    const { contract } = registration
    return {
      ...contractFrontDoor(contract),
      name: contract.name,
      version: contract.version,
      input: contract.input,
      target,
      handle,
      ...rolledBack,
    }
  }
  const { def, name } = registration
  return {
    ...defFrontDoor(def),
    name,
    version: 1,
    input: def.input,
    target,
    handle,
    ...rolledBack,
  }
}
