/**
 * THE DERIVED ACCOUNT SURFACE (POD-314) — `connect` and `disconnect` from their
 * contracts, `list` from the query table.
 */

import { asUserId, type HarnessAgent, type MachineId } from '@podium/model'
import { resolveRole, type ResolvedRole } from '@podium/runtime'
import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import {
  codexAuthorizerFor,
  codexLoginMachines,
  type CodexLoginMachineSource,
  pickCodexMachine,
} from '../../codex-machine'
import { ACCOUNT_QUERIES } from './queries'
import { ACCOUNT_COMMANDS_TRPC } from './registry'

export type AccountProcedures = FamilyProcedures<
  typeof ACCOUNT_COMMANDS_TRPC,
  typeof ACCOUNT_QUERIES
>

export interface CodexServerAiMarker {
  harness: HarnessAgent
  machineId?: MachineId
  machineName?: string
  lastError?: string
}

/**
 * Assemble the hub marker for the viewer's server-AI login (POD-4750): the
 * background role decides the account, and only a role that runs on a native
 * login (today: the ChatGPT Responses API) yields a marker. The machine comes
 * from the same scoped picker as the one-shot transport, so the hub row and
 * the turn cannot disagree — and every identity here (role harness, account)
 * flows as a value, never a literal (POD-4414 §5).
 *
 * The background role's last refusal text (POD-4805) rides along when the
 * issue assistant has recorded one — including when no machine could be
 * picked, so Settings still says why. No marker at all when the role runs on
 * no native login, or when there is no failure to explain.
 *
 * Pure over injected reads, so tests pin the ride-along without a router.
 */
export function assembleCodexServerAiMarker(opts: {
  role: ResolvedRole
  authorize: (machineId: MachineId) => string | undefined
  listings: readonly CodexLoginMachineSource[]
  isOnline: (id: MachineId) => boolean
  defaultMachineId: MachineId | undefined
  lastError: string | undefined
}): CodexServerAiMarker | undefined {
  if (opts.role.execution !== 'api' || !opts.role.accountId.startsWith('native:')) {
    return undefined
  }
  const harness = opts.role.harness
  const errorPart = opts.lastError ? { lastError: opts.lastError } : {}
  try {
    const picked = pickCodexMachine(
      codexLoginMachines(opts.listings, opts.isOnline, harness),
      { defaultMachineId: opts.defaultMachineId, authorize: opts.authorize },
    )
    return { harness, machineId: picked.machineId, machineName: picked.machineName, ...errorPart }
  } catch {
    return opts.lastError ? { harness, ...errorPart } : undefined
  }
}

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
      // Which native login THIS viewer's server AI would spend — see
      // {@link assembleCodexServerAiMarker}. Undefined when the role runs on
      // no native login or none is usable for the viewer: rows omit the
      // marker rather than inventing one.
      resolveCodexServerAi: async (): Promise<CodexServerAiMarker | undefined> => {
        if (!state.users) return undefined
        try {
          const viewer = asUserId(state.caller.userId)
          const role = resolveRole(await state.modules.settings.getSettingsFor(viewer), 'background')
          const authorize = await codexAuthorizerFor(
            { users: state.users, machines: state.modules.machines },
            viewer,
          )
          return assembleCodexServerAiMarker({
            role,
            authorize,
            listings: await state.modules.machines.listMachines(),
            isOnline: (id) => state.modules.machines.hasDaemon(id),
            defaultMachineId: await state.modules.machines.defaultMachine().catch(() => undefined),
            lastError: state.modules.issues.gitWorkflow.backgroundLastError(),
          })
        } catch {
          return undefined
        }
      },
    }),
    commands: ACCOUNT_COMMANDS_TRPC,
    queries: ACCOUNT_QUERIES,
  })
