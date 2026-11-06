/**
 * THE DERIVED AUTOMATION SURFACE (POD-735, the 3.11 cutover) — every automation
 * tRPC mutation, produced from the joined table in `registry.ts` rather than
 * written out.
 *
 * ON THE SYNC WRITE ENTRY POINT SINCE POD-6418. The four writes are registered on
 * `sync.submit` (`sync-write.ts`), and the procedures built here are thin
 * adapters onto it, kept for shipped clients (see {@link automationProcedures}).
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
import type { MutationProcedures } from '../derived-family'
import { legacyRouteAdapters } from '../sync-write/family'
import {
  type AUTOMATION_COMMANDS,
  type AutomationProcName,
  isAutomationCommandExposedOn,
} from './registry'
import { AUTOMATION_SYNC_FAMILY } from './sync-write'

/** The transports that would make this surface agent-reachable. Named as a set so
 *  the check below is about the CLASS of transport and not about one tag someone
 *  happened to think of. */
const AGENT_TRANSPORTS = ['relay', 'mcp', 'cli', 'peer', 'outbox'] as const

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

type AutomationProcedures = MutationProcedures<typeof AUTOMATION_COMMANDS>

/**
 * Every automation write procedure, keyed by its bare proc name — spread into
 * the `automations:` router in `router.ts`, which then contains no mutation of its
 * own.
 *
 * LEGACY(remove-after: 2027-03): since POD-6418 every automation write goes
 * through `sync.submit`, and these four routes are thin adapters onto it. The
 * desktop app ships its own build of the web app, whose Automations tab calls
 * them; removing them breaks that build's automation edits against this server.
 */
export function automationProcedures(): AutomationProcedures {
  assertOperatorOnly()
  const built = legacyRouteAdapters(AUTOMATION_SYNC_FAMILY, [
    'create',
    'update',
    'setEnabled',
    'remove',
  ])
  assertSurfaceMatchesContracts(built)
  return built
}
