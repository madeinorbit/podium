/**
 * THE VAULT COMMANDS (POD-6889): `vault.reset`, admin people only.
 *
 * The admin floor is the contract's (`roleFloor: 'admin'`, checked at the front
 * door); `humanOnly` refuses an agent acting with an admin's delegation, because
 * deleting every stored secret is not something a session decides.
 */

import {
  type AnyCommandContract,
  registryClassificationErrors,
  type TransportTag,
  VAULT_CONTRACT_NAMES,
  VAULT_CONTRACTS,
  type VaultContractName,
} from '@podium/commands'
import type { UserId } from '@podium/model'
import type { z } from 'zod'
import type { CredentialId } from '../credentials/credential-id'
import type { CredentialEvent } from '../credentials/events'
import type { VaultStatus } from '../credentials/vault'
import type { PlainTargetCheck } from '../plain-command/entry'

/** Exactly what the vault family reaches, named. */
export interface VaultState {
  readonly vault: { reset(): Promise<CredentialId[]>; status(): VaultStatus }
  readonly recordEvent: (event: CredentialEvent) => Promise<void>
  readonly callerUserId: UserId
  /** Throws FORBIDDEN unless the caller is a human admin. */
  readonly requireAdmin: () => void
}

export type VaultHandler<In, Out> = (state: VaultState, input: In) => Out

export interface VaultCommand {
  readonly contract: AnyCommandContract
  readonly targetPermitted?: PlainTargetCheck
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: VaultHandler<any, unknown>
}

/** Only a person, never an agent session acting for one. */
export const humanOnly: PlainTargetCheck = (principal) => principal.kind === 'user'

export const VAULT_COMMANDS_TRPC = {
  reset: {
    contract: VAULT_CONTRACTS.reset,
    targetPermitted: humanOnly,
    handler: (async (state) => {
      state.requireAdmin()
      const affected = await state.vault.reset()
      await state.recordEvent({
        kind: 'attention',
        credentialId: null,
        actorUserId: state.callerUserId,
        detail: `vault-reset: ${affected.length} credential(s) need attention`,
      })
      return { needsAttention: affected.length, state: state.vault.status().state }
    }) satisfies VaultHandler<z.infer<(typeof VAULT_CONTRACTS)['reset']['input']>, unknown>,
  },
} as const satisfies Record<VaultContractName, VaultCommand>

export type VaultCommandName = keyof typeof VAULT_COMMANDS_TRPC

export const isVaultCommand = (name: string): name is VaultCommandName =>
  Object.hasOwn(VAULT_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isVaultCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isVaultCommand(name)) return false
  return VAULT_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const vaultCommandsOn = (transport: TransportTag): VaultCommandName[] =>
  VAULT_CONTRACT_NAMES.filter((n) => isVaultCommandExposedOn(n, transport))

export const vaultRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(VAULT_COMMANDS_TRPC).map((c) => c.contract))
