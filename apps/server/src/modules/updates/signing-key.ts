import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '@podium/runtime/config'

/** The one update-signing identity owned by this server instance. */
export interface UpdateSigningKey {
  /** PKCS#8 DER, base64 encoded. Server-only. */
  privateKey: string
  /** SPKI DER, base64 encoded. Safe to send to a pairing daemon. */
  publicKey: string
}

const FILE_NAME = 'update-signing-key.json'

function invalidKey(path: string): Error {
  return new Error(`invalid persisted update signing key at ${path}`)
}

function parsePersistedKey(path: string, raw: string): UpdateSigningKey {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) throw invalidKey(path)
    const candidate = value as { privateKey?: unknown; publicKey?: unknown }
    if (typeof candidate.privateKey !== 'string' || candidate.privateKey.length === 0)
      throw invalidKey(path)
    if (typeof candidate.publicKey !== 'string' || candidate.publicKey.length === 0)
      throw invalidKey(path)

    // Do not silently accept a file whose public half no longer matches the private
    // half. Re-minting here would rotate the trust root on a damaged state directory.
    const privateKey = createPrivateKey({
      key: Buffer.from(candidate.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    const derivedPublicKey = createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64')
    if (derivedPublicKey !== candidate.publicKey) throw invalidKey(path)
    return { privateKey: candidate.privateKey, publicKey: candidate.publicKey }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `invalid persisted update signing key at ${path}`
    )
      throw error
    throw invalidKey(path)
  }
}

function mintKey(): UpdateSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }
}

/**
 * Read the server's update key, or mint it once in the instance state directory.
 *
 * An existing but malformed file is an availability failure, not permission to
 * mint a replacement: replacing it would make every daemon's pairing pin stale.
 * `wx` also makes simultaneous server starts converge on the same first key.
 */
export function readOrCreateUpdateSigningKey(dir: string = stateDir()): UpdateSigningKey {
  const path = join(dir, FILE_NAME)
  try {
    return parsePersistedKey(path, readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const key = mintKey()
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path, JSON.stringify(key, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return parsePersistedKey(path, readFileSync(path, 'utf8'))
  }
}

const DEV_ARTIFACT_TOKEN_FILE_NAME = 'dev-artifact-token'

function readDevArtifactToken(path: string): string {
  const token = readFileSync(path, 'utf8').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error(`invalid persisted development artifact token at ${path}`)
  }
  return token
}

/**
 * Read the credential embedded in development-feed artifact URLs, or mint it
 * once in the instance state directory.
 *
 * The manifest outlives the process that wrote it, so its query credential has
 * exactly the same lifetime requirement. A malformed existing file refuses
 * startup rather than rotating every persisted artifact URL into a 401.
 */
export function readOrCreateDevArtifactToken(dir: string = stateDir()): string {
  const path = join(dir, DEV_ARTIFACT_TOKEN_FILE_NAME)
  try {
    return readDevArtifactToken(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const token = randomUUID()
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path, token + '\n', { mode: 0o600, flag: 'wx' })
    return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return readDevArtifactToken(path)
  }
}
