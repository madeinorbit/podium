/**
 * Resolve a role's account id into the env a spawn should carry (SP-6454, #216).
 *
 * Native accounts inject nothing — the CLI uses its own on-disk login, and the
 * spawn frame stays byte-identical to the pre-#216 shape. Only a MANAGED account
 * with a stored credential produces env.
 *
 * WHOSE KEY (POD-6360, user decision 2026-11-04): the session owner's own key
 * first, then a key another user explicitly shares with them. Nothing else: an
 * unshared key of another user is never used, whoever owns it. With neither,
 * the spawn is refused with {@link MissingManagedKeyError}, which names the
 * missing key and says an admin can share one.
 */

import type { AccountId, UserId } from '@podium/model'
import { credentialEnv } from '@podium/runtime'
import type { AccountsRepository, ManagedAccountRow } from '../../store/accounts'

/** The words a person reads for each managed account id. */
const MANAGED_KEY_NAMES: Readonly<Record<string, string>> = {
  'managed:anthropic': 'Anthropic API key',
  'managed:openai': 'OpenAI API key',
  'managed:openrouter': 'OpenRouter API key',
  'managed:claude-oauth': 'Claude setup token',
}

export const managedKeyName = (accountId: AccountId): string =>
  MANAGED_KEY_NAMES[accountId] ?? `managed key ${accountId}`

/** The role selects a managed key that is neither the owner's nor shared with them. */
export class MissingManagedKeyError extends Error {
  constructor(readonly accountId: AccountId) {
    super(
      `No ${managedKeyName(accountId)} is available to you: this agent's role uses one, and you ` +
        'have not connected your own (Settings → Accounts) and nobody shares one with you. An ' +
        'admin can share theirs.',
    )
    this.name = 'MissingManagedKeyError'
  }
}

/** The key a session owned by `ownerUserId` may use for `accountId`, if any. */
export async function managedKeyFor(
  accounts: AccountsRepository,
  ownerUserId: UserId,
  accountId: AccountId,
): Promise<ManagedAccountRow | undefined> {
  return (
    (await accounts.own(ownerUserId, accountId)) ??
    (await accounts.sharedWith(ownerUserId, accountId))[0]
  )
}

export async function resolveAccountEnv(
  accounts: AccountsRepository,
  accountId: AccountId,
  ownerUserId: UserId,
): Promise<{ env?: Record<string, string> }> {
  if (!accountId.startsWith('managed:')) return {}
  const row = await managedKeyFor(accounts, ownerUserId, accountId)
  if (!row) throw new MissingManagedKeyError(accountId)
  const env = credentialEnv({
    provider: row.provider,
    kind: row.kind,
    credential: row.credential,
  })
  return Object.keys(env).length > 0 ? { env } : {}
}
