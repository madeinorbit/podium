/**
 * A PLAIN FAMILY'S DECLARATION (ADR 12 D8, POD-6593): its name, its service
 * selector and its command table, as data. The registrations are made from it
 * once, in `commands.ts`; its tRPC routes are generated from those
 * registrations by `plainFamilyProcedures` (`family.ts`). Kept apart from both so
 * the registry can be composed without importing a route module.
 */

import type { CommandPrincipal } from '../../command-principal'
import { type AnyDerivedCommand, type FamilyState, familyState } from '../derived-family'
import type { PlainTargetCheck } from './entry'
import type { PlainContractRegistration } from './registry'

/** A plain command's table entry may carry its target check (`entry.ts`, step 4). */
export type PlainCommandEntry = AnyDerivedCommand & { readonly targetPermitted?: PlainTargetCheck }

/**
 * A plain family. Its service selector may also read the caller's PRINCIPAL, for
 * a plain command that sends a sync command as its caller (`cloud.moveSession`'s
 * local hibernate, POD-6417). Its queries select without one.
 */
export interface PlainFamily<Svc, C extends Record<string, AnyDerivedCommand>> {
  /** The router key, for messages. */
  readonly family: string
  readonly service: (state: FamilyState, principal?: CommandPrincipal) => Svc
  readonly commands: C
}

/** Declare a plain family. Runtime-trivial; it pins the table's literal type. */
export const definePlainFamily = <Svc, C extends Record<string, AnyDerivedCommand>>(
  family: PlainFamily<Svc, C>,
): PlainFamily<Svc, C> => family

/** One registration per command of `family`, each under its contract's name. */
export function plainFamilyRegistrations<Svc, C extends Record<string, AnyDerivedCommand>>(
  family: PlainFamily<Svc, C>,
): PlainContractRegistration[] {
  return (Object.values(family.commands) as PlainCommandEntry[]).map((command) => ({
    contract: command.contract,
    targetPermitted: command.targetPermitted,
    handle: (ctx, input) =>
      command.handler(family.service(familyState(ctx.request), ctx.principal), input),
  }))
}
