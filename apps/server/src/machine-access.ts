/** Machine access is resolved from durable personal grant edges. Role-based
 * admin management is layered on top; custody controls transfer and release. */

import type { MachineId, MachineUseDecision, SessionId, UserId } from '@podium/model'
import type { MachineGrant, MachineVerb, ResolvedMachine } from '@podium/protocol'
import type { CommandPrincipal } from './command-principal'
import { onBehalfOfUser } from './command-principal'
import { currentReadScope, inExplicitReadScope, readScopeSlot } from './store/executor/read-scope'

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
export type MachineOwnershipRow = Pick<ResolvedMachine, 'machine' | 'owner' | 'name'> & { grants: (MachineGrant & { custody?: boolean })[]; revokedAt?: string | null; daemonAssigned?: boolean; daemonAvailable?: boolean }

/**
 * Where ownership facts come from. A direct index may read live per question;
 * rule-46 sites bind one to the lease for an authorization pass, then discard
 * it so a revocation stops the next apply without an invalidation step.
 */
export interface MachineOwnershipIndex {
  /** `undefined` = no such machine row exists at all. */
  rowFor(machineId: MachineId): MachineOwnershipRow | undefined
  /**
   * A per-delegation narrowing: which machine ids THIS agent session may use,
   * when its delegation restricts them. `undefined` = no narrowing declared,
   * which is NOT the empty set — the empty set denies everything.
   *
   * D16.2/D16.3: a sub-agent delegates from its parent and never widens, so
   * every link's narrowing applies to the leaf.
   */
  delegatedMachines?(agentSessionId: SessionId): ReadonlySet<string> | undefined
}

/**
 * The grant-edge slice this module reads (POD-1079). One call per decision, not
 * a cache: ADR 9 D2 rule 4 evaluates a grant LIVE, so removing the edge must
 * stop the NEXT apply with no invalidation step in between.
 *
 * Omission of a grant source fails closed: no personal rights are inferred.
 */
export interface MachineGrantSource {
  grantsForMachine?(machineId: MachineId): { grantee: string; verb: string; custody?: boolean }[]
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
 * The wire carries viewer-relative ownership and an explicit unowned state,
 * never the personal grantee's identity.
 *
 * Custody and personal rights are read separately from the grant edge source.
 */
export interface MachineRowSource extends MachineGrantSource {
  ownershipRows(): { id: MachineId; name?: string; revokedAt?: string | null; daemonAssigned?: boolean; daemonAvailable?: boolean }[]
}

/** Async repository-backed form, resolved before a synchronous policy pass begins. */
export interface AsyncMachineRowSource {
  ownershipRows():
    | { id: MachineId; name?: string; revokedAt?: string | null; daemonAssigned?: boolean; daemonAvailable?: boolean }[]
    | Promise<{ id: MachineId; name?: string; revokedAt?: string | null; daemonAssigned?: boolean; daemonAvailable?: boolean }[]>
  grantsForMachine?(
    machineId: MachineId,
  ):
    | { grantee: string; verb: string; custody?: boolean }[]
    | Promise<{ grantee: string; verb: string; custody?: boolean }[]>
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
        .map((edge) => ({ subject: edge.grantee as UserId, verb: edge.verb as MachineVerb, custody: edge.custody === true }))
      return {
        machine: row.id,
        owner: machineCustodian(edges),
        daemonAssigned: row.daemonAssigned === true,
        daemonAvailable: row.daemonAvailable === true,
        revokedAt: row.revokedAt,
        grants: edges,
        ...(row.name === undefined ? {} : { name: row.name }),
      }
    },
  }
}

/** Resolve repository-backed ownership once before a non-yielding policy pass. */
export async function ownershipSnapshotFromMachines(
  machines: AsyncMachineRowSource,
): Promise<MachineOwnershipIndex> {
  const rows = await machines.ownershipRows()
  const resolved = await Promise.all(
    rows.map(async (row): Promise<MachineOwnershipRow> => {
      const edges = ((await machines.grantsForMachine?.(row.id)) ?? [])
        .filter((edge) => MACHINE_VERBS.includes(edge.verb))
        .map((edge) => ({ subject: edge.grantee as UserId, verb: edge.verb as MachineVerb, custody: edge.custody === true }))
      return {
        machine: row.id, owner: machineCustodian(edges), grants: edges,
        daemonAssigned: row.daemonAssigned === true,
        daemonAvailable: row.daemonAvailable === true,
        revokedAt: row.revokedAt,
        ...(row.name === undefined ? {} : { name: row.name }),
      }
    }),
  )
  const byId = new Map(resolved.map((row) => [row.machine, row]))
  return { rowFor: (machineId) => byId.get(machineId) }
}

const ownershipByPassSlot = readScopeSlot(
  () => new WeakMap<MachineRowSource, Map<MachineId, MachineOwnershipRow | undefined>>(),
)

/**
 * Ownership facts held for exactly one authorization pass (spec rule 46).
 *
 * The explicit read scope is the pass's lease. Each machine is read at most
 * once through its slot, so two checks in one externally observed answer cannot
 * splice together pre- and post-revocation states. A new scope owns a new slot,
 * so the next apply re-reads and sees every revocation committed before lease
 * acquisition.
 */
