/**
 * A key stored before credentials existed, as the one-time move leaves it: a
 * credential of its owner with the secret sealed in the vault and the old
 * account id (`managed:openai`) as its `legacy_key`, allowed on the machines it
 * was sent to. Settings and sessions that still name the old id resolve to it
 * (`credentials/legacy-ids.ts`).
 *
 * Fixtures used to plant an `accounts` row for this; that table is emptied
 * once its keys are moved (credential management plan Task 21).
 */

import type { CredentialId, CredentialTypeId, MachineId, UserId } from '@podium/model'
import type { SessionStore } from '../store'
import { newCredentialId } from '../store/credentials'

export async function seedLegacyKeyCredential(
  store: Pick<SessionStore, 'credentials' | 'vault'>,
  i: {
    owner: UserId
    /** The old account id sessions and settings recorded (`managed:openai`). */
    accountKey: string
    type: CredentialTypeId
    secret: string
    /** Machines the key was sent to (machines the owner only uses). */
    sentTo?: readonly MachineId[]
    label?: string
  },
): Promise<CredentialId> {
  const id = newCredentialId()
  const sealed = await store.vault.seal(
    { credentialId: id, type: i.type, version: 1 },
    Buffer.from(i.secret, 'utf8'),
  )
  await store.credentials.insertWithSecret(
    {
      id,
      ownerUserId: i.owner,
      label: i.label ?? i.accountKey,
      type: i.type,
      legacyId: `${i.accountKey}@${i.owner}`,
      legacyKey: i.accountKey,
    },
    sealed,
  )
  for (const machineId of i.sentTo ?? []) {
    await store.credentials.allowMachine(id, machineId, i.owner)
  }
  return id
}
