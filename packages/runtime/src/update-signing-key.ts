import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './config'
import {
  acceptsUpdateKeyRotation,
  updateKeyRotationPayload,
  verifyUpdateKeyRotation,
  type UpdateKeyRotation,
} from './update-key-trust'

/** The one update-signing identity owned by this server instance. */
export interface UpdateSigningKey {
  /** PKCS#8 DER, base64 encoded. Server-only. */
  privateKey: string
  /** SPKI DER, base64 encoded. Safe to send to a pairing daemon. */
  publicKey: string
  /** Old-key-signed path by which an already-pinned daemon may reach this key. */
  rotations: UpdateKeyRotation[]
}

const FILE_NAME = 'update-signing-key.json'
const PUBLIC_ANCHOR_FILE_NAME = 'update-signing-key.pub'

function invalidKey(path: string): Error {
  return new Error(`invalid persisted update signing key at ${path}`)
}

function parsePersistedKey(path: string, raw: string): UpdateSigningKey {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) throw invalidKey(path)
    const candidate = value as {
      privateKey?: unknown
      publicKey?: unknown
      rotations?: unknown
    }
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

    const rotations = candidate.rotations ?? []
    if (!Array.isArray(rotations)) throw invalidKey(path)
    let previous: string | undefined
    const parsedRotations: UpdateKeyRotation[] = []
    for (const value of rotations) {
      if (typeof value !== 'object' || value === null) throw invalidKey(path)
      const rotation = value as Partial<UpdateKeyRotation>
      if (
        typeof rotation.from !== 'string' ||
        typeof rotation.to !== 'string' ||
        typeof rotation.signature !== 'string'
      )
        throw invalidKey(path)
      if (previous !== undefined && rotation.from !== previous) throw invalidKey(path)
      if (!verifyUpdateKeyRotation(rotation as UpdateKeyRotation)) throw invalidKey(path)
      parsedRotations.push(rotation as UpdateKeyRotation)
      previous = rotation.to
    }
    if (previous !== undefined && previous !== candidate.publicKey) throw invalidKey(path)
    return {
      privateKey: candidate.privateKey,
      publicKey: candidate.publicKey,
      rotations: parsedRotations,
    }
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
    rotations: [],
  }
}

function writeKey(path: string, key: UpdateSigningKey, flag: 'wx' | 'w'): void {
  writeFileSync(path, JSON.stringify(key, null, 2) + '\n', { mode: 0o600, flag })
}

/**
 * Read the server's update key, or mint it once in the instance state directory.
 *
 * An existing but malformed file is an availability failure, not permission to
 * mint a replacement: replacing it would make every daemon's pairing pin stale.
 * `wx` also makes simultaneous server starts converge on the same first key.
 */
export function readOrCreateUpdateSigningKey(
  dir: string = stateDir(),
  opts: { allowCreate?: boolean; confirmNoPins?: boolean } = {},
): UpdateSigningKey {
  const path = join(dir, FILE_NAME)
  const anchorPath = join(dir, PUBLIC_ANCHOR_FILE_NAME)
  try {
    const key = parsePersistedKey(path, readFileSync(path, 'utf8'))
    try {
      ensurePublicAnchor(anchorPath, key)
    } catch (error) {
      if (!opts.confirmNoPins) throw error
      replacePublicAnchor(anchorPath, key.publicKey)
    }
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const anchoredPublicKey = readPublicAnchor(anchorPath)
  if (opts.allowCreate === false || (anchoredPublicKey !== undefined && !opts.confirmNoPins)) {
    throw new Error(
      `refusing to mint a replacement update signing key at ${path}: enrolled machines ` +
        'may still trust the missing key. Restore update-signing-key.json from backup; if ' +
        'no machine ever pinned it, run `podium update-key initialize --confirm-no-pins`.',
    )
  }

  const key = mintKey()
  mkdirSync(dir, { recursive: true })
  try {
    writeKey(path, key, 'wx')
    if (anchoredPublicKey === undefined) ensurePublicAnchor(anchorPath, key)
    else replacePublicAnchor(anchorPath, key.publicKey)
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const winner = parsePersistedKey(path, readFileSync(path, 'utf8'))
    if (opts.confirmNoPins) replacePublicAnchor(anchorPath, winner.publicKey)
    else ensurePublicAnchor(anchorPath, winner)
    return winner
  }
}

/**
 * Rotate deliberately while the old private key still exists. The complete
 * chain is persisted with the new private key, so an offline daemon can verify
 * every missed transition from its own pin on its next authenticated hello.
 */
export function rotateUpdateSigningKey(dir: string = stateDir()): UpdateSigningKey {
  const path = join(dir, FILE_NAME)
  const current = readOrCreateUpdateSigningKey(dir, { allowCreate: false })
  const next = mintKey()
  const privateKey = createPrivateKey({
    key: Buffer.from(current.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const rotation: UpdateKeyRotation = {
    from: current.publicKey,
    to: next.publicKey,
    signature: sign(
      null,
      updateKeyRotationPayload(current.publicKey, next.publicKey),
      privateKey,
    ).toString('base64'),
  }
  const rotated: UpdateSigningKey = {
    ...next,
    rotations: [...current.rotations, rotation],
  }
  const temporary = `${path}.next`
  writeKey(temporary, rotated, 'w')
  renameSync(temporary, path)
  return rotated
}

function readPublicAnchor(path: string): string | undefined {
  try {
    const publicKey = readFileSync(path, 'utf8').trim()
    if (publicKey.length === 0) throw new Error(`invalid update signing key anchor at ${path}`)
    return publicKey
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function ensurePublicAnchor(path: string, key: UpdateSigningKey): void {
  try {
    writeFileSync(path, key.publicKey + '\n', { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const anchoredPublicKey = readPublicAnchor(path)
    if (anchoredPublicKey === undefined) {
      throw new Error(`update signing key anchor disappeared at ${path}`)
    }
    if (
      anchoredPublicKey !== key.publicKey &&
      !acceptsUpdateKeyRotation(anchoredPublicKey, key.publicKey, key.rotations)
    ) {
      throw new Error(`persisted update signing key does not match its public anchor at ${path}`)
    }
  }
}

function replacePublicAnchor(path: string, publicKey: string): void {
  const temporary = `${path}.next`
  writeFileSync(temporary, publicKey + '\n', { mode: 0o600, flag: 'w' })
  renameSync(temporary, path)
}
