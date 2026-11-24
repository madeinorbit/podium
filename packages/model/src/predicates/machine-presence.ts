/** Client readings mark freshness explicitly; a server listing is current at delivery. */
export interface MachinePresenceReading {
  readonly online: boolean
  readonly onlineKnown?: boolean
}

export type MachinePresence = 'Online' | 'Reconnecting' | 'Offline'

/** A lost browser link says nothing about the machine's daemon connection. */
export function machinePresence(machine: MachinePresenceReading): MachinePresence {
  if (machine.onlineKnown === false) return 'Reconnecting'
  return machine.online ? 'Online' : 'Offline'
}
