/**
 * THE machine access gate for the COMMAND layer — `see` / `use` / `manage` over
 * owned compute (ADR 3 Amendment 1 D18, ADR 9 D6, readiness §3.1.4).
 *
 * ---------------------------------------------------------------------------
 * WHAT ALREADY EXISTED, AND WHY THIS IS NOT A SECOND COPY OF IT
 * ---------------------------------------------------------------------------
 *
 * Two halves of this were already landed and are REUSED verbatim rather than
 * restated:
 *
 *  - `@podium/protocol`'s `handshake/strategies/types.ts` owns the vocabulary —
 *    `MachineVerb`, the `MachineGrant` edge `(subject, verb)`, `ResolvedMachine`
 *    with its `owner: UserId | null`, and `machineUseAllowed(machine, subject)`,
 *    the all-in-one guard: an owner-less machine grants `use` to NOBODY.
 *  - `@podium/model`'s `predicates/machine-selection.ts` owns the consumption
 *    side — `MachineUseDecision` with no third "unknown" member (a third state
 *    reads as "probably fine" and the gate fails open), an ABSENT `machine.use`
 *    meaning not-evaluated, and `agentCapabilityRejection` checking the `use`
 *    denial FIRST, before liveness and before any inventory read, so a denied
 *    machine never answers questions about its owner's harnesses.
 *
 * That predicate's header says the decision arrives "at the server projection
 * boundary, which is where the principal lives". THIS MODULE IS THAT BOUNDARY.
 * It resolves a principal's verbs against a machine row and hands the verdict
 * to the predicate; it re-implements neither the ordering nor the guard, and it
 * teaches `packages/model` nothing about principals.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PLACE THIS DIFFERS FROM THE HANDSHAKE, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * `gateway/machine-directory.ts` reports `owner: null` for every machine, so
 * `machineUseAllowed` refuses `use` to everyone. That is right THERE: its
 * subject is an authenticating daemon peer, and no daemon should inherit a
 * human's execute rights.
 *
 * Here the subject is a human (or an agent acting for one), and refusing
 * everyone would take the product offline: nobody could spawn. The pre-accounts
 * answer is that the instance's one account IS the owner of every paired
 * machine — which is M3 ("a newly paired machine is private to its pairer")
 * evaluated in a world with exactly one pairer, not a widening of it. A second
 * human cannot authenticate today, and when POD-1079 lands the owner column
 * {@link ownershipFromMachines} reads it instead of defaulting, with no call
 * site here changing.
 *
 * ---------------------------------------------------------------------------
 * ABSENT vs UNAUTHORIZED vs UNREACHABLE
 * ---------------------------------------------------------------------------
 *
 * Three answers, and collapsing any two is a defect:
 *
 *  - **absent** — the principal cannot `see` it. INDISTINGUISHABLE from a
 *    machine id that was never paired: same code, same message. Otherwise spawn
 *    errors enumerate a colleague's fleet (D20's consistent-error rule).
 *  - **unauthorized** — visible, no `use` grant. "Ask its owner", not "wait".
 *  - **unreachable** — visible, granted, daemon offline. "Wake it up." Owned by
 *    `MachinesService.requireAgent`, not by this module.
 *
 * D18.5 draws the unauthorized/unreachable distinction ONLY inside the `see`
 * set, which is exactly what makes it compatible with the consistent-error
 * rule: outside that set there is nothing to be unreachable, because as far as
 * this principal is concerned there is nothing at all.
 */

import type { MachineUseDecision } from '@podium/model'
import type { MachineGrant, MachineId, MachineVerb, UserId } from '@podium/protocol'
import { machineUseAllowed } from '@podium/protocol'
import type { CommandPrincipal } from './command-principal'
import { INSTANCE_OWNER, onBehalfOfUser } from './command-principal'

/**
 * One machine's ownership facts — structurally the handshake's
 * `ResolvedMachine`, so {@link machineUseAllowed} consumes it unchanged.
 */
export interface MachineOwnershipRow {
  readonly machine: MachineId
  readonly owner: UserId | null
  readonly grants: readonly MachineGrant[]
  readonly name?: string
}

/**
 * Where ownership facts come from. Consulted LIVE at every decision (D16.1):
 * revoking a grant must stop the NEXT apply, with no reaper to write and
 * therefore none to forget.
 */
export interface MachineOwnershipIndex {
  /** `undefined` = no such machine row exists at all. */
  rowFor(machineId: string): MachineOwnershipRow | undefined
  /**
   * A per-delegation narrowing: which machine ids THIS agent session may use,
   * when its delegation restricts them. `undefined` = no narrowing declared,
   * which is NOT the empty set — the empty set denies everything.
   *
   * D16.2/D16.3: a sub-agent delegates from its parent and never widens, so
   * every link's narrowing applies to the leaf.
   */
  delegatedMachines?(agentSessionId: string): ReadonlySet<string> | undefined
}

/** The machines-service slice this module reads. */
export interface MachineRowSource {
  listMachines(): { id: string; name?: string }[]
}

/**
 * Ownership over today's `machines` table. The table has no owner column and no
 * grant list (POD-1079 / POD-318 own that), so every row resolves to the
 * instance's one account as owner with no additional grants.
 *
 * When the columns land, only the two marked lines change.
 */
