/** Machine enrollment owns this key; callers explicitly choose its storage directory.
 * Creation is an enrollment operation, never a boot-time repair or fallback.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isSigningKeyPair,
  mintSigningKeyPair,
  publicKeyWire,
  signMessage,
  verifyWithWireKey,
  type SigningKeyPair,
} from './signing'

export const MACHINE_KEY_FILE = 'machine.key'
export const MACHINE_SIGNATURE_PREFIX = 'podium-machine-v1\n'
export interface MachineCredential extends SigningKeyPair {
  version: 1
}

function parse(path: string, raw: string): MachineCredential {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`invalid persisted machine credential at ${path}`)
  }
  if (!isSigningKeyPair(value) || (value as Partial<MachineCredential>).version !== 1) {
    throw new Error(`invalid persisted machine credential at ${path}`)
  }
  return { version: 1, privateKey: value.privateKey, publicKey: value.publicKey }
}

/** Absence is reported to the enrollment caller; corruption is always an error. */
export function readMachineCredential(credentialDir: string): MachineCredential | undefined {
  const path = join(credentialDir, MACHINE_KEY_FILE)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parse(path, raw)
}

/** Explicit enrollment only. Exclusive creation preserves an existing credential. */
export function createMachineCredential(credentialDir: string): MachineCredential {
  const existing = readMachineCredential(credentialDir)
  if (existing) return existing
  const credential: MachineCredential = { version: 1, ...mintSigningKeyPair() }
  mkdirSync(credentialDir, { recursive: true, mode: 0o700 })
  const path = join(credentialDir, MACHINE_KEY_FILE)
  try {
    writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    return credential
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return parse(path, readFileSync(path, 'utf8'))
  }
}

export const machinePublicKeyWire = publicKeyWire
export const signWithMachine = (
  credential: Pick<MachineCredential, 'privateKey'>,
  message: string,
): string => signMessage(credential, MACHINE_SIGNATURE_PREFIX, message)
export const verifyWithMachineKey = (wire: string, message: string, signature: string): boolean =>
  verifyWithWireKey(wire, MACHINE_SIGNATURE_PREFIX, message, signature)
