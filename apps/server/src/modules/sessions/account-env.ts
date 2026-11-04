/**
 * Resolve the account a spawn runs with into the env it carries (SP-6454, #216),
 * for ONE member on ONE machine (POD-6300; design §2.4, §2.5, Q1).
 *
 * WHOSE ACCOUNT. Always the session owner's own: a managed account id names the
 * owner's row with that id, never another member's. An id the owner has no row
 * for is refused, so a run never falls through to somebody else's credential.
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
import type { AccountsRepository } from '../../store/accounts'

export interface AccountEnvPorts {
  accounts: Pick<AccountsRepository, 'getFor' | 'sentTo'>
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
  override readonly name = 'SpawnAccountRefusal'
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

  const row = await ports.accounts.getFor(target.ownerUserId, accountId)
  if (!row) {
    throw new SpawnAccountRefusal(
      `You have no ${providerLabel(accountId)} connection, and Podium never uses someone ` +
        "else's. Connect yours in Settings → Accounts, or select another account.",
    )
  }
  if (
    foreign &&
    !(await ports.accounts.sentTo(target.ownerUserId, accountId)).includes(target.machineId)
  ) {
    throw new SpawnAccountRefusal(
      `Before your first run on "${await machineName()}": ${SHARED_MACHINE_ACCOUNT_WARNING} ` +
        `To run there, send your ${providerLabel(accountId)} connection to it in Settings → Accounts.`,
    )
  }
  const env = credentialEnv({
    provider: row.provider,
    kind: row.kind,
    credential: row.credential,
  })
  return Object.keys(env).length > 0 ? { env } : {}
}
