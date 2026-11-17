/**
 * THE CREDENTIAL QUERY — `credentials.list`: the credentials the caller owns or
 * was given, each with what the caller may do with it. Never a secret: each row is
 * built field by field and parsed through `CredentialView`, which has no field
 * that could hold one.
 *
 * Seven reads whatever the number of credentials: the caller's own, the
 * placements of theirs still being removed, the grants to
 * the caller or to all members, those credentials, the grants of every listed
 * credential (own ones too, for `sharedWith`), the granters' standing, and the
 * allowed machines.
 */

import type { TransportTag } from '@podium/commands'
import {
  ALL_MEMBERS_GRANTEE,
  type CredentialId,
  type CredentialShare,
  CredentialView,
  type MachineId,
  type UserId,
} from '@podium/model'
import { z } from 'zod'
import type { CredentialRecord, PlacementKind } from '../../store/credentials'
import type { GrantRow } from '../../store/grants'
import type { CredentialsState, CredentialsStore } from './commands'
import { accessFrom, CREDENTIAL_RESOURCE_KIND, type CredentialAccessLevel } from './may-use'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface CredentialQuery<I extends z.ZodTypeAny, Out> {
  readonly input: I
  readonly exposure: readonly TransportTag[]
  readonly run: (state: CredentialsState, input: z.infer<I>) => Out
}

const query = <I extends z.ZodTypeAny, Out>(
  input: I,
  run: (state: CredentialsState, input: z.infer<I>) => Out,
): CredentialQuery<I, Out> => ({ input, exposure: SERVED_ON, run })

/** Its grants as the owner and a manager read them; a use holder gets none. */
function sharesOf(edges: readonly GrantRow[]): CredentialShare[] {
  return edges.flatMap((edge): CredentialShare[] => {
    if (edge.verb !== 'use' && edge.verb !== 'manage') return []
    const grantee = edge.grantee === ALL_MEMBERS_GRANTEE ? 'all-members' : { userId: edge.grantee }
    return [{ grantee, verb: edge.verb } as CredentialShare]
  })
}

/** A home or copied login waiting for its machine to confirm its removal (§8). */
type PendingHome = { machineId: MachineId; kind: PlacementKind }

function viewOf(
  record: CredentialRecord,
  access: CredentialAccessLevel,
  allowedMachines: readonly string[],
  edges: readonly GrantRow[],
  pending: readonly PendingHome[] = [],
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
    // Which machines hold a login is read from their inventories (epic Task 9).
    // What Podium placed and is still removing shows until the machine confirms;
    // a copied login file is in the harness's own home.
    homes: pending.map((p) => ({
      machineId: p.machineId,
      homeId: p.kind === 'home' ? `podium:${record.id}` : 'default',
      state: 'removal-pending' as const,
    })),
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
  const pendingRows = await store.credentials.listPendingPlacementsOfOwner(userId)
  const pendingOf = new Map<string, PendingHome[]>()
  for (const row of pendingRows) {
    const list = pendingOf.get(row.credential.id) ?? []
    list.push({ machineId: row.machineId, kind: row.kind })
    pendingOf.set(row.credential.id, list)
    if (row.credential.status === 'revoked' && !own.some((r) => r.id === row.credential.id)) {
      own.push(row.credential)
    }
  }
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
        access === 'owner' ? (pendingOf.get(record.id) ?? []) : [],
      ),
    )
}

export const CREDENTIAL_QUERIES = {
  list: query(z.object({}).passthrough().optional(), async (state) =>
    listCredentials(state.store, state.callerUserId),
  ),
  /** Where the caller's sign-in on a machine stands (§6 way 2): waiting, signed in as an account, or failed. */
  signInStatus: query(z.object({ credentialId: z.string().min(1).max(100) }), (state, input) =>
    state.signIn
      ? state.signIn.status(input.credentialId, state.callerUserId)
      : ({
          state: 'failed',
          reason: 'Signing in on a machine is not available on this server.',
        } as const),
  ),
  /** Where the caller's ChatGPT sign-in attempt stands (§11): waiting, signed in, or failed. */
  chatgptSignInStatus: query(z.object({ attemptId: z.string().min(1).max(100) }), (state, input) =>
    state.chatgpt
      ? state.chatgpt.status(input.attemptId, state.callerUserId)
      : ({
          state: 'failed',
          reason: 'Sign in with ChatGPT is not available on this server.',
        } as const),
  ),
}
