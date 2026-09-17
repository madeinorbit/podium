/** Installation identity wire types and signing helpers. Persistence belongs to
 * the installation database; only the one-time server import reads the old file. */
import { randomBytes } from 'node:crypto'
import type { SqlDatabase } from './sqlite'

import { isSigningKeyPair, mintSigningKeyPair } from './signing'
export {
  publicKeyWire as installationPublicKeyWire,
  parseWirePublicKey,
  signMessage as signWithInstallation,
  verifyWithWireKey,
} from './signing'

export const INSTALLATION_FILE = 'installation.json'
export const INSTALLATION_META_KEY = 'installation_identity'
export const INSTALLATION_PRIVATE_KEY = 'installation.privateKey'

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

export function parseInstallationIdentity(path: string, raw: string): InstallationIdentity {
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

export function mintInstallationIdentity(now: Date = new Date()): InstallationIdentity {
  return {
    version: 1,
    installationId: `pdm_${randomBytes(32).toString('base64url')}`,
    ...mintSigningKeyPair(),
    generation: 1,
    createdAt: now.toISOString(),
  }
}

/** The transfer target owns this offline database before it starts the server.
 * Each promotion retry reinstalls the source snapshot, so N always becomes N+1.
 * An older database without an installation identity has nothing to advance. */
export function bumpInstallationGeneration(db: SqlDatabase): void {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(INSTALLATION_META_KEY) as
    | { value: string }
    | undefined
  if (!row) return
  const metadata = JSON.parse(row.value)
  if (
    !Number.isSafeInteger(metadata.generation) ||
    metadata.generation < 1 ||
    metadata.generation === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('invalid persisted installation generation')
  }
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
    JSON.stringify({ ...metadata, generation: metadata.generation + 1 }),
    INSTALLATION_META_KEY,
  )
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
