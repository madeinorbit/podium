/**
 * Resolve a role's account id into the env a spawn should carry (SP-6454, #216).
 *
 * Native accounts inject nothing — the CLI uses its own on-disk login, and the
 * spawn frame stays byte-identical to the pre-#216 shape. Only a MANAGED account
 * with a stored credential produces env.
 *
 * ---------------------------------------------------------------------------
 * WHOSE CREDENTIAL (PDM-280)
 * ---------------------------------------------------------------------------
 *
 * `owner` is the human the session BELONGS TO — the one who started it — and the
 * lookup is keyed on them. Not the earliest admin, not the attached task's
 * assignee. A session follows its initiator (B1), an agent is held to its
 * delegating human's ceiling (PDM-246), and a message-woken session belongs to
 * the sender (PDM-275); a credential that did not follow the same person would
 * exceed that ceiling in the one dimension the ceiling cannot express, because
 * spend and rate limit are not authorization.
 *
 * DO NOT SOURCE THIS FROM `settingsViewer()`. That port looks like the answer
 * and is not: its one implementation returns `firstAdminMemberId()`, and the
 * comment beside it promises a replacement that shipped without happening
 * (PDM-295). Keying here on it would resolve the earliest admin's credential for
 * every spawn on the instance — the defect this file exists to close, wearing a
 * new name.
 *
 * ---------------------------------------------------------------------------
 * A MANAGED SLOT WITH NO ROW FOR THIS OWNER REFUSES, AND DOES NOT SUBSTITUTE
 * ---------------------------------------------------------------------------
 *
 * Falling back to anybody else's credential is the one thing this function must
 * not do. Phase B has found five places where missing identity was GUESSED
 * rather than refused (spawn's, resumeSession's, create()'s, the read path's,
 * and `settingsViewer` itself); this is the place where a guess also spends
 * another person's money and consumes their rate limit, invisibly, with no
 * record of whose run did it.
 *
 * Returning `{}` — the pre-PDM-280 behaviour for an absent row — was the
 * alternative and was ruled against: the agent then spawns and quietly
 * authenticates as whatever login the machine happens to have, which is the
 * same invisible cross-person spend arriving by another route.
 */

import type { AccountId, UserId } from '@podium/model'
import { credentialEnv } from '@podium/runtime'
import type { AccountsRepository } from '../../store/accounts'

/** The slot prefix that means "Podium holds this credential and injects it". */
const MANAGED = 'managed:'

export async function resolveAccountEnv(
  accounts: AccountsRepository,
  owner: UserId,
  accountId: AccountId,
): Promise<{ env?: Record<string, string> }> {
  if (!accountId.startsWith(MANAGED)) return {}
  const row = await accounts.get(owner, accountId)
  if (!row) throw new Error(missingCredentialMessage(owner, accountId))
  const env = credentialEnv({
    provider: row.provider,
    kind: row.kind,
    credential: row.credential,
  })
  return Object.keys(env).length > 0 ? { env } : {}
}

/**
 * The refusal, naming the person and the provider.
 *
 * It says CONNECT A KEY rather than "choose a different account", and that is
 * deliberate: until PDM-295 lands, the SLOT comes from the first admin's
 * settings while the credential comes from this owner's rows, so a member can be
 * refused on a slot they never chose and cannot change from their own settings.
 * Sending them to the account selector would send them somewhere that cannot
 * help them.
 */
function missingCredentialMessage(owner: UserId, accountId: AccountId): string {
  const provider = accountId.slice(MANAGED.length)
  return (
    `no managed credential for '${provider}': ${owner} has not connected one (slot '${accountId}'). ` +
    'Connect it in Settings → Accounts; a credential belongs to one person and is never borrowed from another.'
  )
}
