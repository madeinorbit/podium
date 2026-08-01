/**
 * THE FLEET AUTHORIZATION GATE (POD-1079) — the runtime that finally READS
 * `roleFloor` and `machineVerb`.
 *
 * POD-384 declared both fields on all ten fleet contracts and said in as many
 * words that nothing enforces them. This is that enforcement, and it is DERIVED
 * from the declaration rather than written per handler: `trpc.ts` derives every
 * procedure through {@link fleetAuthzFailure}, so a fleet command added
 * tomorrow is gated by whatever its contract declares, without anybody
 * remembering to add a check.
 *
 * ---------------------------------------------------------------------------
 * TWO GATES, IN ORDER, AND THE ORDER IS THE DECISION
 * ---------------------------------------------------------------------------
 *
 * 1. `roleFloor` — may this principal ATTEMPT the command at all? Compared
 *    against the INSTANCE account role (ADR 9 D1.4), not the capability role
 *    already on the transport. POD-384's reasoning, preserved verbatim because
 *    it is the part that matters: a floor is never a statement about which ROWS
 *    may be touched. Nine fleet contracts are `member` precisely so that D6 M1's
 *    OWNER column stays reachable, which leaves the real refusal here.
 *
 * 2. `machineVerb` — may this principal do THAT to THAT machine? Resolved
 *    through `machine-access.ts` against the machine's owner and its live grant
 *    edges.
 *
 * The floor runs first because it is the cheaper and coarser question, and
 * because a principal below the floor must not learn anything about the machine
 * it named. Reversing them would answer "unknown machine" versus "forbidden" to
 * someone who may not attempt the command at all.
 *
 * ---------------------------------------------------------------------------
 * INVISIBLE FAILS AS NONEXISTENT (D20 / readiness §3.1.2)
 * ---------------------------------------------------------------------------
 *
 * A machine the principal cannot SEE produces `NOT_FOUND` with the SAME message
 * a never-paired id produces — `machineAccessMessage('absent', …)`, the string
 * `MachinesService.requireAgent` already throws. Only INSIDE the `see` set does
 * a `FORBIDDEN` appear, which is what keeps the unauthorized/unreachable
 * distinction (M5) compatible with the consistent-error rule.
 */

import { FLEET_CONTRACTS, type FleetContractName } from '@podium/commands'
import { isAdminGrade, type UserRole } from '@podium/model'
import type { MachineVerb } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { type CommandPrincipal, onBehalfOfUser, resolvePrincipal } from '../../command-principal'
import {
  checkMachineVerb,
  type MachineOwnershipIndex,
  machineAccessMessage,
  ownershipFromMachines,
} from '../../machine-access'
import { sessionSpawnerParentId } from '../../steward'
import type { Context } from '../../trpc'
import { mods } from '../../trpc'

// ---------------------------------------------------------------------------
// WHICH MACHINE a command is about — declared per command, never guessed
// ---------------------------------------------------------------------------

/**
 * What a fleet command's input says about its target machine.
 *
 * A CLOSED union rather than "read `input.machineId` if it is there", because
 * the three cases refuse differently and a missing key must not silently become
 * the permissive one. `machines.rename` names its machine in `id`, the repo and
 * discovery family in `machineId`, and `discovery.refreshRepos` names none at
 * all because it fans out over the whole fleet.
 */
export type FleetTarget =
  /** A machine named by the caller. */
  | { readonly kind: 'machine'; readonly machineId: string }
  /** The selector was omitted: the handler resolves `machines.defaultMachine()`,
   *  so that is what must be gated — not "nothing". */
  | { readonly kind: 'default' }
  /** The command touches every machine it can reach. The gate narrows the fan-out
   *  to the ones this principal holds the verb on rather than refusing outright. */
  | { readonly kind: 'fleet-wide' }
  /** The contract declares no `machineVerb` — there is no machine to gate.
   *  `machines.pairingCode` is the only one: no machine exists yet. */
  | { readonly kind: 'none' }

const named = (machineId: string | undefined): FleetTarget =>
  machineId === undefined ? { kind: 'default' } : { kind: 'machine', machineId }

