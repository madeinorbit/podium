import { reportCommandFailure } from './failures'
import type { MachinesCommands } from './machines-types'
import type { CommandWrites } from './writes'

/** The two existing machine spec edits from POD-6644, unchanged. */
export function createMachinesCommands(
  shared: Pick<CommandWrites, 'editRecord' | 'reportFailure'>,
): MachinesCommands {
  const commands: MachinesCommands = {
    rename: async (machineId, name) =>
      shared.editRecord({ kind: 'machine', id: machineId }, { name }),
    setUpdateChannel: async (machineId, channel) =>
      shared.editRecord({ kind: 'machine', id: machineId }, { updateChannelOverride: channel }),
  }
  return {
    rename: reportCommandFailure(commands.rename, shared.reportFailure),
    setUpdateChannel: reportCommandFailure(commands.setUpdateChannel, shared.reportFailure),
  }
}
