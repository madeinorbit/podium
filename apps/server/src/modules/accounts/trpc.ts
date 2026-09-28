/**
 * THE DERIVED ACCOUNT SURFACE (POD-314) — `connect` and `disconnect` from their
 * contracts, `list` from the query table.
 */

import { asUserId, type HarnessAgent, type MachineId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
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
      // Which native login THIS viewer's server AI would spend (POD-4750):
      // the caller's background role decides the account, and only a role
      // that runs on a native login (today: the ChatGPT Responses API) yields
      // a marker. The machine then comes from the same scoped picker as the
      // one-shot transport, so the hub row and the turn cannot disagree — and
      // every identity here (role harness, account) flows as a value, never a
      // literal (POD-4414 §5). Undefined when the role runs on no native login
      // or none is usable for the viewer: rows omit the marker rather than
      // inventing one.
      resolveCodexServerAi: async (): Promise<
        { harness: HarnessAgent; machineId: MachineId; machineName: string } | undefined
      > => {
        if (!state.users) return undefined
        try {
          const viewer = asUserId(state.caller.userId)
          const role = resolveRole(await state.modules.settings.getSettingsFor(viewer), 'background')
          if (role.execution !== 'api' || !role.accountId.startsWith('native:')) return undefined
          const harness = role.harness
          const authorize = await codexAuthorizerFor(
            { users: state.users, machines: state.modules.machines },
            viewer,
          )
          const listings = await state.modules.machines.listMachines()
          const picked = pickCodexMachine(
            codexLoginMachines(listings, (id) => state.modules.machines.hasDaemon(id), harness),
            {
              defaultMachineId: await state.modules.machines.defaultMachine().catch(() => undefined),
              authorize,
              serverVersion: serverVersionLabel(),
            },
          )
          return { harness, machineId: picked.machineId, machineName: picked.machineName }
        } catch {
          return undefined
        }
      },
    }),
    commands: ACCOUNT_COMMANDS_TRPC,
    queries: ACCOUNT_QUERIES,
  })
