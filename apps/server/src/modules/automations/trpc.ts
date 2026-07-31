import { familyState } from '../derived-family'
/**
 * THE DERIVED AUTOMATION SURFACE (POD-735, the 3.11 cutover) — every automation
 * tRPC mutation, produced from the joined table in `registry.ts` rather than
 * written out.
 *
 * `router.ts` spreads the result into its `automations` router alongside the two
 * QUERIES, which are not derived: they have no contracts, because a `visibility`
 * class describes what a command WRITES and a read writes nothing (the same line
 * `modules/workflows/queries.ts` and `SPEC_CONTRACTS` draw).
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS THERE BEFORE
 * ---------------------------------------------------------------------------
 *
 * Four `.mutation(` procedures in `router.ts`, each naming an inline schema
 * (`automationInput`, `automationPatch`) and a method on `AutomationsService`.
 * That shape is a second declaration of a surface that already declares itself:
 * what these commands validate, which transports serve them, and what class of
 * state they write are all facts of `AUTOMATION_CONTRACTS`. A hand-written
 * procedure beside a contract is a second answer to "how is this authorized".
 *
 * `scripts/audit-automation-commands.ts` fails the build if a `.mutation(`
 * reappears inside the `automations:` router literal, and
 * `automation-cutover.audit.test.ts` checks the RUNNING object — the pairing
 * POD-732 paid for, because an empty router satisfies every absence claim
 * perfectly.
 *
 * ---------------------------------------------------------------------------
 * EXPOSURE DRIVES THE WIRE, IN BOTH DIRECTIONS (ADR 3 D3, default-closed)
 * ---------------------------------------------------------------------------
 *
 * A mutation appears here if and only if its contract declares `trpc`. Nobody
 * maintains a second list saying so, and {@link assertSurfaceMatchesContracts}
 * checks the built object at MODULE LOAD in both directions: a contract that
 * declares `trpc` and produced no procedure, or a procedure whose contract does
 * not declare `trpc`, throws before the server serves a request. Without the
 * second direction an empty surface would satisfy the first perfectly.
 *
 * ---------------------------------------------------------------------------
 * OPERATOR-ONLY, CHECKED AND NOT ONLY DECLARED
 * ---------------------------------------------------------------------------
 *
 * An automation spawns agent sessions, so it is not an agent-reachable surface.
 * The contracts say so (`operatorOnly`, and an exposure set that names `trpc`
 * alone); {@link assertOperatorOnly} refuses at module load to build a procedure
 * for a contract that has grown an agent transport, so the declaration cannot
 * drift away from what is served without the server failing to start. The other
 * half — that the daemon relay ACTUALLY refuses `automations.*` — is asserted
 * against the real `AgentRelayGate` in `automation-cutover.audit.test.ts`, with a
 * positive control, because a gate that refuses everything would satisfy the
 * refusal claim without meaning anything.
 *
 * ---------------------------------------------------------------------------
 * WHY OUTPUT TYPES SURVIVE THE DERIVATION
 * ---------------------------------------------------------------------------
 *
 * `AppRouter` inference is what makes `trpc.automations.setEnabled.mutate(…)`
 * checked at all in `apps/web`. A naive generic derivation types every result
 * `unknown` and the damage lands silently on every call site rather than here, so
 * the output is read off the JOINED HANDLER's return type — the registry pairs
 * contract with handler, so the handler is in scope — and is not written down a
 * second time.
 */

import { AUTOMATION_CONTRACTS } from '@podium/commands'
import { TRPCError, type TRPCMutationProcedure } from '@trpc/server'
import type { z } from 'zod'
import { mods, t, type Context } from '../../trpc'
import {
  AUTOMATION_COMMANDS,
  type AutomationProcName,
  automationCommandsOn,
  isAutomationCommandExposedOn,
} from './registry'
import type { AutomationsService } from './service'

/** The transports that would make this surface agent-reachable. Named as a set so
 *  the check below is about the CLASS of transport and not about one tag someone
 *  happened to think of. */
