/**
 * THE PLAIN COMMAND REGISTRATIONS (ADR 12 D8 and D9, POD-6593).
 *
 * The plain path's counterpart to `SyncWriteRegistry`: a command with no synced
 * effect is a REGISTRATION, not a route. It supplies its declaration (an ADR 3
 * contract, or a `defineCommands` entry and its wire name), an optional target
 * check, and a handler. Every transport's adapter is generated from it
 * (`modules/write-routes/`) and runs it through the plain entry
 * (`entry.ts`): coarse check, parse, target check, then the handler inside the
 * plain scope. A handler never sees the request's transport.
 *
 * ONLINE ONLY, AT REGISTRATION. A declaration a client could queue (an
 * offline-eligible delivery class, or the outbox among its transports) is
 * refused here, when the registry is composed: such a command can only be a
 * sync registration. That is the converse of the sync registry's rule, and the
 * two together leave no queued command off the entry point.
 *
 * ONE INSTANCE. Plain commands hold no per-server state of their own: what a
 * handler works on comes from the context the transport hands it. So the
 * registry is composed once, from the family declarations, in `commands.ts`.
 */

import type { AnyCommandContract, CommandDef } from '@podium/commands'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { Context } from '../../trpc'
import type { PlainContext } from '../../write-contexts'
import { contractFrontDoor, defFrontDoor, type FrontDoorCommand } from '../front-door'
import type { IssueCaller } from '../issues/command-ctx'
import {
  assertPlainContract,
  type PlainCommandReply,
  type PlainTargetCheck,
  runPlainCommand,
  runPlainDef,
} from './entry'

/**
 * What a plain handler gets: who is asking, the command, the caller as issue
 * authorization reads it, and the composed modules. No writer: a plain command
 * cannot write synced data.
 *
 * `request` is the tRPC context, on a tRPC call only: a family whose service
 * reads more than the modules (the instance's config, the accounts repository,
 * the request's repos) selects it from there ({@link trpcRequest}), and such a
 * command is served on tRPC alone.
 */
export interface PlainHandlerContext extends PlainContext {
  readonly caller: IssueCaller
  readonly modules: RegistryModules
  readonly request?: Context | undefined
}

/** The tRPC request a tRPC-only plain handler selects its service from. */
export function trpcRequest(ctx: PlainHandlerContext): Context {
  if (ctx.request === undefined) {
    throw new Error(
      `plain command: ${ctx.command} is served on tRPC only, and this call has no tRPC request`,
    )
  }
  return ctx.request
}

type PlainHandle = (ctx: PlainHandlerContext, input: unknown) => unknown

/** A registration over an ADR 3 `CommandContract`. */
export interface PlainContractRegistration {
  readonly contract: AnyCommandContract
  readonly targetPermitted?: PlainTargetCheck | undefined
  readonly handle: PlainHandle
}

/** A registration over a `defineCommands` entry, which carries no name of its own. */
export interface PlainDefRegistration {
  /** The dotted wire name, `namespace.key`. */
  readonly name: string
  readonly def: CommandDef
  readonly targetPermitted?: PlainTargetCheck | undefined
  readonly handle: PlainHandle
}

export type PlainRegistration = PlainContractRegistration | PlainDefRegistration

/** One plain command as the adapters read it, whichever format declared it. */
export interface PlainCommand {
  readonly name: string
  readonly door: FrontDoorCommand
  readonly registration: PlainRegistration
}

/** One call of a registered plain command, as a transport hands it over. */
export interface PlainCall {
  readonly principal: CommandPrincipal
  readonly transport: 'trpc' | 'cli' | 'mcp' | 'relay'
  readonly input: unknown
  readonly caller: IssueCaller
  readonly modules: RegistryModules
  /** The tRPC context, on a tRPC call. */
  readonly request?: Context | undefined
}

export class PlainCommandRegistry {
  private readonly commands = new Map<string, PlainCommand>()

  register(registration: PlainRegistration): void {
    const command = normalise(registration)
    if (this.commands.has(command.name)) {
      throw new Error(`plain command: ${command.name} is registered twice`)
    }
    this.commands.set(command.name, command)
  }

  lookup(name: string): PlainCommand | undefined {
    return this.commands.get(name)
  }

  names(): string[] {
    return [...this.commands.keys()]
  }

  /** Run one call through the plain entry. A refusal is a reply. */
  async run(name: string, call: PlainCall): Promise<PlainCommandReply<unknown>> {
    const command = this.commands.get(name)
    if (command === undefined) throw new Error(`plain command: no registration named ${name}`)
    const { registration } = command
    const run = async (input: unknown, ctx: PlainContext) =>
      await registration.handle(
        { ...ctx, caller: call.caller, modules: call.modules, request: call.request },
        input,
      )
    const common = {
      principal: call.principal,
      transport: call.transport,
      input: call.input,
      targetPermitted: registration.targetPermitted,
      run,
    }
    return 'contract' in registration
      ? await runPlainCommand({ ...common, contract: registration.contract })
      : await runPlainDef({ ...common, name: registration.name, def: registration.def })
  }
}

function normalise(registration: PlainRegistration): PlainCommand {
  if ('contract' in registration) {
    assertPlainContract(registration.contract)
    return {
      name: registration.contract.name,
      door: contractFrontDoor(registration.contract),
      registration,
    }
  }
  assertPlainDef(registration.name, registration.def)
  return { name: registration.name, door: defFrontDoor(registration.def), registration }
}

/** A `defineCommands` entry on the plain path is online only, as a contract is. */
export function assertPlainDef(name: string, def: CommandDef): void {
  if (def.offline === 'eligible') {
    throw new Error(
      `${name} is served on the plain path but is offline-eligible: a plain command is never queued`,
    )
  }
}
