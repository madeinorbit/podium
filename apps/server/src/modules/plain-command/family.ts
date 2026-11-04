/**
 * THE PLAIN FAMILY BUILDER (ADR 12 D8, POD-6360): the tRPC adapter onto the
 * plain command path, for the families whose commands have no synced effect.
 *
 * It takes the same declaration as `derivedFamilyProcedures` — a family name, a
 * service selector, a command table and a query table — and differs in one place:
 * each command runs through {@link runPlainCommand}, so the front door (coarse
 * check, then parse) and the plain scope apply to every one of them. The queries
 * are built by the derived builder unchanged.
 *
 * THE PROCEDURE DOES NOT PARSE. Its `.input` is a pass-through, so the coarse
 * check runs before the input is looked at (ADR 3 `errorConsistency`); a schema on
 * the procedure would answer a refused caller's bad input with a validation error.
 * The client's types are unaffected: `FamilyProcedures` reads each input type off
 * the contract's own schema.
 */

import type { AnyCommandContract } from '@podium/commands'
import { TRPCError } from '@trpc/server'
import { t } from '../../trpc'
import {
  type AnyDerivedCommand,
  type AnyDerivedQuery,
  assertSurfaceMatchesDeclarations,
  type DerivedFamily,
  derivedFamilyProcedures,
  type FamilyProcedures,
  familyState,
} from '../derived-family'
import {
  assertPlainContract,
  type PlainCommandRefusal,
  type PlainTargetCheck,
  runPlainCommand,
} from './entry'

/** A plain command's table entry may carry its target check (`entry.ts`, step 4). */
type PlainCommandEntry = AnyDerivedCommand & { readonly targetPermitted?: PlainTargetCheck }

/** The input is parsed by the plain entry, after the coarse check. */
const unparsed = (raw: unknown): unknown => raw

/** A front-door refusal as the tRPC error this transport has always answered. */
export function plainRefusalError(
  contract: AnyCommandContract,
  refusal: PlainCommandRefusal,
): TRPCError {
  switch (refusal.kind) {
    case 'unauthorized':
      return new TRPCError({
        code: 'FORBIDDEN',
        message: `${contract.name} is not permitted for this caller`,
      })
    case 'invalid':
      // The cause's message, exactly as tRPC's own input validation reports it.
      return new TRPCError({ code: 'BAD_REQUEST', cause: refusal.error })
  }
}

export function plainFamilyProcedures<
  Svc,
  C extends Record<string, AnyDerivedCommand>,
  Q extends Record<string, AnyDerivedQuery>,
>(spec: DerivedFamily<Svc, C, Q>): FamilyProcedures<C, Q> {
  const built: Record<string, unknown> = derivedFamilyProcedures({ ...spec, commands: {} })

  for (const [name, command] of Object.entries(spec.commands) as [string, PlainCommandEntry][]) {
    const { contract } = command
    assertPlainContract(contract)
    if (!contract.exposure.includes('trpc')) continue
    built[name] = t.procedure.input(unparsed).mutation(async ({ ctx, input }) => {
      const reply = await runPlainCommand({
        contract,
        principal: ctx.principal,
        transport: 'trpc',
        input,
        targetPermitted: command.targetPermitted,
        run: (parsed) => command.handler(spec.service(familyState(ctx)), parsed),
      })
      if (reply.outcome === 'rejected') throw plainRefusalError(contract, reply.refusal)
      return reply.result
    })
  }

  assertSurfaceMatchesDeclarations(spec.family, spec.commands, spec.queries, built)
  return built as FamilyProcedures<C, Q>
}
