/**
 * THE CREDENTIAL LIST — the credentials a person owns or was given, each with what
 * they may do with it (`credentials.list`, and the credential refs the issue service
 * resolves). Its own module, apart from the query family, so a reader of credential
 * refs does not import the command family (`store-port.ts`).
 *
 * Eight reads whatever the number of credentials: the caller's own, the placements
 * of theirs still on a machine, the machines' inventories, the grants to the caller
 * or to all members, those credentials, the grants of every listed credential (own
 * ones too, for `sharedWith`), the granters' standing, and the allowed machines.
 */

import {
  ALL_MEMBERS_GRANTEE,
  type CredentialId,
  type CredentialShare,
  CredentialView,
  type MachineId,
  type UserId,
} from '@podium/model'
import { DEFAULT_HOME_ID, type HomeHarness, homeIdFor } from '@podium/protocol'
import type { CredentialRecord, PlacementKind } from '../../store/credentials'
import type { GrantRow } from '../../store/grants'
import type { MachineRecord } from '../../store/types'
import { homeHarnessFor } from './home-removers'
import { accessFrom, CREDENTIAL_RESOURCE_KIND, type CredentialAccessLevel } from './may-use'
import type { CredentialsStore } from './store-port'

/** Its grants as the owner and a manager read them; a use holder gets none. */
function sharesOf(edges: readonly GrantRow[]): CredentialShare[] {
  return edges.flatMap((edge): CredentialShare[] => {
    if (edge.verb !== 'use' && edge.verb !== 'manage') return []
    const grantee = edge.grantee === ALL_MEMBERS_GRANTEE ? 'all-members' : { userId: edge.grantee }
    return [{ grantee, verb: edge.verb } as CredentialShare]
  })
}

/** What Podium placed on a machine and has not removed (§8). */
type LivePlacement = {
  machineId: MachineId
  kind: PlacementKind
  homeId?: string
  state: 'present' | 'removal-pending'
}

type HomeView = CredentialView['homes'][number]
type MachineInventories = readonly Pick<MachineRecord, 'id' | 'inventory' | 'revokedAt'>[]

/** One home's login state as its machine reports it. */
function reportedState(
  machine: MachineInventories[number] | undefined,
  harness: HomeHarness,
  homeId: string,
): HomeView['state'] {
  const agent = machine?.inventory?.agents.find((a) => a.kind === harness)
  const login =
    agent?.logins?.find((l) => l.homeId === homeId) ??
    (homeId === DEFAULT_HOME_ID ? agent?.login : undefined)
  return login?.state ?? 'unknown'
}

/**
 * Where a credential's login is (§4: read from the machines' inventories, not
 * copied into the row): each home Podium placed for it, with the state its
 * machine reports, and each machine whose own directory reports the same
 * account. A placement being removed shows as `removal-pending`.
 */
function homesOf(
  record: CredentialRecord,
  placements: readonly LivePlacement[],
  machines: MachineInventories,
): HomeView[] {
  const harness = homeHarnessFor(record.type)
  const byId = new Map(machines.map((m) => [m.id, m] as const))
  const homes: HomeView[] = []
  const seen = new Set<string>()
  const add = (home: HomeView) => {
    const key = `${home.machineId}\u0000${home.homeId}`
    if (seen.has(key)) return
    seen.add(key)
    homes.push(home)
  }
  for (const p of placements) {
    // A copied login file is in the harness's own directory.
    const homeId =
      p.kind === 'home'
        ? (p.homeId ?? (harness ? homeIdFor(record.id, harness) : DEFAULT_HOME_ID))
        : DEFAULT_HOME_ID
    add({
      machineId: p.machineId,
      homeId,
      state:
        p.state === 'removal-pending' || !harness
          ? 'removal-pending'
          : reportedState(byId.get(p.machineId), harness, homeId),
    })
  }
  const fingerprint = record.identity.fingerprint
  if (harness && fingerprint && record.status !== 'revoked') {
    for (const machine of machines) {
      if (machine.revokedAt) continue
      const agent = machine.inventory?.agents.find((a) => a.kind === harness)
      const own = agent?.logins?.find((l) => l.homeId === DEFAULT_HOME_ID) ?? agent?.login
      if (own?.state === 'in' && own.identity?.fingerprint === fingerprint) {
        add({ machineId: machine.id, homeId: DEFAULT_HOME_ID, state: 'in' })
      }
    }
  }
  return homes
}

