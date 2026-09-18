/** Local maintenance uses the host's enrolled identity, never a separate secret. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MachineChallenge, machineHelloTranscript } from '@podium/protocol'
import { stateDir } from './config'
import { readMachineState } from './local-machine'
import { machinePublicKeyWire, readMachineCredential, signWithMachine, type MachineCredential } from './machine-credential'

export type HostMachineCredential =
  | { machineId: string; kind: 'bearer'; token: string }
  | { machineId: string; kind: 'key'; key: MachineCredential }

/** Read on every request so an acknowledged rotation needs no worker restart. */
export function readHostMachineCredential(dir = stateDir(), allowLegacyFile = true): HostMachineCredential {
  const machine = readMachineState(dir)
  if (!machine) throw new Error('host machine identity is unavailable')
  const section = machine.supervisor ?? machine.daemon
  if (section && section.machineId !== machine.machineId) throw new Error('host machine credential identity mismatch')
  if (typeof section?.enrolledPublicKey === 'string') {
    const key = readMachineCredential(dir)
    if (!key) throw new Error('enrolled host machine key is unavailable')
    const active = key.pendingRotation && machinePublicKeyWire(key.pendingRotation) === section.enrolledPublicKey
      ? { version: 1 as const, ...key.pendingRotation } : key
    if (machinePublicKeyWire(active) !== section.enrolledPublicKey) throw new Error('enrolled host machine key mismatch')
    return { machineId: machine.machineId, kind: 'key', key: active }
  }
  if (typeof section?.token === 'string' && section.token) return { machineId: machine.machineId, kind: 'bearer', token: section.token }
  // Read-only migration candidate. ONLY the normal host-row bearer verifier can
  // accept it. An unrelated historical daemon.secret has no authority.
  if (allowLegacyFile) {
    try {
      const token = readFileSync(join(dir, 'daemon.secret'), 'utf8').trim()
      if (token) return { machineId: machine.machineId, kind: 'bearer', token }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error('host machine has no enrolled credential')
}

export async function maintenanceAuthorization(
  base: string, path: string, body: string, dir: string,
  fetchFn: typeof fetch, signal: AbortSignal,
): Promise<string> {
  const credential = readHostMachineCredential(dir)
  if (credential.kind === 'bearer') return `Bearer ${credential.token}`
  const response = await fetchFn(`${base}/maintenance/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, body }), signal,
  })
  if (!response.ok) throw new Error(`maintenance challenge failed (${response.status})`)
  const challenge = MachineChallenge.parse(await response.json())
  const binding = createHash('sha256').update(JSON.stringify([path, body])).digest('hex')
  if (!challenge.connectionId.startsWith('maintenance:') || !challenge.connectionId.endsWith(`:${binding}`)
    || challenge.machineId !== credential.machineId || challenge.expiresAtMs <= Date.now()) throw new Error('invalid maintenance challenge')
  return `MachineKey ${JSON.stringify({ nonce: challenge.nonce,
    signature: signWithMachine(credential.key, machineHelloTranscript(challenge)) })}`
}
