import { harnessInstallActionContract, type harnessInstallActionInput } from '@podium/commands'
import type { HarnessActionResult } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { checkMachineVerb, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import { definePlainFamily } from '../plain-command/declare'

/** Same gate for every client and the CLI relay; no server-side version decisions. */
export async function runHarnessAction(
  modules: Pick<RegistryModules, 'machines' | 'rpc'>,
  principal: CommandPrincipal,
  input: z.infer<typeof harnessInstallActionInput>,
): Promise<HarnessActionResult> {
  const ownership = await ownershipSnapshotFromMachines(modules.machines)
  const failure = checkMachineVerb(
    principal,
    input.machineId,
    ownership,
    input.action === 'changes' ? 'use' : 'manage',
  )
  if (failure)
    throw new TRPCError({
      code: failure === 'absent' ? 'NOT_FOUND' : 'FORBIDDEN',
      message:
        failure === 'absent'
          ? 'No such machine.'
          : 'You cannot manage harness installs on this machine.',
    })
  if (!modules.machines.hasDaemon(input.machineId))
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This machine is offline.' })
  return await modules.rpc.harnessAction(
    input.action,
    input.harness,
    input.machineId,
    input.confirmedConversations,
  )
}

export interface InstallState {
  modules: Pick<RegistryModules, 'machines' | 'rpc'>
  principal: CommandPrincipal | undefined
}

export const HARNESS_INSTALL_FAMILY = definePlainFamily({
  family: 'harnessInstalls',
  service: (state, principal): InstallState => ({
    modules: state.modules,
    principal: principal ?? state.principal,
  }),
  commands: {
    action: {
      contract: harnessInstallActionContract,
      handler: async (state: InstallState, input: z.infer<typeof harnessInstallActionInput>) => {
        if (!state.principal) throw new TRPCError({ code: 'UNAUTHORIZED' })
        return await runHarnessAction(state.modules, state.principal, input)
      },
    },
  },
})
