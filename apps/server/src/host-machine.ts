import type { MachineId } from '@podium/model'

/** The server's own install, when it belongs to a fleet machine. Never a routing default. */
export type HostMachine = { readonly id: MachineId } | null