export function ownershipFromMachinesPerPass(machines: MachineRowSource): MachineOwnershipIndex {
  if (!inExplicitReadScope()) {
    throw new Error(
      'ownershipFromMachinesPerPass requires an explicit read scope for each authorization pass',
    )
  }
  const snapshots = currentReadScope().slot(ownershipByPassSlot)
  let rows = snapshots.get(machines)
  if (!rows) {
    rows = new Map()
    snapshots.set(machines, rows)
  }
  const live = ownershipFromMachines(machines)
  return {
    rowFor: (machineId) => {
      if (rows.has(machineId)) return rows.get(machineId)
      const row = live.rowFor(machineId)
      rows.set(machineId, row)
      return row
    },
  }
}

/** Custody is an explicit attribute, never an implied verb or row owner. */
export function machineCustodian(edges: readonly (MachineGrant & { custody?: boolean })[]): UserId | null {
  const custodians = edges.filter((edge) => edge.custody === true && edge.verb === 'manage')
  return custodians.length === 1 ? custodians[0]!.subject : null
}

const verbsFromRow = (row: MachineOwnershipRow, subject: UserId | null): Set<MachineVerb> => {
  const verbs = new Set<MachineVerb>()
  // Retained shares are inert once custody is released. Every admitted verb is
  // nevertheless an explicit edge; custody itself never supplies use.
  if (subject === null || machineCustodian(row.grants) === null) return verbs
  for (const grant of row.grants) if (grant.subject === subject) verbs.add(grant.verb)
  if (verbs.size > 0) verbs.add('see')
  return verbs
}

/**
 * The verbs a principal currently holds on one machine — resolved live over the
 * delegation chain (D16.2).
 *
 * Rule 4 exception (POD-4255): in-process system jobs hold `see`, and `use`
 * only on existing, non-revoked machines with exactly one explicit custodian
 * and an assigned, available daemon. No personal use grant is required.
 * SessionClientPlane.reattachMessageFor needs this verdict to rebind survivors
 * after daemon reconnect and census recovery. Transport principals never mint
 * this authority (D21.2); writes remain attributed to system, with no human
 * on whose behalf it acts (D17.5). It deliberately does NOT hold `manage`.
 */
export function machineVerbsFor(
  principal: CommandPrincipal,
  machineId: MachineId,
  ownership: MachineOwnershipIndex,
): ReadonlySet<MachineVerb> {
  // NO ROW MEANS NO VERBS, with no arm underneath it. There used to be one: `'local'`
  // and `'__local__'` were sentinels that routinely had no machines row, so a gate
  // reading "no row ⇒ absent" refused the product's own default state, and the fix was
  // a SYNTHESIZED row owned by the instance installer. POD-318 removed the premise —
  // explicit enrollment writes every machine row (including this host at setup),
  // never boot or a resolver — so an unknown machine id is
  // now exactly what it says it is, and the default-closed reading is the only one.
  const row = ownership.rowFor(machineId)
  if (!row) return new Set()
  if (principal.kind === 'system') {
    return new Set<MachineVerb>(row.revokedAt || machineCustodian(row.grants) === null || !row.daemonAssigned || !row.daemonAvailable ? ['see'] : ['see', 'use'])
  }
  const held = row.revokedAt
    ? new Set<MachineVerb>(machineCustodian(row.grants) === onBehalfOfUser(principal) ? ['see'] : [])
    : verbsFromRow(row, onBehalfOfUser(principal))
  if (row.daemonAssigned !== true || row.daemonAvailable !== true) held.delete('use')
  // Administration grants custody, never execution consent (D19.4b).
  if (principal.capability.role === 'admin') {
    held.add('manage')
    held.add('see')
  }
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
  machineId: MachineId,
  ownership: MachineOwnershipIndex,
): boolean {
  return machineVerbsFor(principal, machineId, ownership).has('see')
}

/** The `use` verdict, in the vocabulary `@podium/model`'s predicate consumes. */
export function machineUseDecision(
  principal: CommandPrincipal,
  machineId: MachineId,
  ownership: MachineOwnershipIndex,
): MachineUseDecision {
  return machineVerbsFor(principal, machineId, ownership).has('use') ? 'granted' : 'denied'
}

/** The viewer-relative ownership fact; admin custody authority is separate. */
export function isMachineOwner(
  principal: CommandPrincipal,
  machineId: MachineId,
  ownership: MachineOwnershipIndex,
): boolean {
  const row = ownership.rowFor(machineId)
  const human = onBehalfOfUser(principal)
  if (!row || machineCustodian(row.grants) === null || human === null) return false
  return machineCustodian(row.grants) === human
}

/** Custody authority, narrowed by every agent delegation link just like use/manage. */
export function canManageMachineCustody(
  principal: CommandPrincipal,
  machineId: MachineId,
  ownership: MachineOwnershipIndex,
): boolean {
  return !ownership.rowFor(machineId)?.revokedAt && principal.kind !== 'system' &&
    machineVerbsFor(principal, machineId, ownership).has('manage') &&
    (principal.capability.role === 'admin' || isMachineOwner(principal, machineId, ownership))
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
  machineId: MachineId,
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
  machineId: MachineId,
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
  machineId: MachineId | '',
  machineName: string | undefined,
): string {
  return failure === 'absent'
    ? `unknown machine '${machineId}'`
    : `you do not have access to run agents on machine '${machineName ?? machineId}'`
}
