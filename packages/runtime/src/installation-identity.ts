/**
 * THE INSTALLATION'S OWN IDENTITY — a random id and an Ed25519 key, minted once,
 * that TRAVEL WITH THE INSTALLATION through a server transfer.
 *
 * This is the third identity file in the state dir and it answers a question the
 * other two cannot. `machine.id` names the HOST and deliberately stays behind on a
 * transfer; `update-signing-key.json` is the trust root joined machines pin for
 * update artifacts and moves with server authority. Neither can name "this
 * Podium, wherever it runs today", which is what Podium Connect looks an
 * installation up by and what a client compares a pairing against.
 *
 * The id is 256 random bits, so it cannot be enumerated; the key proves that a
 * write to Connect came from the installation that registered the id. The two are
 * SEPARATE so that a key can one day rotate under a stable id.
 *
 * `generation` counts server transfers. The target bumps it when it promotes; a
 * source that keeps running keeps the old number and is refused by Connect with
 * GENERATION_BEHIND, which is the one signal that says "this installation moved".
 *
 * Same conventions as its neighbours: `wx` so concurrent cold starts converge on one
 * file, 0600, and a corrupt file is an availability failure, never re-minted —
 * re-minting would silently make this a different installation.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './config'

import { isSigningKeyPair, mintSigningKeyPair } from './signing'
export {
  publicKeyWire as installationPublicKeyWire,
  parseWirePublicKey,
  signMessage as signWithInstallation,
  verifyWithWireKey,
} from './signing'

export const INSTALLATION_FILE = 'installation.json'

/** Domain prefixes, byte for byte what connect.podium.do uses. */
export const CONNECT_REQUEST_PREFIX = 'podium-connect-request-v1\n'
export const CONNECT_REACHABILITY_PREFIX = 'podium-reachability-v1\n'
export const CONNECT_PROBE_PREFIX = 'podium-connect-probe-v1\n'

const INSTALLATION_ID_RE = /^pdm_[A-Za-z0-9_-]{43}$/

export interface InstallationIdentity {
  version: 1
  /** `pdm_` + base64url of 32 random bytes. The Connect lookup key. */
  installationId: string
  /** PKCS#8 DER, base64. Never leaves this process. */
  privateKey: string
  /** SPKI DER, base64. */
  publicKey: string
  /** Transfers survived. Starts at 1; the target bumps it on promotion. */
  generation: number
  createdAt: string
}

export const isInstallationId = (value: unknown): value is string =>
  typeof value === 'string' && INSTALLATION_ID_RE.test(value)

function invalid(path: string): Error {
  return new Error(`invalid persisted installation identity at ${path}`)
}

function parse(path: string, raw: string): InstallationIdentity {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw invalid(path)
  }
  if (typeof value !== 'object' || value === null) throw invalid(path)
  const c = value as Partial<InstallationIdentity>
  if (c.version !== 1) throw invalid(path)
  if (!isInstallationId(c.installationId)) throw invalid(path)
  if (typeof c.privateKey !== 'string' || typeof c.publicKey !== 'string') throw invalid(path)
  if (!Number.isInteger(c.generation) || (c.generation as number) < 1) throw invalid(path)
  if (typeof c.createdAt !== 'string') throw invalid(path)
  if (!isSigningKeyPair({ privateKey: c.privateKey, publicKey: c.publicKey })) throw invalid(path)
  return {
    version: 1,
    installationId: c.installationId,
    privateKey: c.privateKey,
    publicKey: c.publicKey,
    generation: c.generation as number,
    createdAt: c.createdAt,
  }
}

function mint(now: Date): InstallationIdentity {
  return {
    version: 1,
    installationId: `pdm_${randomBytes(32).toString('base64url')}`,
    ...mintSigningKeyPair(),
    generation: 1,
    createdAt: now.toISOString(),
  }
}

function write(path: string, identity: InstallationIdentity, flag: 'wx' | 'w'): void {
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, flag })
}

/** The identity if this state dir has one; undefined when it was never minted. */
export function readInstallationIdentity(
  dir: string = stateDir(),
): InstallationIdentity | undefined {
  const path = join(dir, INSTALLATION_FILE)
  try {
    return parse(path, readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Read the identity or mint it once. Only a SERVER should call this: a daemon has
 *  no installation of its own, and minting one on a paired box would make a later
 *  transfer's restore look like a change of identity. */
export function readOrCreateInstallationIdentity(dir: string = stateDir()): InstallationIdentity {
  const existing = readInstallationIdentity(dir)
  if (existing) return existing
  const identity = mint(new Date())
  mkdirSync(dir, { recursive: true })
  try {
    write(join(dir, INSTALLATION_FILE), identity, 'wx')
    return identity
  } catch {
    // Lost the wx race: the winner's file is the identity.
    return parse(join(dir, INSTALLATION_FILE), readFileSync(join(dir, INSTALLATION_FILE), 'utf8'))
  }
}

/**
 * Advance the generation by one, durably. Called by the transfer target when it
 * promotes; undefined when there is nothing to bump (a target whose snapshot
 * carried no identity, which is every transfer from a server older than this).
 */
export function bumpInstallationGeneration(
  dir: string = stateDir(),
): InstallationIdentity | undefined {
  const existing = readInstallationIdentity(dir)
  if (!existing) return undefined
  const next = { ...existing, generation: existing.generation + 1 }
  const path = join(dir, INSTALLATION_FILE)
  const temp = `${path}.${process.pid}.tmp`
  write(temp, next, 'w')
  renameSync(temp, path)
  return next
}

export const connectRequestMessage = (
  method: string,
  path: string,
  timestamp: number,
  bodyHashHex: string,
): string => `${method}\n${path}\n${timestamp}\n${bodyHashHex}`

export const connectProbeMessage = (
  installationId: string,
  challenge: string,
  timestamp: number,
): string => `${installationId}\n${challenge}\n${timestamp}`
