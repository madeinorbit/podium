import type { HarnessAgent, MachineId } from '@podium/model'
import type { ResolvedRole } from '@podium/runtime'
import {
  type CodexLoginMachineSource,
  codexLoginMachines,
  pickCodexMachine,
} from '../../codex-machine'

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
    const picked = pickCodexMachine(codexLoginMachines(opts.listings, opts.isOnline, harness), {
      defaultMachineId: opts.defaultMachineId,
      authorize: opts.authorize,
    })
    return { harness, machineId: picked.machineId, machineName: picked.machineName, ...errorPart }
  } catch {
    return opts.lastError ? { harness, ...errorPart } : undefined
  }
}
