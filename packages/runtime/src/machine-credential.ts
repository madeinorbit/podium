/** Machine enrollment owns this key; callers explicitly choose its storage directory.
 * Creation is an enrollment operation, never a boot-time repair or fallback.
 */
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs'
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
  /** An explicit rotation keeps both private keys until the server acknowledges. */
  pendingRotation?: SigningKeyPair
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
  const pending = (value as MachineCredential).pendingRotation
  if (pending !== undefined && !isSigningKeyPair(pending)) throw new Error(`invalid pending machine credential at ${path}`)
  return { version: 1, privateKey: value.privateKey, publicKey: value.publicKey,
    ...(pending ? { pendingRotation: pending } : {}) }
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

/** Atomic replacement uses a transient sibling, never a second durable credential file. */
function saveCredential(dir: string, credential: MachineCredential): void {
  const path = join(dir, MACHINE_KEY_FILE)
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(credential)}\n`, { mode: 0o600 })
  const fd = openSync(temporary, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  const directory = openSync(dir, 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

/** Explicit operator action. Retries reuse the persisted proposal, including after restart. */
export function prepareMachineCredentialRotation(dir: string): MachineCredential {
  const current = createMachineCredential(dir)
  if (current.pendingRotation) return current
  const prepared = { ...current, pendingRotation: mintSigningKeyPair() }
  saveCredential(dir, prepared)
  return prepared
}

/** The caller persists the acknowledged public key before retiring the old private key. */
export function acknowledgeMachineCredentialRotation(dir: string, publicKey: string): boolean {
  const current = readMachineCredential(dir)
  if (!current?.pendingRotation || machinePublicKeyWire(current.pendingRotation) !== publicKey) return false
  saveCredential(dir, { version: 1, ...current.pendingRotation })
  return true
}
