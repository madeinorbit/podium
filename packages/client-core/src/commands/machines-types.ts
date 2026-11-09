import type { MachineId, UpdateChannel } from '@podium/model'

export interface MachinesCommands {
  rename(machineId: MachineId, name: string): Promise<void>
  setUpdateChannel(machineId: MachineId, channel: UpdateChannel | null): Promise<void>
}
