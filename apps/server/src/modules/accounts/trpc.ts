/**
 * THE DERIVED ACCOUNT SURFACE (POD-314) — `connect` and `disconnect` from their
 * contracts, `list` from the query table.
 */

import { asUserId } from '@podium/model'
import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { codexAuthorizerFor, codexLoginMachines, pickCodexMachine, serverVersionLabel } from '../../codex-machine'
import { ACCOUNT_QUERIES } from './queries'
import { ACCOUNT_COMMANDS_TRPC } from './registry'

export type AccountProcedures = FamilyProcedures<
  typeof ACCOUNT_COMMANDS_TRPC,
  typeof ACCOUNT_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `accounts` router. */
export const accountFamilyProcedures = (): AccountProcedures =>
  derivedFamilyProcedures({
    family: 'accounts',
    service: (state) => ({
      accounts: state.store.accounts,
      machines: state.store.machines,
      machineService: state.modules.machines,
      settings: state.modules.settings,
      nativeLogin: state.modules.nativeLogin,
      callerUserId: state.caller.userId,
      // Which machine's Codex login THIS viewer's server AI would run on
      // (POD-4750): the same scoped picker as the one-shot transport, so the
      // hub row and the turn cannot disagree. Undefined when no login is
      // usable for the viewer (or no user store is assembled) — the row then
      // omits "Server AI uses …" rather than inventing one.
      resolveCodexServerAi: async () => {
        if (!state.users) return undefined
        try {
          const authorize = await codexAuthorizerFor(
            { users: state.users, machines: state.modules.machines },
            asUserId(state.caller.userId),
          )
          const listings = await state.modules.machines.listMachines()
          const picked = pickCodexMachine(
            codexLoginMachines(listings, (id) => state.modules.machines.hasDaemon(id)),
            {
              defaultMachineId: await state.modules.machines.defaultMachine().catch(() => undefined),
              authorize,
              serverVersion: serverVersionLabel(),
            },
          )
          return { machineId: picked.machineId, machineName: picked.machineName }
        } catch {
          return undefined
        }
      },
    }),
    commands: ACCOUNT_COMMANDS_TRPC,
    queries: ACCOUNT_QUERIES,
  })
