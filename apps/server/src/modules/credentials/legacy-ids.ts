// LEGACY(remove-after: 2027-02): reads account ids written before credentials existed; removing it stops old spellings from resolving
/**
 * OLD ACCOUNT IDS → CREDENTIALS (credential management spec §18).
 *
 * Sessions and settings written before credentials existed name an account:
 * `''` or `native:<harness>` (the harness's own login), `native:<harness>:<fingerprint>`
 * (that login's identity), or a stored connection (`managed:anthropic`). Each
 * resolves to what it meant then, for the person who wrote it.
 *
 * A stored connection meant the person's own key for that id, and with none,
 * a key another member shared with them: the first shared one in the old
 * read's order (`managedKeyFor` before credentials existed). It still does,
 * through the credentials moved from those keys and the grants their sharing
 * became.
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
import { accessFrom, CREDENTIAL_RESOURCE_KIND, type MayUseDeps } from './may-use'

export type LegacyIdDeps = Pick<SessionStore, 'credentials'> & MayUseDeps

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
  const own = await deps.credentials.findByLegacyKey(ownerUserId, accountId)
  if (own) return own.id
  const byId = await deps.credentials.findByLegacyId(accountId)
  if (byId?.ownerUserId === ownerUserId) return byId.id
  return (await sharedFromLegacy(deps, accountId, ownerUserId)) ?? byId?.id ?? null
}

/** The old workspace-wide key a member adopted at the personal-key upgrade (POD-6360). */
const EARLIER_WORKSPACE_KEYS = ['managed:anthropic', 'managed:openai', 'managed:openrouter']

/**
 * The key the old read took when the person had none of their own: among the
 * keys other members shared with them under this account id or its earlier
 * workspace alias, the oldest by the old row's creation, then its id. Shared
 * means usable now (`mayUse`): the old sharing became grants, read at the call.
 */
async function sharedFromLegacy(
  deps: LegacyIdDeps,
  accountId: string,
  userId: UserId,
): Promise<CredentialId | null> {
  const candidates = await deps.credentials.legacySharedCandidates({
    userId,
    legacyKey: accountId,
    earlierKey: EARLIER_WORKSPACE_KEYS.includes(accountId)
      ? `${accountId}:earlier-workspace`
      : accountId,
  })
  if (candidates.length === 0) return null
  const edges = await deps.grants.loadForResources(
    CREDENTIAL_RESOURCE_KIND,
    candidates.map((c) => c.id),
  )
  const access = await Promise.all(
    candidates.map((c) => accessFrom(deps, userId, c, edges.get(c.id) ?? [])),
  )
  return candidates[access.findIndex((level) => level !== null)]?.id ?? null
}
