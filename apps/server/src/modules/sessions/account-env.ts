/**
 * Resolve a role's account id into the env a spawn should carry (SP-6454, #216).
 *
 * Native accounts inject nothing — the CLI uses its own on-disk login, and the
 * spawn frame stays byte-identical to the pre-#216 shape. Only a MANAGED account
 * with a stored credential produces env.
 */

import { credentialEnv } from '@podium/runtime'
import type { AccountsRepository } from '../../store/accounts'

export function resolveAccountEnv(
  accounts: AccountsRepository,
  accountId: string,
): { env?: Record<string, string> } {
  if (!accountId.startsWith('managed:')) return {}
  const row = accounts.get(accountId)
  if (!row) return {}
  const env = credentialEnv({
    provider: row.provider,
    kind: row.kind,
    credential: row.credential,
  })
  return Object.keys(env).length > 0 ? { env } : {}
}
