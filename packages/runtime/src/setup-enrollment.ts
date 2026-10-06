import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { type MachineChallenge, machineHelloTranscript } from '@podium/protocol'
import { stateDir } from './config'
import { fsyncPath } from './fsync'
import {
  createMachineCredential,
  machinePublicKeyWire,
  readMachineCredential,
  signWithMachine,
} from './machine-credential'
import { loadSupervisorState, saveSupervisorState } from './machine-supervisor'

export interface SetupEnrollmentRequest {
  requestId: string
  machineId: string
  publicKey: string
  agentExecution: boolean
  /** Explicit pre-server setup acknowledgement; consumed by first activation only. */
  preauthorized: boolean
}

function syncPath(path: string): void {
  fsyncPath(path)
}
function persist(dir: string, state: ReturnType<typeof loadSupervisorState>): void {
  saveSupervisorState(dir, state)
  syncPath(join(dir, 'machine.json'))
  syncPath(dir)
}

export function prepareSetupEnrollment(
  agentExecution: boolean,
  preauthorized = false,
  dir = stateDir(),
): SetupEnrollmentRequest {
  const state = loadSupervisorState(dir)
  if (state.setupEnrollment) {
    const key = readMachineCredential(dir)
    if (!key || machinePublicKeyWire(key) !== state.setupEnrollment.publicKey)
      throw new Error('setup request key is unavailable')
    syncPath(join(dir, 'machine.key'))
    persist(dir, state)
    return state.setupEnrollment
  }
  const key = createMachineCredential(dir)
  syncPath(join(dir, 'machine.key'))
  syncPath(dir)
  const request = {
    requestId: randomUUID(),
    machineId: state.machineId,
    publicKey: machinePublicKeyWire(key),
    agentExecution,
    preauthorized,
  }
  state.setupEnrollment = request
  persist(dir, state)
  return request
}

export function confirmSetupEnrollment(
  requestId: string,
  publicKey: string,
  dir = stateDir(),
): SetupEnrollmentRequest {
  const state = loadSupervisorState(dir)
  const request = state.setupEnrollment
  const key = readMachineCredential(dir)
  if (
    !request ||
    request.requestId !== requestId ||
    request.publicKey !== publicKey ||
    !key ||
    machinePublicKeyWire(key) !== publicKey
  )
    throw new Error('setup enrollment confirmation does not match the persisted request')
  state.enrolledPublicKey = publicKey
  delete state.token
  persist(dir, state)
  return request
}

/** The supervisor signs only for its own machine; private key bytes never cross the channel. */
export function signMachineHello(challenge: MachineChallenge, dir = stateDir()): string {
  const state = loadSupervisorState(dir)
  if (challenge.machineId !== state.machineId || challenge.expiresAtMs <= Date.now())
    throw new Error('invalid machine hello challenge')
  const key = readMachineCredential(dir)
  if (!key) throw new Error('machine enrollment has not persisted a key')
  if (key.pendingRotation) throw new Error('machine credential rotation is awaiting confirmation')
  return signWithMachine(key, machineHelloTranscript(challenge))
}