/**
 * The target of every fleet command, by name.
 *
 * `satisfies Record<FleetContractName, …>` is the load-bearing part: a command
 * added to the contract table with no entry here is a COMPILE ERROR, not an
 * ungated command. That is the same both-directions discipline `FLEET_COMMANDS`
 * uses, and it is what stops this table from being the place enforcement quietly
 * stops covering the family.
 */
export const FLEET_TARGETS = {
  'machines.rename': (input: unknown) => named((input as { id: string }).id),
  'machines.share': (input: unknown) => named((input as { id: string }).id),
  'machines.unshare': (input: unknown) => named((input as { id: string }).id),
  'machines.revoke': (input: unknown) => named((input as { id: string }).id),
  // No machine exists yet, so there is no owner column that could admit anyone —
  // the `admin` floor is the only gate, exactly as POD-384's rationale says.
  'machines.pairingCode': () => ({ kind: 'none' }) as FleetTarget,
  'repos.add': (input: unknown) => named((input as { machineId?: string }).machineId),
  'repos.addMany': (input: unknown) => named((input as { machineId?: string }).machineId),
  'repos.remove': (input: unknown) => named((input as { machineId?: string }).machineId),
  'repos.setPrefix': (input: unknown) => named((input as { machineId?: string }).machineId),
  // Input is `z.void()`: it refreshes every online machine.
  'discovery.refreshRepos': () => ({ kind: 'fleet-wide' }) as FleetTarget,
  'discovery.scanFolder': (input: unknown) => named((input as { machineId?: string }).machineId),
  'discovery.scanMachine': (input: unknown) => named((input as { machineId: string }).machineId),
} satisfies Record<FleetContractName, (input: unknown) => FleetTarget>

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

/**
 * Does this account grade satisfy the contract's floor?
 *
 * `undefined` is NOT a role: it means the principal has no readable, enabled
 * account, and it satisfies NO floor. That is the fail-closed arm and it is the
 * reason this takes `UserRole | undefined` rather than defaulting a missing row
 * to `member` somewhere upstream.
 */
export function roleSatisfiesFloor(role: UserRole | undefined, floor: 'admin' | 'member'): boolean {
  if (role === undefined) return false
  return floor === 'admin' ? isAdminGrade(role) : true
}

/**
 * The account role behind a principal, or `undefined` when there is none.
 *
 * A SYSTEM principal has no account and is deliberately treated as satisfying
 * every floor — the same carve-out `machineVerbsFor` makes, for the same reason:
 * it is constructed in-process only and is unreachable from every transport
 * (D21.2), while boot reconcile and the expiry sweeps genuinely have no human
 * behind them. It is handled by the caller below rather than by inventing a role
 * for it here, because "the steward is an admin" is exactly the service account
 * ADR 9 D8 S5 rejects.
 */
function accountRoleOf(principal: CommandPrincipal, ctx: Context): UserRole | undefined {
  const user = onBehalfOfUser(principal)
  if (user === null) return undefined
  return ctx.registry.sessionStore.users.roleOf(user)
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface FleetAuthzDeps {
  principal: CommandPrincipal
  ownership: MachineOwnershipIndex
  role: UserRole | undefined
  /** `machines.defaultMachine()` — resolved lazily, so a command that names its
   *  machine never consults it. */
  defaultMachine: () => string
  /** Every machine id this principal might touch on a fleet-wide command. */
  allMachineIds: () => string[]
  machineName: (machineId: string) => string | undefined
}

/**
 * The refusal for one command + input, or `undefined` to proceed.
 *
 * Returned rather than thrown so the decision is testable without a tRPC
 * request, and so the middleware has exactly one place that converts a decision
 * into an HTTP status.
 */
export function fleetAuthzFailure(
  name: FleetContractName,
  input: unknown,
  deps: FleetAuthzDeps,
): TRPCError | undefined {
  const contract = FLEET_CONTRACTS[name]
  const { policy } = contract

  // 1 — the floor. A system principal is in-process only and has no account.
  if (deps.principal.kind !== 'system' && !roleSatisfiesFloor(deps.role, policy.roleFloor)) {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: `${name} requires an ${policy.roleFloor} account`,
    })
  }

  // 2 — the verb. Absent means the contract places no work on owned compute.
  //
  // Read through `CommandPolicy` rather than off the union: `machineVerb` is the
  // one optional field in the shape (framework.ts: "only a contract that places
  // work on owned compute has one"), so the literal union of twelve policies has
  // members without the key. The narrowing is what the field's optionality MEANS
  // — it is not a cast around a missing declaration.
  const fleetPolicy = policy as {
    machineVerb?: MachineVerb
    machineSharingAuthority?: 'owner-only'
  }
  const verb = fleetPolicy.machineVerb
  if (verb === undefined) return undefined

  const target = (FLEET_TARGETS[name] as (i: unknown) => FleetTarget)(input)
  switch (target.kind) {
    case 'none':
      return undefined
    case 'machine': {
      const refusal = machineRefusal(target.machineId, verb, deps)
      if (refusal) return refusal
      return fleetPolicy.machineSharingAuthority === 'owner-only'
        ? machineOwnerRefusal(target.machineId, deps)
        : undefined
    }
    case 'default':
      return machineRefusal(deps.defaultMachine(), verb, deps)
    case 'fleet-wide': {
      // A fan-out is narrowed, not refused — EXCEPT when it would touch nothing,
      // which is a refusal the caller must be able to tell from "no daemons
      // online". A principal holding the verb on no machine at all is told the
      // same thing it would be told about any single machine it cannot see.
      const reachable = deps.allMachineIds().filter((id) => mayUse(id, verb, deps))
      return reachable.length > 0
        ? undefined
        : new TRPCError({
            code: 'NOT_FOUND',
            message: machineAccessMessage('absent', '', undefined),
          })
    }
  }
}