const AGENT_TRANSPORTS = ['relay', 'mcp', 'cli', 'peer', 'outbox'] as const

type MutationProcedure<N extends AutomationProcName> = TRPCMutationProcedure<{
  meta: unknown
  input: z.input<(typeof AUTOMATION_COMMANDS)[N]['contract']['input']>
  output: ReturnType<(typeof AUTOMATION_COMMANDS)[N]['handler']>
}>

/**
 * One mutation, built out of its contract: the CONTRACT'S OWN schema instance for
 * validation (so a restated copy is impossible rather than merely discouraged),
 * and the joined handler for the body.
 */
function automationMutation<N extends AutomationProcName>(name: N): MutationProcedure<N> {
  const { contract, handler } = AUTOMATION_COMMANDS[name]
  if (!contract.exposure.includes('trpc')) {
    throw new Error(`automations.${name} does not declare the trpc transport`)
  }
  // The table is heterogeneous by construction, so at THIS point the handler's
  // input type is the INTERSECTION of all four and the parsed input is the UNION —
  // TypeScript cannot pair them up here. It does not need to: each pairing is
  // checked where it is declared (`AUTOMATION_COMMANDS` is `satisfies
  // Record<AutomationContractName, AutomationCommand>`, and each handler annotates
  // the input it accepts), and `MutationProcedure<N>` re-derives the per-command
  // types for the client. This erasure is the one place the two meet — the same
  // shape `modules/fleet/trpc.ts` carries, for the same reason.
  const run = handler as (
    service: AutomationsService,
    input: unknown,
    principal: NonNullable<Context['principal']>,
  ) => unknown
  return t.procedure.input(contract.input).mutation(({ ctx, input }) => {
    if (!ctx.principal) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'authentication required' })
    }
    return run(familyState(ctx).modules.automations, input, ctx.principal)
  }) as unknown as MutationProcedure<N>
}

/**
 * The operator-only claim, refused at module load rather than reported later.
 *
 * Reads the CONTRACT TABLE and not the built object: a contract that grew `relay`
 * would still build a perfectly good tRPC procedure, so the thing to catch is the
 * declaration, before anything is served.
 */
function assertOperatorOnly(): void {
  for (const [name, contract] of Object.entries(AUTOMATION_CONTRACTS)) {
    for (const transport of AGENT_TRANSPORTS) {
      if (contract.exposure.includes(transport)) {
        throw new Error(
          `automations.${name} declares the \`${transport}\` transport — automations spawn agent ` +
            'sessions and are operator-only (POD-735); opening one needs a policy decision, not an ' +
            'exposure edit',
        )
      }
    }
  }
}

/**
 * The both-directions exposure check, over the object that will actually be
 * served — so an empty one fails the first loop rather than satisfying it.
 */
function assertSurfaceMatchesContracts(built: Record<string, unknown>): void {
  for (const name of Object.keys(AUTOMATION_CONTRACTS) as AutomationProcName[]) {
    const present = built[name] !== undefined
    if (isAutomationCommandExposedOn(name, 'trpc') && !present) {
      throw new Error(
        `automation contract ${name} declares trpc exposure but the derived router would not serve it`,
      )
    }
    if (!isAutomationCommandExposedOn(name, 'trpc') && present) {
      throw new Error(
        `the derived router serves automations.${name}, whose contract does not declare trpc exposure`,
      )
    }
  }
}

type AutomationProcedures = { [N in AutomationProcName]: MutationProcedure<N> }

/**
 * Every derived automation procedure, keyed by its bare proc name — spread into
 * the `automations:` router in `router.ts`, which then contains no mutation of its
 * own.
 *
 * Built by iterating the TABLE, not a list written here: a fifth contract is
 * served because it was declared, and the only way to remove a procedure is to
 * remove its declaration.
 */
export function automationProcedures(): AutomationProcedures {
  assertOperatorOnly()
  const record: Record<string, unknown> = {}
  for (const name of automationCommandsOn('trpc')) {
    record[name] = automationMutation(name)
  }
  assertSurfaceMatchesContracts(record)
  return record as AutomationProcedures
}
