/**
 * THE VAULT (credential management design §7, "Encryption").
 *
 * Every secret Podium holds is sealed here with AES-256-GCM under one random data
 * key, with a fresh 12-byte nonce per seal and the binding (credential id, type,
 * version) as authenticated data: a ciphertext moved to another row, passed off as
 * another type or replayed as another version does not open.
 *
 * The data key is stored in the database wrapped by the outside key
 * (`@podium/runtime/vault-key`), created at the first seal. Three states:
 *
 *  - `empty`: no data key yet. The first seal creates one.
 *  - `ready`: the data key is open.
 *  - `locked`: a data key is stored and the outside key is missing or does not
 *    open it (a restored database, a lost file). Nothing is sealed or opened,
 *    and no new key is created: replacing the key silently would orphan every
 *    stored secret. The way out is `podium vault reset --confirm`, or putting
 *    the key file back and restarting.
 *
 * A plaintext is opened only inside `withSecret`, handed to its callback and
 * wiped afterwards. The server keeps no plaintext.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { CredentialId } from '@podium/model'
import type { KeyProvider } from '@podium/runtime/vault-key'
import type {
  CredentialRecord,
  CredentialsRepository,
  SealedSecret,
  StoredVaultKey,
  VaultKeyCheck,
} from '../../store/credentials'

export type { SealedSecret } from '../../store/credentials'

/** What a sealed secret is bound to. Changing any of the three fails the open. */
export type SecretBinding = { credentialId: string; type: string; version: number }

export type VaultState = 'ready' | 'empty' | 'locked'

export interface VaultStatus {
  /** Where the outside key is expected. */
  keyPath: string
  /** The outside key that wrapped the stored data key; null when the vault is empty. */
  keyId: string | null
  state: VaultState
  /** Why the outside key cannot be used, naming the file; null when it can. */
  problem: string | null
}

/** The rows the vault keeps; implemented by the store. */
export interface VaultKeyStore {
  readVaultKey(): Promise<StoredVaultKey | null>
  insertVaultKeyIfAbsent(keyId: string, wrapped: Buffer): Promise<void>
  /** Delete the data key and every secret sealed under it; returns the credentials
   *  that had one, now needing attention. */
  deleteVaultKeyAndSecrets(reason: string): Promise<CredentialId[]>
}

/** The vault cannot seal or open: locked, or its outside key is unusable. */
export class VaultLockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultLockedError'
  }
}

/** A credential's secret cannot be handed out. Never carries the secret. */
export class SecretUnavailableError extends Error {
  constructor(
    readonly credentialId: CredentialId,
    readonly reason: 'not-found' | 'revoked' | 'no-secret' | 'needs-attention',
    message: string,
  ) {
    super(message)
    this.name = 'SecretUnavailableError'
  }
}

const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const RESET_REASON = 'vault-reset'

function dataKeyIdOf(dataKey: Buffer): string {
  return `dk_${createHmac('sha256', dataKey).update('podium vault data key id').digest('hex').slice(0, 16)}`
}