function viewOf(
  record: CredentialRecord,
  access: CredentialAccessLevel,
  allowedMachines: readonly string[],
  edges: readonly GrantRow[],
  homes: readonly HomeView[],
): CredentialView {
  return CredentialView.parse({
    id: record.id,
    ownerUserId: record.ownerUserId,
    label: record.label,
    type: record.type,
    identity: record.identity,
    status: record.status,
    ...(record.statusReason ? { statusReason: record.statusReason } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    ...(record.verifiedAt ? { verifiedAt: record.verifiedAt } : {}),
    ...(record.limitReachedUntil ? { limitReachedUntil: record.limitReachedUntil } : {}),
    homes,
    allowedMachines,
    // Sessions name their credential from epic Task 3 on; counted there.
    sessionCount: 0,
    access,
    ...(access === 'use' ? {} : { sharedWith: sharesOf(edges) }),
  })
}

export async function listCredentials(
  store: CredentialsStore,
  userId: UserId,
): Promise<CredentialView[]> {
  const own = await store.credentials.listVisibleTo(userId)
  // A removed credential stays listed, as `revoked`, while a machine has not
  // yet confirmed removing what Podium placed there (§8 "visibly").
  const placementRows = await store.credentials.listLivePlacementsOfOwner(userId)
  const placementsOf = new Map<string, LivePlacement[]>()
  for (const row of placementRows) {
    const list = placementsOf.get(row.credential.id) ?? []
    list.push({
      machineId: row.machineId,
      kind: row.kind,
      state: row.state,
      ...(row.homeId ? { homeId: row.homeId } : {}),
    })
    placementsOf.set(row.credential.id, list)
    if (
      row.state === 'removal-pending' &&
      row.credential.status === 'revoked' &&
      !own.some((r) => r.id === row.credential.id)
    ) {
      own.push(row.credential)
    }
  }
  // Which machines hold a login: their inventories, one read (§4).
  const machines = await store.machines.listMachines()
  const ownIds = new Set<string>(own.map((record) => record.id))
  const edges = await store.grants.listForGrantees(CREDENTIAL_RESOURCE_KIND, [
    userId,
    ALL_MEMBERS_GRANTEE,
  ])
  const grantedIds = [...new Set(edges.map((edge) => edge.resourceId))].filter(
    (id) => !ownIds.has(id),
  ) as CredentialId[]
  const granted = await store.credentials.getMany(grantedIds)
  // One read for both: a granted credential's grants decide access, an own
  // one's are whom the owner shared it with.
  const grantsOf = await store.grants.loadForResources(CREDENTIAL_RESOURCE_KIND, [
    ...own.map((record) => record.id),
    ...granted.map((record) => record.id),
  ])
  // Together, so the granters' standing is one read.
  const access = await Promise.all(
    granted.map((record) => accessFrom(store, userId, record, grantsOf.get(record.id) ?? [])),
  )
  const visible: { record: CredentialRecord; access: CredentialAccessLevel }[] = [
    ...own.map((record) => ({ record, access: 'owner' as const })),
    ...granted.flatMap((record, i) => {
      const level = access[i]
      return level ? [{ record, access: level }] : []
    }),
  ]
  const allowed = await store.credentials.allowedMachinesOf(visible.map((v) => v.record.id))
  return visible
    .sort(
      (a, b) =>
        a.record.createdAt.localeCompare(b.record.createdAt) ||
        a.record.id.localeCompare(b.record.id),
    )
    .map(({ record, access }) =>
      viewOf(
        record,
        access,
        allowed.get(record.id) ?? [],
        grantsOf.get(record.id) ?? [],
        homesOf(record, access === 'owner' ? (placementsOf.get(record.id) ?? []) : [], machines),
      ),
    )
}
