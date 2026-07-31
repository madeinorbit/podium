/**
 * THE JOIN — the five cloud contracts (L1) paired with the `CloudService`
 * methods that implement them (L3), per ADR 3 D1.
 */

import {
  type AnyCommandContract,
  CLOUD_CONTRACT_NAMES,
  CLOUD_CONTRACTS,
  type CloudContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { CloudService } from './service'

export type CloudHandler<In, Out> = (svc: CloudService, input: In) => Out

export interface CloudCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: CloudHandler<any, unknown>
}

type In<C extends { input: z.ZodTypeAny }> = z.infer<C['input']>

export const CLOUD_COMMANDS_TRPC = {
  createMachine: {
    contract: CLOUD_CONTRACTS.createMachine,
    handler: ((svc, input) => svc.createCloudMachine(input)) satisfies CloudHandler<
      In<typeof CLOUD_CONTRACTS.createMachine>,
      unknown
    >,
  },
  createAgent: {
    contract: CLOUD_CONTRACTS.createAgent,
    handler: ((svc, input) => svc.createCloudAgent(input)) satisfies CloudHandler<
      In<typeof CLOUD_CONTRACTS.createAgent>,
      unknown
    >,
  },
  moveSession: {
    contract: CLOUD_CONTRACTS.moveSession,
    handler: ((svc, input) => svc.moveSession(input)) satisfies CloudHandler<
      In<typeof CLOUD_CONTRACTS.moveSession>,
      unknown
    >,
  },
  stop: {
    contract: CLOUD_CONTRACTS.stop,
    handler: ((svc, input) => svc.stopRuntime(input.id)) satisfies CloudHandler<
      In<typeof CLOUD_CONTRACTS.stop>,
      unknown
    >,
  },
  wake: {
    contract: CLOUD_CONTRACTS.wake,
    handler: ((svc, input) => svc.wakeRuntime(input.id)) satisfies CloudHandler<
      In<typeof CLOUD_CONTRACTS.wake>,
      unknown
    >,
  },
} as const satisfies Record<CloudContractName, CloudCommand>

export type CloudCommandName = keyof typeof CLOUD_COMMANDS_TRPC

export const isCloudCommand = (name: string): name is CloudCommandName =>
  Object.hasOwn(CLOUD_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isCloudCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isCloudCommand(name)) return false
  return CLOUD_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const cloudCommandsOn = (transport: TransportTag): CloudCommandName[] =>
  CLOUD_CONTRACT_NAMES.filter((n) => isCloudCommandExposedOn(n, transport))

export const cloudRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(CLOUD_COMMANDS_TRPC).map((c) => c.contract))