export function ownershipFromMachines(machines: MachineRowSource): MachineOwnershipIndex {
  return {
    rowFor: (machineId) => {
      const row = machines.listMachines().find((candidate) => candidate.id === machineId)
      if (!row) return undefined
      return {
        machine: row.id as MachineId,
        // POD-1079: read `row.ownerUserId` here.
        owner: INSTANCE_OWNER,
        // POD-1079: read the grant edges here.
        grants: [],
        ...(row.name === undefined ? {} : { name: row.name }),
      }
    },
  }
}

const verbsFromRow = (row: MachineOwnershipRow, subject: UserId | null): Set<MachineVerb> => {
  const verbs = new Set<MachineVerb>()
  if (subject === null || row.owner === null) return verbs
  if (row.owner === subject) {
    // M1: the owner holds all three by default. Sharing is a deliberate act.
    verbs.add('see')
    verbs.add('use')
    verbs.add('manage')
    return verbs
  }
  for (const grant of row.grants) if (grant.subject === subject) verbs.add(grant.verb)
  // `use` goes through the shared guard rather than the loop above, so the
  // all-in-one rule has exactly one implementation.
  if (machineUseAllowed(row, subject)) verbs.add('use')
  // A grant of any verb necessarily discloses existence; `use` and `manage` are
  // meaningless without it. The converse never holds — see never implies use (M2).
  if (verbs.size > 0) verbs.add('see')
  return verbs
}

/**
 * The verbs a principal currently holds on one machine — resolved live over the
 * delegation chain (D16.2).
 *
 * A system principal holds `see` and `use`. It is constructed in-process only
 * and is unreachable from every transport (D21.2), so it is not an escalation
 * surface; denying it would break boot reconcile and the expiry sweeps, which
 * park and resurrect sessions with no human behind the call. Its writes are
 * still attributed `system` and still land in the scope of what they acted on —
 * that obligation is D17.5's, and it lives on the attribution pair, not here.
 * It deliberately does NOT hold `manage`.
 */
export function machineVerbsFor(
  principal: CommandPrincipal,
  machineId: string,
  ownership: MachineOwnershipIndex,
): ReadonlySet<MachineVerb> {
  const row = ownership.rowFor(machineId)
  if (!row) return new Set()
  if (principal.kind === 'system') return new Set<MachineVerb>(['see', 'use'])
  const held = verbsFromRow(row, onBehalfOfUser(principal))
  if (principal.kind !== 'agent') return held
  // The human's CURRENT rights are the ceiling; the agent's own delegation may
  // only narrow, never widen. Every link from the leaf to the root is applied,
  // so a child can never reach past its parent.
  for (const link of [principal.agentSessionId, ...principal.chain]) {
    const allowed = ownership.delegatedMachines?.(link)
    if (allowed !== undefined && !allowed.has(machineId)) {
      // Narrowed away: what the agent may SEE survives (fleet health and "your
      // session ran there" attribution are not execution); use/manage do not.
      return new Set([...held].filter((verb) => verb === 'see'))
    }
  }
  return held
}

/** Can this principal know the machine exists at all? */
export function canSeeMachine(
  principal: CommandPrincipal,
  machineId: string,
  ownership: MachineOwnershipIndex,
): boolean {
  return machineVerbsFor(principal, machineId, ownership).has('see')
}

/** The `use` verdict, in the vocabulary `@podium/model`'s predicate consumes. */
export function machineUseDecision(
  principal: CommandPrincipal,
  machineId: string,
  ownership: MachineOwnershipIndex,
): MachineUseDecision {
  return machineVerbsFor(principal, machineId, ownership).has('use') ? 'granted' : 'denied'
}

/** Why a machine reference failed, when it did. */
export type MachineAccessFailure = 'absent' | 'unauthorized'

/**
 * Resolve a caller-supplied machine id against this principal.
 *
 * `undefined` = the reference is good and execution may be ATTEMPTED. Whether
 * the daemon actually answers is reachability, reported separately by
 * `MachinesService.requireAgent` — that separation is D18.5.
 */
export function checkMachineUse(
  principal: CommandPrincipal,
  machineId: string,
  ownership: MachineOwnershipIndex,
): MachineAccessFailure | undefined {
  const verbs = machineVerbsFor(principal, machineId, ownership)
  // Invisible and never-paired are ONE answer on purpose.
  if (!verbs.has('see')) return 'absent'
  return verbs.has('use') ? undefined : 'unauthorized'
}

/**
 * The message for a failed machine reference.
 *
 * `absent` reuses VERBATIM the string `MachinesService.requireAgent` already
 * throws for a never-paired id, which is what MAKES invisible indistinguishable
 * from nonexistent. `unauthorized` reuses the string the same switch already
 * carries for the model predicate's `use` denial, so the refusal has one
 * wording and not two.
 */
export function machineAccessMessage(
  failure: MachineAccessFailure,
  machineId: string,
  machineName: string | undefined,
): string {
  return failure === 'absent'
    ? `unknown machine '${machineId}'`
    : `you do not have access to run agents on machine '${machineName ?? machineId}'`
}