const mayUse = (machineId: string, verb: MachineVerb, deps: FleetAuthzDeps): boolean =>
  checkMachineVerb(deps.principal, machineId, deps.ownership, verb) === undefined

function machineOwnerRefusal(machineId: string, deps: FleetAuthzDeps): TRPCError | undefined {
  const row = deps.ownership.rowFor(machineId)
  const human = onBehalfOfUser(deps.principal)
  if (!row || row.owner === null || human === null) {
    return new TRPCError({
      code: 'NOT_FOUND',
      message: machineAccessMessage('absent', machineId, undefined),
    })
  }
  return row.owner === human
    ? undefined
    : new TRPCError({
        code: 'FORBIDDEN',
        message: 'only the machine owner may change sharing',
      })
}

function machineRefusal(
  machineId: string,
  verb: MachineVerb,
  deps: FleetAuthzDeps,
): TRPCError | undefined {
  const failure = checkMachineVerb(deps.principal, machineId, deps.ownership, verb)
  if (failure === undefined) return undefined
  const message = machineAccessMessage(failure, machineId, deps.machineName(machineId))
  // Invisible and never-paired produce the SAME code and the SAME string.
  return failure === 'absent'
    ? new TRPCError({ code: 'NOT_FOUND', message })
    : new TRPCError({ code: 'FORBIDDEN', message })
}

/**
 * Build the gate's dependencies from a tRPC context.
 *
 * The principal is resolved HERE, at the transport seam, from the capability —
 * never from the input. `parentSessionOf` walks live `spawnedBy` rows so a
 * sub-agent's delegation chain roots at exactly one human (D16.2), which is the
 * same construction `sessionCommandCtx` uses; a second answer to "who is
 * calling" is what ADR 3 D7 exists to prevent.
 */
export function fleetAuthzDeps(ctx: Context): FleetAuthzDeps {
  const machines = mods(ctx).machines
  const sessions = mods(ctx).sessions
  const principal = resolvePrincipal(ctx.capability, {
    parentSessionOf: (sessionId) =>
      sessionSpawnerParentId(
        sessions.listSessions().find((s) => s.sessionId === sessionId)?.spawnedBy,
      ),
  })
  return {
    principal,
    ownership: ownershipFromMachines(machines),
    role: accountRoleOf(principal, ctx),
    defaultMachine: () => machines.defaultMachine(),
    allMachineIds: () => machines.ownershipRows().map((row) => row.id),
    machineName: (machineId) => machines.ownershipRows().find((r) => r.id === machineId)?.name,
  }
}

/** The `use` predicate for a fleet-wide fan-out, so the command touches only the
 *  machines the principal may actually place work on. */
export function fleetUsePredicate(deps: FleetAuthzDeps, verb: MachineVerb) {
  return (machineId: string): boolean => mayUse(machineId, verb, deps)
}
