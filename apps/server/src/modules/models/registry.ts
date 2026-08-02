/**
 * THE JOIN — the one model-catalog contract (L1) paired with the
 * `SettingsService` method that implements it (L3), per ADR 3 D1.
 *
 * THE SERVICE IS `settings` AND THE ROUTER IS `models`, which looks like a
 * mismatch and is not. The catalog has always been owned by `SettingsService`
 * (`getModelCatalog` / `refreshModelCatalog`) because it backs the settings model
 * pickers; only the WIRE groups it under its own `models` router. This issue
 * moves neither — re-homing the methods would be a service refactor inside a
 * cutover that has to be graded behaviour-preserving.
 *
 * It is deliberately NOT folded into the `settings` contract table either: that
 * table is POD-352's guard (`scripts/audit-router-mutations.ts` fails on an added
 * OR removed settings key, in both directions), and quietly absorbing a fifth
 * command into it would trip the guard for a real reason.
 *
 * `ModelState` names settings PLUS `defaultMachine` because the catalog is now
 * machine-keyed (POD-1123): a call with no `machineId` resolves to the server's
 * default machine rather than an instance-global singleton.
 */

import {
  type AnyCommandContract,
  MODEL_CONTRACT_NAMES,
  MODEL_CONTRACTS,
  type ModelContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { RegistryModules } from '../../relay'
import type { SettingsService } from '../settings/service'

/** Exactly what the model family reaches, named. */
export interface ModelState {
  readonly settings: SettingsService
  /** `machines.defaultMachine()` — resolved lazily when the client omits machineId. */
  readonly defaultMachine: () => string
}

export type ModelHandler<In, Out> = (state: ModelState, input: In) => Out

export interface ModelCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table; each entry's
  // input type is pinned by its own contract through the `satisfies` below.
  readonly handler: ModelHandler<any, unknown>
}

export const MODEL_COMMANDS_TRPC = {
  refresh: {
    contract: MODEL_CONTRACTS.refresh,
    handler: ((state, input) =>
      state.settings.refreshModelCatalog(
        input?.machineId ?? state.defaultMachine(),
      )) satisfies ModelHandler<
      z.infer<(typeof MODEL_CONTRACTS)['refresh']['input']>,
      unknown
    >,
  },
} as const satisfies Record<ModelContractName, ModelCommand>

export type ModelCommandName = keyof typeof MODEL_COMMANDS_TRPC

export const isModelCommand = (name: string): name is ModelCommandName =>
  Object.hasOwn(MODEL_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isModelCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isModelCommand(name)) return false
  return MODEL_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const modelCommandsOn = (transport: TransportTag): ModelCommandName[] =>
  MODEL_CONTRACT_NAMES.filter((n) => isModelCommandExposedOn(n, transport))

export const modelRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(MODEL_COMMANDS_TRPC).map((c) => c.contract))

/** Bundle used by `modelFamilyProcedures` — keeps the selector in one place. */
export function selectModelState(modules: RegistryModules): ModelState {
  return {
    settings: modules.settings,
    defaultMachine: () => modules.machines.defaultMachine(),
  }
}
