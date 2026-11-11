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
 * themselves. Each source write names its records before it runs. The Authority
 * builds them before and after that write and appends each changed record.
 *
 * STATEMENTS: the machines named, their grant edges and the members are read
 * for each build. The log appends only the changed records. The statement
 * count stays constant with the machines or members
 * (`records.statement-count.test.ts`).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  asMachineId,
  type MachineAccessWire,
  type MachineGrantEntry,
  type MachineId,
  machineAccessRowId,
  parseMachineAccessRowId,
  type UserId,
  type UserRole,
} from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import type { AffectedRecordSpec, EntityChangeSpec, LedgerWriter } from '@podium/sync'
import {
  type CheckoutReach,
  type CheckoutReaders,
  checkoutReaders,
  covers,
  reachOf,
} from '../../checkout-reach'
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
import type { SessionStore } from '../../store'
import type { CompareMachineRecords } from '../../store/machine-record-writes'
import type { MachineRecordFacts } from './service'

/** A member the records are written for. */
export interface RecordMember {
  readonly id: UserId
  readonly role: UserRole
}

export interface MachineRecordsDeps {
  /** The machines' record facts (all when `ids` is omitted). */
  facts(ids?: readonly MachineId[]): Promise<MachineRecordFacts[]>
  /** The machine grant edges of these machines, in one read. */
  grants(ids: readonly MachineId[]): Promise<ReadonlyMap<string, readonly RecordGrantEdge[]>>
  /** Every member who can act (enabled), with their role. */
  members(): Promise<readonly RecordMember[]>
  /**
   * Each member's recorded checkout reach (POD-6644), and the transaction the
   * records and the reach are written in together. Absent: no reach is
   * recorded (tests of the records alone).
   */
  readonly reach?: {
    of(
      ids: readonly MachineId[],
    ): Promise<ReadonlyMap<MachineId, ReadonlyMap<string, { reach: CheckoutReach }>>>
    /** Each member's lost checkouts on these machines (`checkout_lost`). */
    lost(
      ids: readonly MachineId[],
    ): Promise<ReadonlyMap<MachineId, ReadonlyMap<string, readonly { path: string; root: boolean }[]>>>
    /** The live checkouts of these machines, each marked root or not. */
    paths(
      ids: readonly MachineId[],
    ): Promise<ReadonlyMap<MachineId, readonly { path: string; root: boolean }[]>>
    apply(
      change: {
        readonly reach: readonly { userId: string; machineId: MachineId; reach: CheckoutReach }[]
        readonly lost: readonly {
          userId: string
          machineId: MachineId
          path: string
          root: boolean
        }[]
        readonly found: readonly { userId: string; machineId: MachineId; path: string }[]
      },
      at: string,
    ): Promise<void>
    transact<T>(fn: () => Promise<T>): Promise<T>
    now(): string
  }
}

/** One stored machine grant edge, as the records read it. */
export interface RecordGrantEdge {
  readonly grantee: string
  readonly verb: string
  readonly custody?: boolean
  /** When it was written; absent from fixtures that do not say. */
  readonly createdAt?: string
  /** The human who wrote it. */
  readonly onBehalfOf?: string | null
}

type Spec = EntityChangeSpec

const MACHINE_VERBS = new Set(['see', 'use', 'manage'])

