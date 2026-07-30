/**
 * THE JOIN — the four settings write contracts (L1, `@podium/commands`) paired
 * with the `SettingsService` methods that implement them (L3), per ADR 3 D1 and
 * the three-way split POD-311 established.
 *
 * Same shape as `modules/specs/registry.ts` and `modules/fleet/registry.ts`,
 * deliberately: the framework is built, and a family that invented its own join
 * would be a fifth answer to a question four families already answer the same
 * way.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FAMILY ADDS THAT THE OTHERS DO NOT: TWO HANDLERS, FOUR COMMANDS
 * ---------------------------------------------------------------------------
 *
 * `updatePersonal` and `updateInstance` both forward to
 * `SettingsService.updatePreferences`, because the TIER GATE IS THE INPUT
 * SCHEMA and not the handler. Each command's schema admits only the paths its
 * own tier classifies, so by the time a handler runs, "which tier is this" has
 * already been decided by the thing that refused everything else. A second
 * decision in the handler could not refuse anything the schema let through, and
 * two answers to one authorization question is what this whole phase is undoing.
 *
 * The secret pair does NOT share a handler with them and must not: those methods
 * write the store directly, past the guard that now refuses a secret change on
 * the blob command. That asymmetry is the point — one path may write credential
 * material, three may not, and it is visible here rather than inside a branch.
 */

import {
  type AnyCommandContract,
  registryClassificationErrors,
  SETTINGS_COMMAND_NAMES,
  SETTINGS_CONTRACTS,
  type SettingsContractName,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { SettingsService } from './service'

/** A settings handler is a method ON the service; everything it needs (the
 *  store, the bus, the fingerprint key) is already a constructor dependency. */
export type SettingsHandler<In, Out> = (svc: SettingsService, input: In) => Out

/** One contract joined to the service method that implements it. */
export interface SettingsCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous by
  // construction; each entry's input type is pinned by its own contract through
  // the `satisfies` below, and re-derived per command by `SettingsProcedures`.
  readonly handler: SettingsHandler<any, unknown>
}

/**
 * The joined table, keyed by the DOTTED wire name (the fleet table's shape
 * rather than the spec table's bare one), because these four are not all the
 * `settings` router serves and the dotted key is what the audit and the running
 * router both name.
 */
export const SETTINGS_COMMANDS_TRPC = {
  'settings.updatePersonal': {
    contract: SETTINGS_CONTRACTS['settings.updatePersonal'],
    handler: ((svc, input) => svc.updatePreferences(input.values)) satisfies SettingsHandler<
      z.infer<(typeof SETTINGS_CONTRACTS)['settings.updatePersonal']['input']>,
      unknown
    >,
  },
  'settings.updateInstance': {
    contract: SETTINGS_CONTRACTS['settings.updateInstance'],
    handler: ((svc, input) => svc.updatePreferences(input.values)) satisfies SettingsHandler<
      z.infer<(typeof SETTINGS_CONTRACTS)['settings.updateInstance']['input']>,
      unknown
    >,
  },
  'settings.setSecret': {
    contract: SETTINGS_CONTRACTS['settings.setSecret'],
    handler: ((svc, input) => svc.setSecret(input.key, input.value)) satisfies SettingsHandler<
      z.infer<(typeof SETTINGS_CONTRACTS)['settings.setSecret']['input']>,
      unknown
    >,
  },
  'settings.clearSecret': {
    contract: SETTINGS_CONTRACTS['settings.clearSecret'],
    handler: ((svc, input) => svc.clearSecret(input.key)) satisfies SettingsHandler<
      z.infer<(typeof SETTINGS_CONTRACTS)['settings.clearSecret']['input']>,
      unknown
    >,
  },
} as const satisfies Record<SettingsContractName, SettingsCommand>

export type SettingsCommandName = keyof typeof SETTINGS_COMMANDS_TRPC

export const isSettingsCommand = (name: string): name is SettingsCommandName =>
  Object.hasOwn(SETTINGS_COMMANDS_TRPC, name)

/** The bare procedure key the `settings` router serves a command under —
 *  `settings.setSecret` is served as `setSecret`. Derived by stripping the one
 *  known prefix rather than stored as a second name, so the wire name and the
 *  proc key cannot drift into two vocabularies. */
export const settingsProcKey = (name: SettingsCommandName): string => name.slice('settings.'.length)

/**
 * ADR 3 D3, enforced rather than documented. Default-closed: an unknown name is
 * `false`, so a typo at a call site removes a surface loudly instead of opening
 * one silently.
 */
export function isSettingsCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isSettingsCommand(name)) return false
  return SETTINGS_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

/** The commands this family serves on `transport`, in the contract table's
 *  sorted order so a consumer's iteration does not depend on declaration order. */
export const settingsCommandsOn = (transport: TransportTag): SettingsCommandName[] =>
  SETTINGS_COMMAND_NAMES.filter((n) => isSettingsCommandExposedOn(n, transport))

/** The classification lint over the joined table — the same function the L1 test
 *  runs, so the gate cannot pass at L1 and be absent where the handlers live. */
export const settingsRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(SETTINGS_COMMANDS_TRPC).map((c) => c.contract))
