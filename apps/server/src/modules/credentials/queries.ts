/**
 * THE CREDENTIAL QUERY — `credentials.list`: the credentials the caller owns or
 * was given, each with what the caller may do with it. Never a secret: each row is
 * built field by field and parsed through `CredentialView`, which has no field
 * that could hold one.
 *
 * Six reads whatever the number of credentials: the caller's own, the grants to
 * the caller or to all members, those credentials, all their grants, the granters'
 * standing, and the allowed machines.
 */

import type { TransportTag } from '@podium/commands'
import { ALL_MEMBERS_GRANTEE, type CredentialId, CredentialView, type UserId } from '@podium/model'
import { z } from 'zod'
import type { CredentialRecord } from '../../store/credentials'
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

function viewOf(
  record: CredentialRecord,
  access: CredentialAccessLevel,
  allowedMachines: readonly string[],
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
    // Which machines hold a login is read from their inventories (epic Task 9).
    homes: [],
    allowedMachines,
    // Sessions name their credential from epic Task 3 on; counted there.
    sessionCount: 0,
    access,
  })
}

export async function listCredentials(
  store: CredentialsStore,
  userId: UserId,
): Promise<CredentialView[]> {
  const own = await store.credentials.listVisibleTo(userId)
  const ownIds = new Set<string>(own.map((record) => record.id))
  const edges = await store.grants.listForGrantees(CREDENTIAL_RESOURCE_KIND, [
    userId,
    ALL_MEMBERS_GRANTEE,
  ])
  const grantedIds = [...new Set(edges.map((edge) => edge.resourceId))].filter(
    (id) => !ownIds.has(id),
  ) as CredentialId[]
  const granted = await store.credentials.getMany(grantedIds)
  const grantsOf = await store.grants.loadForResources(
    CREDENTIAL_RESOURCE_KIND,
    granted.map((record) => record.id),
  )
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
    .map(({ record, access }) => viewOf(record, access, allowed.get(record.id) ?? []))
}

export const CREDENTIAL_QUERIES = {
  list: query(z.object({}).passthrough().optional(), async (state) =>
    listCredentials(state.store, state.callerUserId),
  ),
}
