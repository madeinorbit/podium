/**
 * A MACHINE'S SYNCED RECORDS, AS THE SERVER WRITES THEM (POD-6644, design
 * POD-5620 §1.12).
 *
 * Two kinds, one write:
 *
 *  - `machine`: the display facts every member reads (deployment substrate).
 *  - `machineAccess`: one row per (member, machine) for each member who may SEE
 *    the machine, holding that member's own verdicts and the operational facts
 *    they may read. A fact only `use` admits (harness history, inventory) is on
 *    the row only when the member holds `use`. A member who may not see the
 *    machine has no row: a row they held is removed.
 *
 * The verdicts are today's (`machinesForPrincipal` in `sessions/command-ctx.ts`),
 * decided by `machine-access.ts` for each member as a person acting for
 * themselves. Every row is computed and handed to `capture`, which writes only
 * what changed: a call after a write that moved no record fact appends nothing.
 *
 * STATEMENTS: the machines named, their grant edges and the members are read
 * once each; the change log is read once for the batch and appended once. The
 * count does not grow with machines or members
 * (`records.statement-count.test.ts`).
 */

import {
  type MachineAccessWire,
  type MachineId,
  machineAccessRowId,
  type UserId,
  type UserRole,
} from '@podium/model'
import { userCommandPrincipal } from '../../command-principal'
import {
  canManageMachineCustody,
  canSeeMachine,
  isMachineOwner,
  type MachineOwnershipIndex,
  type MachineOwnershipRow,
  machineCustodian,
  machineUseDecision,
  machineVerbsFor,
} from '../../machine-access'
import type { MachineRecordFacts, MachineRecordWriter } from './service'

/** A member the records are written for. */
export interface RecordMember {
  readonly id: UserId
  readonly role: UserRole
}

export interface MachineRecordsDeps {
  /** The machines' record facts (all when `ids` is omitted). */
  facts(ids?: readonly MachineId[]): Promise<MachineRecordFacts[]>
  /** The machine grant edges of these machines, in one read. */
  grants(
    ids: readonly MachineId[],
  ): Promise<ReadonlyMap<string, readonly { grantee: string; verb: string; custody?: boolean }[]>>
  /** Every member who can act (enabled), with their role. */
  members(): Promise<readonly RecordMember[]>
}

type Spec = Parameters<MachineRecordWriter['capture']>[0][number]

const MACHINE_VERBS = new Set(['see', 'use', 'manage'])

/** The ownership index of the machines one write covers, from rows it read. */
function ownershipOf(
  facts: readonly MachineRecordFacts[],
  grants: ReadonlyMap<string, readonly { grantee: string; verb: string; custody?: boolean }[]>,
): MachineOwnershipIndex {
  const rows = new Map<string, MachineOwnershipRow>()
  for (const fact of facts) {
    const id = fact.machine.id
    const edges = (grants.get(id) ?? [])
      .filter((edge) => MACHINE_VERBS.has(edge.verb))
      .map((edge) => ({
        subject: edge.grantee as UserId,
        verb: edge.verb as 'see' | 'use' | 'manage',
        custody: edge.custody === true,
      }))
    rows.set(id, {
      machine: id,
      owner: machineCustodian(edges),
      grants: edges,
      revokedAt: fact.revokedAt,
      name: fact.machine.name,
    })
  }
  return { rowFor: (machineId) => rows.get(machineId) }
}

/** One member's access row for one machine, or `undefined` when they may not see it. */
export function accessRowFor(
  member: RecordMember,
  fact: MachineRecordFacts,
  ownership: MachineOwnershipIndex,
): MachineAccessWire | undefined {
  const principal = userCommandPrincipal(member.id, member.role)
  const id = fact.machine.id
  if (!canSeeMachine(principal, id, ownership)) return undefined
  const verbs = machineVerbsFor(principal, id, ownership)
  const admin = principal.capability.role === 'admin'
  const use = fact.revokedAt ? 'denied' : machineUseDecision(principal, id, ownership)
  const unowned = ownership.rowFor(id)?.owner === null
  return {
    userId: member.id,
    machineId: id,
    use,
    owned: isMachineOwner(principal, id, ownership),
    transferable: !fact.revokedAt && canManageMachineCustody(principal, id, ownership),
    unowned,
    adoptable: unowned && admin && verbs.has('manage'),
    supersedable: !fact.supersededBy && admin && verbs.has('manage'),
    ...fact.see,
    ...(use === 'granted' ? fact.use : {}),
  }
}

/**
 * The change specs for these machines' records (all machines when `ids` is
 * omitted), for every member, plus removals of `formerMembers`' rows.
 */
export async function machineRecordSpecs(
  deps: MachineRecordsDeps,
  scope: { readonly ids?: readonly MachineId[]; readonly formerMembers?: readonly UserId[] } = {},
): Promise<Spec[]> {
  const facts = await deps.facts(scope.ids)
  if (facts.length === 0) return []
  const [grants, members] = await Promise.all([
    deps.grants(facts.map((fact) => fact.machine.id)),
    deps.members(),
  ])
  const ownership = ownershipOf(facts, grants)
  const specs: Spec[] = []
  for (const fact of facts) {
    const id = fact.machine.id
    specs.push({ entity: 'machine', id, op: 'upsert', value: fact.machine })
    for (const member of members) {
      const row = accessRowFor(member, fact, ownership)
      const accessId = machineAccessRowId(member.id, id)
      specs.push(
        row === undefined
          ? { entity: 'machineAccess', id: accessId, op: 'remove' }
          : { entity: 'machineAccess', id: accessId, op: 'upsert', value: row },
      )
    }
    for (const former of scope.formerMembers ?? []) {
      if (members.some((member) => member.id === former)) continue
      specs.push({ entity: 'machineAccess', id: machineAccessRowId(former, id), op: 'remove' })
    }
  }
  return specs
}

/** Write the records on `writer`. Unchanged rows append nothing. */
export async function writeMachineRecords(
  deps: MachineRecordsDeps,
  writer: MachineRecordWriter,
  scope: { readonly ids?: readonly MachineId[]; readonly formerMembers?: readonly UserId[] } = {},
): Promise<void> {
  const specs = await machineRecordSpecs(deps, scope)
  if (specs.length > 0) await writer.capture(specs)
}
