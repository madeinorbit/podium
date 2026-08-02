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
 * everyone would take the product offline: nobody could spawn.
 *
 * POD-1079 REPLACED THE DEFAULT WITH A COLUMN. {@link ownershipFromMachines} now
 * reads `machines.owner_user_id` and the `grants` edge table, live, and no call
 * site changed — the seam POD-1075 left is exactly the seam that was filled. The
 * qualifier that survives is about the TRANSPORT, not this module: there is
 * still one shared password, so every connection resolves to one `UserId`
 * ({@link deviceGradeSoleOwner}, and `audit:machine-grants` holds its call sites
 * to an allowlist). This gate can refuse a second person; today's login cannot
 * produce one.
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
import type {
  MachineGrant,
  MachineId,
  MachineVerb,
  ResolvedMachine,
  UserId,
} from '@podium/protocol'
import { machineUseAllowed } from '@podium/protocol'
import type { CommandPrincipal } from './command-principal'
import { onBehalfOfUser } from './command-principal'

/**
 * One machine's ownership facts — DERIVED from the handshake's
 * `ResolvedMachine`, not restated in its shape.
 *
 * It was a four-key structural copy until POD-642 named the type-level half of
 * the vocabulary-fork rule. The schema half is familiar (compose the instance,
 * assert `toBe`); the type half needs stating separately, because a forked TYPE
 * has no runtime value to compare — an identity check cannot exist for it, so
 * the protection has to be the derivation itself.
 *
 * `Pick` rather than the whole type because `directoryContext` is the
 * handshake's own passthrough and nothing here may read it. That narrowing is
 * real; the four keys it keeps are not this module's to define.
 */
export type MachineOwnershipRow = Pick<
  ResolvedMachine,
  'machine' | 'owner' | 'grants' | 'name'
>

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

/**
 * The grant-edge slice this module reads (POD-1079). One call per decision, not
 * a cache: ADR 9 D2 rule 4 evaluates a grant LIVE, so removing the edge must
 * stop the NEXT apply with no invalidation step in between.
 *
 * OPTIONAL ON THE SOURCE, and the omission is the CLOSED direction: a source
 * with no grant table resolves owner-only — fewer verbs, never more. A required
 * method would have forced every fixture to supply an empty one, and an empty
 * fake is exactly what makes a grant test unable to say YES.
 */
export interface MachineGrantSource {
  grantsForMachine?(machineId: string): { grantee: string; verb: string }[]
}

/**
 * The machines-service slice this module reads.
 *
 * A SEPARATE method from `listMachines()`, deliberately (POD-1079). The listing
 * is the WIRE projection, and ownership is a server-side fact: putting an owner
 * id on `MachineWire` would ship every machine's owner to every client that can
 * see the machine, which is a disclosure decision nobody made. This reads the
 * stored rows instead.
 *
 * `ownerUserId` is REQUIRED and nullable rather than optional: a source that
 * cannot say who owns a machine must say `null` — "nobody, so `use` is refused
 * to everyone" — and an absent key would be indistinguishable from a source that
 * simply forgot to thread it.
 */
export interface MachineRowSource extends MachineGrantSource {
  ownershipRows(): { id: string; name?: string; ownerUserId: string | null }[]
}


/** The verbs a machine grant can carry, as a runtime membership test. A stored
 *  verb this build does not know (`read`/`write` belong to other classes, and a
 *  newer build may write a fifth) is DROPPED rather than admitted. */
const MACHINE_VERBS: readonly string[] = ['see', 'use', 'manage']

/**
 * Ownership over the `machines` table and the `grants` edge table.
 *
 * Both reads are LIVE on every call. That is the D16.1 obligation stated as
 * code: an owner change or a revoked share takes effect at the next decision,
 * and there is no reaper to write and therefore none to forget. The machine
 * ROWS come through `MachinesService`, which caches them and invalidates on
 * every write; the GRANTS deliberately bypass that cache.
 *
 * The source supplies BOTH halves — see {@link MachineGrantSource} for why the
 * grant half is optional and why omitting it is the closed direction.
 */
export function ownershipFromMachines(machines: MachineRowSource): MachineOwnershipIndex {
  return {
    rowFor: (machineId) => {
      const row = machines.ownershipRows().find((candidate) => candidate.id === machineId)
      if (!row) return undefined
      const edges = (machines.grantsForMachine?.(row.id) ?? [])
        .filter((edge) => MACHINE_VERBS.includes(edge.verb))
        .map((edge) => ({ subject: edge.grantee as UserId, verb: edge.verb as MachineVerb }))
      return {
        machine: row.id as MachineId,
        owner: row.ownerUserId === null ? null : (row.ownerUserId as UserId),
        grants: edges,
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
  // NO ROW MEANS NO VERBS, with no arm underneath it. There used to be one: `'local'`
  // and `'__local__'` were sentinels that routinely had no machines row, so a gate
  // reading "no row ⇒ absent" refused the product's own default state, and the fix was
  // a SYNTHESIZED row owned by the instance installer. POD-318 removed the premise —
  // `ensureHostMachine` writes this host's row before the first session exists, and
  // every other machine's row is written when it pairs — so an unknown machine id is
  // now exactly what it says it is, and the default-closed reading is the only one.
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
  return checkMachineVerb(principal, machineId, ownership, 'use')
}

/**
 * The same resolution for ANY verb (POD-1079) — `manage` is what the fleet's
 * rename / revoke / repo-write family needs, and `see` is what a listing needs.
 *
 * ONE implementation, so the absent-versus-unauthorized split cannot be right
 * for `use` and wrong for `manage`. The ordering is the load-bearing part and it
 * is the same for every verb: a principal that cannot SEE the machine is told
 * the machine does not exist, in the same words a never-paired id gets, BEFORE
 * the verb is considered. A gate that checked the verb first would answer
 * "forbidden" for a colleague's machine and "unknown" for a nonexistent one —
 * an existence oracle over somebody else's fleet (D20's consistent-error rule,
 * readiness §3.1.2).
 */
export function checkMachineVerb(
  principal: CommandPrincipal,
  machineId: string,
  ownership: MachineOwnershipIndex,
  verb: MachineVerb,
): MachineAccessFailure | undefined {
  const verbs = machineVerbsFor(principal, machineId, ownership)
  // Invisible and never-paired are ONE answer on purpose.
  if (!verbs.has('see')) return 'absent'
  return verbs.has(verb) ? undefined : 'unauthorized'
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
