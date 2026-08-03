/**
 * THE JOIN — the eight instance contracts (L1) paired with the `InstanceService`
 * methods that implement them (L3), per ADR 3 D1.
 *
 * THREE TABLES, ONE SERVICE, because the wire groups these as three routers
 * (`setup`, `auth`, `telemetry`) while the state they write is one thing: this
 * deployment's own configuration. Splitting the service to match the routers
 * would have made three adapters over the same `config.json`; keeping one table
 * would have made the derived router keys disagree with the wire.
 */

import {
  type AnyCommandContract,
  AUTH_CONTRACT_NAMES,
  AUTH_CONTRACTS,
  type AuthContractName,
  registryClassificationErrors,
  SETUP_CONTRACT_NAMES,
  SETUP_CONTRACTS,
  type SetupContractName,
  TELEMETRY_CONTRACT_NAMES,
  TELEMETRY_CONTRACTS,
  type TelemetryContractName,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { InstanceService } from './service'

export type InstanceHandler<In, Out> = (svc: InstanceService, input: In) => Out

export interface InstanceCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: InstanceHandler<any, unknown>
}

type In<C extends { input: z.ZodTypeAny }> = z.infer<C['input']>

export const SETUP_COMMANDS_TRPC = {
  complete: {
    contract: SETUP_CONTRACTS.complete,
    handler: ((svc, input) => svc.complete(input)) satisfies InstanceHandler<
      In<typeof SETUP_CONTRACTS.complete>,
      unknown
    >,
  },
  join: {
    contract: SETUP_CONTRACTS.join,
    handler: ((svc, input) => svc.join(input.code)) satisfies InstanceHandler<
      In<typeof SETUP_CONTRACTS.join>,
      unknown
    >,
  },
  connect: {
    contract: SETUP_CONTRACTS.connect,
    handler: ((svc, input) => svc.connect(input)) satisfies InstanceHandler<
      In<typeof SETUP_CONTRACTS.connect>,
      unknown
    >,
  },
  setChannel: {
    contract: SETUP_CONTRACTS.setChannel,
    handler: ((svc, input) => svc.setChannel(input.channel)) satisfies InstanceHandler<
      In<typeof SETUP_CONTRACTS.setChannel>,
      unknown
    >,
  },
} as const satisfies Record<SetupContractName, InstanceCommand>

export const AUTH_COMMANDS_TRPC = {
  setPassword: {
    contract: AUTH_CONTRACTS.setPassword,
    handler: ((svc, input) => svc.setPassword(input)) satisfies InstanceHandler<
      In<typeof AUTH_CONTRACTS.setPassword>,
      unknown
    >,
  },
  setLoginRequired: {
    contract: AUTH_CONTRACTS.setLoginRequired,
    handler: ((svc, input) => svc.setLoginRequired(input)) satisfies InstanceHandler<
      In<typeof AUTH_CONTRACTS.setLoginRequired>,
      unknown
    >,
  },
} as const satisfies Record<AuthContractName, InstanceCommand>

export const TELEMETRY_COMMANDS_TRPC = {
  set: {
    contract: TELEMETRY_CONTRACTS.set,
    handler: ((svc, input) => svc.setConsent(input)) satisfies InstanceHandler<
      In<typeof TELEMETRY_CONTRACTS.set>,
      unknown
    >,
  },
  resetId: {
    contract: TELEMETRY_CONTRACTS.resetId,
    handler: ((svc) => svc.resetInstallId()) satisfies InstanceHandler<
      In<typeof TELEMETRY_CONTRACTS.resetId>,
      unknown
    >,
  },
} as const satisfies Record<TelemetryContractName, InstanceCommand>

/** ADR 3 D3, default-closed, across all three tables. An unknown name is `false`,
 *  so a typo removes a surface loudly instead of opening one silently. */
const ALL = { ...SETUP_COMMANDS_TRPC, ...AUTH_COMMANDS_TRPC, ...TELEMETRY_COMMANDS_TRPC }

export const isInstanceCommand = (name: string): boolean => Object.hasOwn(ALL, name)

export function isInstanceCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isInstanceCommand(name)) return false
  return (
    (ALL as Record<string, InstanceCommand>)[name]?.contract.exposure.includes(transport) ?? false
  )
}

export const instanceCommandNames = (): string[] => [
  ...SETUP_CONTRACT_NAMES,
  ...AUTH_CONTRACT_NAMES,
  ...TELEMETRY_CONTRACT_NAMES,
]

/** The classification lint over all three joined tables. */
export const instanceRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(ALL).map((c) => c.contract))
