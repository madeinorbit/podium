/**
 * THE VAULT'S OUTSIDE KEY (credential management design §7, "Encryption").
 *
 * Every secret Podium stores is encrypted under one random data key. The data key
 * is kept in the database itself, encrypted again ("wrapped") by an outside key
 * that never lives in the database or the state directory, so a copy of either
 * opens nothing.
 *
 * On a self-hosted server the outside key is a file with owner-only permissions:
 *
 *   $PODIUM_VAULT_KEY_FILE, else $XDG_CONFIG_HOME/podium/vault-<instance>.key,
 *   else ~/.config/podium/vault-<instance>.key
 *
 * The environment variable names a PATH (a mounted secret, say). The key itself
 * is never read from an environment value.
 *
 * This module is shared by the server and by a daemon that receives the server in
 * a transfer, so it reads and writes the wrapped data key's row on a raw handle.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SqlDatabase } from './sqlite/types'

const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
/** Authenticated data for a wrapped data key: a wrapped key cannot pass for anything else. */
const WRAP_AAD = Buffer.from('podium.vault.data-key.v1', 'utf8')

/** Where this instance's outside key lives. */
export function resolveVaultKeyPath(env: NodeJS.ProcessEnv, instance: string): string {
  const explicit = env.PODIUM_VAULT_KEY_FILE?.trim()
  if (explicit) return explicit
  const xdg = env.XDG_CONFIG_HOME?.trim()
  const configRoot = xdg || join(env.HOME?.trim() || homedir(), '.config')
  return join(configRoot, 'podium', `vault-${instance}.key`)
}

/** What wraps and unwraps the data key. A file today; a keychain or key service later. */
export interface KeyProvider {
  /** Which outside key this is. Stored next to the wrapped data key; not secret. */
  readonly keyId: string
  wrap(k: Buffer): Promise<Buffer>
  unwrap(w: Buffer): Promise<Buffer>
}

export type VaultKeyProblem = 'missing' | 'permissions' | 'malformed'

/** The outside key cannot be used. The message names the file and says what to do. */
export class VaultKeyError extends Error {
  constructor(
    readonly path: string,
    readonly reason: VaultKeyProblem,
    message: string,
  ) {
    super(message)
    this.name = 'VaultKeyError'
  }
}

function keyIdOf(key: Buffer): string {
  return `file:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

/** Read and check an existing key file. Throws {@link VaultKeyError}. */
function readKeyFile(path: string): Buffer {
  // Follows a symlink: a mounted secret is often one.
  const stat = statSync(path)
  if (!stat.isFile()) {
    throw new VaultKeyError(
      path,
      'malformed',
      `The vault key file ${path} is not a regular file. Restore the key file there, or point PODIUM_VAULT_KEY_FILE at it.`,
    )
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new VaultKeyError(
      path,
      'permissions',
      `The vault key file ${path} can be read by other users (mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 600 ${path}`,
    )
  }
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
  if (key.length !== KEY_BYTES) {
    throw new VaultKeyError(
      path,
      'malformed',
      `The vault key file ${path} does not hold a ${KEY_BYTES}-byte key. Restore the original file.`,
    )
  }
  return key
}

/** Create a new key file, owner-only, refusing to replace anything already there. */
function createKeyFile(path: string): Buffer {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const key = randomBytes(KEY_BYTES)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeSync(fd, `${key.toString('base64')}\n`)
  } finally {
    closeSync(fd)
  }
  return key
}

function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(WRAP_AAD)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

function unseal(key: Buffer, wrapped: Buffer): Buffer {
  if (wrapped.length < NONCE_BYTES + TAG_BYTES) throw new Error('wrapped data key is truncated')
  const nonce = wrapped.subarray(0, NONCE_BYTES)
  const tag = wrapped.subarray(wrapped.length - TAG_BYTES)
  const body = wrapped.subarray(NONCE_BYTES, wrapped.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(WRAP_AAD)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/**
 * The outside key held in a file.
 *
 * An existing file is checked now: one that is not a regular file, is readable by
 * group or others, or does not hold a 32-byte key is refused with a message naming
 * it. A missing file is created (0600, in a 0700 directory when that is new) on the
 * first `wrap` only, which the vault calls only when it has no data key yet. An
 * `unwrap` against a missing file fails and creates nothing: a vault whose key is
 * lost must not silently get a new one.
 */
export async function fileKeyProvider(path: string): Promise<KeyProvider> {
  let key: Buffer | null = existsSync(path) ? readKeyFile(path) : null
  const missing = (): VaultKeyError =>
    new VaultKeyError(
      path,
      'missing',
      `The vault key file ${path} is missing. Restore it from your backup, or set PODIUM_VAULT_KEY_FILE to where it is.`,
    )
  return {
    get keyId() {
      return key ? keyIdOf(key) : 'file:absent'
    },
    async wrap(dataKey: Buffer): Promise<Buffer> {
      key ??= existsSync(path) ? readKeyFile(path) : createKeyFile(path)
      return seal(key, dataKey)
    },
    async unwrap(wrapped: Buffer): Promise<Buffer> {
      if (!key) {
        if (!existsSync(path)) throw missing()
        key = readKeyFile(path)
      }
      return unseal(key, wrapped)
    },
  }
}

interface WrappedRow {
  key_id: string
  wrapped_data_key: string
}

/** The wrapped data key as stored in `vault_key`, or null when the vault has none. */
export function readWrappedDataKey(db: SqlDatabase): { keyId: string; wrapped: Buffer } | null {
  const row = db.prepare('SELECT key_id, wrapped_data_key FROM vault_key WHERE id = 1').get() as
    | WrappedRow
    | undefined
  if (!row) return null
  return { keyId: row.key_id, wrapped: Buffer.from(row.wrapped_data_key, 'base64') }
}

/** Wrap `dataKey` under `provider` and store it as the vault's one data key row. */
export async function writeWrappedDataKey(
  db: SqlDatabase,
  provider: KeyProvider,
  dataKey: Buffer,
): Promise<void> {
  const wrapped = await provider.wrap(dataKey)
  db.prepare(
    `INSERT INTO vault_key (id, key_id, wrapped_data_key, created_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET key_id = excluded.key_id,
       wrapped_data_key = excluded.wrapped_data_key, created_at = excluded.created_at`,
  ).run(provider.keyId, wrapped.toString('base64'), new Date().toISOString())
}

/**
 * Proof that a party holds the data key, bound to one transfer: HMAC-SHA256 of the
 * transfer id under the data key, in hex. Reveals nothing about the key.
 */
export function vaultCheckValue(dataKey: Buffer, transferId: string): string {
  return createHmac('sha256', dataKey).update(`podium.vault.check\0${transferId}`).digest('hex')
}
