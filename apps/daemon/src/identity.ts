import type { MachineId } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import { loadMachineState, updateMachineState } from '@podium/runtime/local-machine'

export interface DaemonIdentity {
  /** Stable UUID join key — the cross-restart machine identity. */
  machineId: MachineId
  /** The paired auth token, once issued (absent until the first successful pair). */
  token?: string
  /** The server update-signing key pinned during pairing. */
  updatePubkey?: string
}

/** Role adapters never write machine.json themselves. */
export function loadIdentity(opts: { dir?: string } = {}): DaemonIdentity {
  const machine = loadMachineState(opts.dir ?? stateDir())
  const data = machine.daemon ?? {}
  // A legacy daemon's credential names its own row; the root id may be a supervisor's
  // or a stale machine.id. Never pair the root id with the daemon's token.
  const machineId = typeof data.machineId === 'string' && data.machineId.trim() ? (data.machineId as MachineId) : machine.machineId
  return { machineId,
    ...(typeof data.token === 'string' ? { token: data.token } : {}),
    ...(typeof data.updatePubkey === 'string' ? { updatePubkey: data.updatePubkey } : {}) }
}
export function saveToken(token: string, opts: { dir?: string } = {}): void {
  updateMachineState(opts.dir ?? stateDir(), (machine) => {
    machine.daemon = { ...machine.daemon, machineId: machine.daemon?.machineId ?? machine.machineId, token }
  })
}
export function savePairingToken(token: string, updatePubkey: string | undefined, opts: { dir?: string } = {}): void {
  updateMachineState(opts.dir ?? stateDir(), (machine) => {
    machine.daemon = { ...machine.daemon, machineId: machine.daemon?.machineId ?? machine.machineId, token, updatePubkey }
  })
}
export function savePinnedUpdatePubkey(updatePubkey: string, opts: { dir?: string } = {}): void {
  updateMachineState(opts.dir ?? stateDir(), (machine) => {
    machine.daemon = { ...machine.daemon, machineId: machine.daemon?.machineId ?? machine.machineId, updatePubkey }
  })
}