function aadOf(bound: SecretBinding): Buffer {
  return Buffer.from(
    `podium.vault.v1\0${bound.credentialId}\0${bound.type}\0${bound.version}`,
    'utf8',
  )
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export class Vault implements VaultKeyCheck {
  private dataKey: Buffer | null = null
  private dataKeyId: string | null = null
  private stored: StoredVaultKey | null = null
  private provider: KeyProvider | null = null
  private problem: string | null = null
  private creating: Promise<void> | null = null

  private constructor(
    private readonly keyPath: string,
    private readonly providerFactory: () => Promise<KeyProvider>,
    private readonly store: VaultKeyStore,
  ) {}

  /**
   * Open the vault. Never throws because of the outside key: a missing,
   * unreadable or wrong key leaves the vault `locked` (or `empty` and unable to
   * seal) with the reason in {@link status}, so the server starts regardless.
   */
  static async open(i: {
    keyPath: string
    provider: () => Promise<KeyProvider>
    store: VaultKeyStore
  }): Promise<Vault> {
    const vault = new Vault(i.keyPath, i.provider, i.store)
    await vault.load()
    return vault
  }

  private async load(): Promise<void> {
    this.dataKey = null
    this.dataKeyId = null
    this.problem = null
    this.provider = null
    try {
      this.provider = await this.providerFactory()
    } catch (error) {
      this.problem = messageOf(error)
    }
    this.stored = await this.store.readVaultKey()
    if (!this.stored || !this.provider) return
    try {
      this.adopt(await this.provider.unwrap(this.stored.wrapped))
    } catch (error) {
      this.problem = this.lockedProblem(error)
    }
  }

  private lockedProblem(error: unknown): string {
    const message = messageOf(error)
    if (message.includes(this.keyPath)) return message
    return `The vault key file ${this.keyPath} does not open the stored key; it is not the file the vault was created with. Restore the original file.`
  }

  private adopt(dataKey: Buffer): void {
    if (dataKey.length !== KEY_BYTES) throw new Error('the stored data key has the wrong length')
    this.dataKey = dataKey
    this.dataKeyId = dataKeyIdOf(dataKey)
  }

  state(): VaultState {
    if (this.dataKey) return 'ready'
    return this.stored ? 'locked' : 'empty'
  }

  status(): VaultStatus {
    return {
      keyPath: this.keyPath,
      keyId: this.stored?.keyId ?? null,
      state: this.state(),
      problem: this.problem,
    }
  }

  /** True when a secret sealed under data key `keyId` can be opened now. */
  canOpen(keyId: string): boolean {
    return this.dataKey !== null && keyId === this.dataKeyId
  }

  private refusal(): VaultLockedError {
    if (this.state() === 'locked') {
      return new VaultLockedError(
        `The vault is locked, so credentials cannot be stored or used. ${this.problem ?? ''} ` +
          `Put the key file back at ${this.keyPath} and restart, or reset the vault with \`podium vault reset --confirm\` and add the credentials again.`,
      )
    }
    return new VaultLockedError(
      this.problem ??
        `The vault key file ${this.keyPath} cannot be used, so credentials cannot be stored.`,
    )
  }

  /** Create the data key on the first seal. Serialised; the stored row wins. */
  private async ensureDataKey(): Promise<void> {
    if (this.dataKey) return
    if (this.state() === 'locked') throw this.refusal()
    this.creating ??= (async () => {
      const provider = this.provider
      if (!provider) throw this.refusal()
      const fresh = randomBytes(KEY_BYTES)
      // Wrap first: a file provider creates its key on the first wrap, and only then
      // has the id to store with it.
      const wrapped = await provider.wrap(fresh)
      await this.store.insertVaultKeyIfAbsent(provider.keyId, wrapped)
      fresh.fill(0)
      this.stored = await this.store.readVaultKey()
      if (!this.stored) throw new Error('the vault key row was not stored')
      this.adopt(await provider.unwrap(this.stored.wrapped))
    })().finally(() => {
      this.creating = null
    })
    await this.creating
  }

  async seal(bound: SecretBinding, plaintext: Buffer): Promise<SealedSecret> {
    await this.ensureDataKey()
    const dataKey = this.dataKey
    const keyId = this.dataKeyId
    if (!dataKey || !keyId) throw this.refusal()
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce)
    cipher.setAAD(aadOf(bound))
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce, keyId }
  }

  open(bound: SecretBinding, sealed: SealedSecret): Buffer {
    const dataKey = this.dataKey
    if (!dataKey) throw this.refusal()
    if (sealed.keyId !== this.dataKeyId) {
      throw new Error('This secret was sealed under a data key the vault no longer holds.')
    }
    if (sealed.ciphertext.length < TAG_BYTES) throw new Error('The sealed secret is truncated.')
    const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)
    const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', dataKey, sealed.nonce)
    decipher.setAAD(aadOf(bound))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  }

  /** The data key itself, for the server transfer only (epic Task 22). */
  exportDataKey(): Buffer | null {
    return this.dataKey ? Buffer.from(this.dataKey) : null
  }

  /**
   * Delete the data key and every sealed secret, and mark the credentials that
   * had one as needing attention. The way out when the outside key is lost for
   * good. Afterwards the vault is `empty` and the next seal creates a new key.
   */
  async reset(): Promise<CredentialId[]> {
    const affected = await this.store.deleteVaultKeyAndSecrets(RESET_REASON)
    this.dataKey?.fill(0)
    await this.load()
    return affected
  }
}

export interface SecretDeps {
  credentials: CredentialsRepository
  vault: Vault
}

/**
 * Seal `plaintext` for `credential` as version `expectedVersion + 1` and store it.
 * `'conflict'` when someone stored a newer version first; nothing changes then.
 */
export async function sealCredentialSecret(
  deps: SecretDeps,
  credential: Pick<CredentialRecord, 'id' | 'type'>,
  plaintext: string,
  expectedVersion: number,
): Promise<number | 'conflict'> {
  const buffer = Buffer.from(plaintext, 'utf8')
  try {
    const sealed = await deps.vault.seal(
      { credentialId: credential.id, type: credential.type, version: expectedVersion + 1 },
      buffer,
    )
    return await deps.credentials.putSecret(credential.id, sealed, expectedVersion)
  } finally {
    buffer.fill(0)
  }
}

/**
 * Run `use` with a credential's secret. The one way to read a Podium-held secret
 * (epic plan: only `attachAccess` and `withSecret` read one). Rejects with a
 * {@link SecretUnavailableError} when the credential is gone, removed, has no
 * secret, or its secret cannot be opened (the vault is locked or was reset).
 */
export async function withSecret<T>(
  deps: SecretDeps,
  credentialId: CredentialId,
  use: (secret: string) => Promise<T>,
): Promise<T> {
  const credential = await deps.credentials.get(credentialId)
  if (!credential) {
    throw new SecretUnavailableError(credentialId, 'not-found', 'This credential does not exist.')
  }
  if (credential.status === 'revoked') {
    throw new SecretUnavailableError(credentialId, 'revoked', 'This credential was removed.')
  }
  const latest = await deps.credentials.latestSecret(credentialId)
  if (!latest) {
    throw new SecretUnavailableError(
      credentialId,
      'no-secret',
      'This credential has no stored secret.',
    )
  }
  if (!latest.openable) {
    const problem = deps.vault.status().problem
    throw new SecretUnavailableError(
      credentialId,
      'needs-attention',
      `This credential needs attention: its secret cannot be opened.${problem ? ` ${problem}` : ''}`,
    )
  }
  const plaintext = deps.vault.open(
    { credentialId, type: credential.type, version: latest.version },
    latest.sealed,
  )
  try {
    return await use(plaintext.toString('utf8'))
  } finally {
    plaintext.fill(0)
  }
}
