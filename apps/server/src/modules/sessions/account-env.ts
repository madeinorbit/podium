/**
 * Resolve the account a spawn runs with into the env it carries (SP-6454, #216),
 * for ONE member on ONE machine (POD-6300; design §2.4, §2.5, Q1).
 *
 * WHOSE ACCOUNT. The session owner's own managed key first, then a key another
 * member explicitly shares. An unshared credential is never a fallback, even
 * for an admin. The key's owner still decides which foreign machines receive it.
 *
 * WHICH MACHINE. A machine's native CLI logins belong to the person who looks
 * after it (its custodian). On the owner's own machine (or one nobody looks
 * after, which machine access decides elsewhere) a native account injects
 * nothing and the CLI uses its on-disk login, so the spawn frame is the pre-#216
 * shape. On someone else's machine:
 *   - a native account is refused: the login there is the custodian's, and
 *     using the owner's own would mean replacing it;
 *   - a managed account is used only after its owner explicitly sent it to that
 *     machine, having been shown {@link SHARED_MACHINE_ACCOUNT_WARNING}; until
 *     then the refusal itself carries that warning.
 */

import {
  type AccountId,
  type MachineId,
  SHARED_MACHINE_ACCOUNT_WARNING,
  type UserId,
} from '@podium/model'
import { credentialEnv } from '@podium/runtime'
import type { AccountsRepository, ManagedAccountRow } from '../../store/accounts'

export interface AccountEnvPorts {
  accounts: Pick<AccountsRepository, 'own' | 'sharedWith' | 'sentTo'>
  machines: {
    custodian(id: string): Promise<UserId | null>
    getMachine(id: string): Promise<{ name: string } | undefined>
  }
}

export interface AccountEnvTarget {
  /** The member the session acts for: its owner. */
  ownerUserId: UserId
  /** The machine it will run on. */
  machineId: MachineId
}

/** A spawn refused because of its account: the message says what to do. */
export class SpawnAccountRefusal extends Error {
  override readonly name: string = 'SpawnAccountRefusal'
}

/** The words a person reads for each managed account id. */
const MANAGED_KEY_NAMES: Readonly<Record<string, string>> = {
  'managed:anthropic': 'Anthropic API key',
  'managed:openai': 'OpenAI API key',
  'managed:openrouter': 'OpenRouter API key',
  'managed:claude-oauth': 'Claude setup token',
}

export const managedKeyName = (accountId: AccountId): string =>
  MANAGED_KEY_NAMES[accountId] ?? `managed key ${accountId}`

/** Neither an owned key nor an explicitly shared one is available. */
export class MissingManagedKeyError extends SpawnAccountRefusal {
  override readonly name = 'MissingManagedKeyError'

  constructor(readonly accountId: AccountId) {
    super(
      `No ${managedKeyName(accountId)} is available to you: this agent's role uses one, and you ` +
        'have not connected your own (Settings → Accounts) and nobody shares one with you. An ' +
        'admin can share theirs.',
    )
  }
}

/** Own key first, then an explicit share: admin status never supplies a key. */
export async function managedKeyFor(
  accounts: Pick<AccountsRepository, 'own' | 'sharedWith'>,
  ownerUserId: UserId,
  accountId: AccountId,
): Promise<ManagedAccountRow | undefined> {
  return (
    (await accounts.own(ownerUserId, accountId)) ??
    (await accounts.sharedWith(ownerUserId, accountId))[0]
  )
}

const providerLabel = (accountId: string): string => {
  if (accountId === 'managed:claude-oauth') return 'Claude subscription (setup-token)'
  const provider = accountId.slice('managed:'.length)
  return provider === 'openai'
    ? 'OpenAI'
    : provider === 'openrouter'
      ? 'OpenRouter'
      : provider === 'anthropic'
        ? 'Anthropic'
        : provider
}

export async function resolveAccountEnv(
  ports: AccountEnvPorts,
  accountId: AccountId,
  target: AccountEnvTarget,
): Promise<{ env?: Record<string, string> }> {
  const custodian = await ports.machines.custodian(target.machineId)
  const foreign = custodian !== null && custodian !== target.ownerUserId
  const machineName = async () =>
    (await ports.machines.getMachine(target.machineId))?.name ?? target.machineId

  if (!accountId.startsWith('managed:')) {
    if (!foreign) return {}
    throw new SpawnAccountRefusal(
      `"${await machineName()}" is someone else's machine: its native CLI logins are theirs, and ` +
        "Podium never runs your agents on another person's login or replaces it with yours. " +
        'Send one of your own connections to this machine in Settings → Accounts and select it, ' +
        'or run on a machine you look after.',
    )
  }

  const row = await managedKeyFor(ports.accounts, target.ownerUserId, accountId)
  if (!row) throw new MissingManagedKeyError(accountId)
  const foreignToCredential = custodian !== null && custodian !== row.ownerUserId
  if (
    foreignToCredential &&
    !(await ports.accounts.sentTo(row.ownerUserId, accountId)).includes(target.machineId)
  ) {
    throw new SpawnAccountRefusal(
      `Before your first run on "${await machineName()}": ${SHARED_MACHINE_ACCOUNT_WARNING} ` +
        (row.ownerUserId === target.ownerUserId
          ? `To run there, send your ${providerLabel(accountId)} connection to it in Settings → Accounts.`
          : 'The owner of the shared connection must send it to this machine in Settings → Accounts.'),
    )
  }
  const env = credentialEnv({
    provider: row.provider,
    kind: row.kind,
    credential: row.credential,
  })
  return Object.keys(env).length > 0 ? { env } : {}
}