/** The ownership index of the machines one write covers, from rows it read. */
function ownershipOf(
  facts: readonly MachineRecordFacts[],
  grants: ReadonlyMap<string, readonly RecordGrantEdge[]>,
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

/**
 * The grants a custodian or an admin reads on a machine (POD-6700): every
 * machine edge except the custodian's own, oldest first. The order is total, so
 * an unchanged set writes an unchanged row.
 */
export function grantEntriesOf(
  edges: readonly RecordGrantEdge[],
  custodian: UserId | null,
): MachineGrantEntry[] {
  return edges
    .filter((edge) => MACHINE_VERBS.has(edge.verb) && edge.grantee !== custodian)
    .map((edge) => ({
      grantee: edge.grantee as UserId,
      verb: edge.verb as MachineGrantEntry['verb'],
      grantedAt: edge.createdAt ?? '',
      grantedBy: (edge.onBehalfOf ?? null) as UserId | null,
    }))
    .sort(
      (a, b) =>
        a.grantedAt.localeCompare(b.grantedAt) ||
        a.grantee.localeCompare(b.grantee) ||
        a.verb.localeCompare(b.verb),
    )
}

/** One member's access row for one machine, or `undefined` when they may not see it.
 *  `edges` are the machine's stored grant edges; the custodian and admins read
 *  them as its grants list. */
export function accessRowFor(
  member: RecordMember,
  fact: MachineRecordFacts,
  ownership: MachineOwnershipIndex,
  readers?: CheckoutReaders,
  edges?: readonly RecordGrantEdge[],
): MachineAccessWire | undefined {
  const principal = userCommandPrincipal(member.id, member.role)
  const id = fact.machine.id
  if (!canSeeMachine(principal, id, ownership)) return undefined
  const verbs = machineVerbsFor(principal, id, ownership)
  const admin = principal.capability.role === 'admin'
  const use = fact.revokedAt ? 'denied' : machineUseDecision(principal, id, ownership)
  const unowned = ownership.rowFor(id)?.owner === null
  const transferable = !fact.revokedAt && canManageMachineCustody(principal, id, ownership)
  return {
    userId: member.id,
    machineId: id,
    use,
    owned: isMachineOwner(principal, id, ownership),
    transferable,
    unowned,
    adoptable: unowned && admin && verbs.has('manage'),
    supersedable: !fact.supersededBy && admin && verbs.has('manage'),
    ...(readers ? { checkoutReach: reachOf(member.id, readers) } : {}),
    ...(transferable && edges
      ? { grants: grantEntriesOf(edges, ownership.rowFor(id)?.owner ?? null) }
      : {}),
    ...fact.see,
    ...(use === 'granted' ? fact.use : {}),
  }
}

/**
 * The change specs for these machines' records (all machines when `ids` is
 * omitted), for every enabled member. Used by the builders and boot reconcile.
 */
export async function machineRecordSpecs(
  deps: MachineRecordsDeps,
  scope: { readonly ids?: readonly MachineId[] } = {},
): Promise<Spec[]> {
  const facts = await deps.facts(scope.ids)
  if (facts.length === 0) return []
  const [grants, members] = await Promise.all([
    deps.grants(facts.map((fact) => fact.machine.id)),
    deps.members(),
  ])
  const ownership = ownershipOf(facts, grants)
  // The admins who MANAGE every machine: the same set the feed reads.
  const admins = new Set(
    members.filter((member) => member.role === 'admin').map((member) => member.id),
  )
  const specs: Spec[] = []
  for (const fact of facts) {
    const id = fact.machine.id
    specs.push({ entity: 'machine', id, op: 'upsert', value: fact.machine })
    const readers = checkoutReaders(grants.get(id) ?? [], admins)
    for (const member of members) {
      const row = accessRowFor(member, fact, ownership, readers, grants.get(id) ?? [])
      const accessId = machineAccessRowId(member.id, id)
      specs.push(
        row === undefined
          ? { entity: 'machineAccess', id: accessId, op: 'remove' }
          : { entity: 'machineAccess', id: accessId, op: 'upsert', value: row },
      )
    }
  }
  return specs
}

/** Compare each source write inside its transaction, including checkout reach.
 * Nested writes leave records already named by their enclosing write to that
 * enclosing comparison. Custody and enrollment therefore publish their final
 * rows together, even though they write several grant edges along the way.
 */
export function makeMachineRecordCompare(
  store: Pick<SessionStore, 'machines' | 'users' | 'transact'>,
  writer: Pick<LedgerWriter, 'commit'>,
  reach: NonNullable<MachineRecordsDeps['reach']>,
): CompareMachineRecords {
  const scopes = new AsyncLocalStorage<{ readonly keys: ReadonlySet<string>; open: boolean }>()
  const keyOf = (record: AffectedRecordSpec) => `${record.entity}\0${record.id}`
  const resolve = async (ids: NonNullable<Parameters<CompareMachineRecords>[0]['machines']>) =>
    typeof ids === 'function' ? await ids() : ids
  return async (scope, write, commandWriter = writer) => {
    if (!scope.member && !scope.display && Array.isArray(scope.machines) && !scope.machines.length)
      return await write()
    const inherited = scopes.getStore()
    return await store.transact(async () => {
      let names: AffectedRecordSpec[] = []
      const { result, changes } = await commandWriter.commit({
        affects: async () => {
          const machines = scope.machines ? await resolve(scope.machines) : []
          const display = scope.display ? await resolve(scope.display) : []
          const members = machines.length ? await store.users.recordMembers() : []
          names = machines.flatMap((id): AffectedRecordSpec[] => [
            { entity: 'machine', id },
            ...members.map((member) => ({
              entity: 'machineAccess' as const,
              id: machineAccessRowId(member.id, asMachineId(id)),
            })),
          ])
          names.push(...display.map((id) => ({ entity: 'machine' as const, id })))
          if (scope.member) {
            const member = scope.member
            names.push(
              ...(await store.machines.recordIds()).map((id) => ({
                entity: 'machineAccess' as const,
                id: machineAccessRowId(member, id),
              })),
            )
          }
          names = names.filter((record) => !inherited?.open || !inherited.keys.has(keyOf(record)))
          return names
        },
        write: async () => {
          const held = {
            keys: new Set([...(inherited?.open ? inherited.keys : []), ...names.map(keyOf)]),
            open: true,
          }
          try {
            return await scopes.run(held, write)
          } finally {
            held.open = false
          }
        },
      })
      await recordReach(reach, changes)
      return result
    })
  }
}

/** The boot re-check has no source write. It remains a reconcile until POD-6221. */
export async function reconcileMachineRecords(
  deps: MachineRecordsDeps,
  writer: Pick<LedgerWriter, 'reconcile'>,
): Promise<void> {
  const run = async () => {
    const specs = await machineRecordSpecs(deps)
    for (const entity of ['machine', 'machineAccess'] as const) {
      const changes = await writer.reconcile(
        entity,
        specs.flatMap((spec) =>
          spec.entity === entity && spec.op === 'upsert'
            ? [{ id: spec.id, value: spec.value }]
            : [],
        ),
      )
      if (deps.reach) await recordReach(deps.reach, changes)
    }
  }
  await (deps.reach ? deps.reach.transact(run) : run())
}

async function recordReach(
  reach: NonNullable<MachineRecordsDeps['reach']>,
  appended: readonly MetadataChange[],
): Promise<void> {
  const moved = appended.flatMap((change) => {
    if (change.entity !== 'machineAccess') return []
    const next: CheckoutReach = change.op === 'upsert' ? (change.value?.checkoutReach ?? 'none') : 'none'
    return [{ ...parseMachineAccessRowId(change.id), next }]
  })
  if (moved.length === 0) return
  const machines = [...new Set(moved.map((row) => row.machineId))]
  const [stored, held] = await Promise.all([reach.of(machines), reach.lost(machines)])
  const before = (row: (typeof moved)[number]) =>
    stored.get(row.machineId)?.get(row.userId)?.reach ?? 'none'
  // A shrink records exactly the live checkouts the old reach covered and the
  // new one does not. The machine's paths are read only when one shrank.
  const shrank = moved.filter(
    (row) => (before(row) === 'all' && row.next !== 'all') || (before(row) !== 'none' && row.next === 'none'),
  )
  const paths =
    shrank.length === 0
      ? new Map<MachineId, readonly { path: string; root: boolean }[]>()
      : await reach.paths([...new Set(shrank.map((row) => row.machineId))])
  const lost = shrank.flatMap((row) =>
    (paths.get(row.machineId) ?? [])
      .filter((checkout) => covers(before(row), checkout) && !covers(row.next, checkout))
      .map((checkout) => ({ userId: row.userId, machineId: row.machineId, ...checkout })),
  )
  // A lost checkout the new reach covers again is re-admitted, so it leaves.
  const found = moved.flatMap((row) =>
    (held.get(row.machineId)?.get(row.userId) ?? [])
      .filter((checkout) => covers(row.next, checkout))
      .map((checkout) => ({ userId: row.userId, machineId: row.machineId, path: checkout.path })),
  )
  await reach.apply(
    {
      reach: moved
        .filter((row) => before(row) !== row.next)
        .map((row) => ({ userId: row.userId, machineId: row.machineId, reach: row.next })),
      lost,
      found,
    },
    reach.now(),
  )
}
