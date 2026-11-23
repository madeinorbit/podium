/** Plain registrations import handlers, never their transport adapters. */
import type { Context } from '../../trpc'
import { familyState } from '../derived-family'
import { type PlainContractRegistration, trpcRequest } from '../plain-command/registry'
import { settingsAuthzDeps } from './authz'
import { settingsCommandWith } from './command-runner'
import { SETTINGS_COMMANDS_TRPC, type SettingsCommandName } from './registry'

export const isPlainSettingsCommand = (name: SettingsCommandName): boolean =>
  SETTINGS_COMMANDS_TRPC[name].contract.delivery.class !== 'offline-eligible'

export const settingsDepsOf = (ctx: Context) => async () => ({
  deps: await settingsAuthzDeps(ctx),
  service: familyState(ctx).modules.settings,
})

export const isPlainSettingsWrite = (name: SettingsCommandName): boolean =>
  isPlainSettingsCommand(name) && SETTINGS_COMMANDS_TRPC[name].contract.policy.action !== 'read'

/**
 * The plain settings WRITES, registered in `plain-command/commands.ts`. The
 * presence read is served as a query on the same front door
 * ({@link plainSettingsCommandWith}); a read has no registration.
 */
export const SETTINGS_PLAIN_REGISTRATIONS: readonly PlainContractRegistration[] = (
  Object.keys(SETTINGS_COMMANDS_TRPC) as SettingsCommandName[]
)
  .filter(isPlainSettingsWrite)
  .map((name) => ({
    contract: SETTINGS_COMMANDS_TRPC[name].contract,
    handle: async (ctx, input, source) => {
      const { deps, service } = await settingsDepsOf(trpcRequest(ctx, source))()
      return await settingsCommandWith(name, deps, service, input)
    },
  }))
