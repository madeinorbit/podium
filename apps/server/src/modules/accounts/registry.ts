/**
 * THE JOIN — the two account contracts (L1) paired with the L3 code that
 * implements them, per ADR 3 D1.
 *
 * The handlers are the router procedure bodies, MOVED and not rewritten: the same
 * id derivation, the same `maskCredential` identity, the same `{ id }` return
 * that deliberately never echoes the credential.
 *
 * This family selects the accounts REPOSITORY and the settings service — the
 * repository because managed credentials are a store table with no service in
 * front of them, and settings because the `list` read merges native CLI logins
 * with what Podium stores.
 */

import {
  ACCOUNT_CONTRACT_NAMES,
  ACCOUNT_CONTRACTS,
  type AccountContractName,
  type AnyCommandContract,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import { asUserId } from '@podium/model'
import type { z } from 'zod'
import { maskCredential } from '../../accounts'
import type { RegistryModules, SessionRegistry } from '../../relay'

/** Exactly what the account family reaches, named. */
export interface AccountState {
  readonly accounts: SessionRegistry['sessionStore']['accounts']
  readonly machines: SessionRegistry['sessionStore']['machines']
  readonly machineService: RegistryModules['machines']
  readonly settings: RegistryModules['settings']
  readonly nativeLogin: RegistryModules['nativeLogin']
  readonly callerUserId: string
}

export type AccountHandler<In, Out> = (state: AccountState, input: In) => Out

export interface AccountCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: AccountHandler<any, unknown>
}

export const ACCOUNT_COMMANDS_TRPC = {
  login: {
    contract: ACCOUNT_CONTRACTS.login,
    handler: ((state, input) =>
      state.nativeLogin.start({
        harness: input.harness,
        ...(input.machineId ? { machineId: input.machineId } : {}),
        ownerUserId: asUserId(state.callerUserId),
      })) satisfies AccountHandler<z.infer<(typeof ACCOUNT_CONTRACTS)['login']['input']>, unknown>,
  },
  connect: {
    contract: ACCOUNT_CONTRACTS.connect,
    handler: ((state, input) => {
      // A Claude setup-token is its own account, distinct from an Anthropic API
      // key. Derived server-side, which is what makes the contract's
      // `callerSuppliedTargetId: false` true rather than aspirational.
      const id = input.kind === 'oauth' ? 'managed:claude-oauth' : `managed:${input.provider}`
      state.accounts.upsert({
        id,
        provider: input.provider,
        kind: input.kind,
        credential: input.credential,
        identity: maskCredential(input.credential),
        scope: 'role',
        createdAt: Date.now(),
      })
      // Only the id: the credential must never be echoed back to a client.
      return { id }
    }) satisfies AccountHandler<z.infer<(typeof ACCOUNT_CONTRACTS)['connect']['input']>, unknown>,
  },
  disconnect: {
    contract: ACCOUNT_CONTRACTS.disconnect,
    handler: ((state, input) => {
      state.accounts.remove(input.id)
      return { ok: true as const }
    }) satisfies AccountHandler<
      z.infer<(typeof ACCOUNT_CONTRACTS)['disconnect']['input']>,
      unknown
    >,
  },
} as const satisfies Record<AccountContractName, AccountCommand>

export type AccountCommandName = keyof typeof ACCOUNT_COMMANDS_TRPC

export const isAccountCommand = (name: string): name is AccountCommandName =>
  Object.hasOwn(ACCOUNT_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isAccountCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isAccountCommand(name)) return false
  return ACCOUNT_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const accountCommandsOn = (transport: TransportTag): AccountCommandName[] =>
  ACCOUNT_CONTRACT_NAMES.filter((n) => isAccountCommandExposedOn(n, transport))

export const accountRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(ACCOUNT_COMMANDS_TRPC).map((c) => c.contract))
