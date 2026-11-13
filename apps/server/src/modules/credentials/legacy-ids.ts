// LEGACY(remove-after: 2027-02): reads account ids written before credentials existed; removing it stops old spellings from resolving
/**
 * OLD ACCOUNT IDS → CREDENTIALS (credential management spec §18).
 *
 * Sessions and settings written before credentials existed name an account:
 * `''` or `native:<harness>` (the harness's own login), `native:<harness>:<fingerprint>`
 * (that login's identity), or a stored connection (`managed:anthropic`). Each
 * resolves to what it meant then, for the person who wrote it.
 */

import { harnessAccepts } from '@podium/harness/metadata'
import {
  CREDENTIAL_ID_PREFIX,
  CREDENTIAL_TYPES,
  type CredentialId,
  type CredentialTypeId,
  type UserId,
} from '@podium/model'
import type { SessionStore } from '../../store'

export type LegacyIdDeps = Pick<SessionStore, 'credentials'>

/** The subscription login type a harness keeps in a home (`anthropic.claude-login`). */
function homeTypeOf(harness: string): string | undefined {
  return harnessAccepts(harness).find(
    (line) => CREDENTIAL_TYPES[line.type as CredentialTypeId]?.store === 'home',
  )?.type
}

/**
 * The credential an old account id names for `ownerUserId` (the session's
 * owner, or the person whose settings hold it), or `null` for no credential.
 */
export async function credentialIdFromLegacy(
  deps: LegacyIdDeps,
  accountId: string,
  ownerUserId: UserId,
): Promise<CredentialId | null> {
  if (accountId === '') return null
  // Already a credential: the resolver says whether it exists.
  if (accountId.startsWith(CREDENTIAL_ID_PREFIX)) return accountId as CredentialId
  if (accountId.startsWith('native:')) {
    const rest = accountId.slice('native:'.length)
    const colon = rest.indexOf(':')
    if (colon < 0) return null
    const type = homeTypeOf(rest.slice(0, colon))
    const fingerprint = rest.slice(colon + 1)
    if (!type || !fingerprint) return null
    return (await deps.credentials.findByIdentity({ ownerUserId, type, fingerprint }))?.id ?? null
  }
  const found =
    (await deps.credentials.findByLegacyKey(ownerUserId, accountId)) ??
    (await deps.credentials.findByLegacyId(accountId))
  return found?.id ?? null
}
