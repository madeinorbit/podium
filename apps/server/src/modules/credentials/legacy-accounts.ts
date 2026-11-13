// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/**
 * THE OLD `accounts.*` COMMANDS WRITE THROUGH TO CREDENTIALS (credential
 * management Task 4).
 *
 * Launches read credentials only (epic Task 3), while the Settings page still
 * calls `accounts.connect`, `disconnect`, `share`, `send` and `unsend` until the
 * credentials page replaces it (Task 17) and Task 21 deletes them. Each of those
 * commands keeps writing its `accounts` row, so `accounts.list` stays right, and
 * makes the same change to the credential that row became, at once:
 *
 *  - connect: a new key under an account id is a new credential (with that
 *    `legacy_key`, and `legacy_id` = the row's storage id); a reconnect renews
 *    the credential's secret, keeping its grants and machines.
 *  - disconnect: removes the credential and its grants; what named it reads
 *    "removed". Connecting again makes a new credential under the same old id.
 *  - share: the credential's `use` grants become exactly the row's sharing.
 *  - send / unsend: allow or disallow the machine for the credential.
 *
 * The secret goes only into the vault, as with `credentials.add`.
 */

import type { CredentialId, MachineId, UserId } from '@podium/model'
import { ALL_MEMBERS_GRANTEE } from '@podium/model'
import type { CredentialRecord } from '../../store/credentials'
import { newCredentialId } from '../../store/credentials'
import type { CredentialsStore } from './commands'
import { recordCredentialEvent } from './events'
import { pastedIdentity } from './fingerprint'
import { legacyAccountType, TYPE_LABELS } from './legacy-import'
import { CREDENTIAL_RESOURCE_KIND } from './may-use'
import { sealCredentialSecret } from './vault'

/** How the accounts table names one person's row (`store/accounts.ts`). */
const storageIdOf = (owner: UserId, accountKey: string): string => `${accountKey}@${owner}`

/** The live credential an old account id of this person became, if any. */
export async function credentialOfAccount(
  store: Pick<CredentialsStore, 'credentials'>,
  owner: UserId,
  accountKey: string,
): Promise<CredentialRecord | undefined> {
  const byKey = await store.credentials.findByLegacyKey(owner, accountKey)
  if (byKey && byKey.status !== 'revoked') return byKey
  const byId = await store.credentials.findByLegacyId(storageIdOf(owner, accountKey))
  if (byId && byId.status !== 'revoked' && byId.ownerUserId === owner) return byId
  return undefined
}

/** Detach the old ids from removed credentials so a new one can hold them. */
async function releaseRemoved(
  store: Pick<CredentialsStore, 'credentials'>,
  owner: UserId,
  accountKey: string,
): Promise<void> {
  for (const found of [
    await store.credentials.findByLegacyKey(owner, accountKey),
    await store.credentials.findByLegacyId(storageIdOf(owner, accountKey)),
  ]) {
    if (found && found.status === 'revoked') await store.credentials.clearLegacyIds(found.id)
  }
}

/** `accounts.connect`: the credential behind (owner, account id) now holds `secret`. */
export async function connectThrough(
  store: CredentialsStore,
  i: { owner: UserId; accountKey: string; provider: string; kind: string; secret: string },
): Promise<CredentialId | undefined> {
  const type = legacyAccountType({ provider: i.provider, kind: i.kind })
  if (!type) return undefined
  const identity = pastedIdentity(type, i.secret, await store.secrets.fingerprintKey())
  const existing = await credentialOfAccount(store, i.owner, i.accountKey)
  if (existing && existing.type === type) {
    const latest = await store.credentials.latestSecret(existing.id)
    const stored = await sealCredentialSecret(store, existing, i.secret, latest?.version ?? 0)
    if (stored === 'conflict') throw new Error('the key was changed at the same moment; try again')
    await store.credentials.setIdentity(existing.id, { ...existing.identity, ...identity })
    if (existing.status !== 'ok') await store.credentials.setStatus(existing.id, 'ok')
    await recordCredentialEvent(store, {
      kind: 'renew',
      credentialId: existing.id,
      actorUserId: i.owner,
      detail: `accounts.connect ${i.accountKey}`,
    })
    return existing.id
  }
  if (existing) await removeThrough(store, i.owner, i.accountKey)
  await releaseRemoved(store, i.owner, i.accountKey)
  const id = newCredentialId()
  const sealed = await store.vault.seal(
    { credentialId: id, type, version: 1 },
    Buffer.from(i.secret, 'utf8'),
  )
  await store.credentials.insertWithSecret(
    {
      id,
      ownerUserId: i.owner,
      label: TYPE_LABELS[type] ?? type,
      type,
      identity,
      legacyId: storageIdOf(i.owner, i.accountKey),
      legacyKey: i.accountKey,
    },
    sealed,
  )
  await recordCredentialEvent(store, {
    kind: 'add',
    credentialId: id,
    actorUserId: i.owner,
    detail: `accounts.connect ${i.accountKey}`,
  })
  return id
}

/** `accounts.disconnect`: remove the credential and let go of its old ids. */
export async function removeThrough(
  store: CredentialsStore,
  owner: UserId,
  accountKey: string,
): Promise<void> {
  const credential = await credentialOfAccount(store, owner, accountKey)
  if (!credential) return
  await store.credentials.remove(credential.id)
  await store.grants.removeAllForResource(CREDENTIAL_RESOURCE_KIND, credential.id)
  // Its old ids stay on it, so a session or setting that names one reads
  // "removed"; a later connect under the same id lets go of them first.
  await recordCredentialEvent(store, {
    kind: 'remove',
    credentialId: credential.id,
    actorUserId: owner,
    detail: `accounts.disconnect ${accountKey}`,
  })
}

/** `accounts.share`: the credential's `use` grants become exactly this sharing. */
export async function shareThrough(
  store: CredentialsStore,
  i: {
    owner: UserId
    accountKey: string
    everyone: boolean
    users: readonly UserId[]
    actor: UserId
  },
): Promise<void> {
  const credential = await credentialOfAccount(store, i.owner, i.accountKey)
  if (!credential) return
  const wanted = new Set<string>([
    ...(i.everyone ? [ALL_MEMBERS_GRANTEE] : []),
    ...i.users.filter((user) => user !== i.owner),
  ])
  const edges = await store.grants.listForResource(CREDENTIAL_RESOURCE_KIND, credential.id)
  for (const edge of edges) {
    if (edge.verb === 'use' && !wanted.has(edge.grantee)) {
      await store.grants.remove(CREDENTIAL_RESOURCE_KIND, credential.id, edge.grantee, 'use')
    }
  }
  const held = new Set(edges.filter((e) => e.verb === 'use').map((e) => e.grantee))
  for (const grantee of wanted) {
    if (held.has(grantee)) continue
    await store.grants.upsert({
      resourceKind: CREDENTIAL_RESOURCE_KIND,
      resourceId: credential.id,
      grantee,
      verb: 'use',
      // The owner gives it; an admin changing another person's sharing is the actor.
      owner: i.owner,
      visibility: 'secret',
      createdAt: new Date().toISOString(),
      actorKind: 'user',
      actorId: i.actor,
      onBehalfOf: i.actor,
    })
  }
  await recordCredentialEvent(store, {
    kind: 'share',
    credentialId: credential.id,
    actorUserId: i.actor,
    detail: `accounts.share ${i.accountKey}: ${[...wanted].join(', ') || 'nobody'}`,
  })
}

/** `accounts.send` / `accounts.unsend`: allow or disallow the machine. */
export async function sendThrough(
  store: CredentialsStore,
  i: { owner: UserId; accountKey: string; machineId: MachineId; sent: boolean; actor: UserId },
): Promise<void> {
  const credential = await credentialOfAccount(store, i.owner, i.accountKey)
  if (!credential) return
  if (i.sent) await store.credentials.allowMachine(credential.id, i.machineId, i.owner)
  else await store.credentials.disallowMachine(credential.id, i.machineId)
  await recordCredentialEvent(store, {
    kind: i.sent ? 'share' : 'unshare',
    credentialId: credential.id,
    actorUserId: i.actor,
    machineId: i.machineId,
    detail: `accounts.${i.sent ? 'send' : 'unsend'} ${i.accountKey}`,
  })
}
