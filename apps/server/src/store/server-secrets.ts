/**
 * SERVER-OWNED SECRETS AT REST — the keyed store ADR 1 D6 asks for (POD-419).
 *
 * The material used to be three nested objects inside the `meta['settings']`
 * JSON blob, interleaved with preferences and served whole to every client that
 * read them. `20260730224810_server-secret-store` lifted it here and removed it
 * there.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPOSITORY DELIBERATELY DOES NOT HAVE
 * ---------------------------------------------------------------------------
 *
 * No `getAllAsBlob()`, and no method returning `Record<ServerSecretKey, string>`.
 * A single accessor handing back every secret in one object is how the material
 * gets back into a blob that something then serialises — which is the defect
 * this issue exists to remove, re-created one layer down. Each consumer names
 * the ONE key it needs, at the moment it needs it, and
 * `audit-client-secrets.ts` counts those call sites.
 *
 * The presence projection is the only bulk read, and it carries no values by
 * construction ({@link SecretPresenceWire} is a different shape, not a `pick`).
 *
 * ---------------------------------------------------------------------------
 * ABSENCE IS THE ROW BEING ABSENT
 * ---------------------------------------------------------------------------
 *
 * There is no `''` spelling of "not configured" here (POD-418 removed it at the
 * model; this removes it at rest). {@link clear} DELETEs, {@link get} returns
 * `undefined`, and `ServerSecret.value` is `.min(1)` — so a caller cannot write
 * a blank and a reader cannot mistake one for a configured secret.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createLogger } from '@podium/logger'
import {
  SERVER_SECRET_KEYS,
  type SecretPresenceWire,
  type ServerSecretKey,
  type UserId,
} from '@podium/model'
import type { PortableCredentialBundle as PortableCredentialBundleValue } from '@podium/protocol'
import { PortableCredentialBundle } from '@podium/protocol'
import {
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
  type InstallationIdentity,
  parseInstallationIdentity,
} from '@podium/runtime/installation-identity'
import { eq, sql } from 'drizzle-orm'
import { FINGERPRINT_SECRET_KEY } from '../fingerprint-key-import'
import { meta, serverSecrets } from '../migrations/schema'
import type { SealedSecret, SecretBinding, Vault } from '../modules/credentials/vault'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

/** Internal key of the sign-in signing secret; not a settings secret. */
export const IDENTITY_SIGNING_SECRET_KEY = 'identity.signingSecret'

function nativeLoginTransferKey(principalUserId: UserId, transferId: string): string {
  const principal = createHash('sha256').update(principalUserId).digest('hex')
  return 'native-login-transfer:' + principal + ':' + transferId
}

const log = createLogger('server:secrets')

/**
 * The server secrets the credential vault seals (design §7: "the same primitive
 * covers two other server secrets"). Their rows hold an envelope, never the
 * plaintext; {@link ServerSecretsRepository.get} opens it for the callers that
 * always had the plaintext.
 */
export const VAULT_SEALED_SECRET_KEYS = [
  'integrations.linearApiKey',
  'notifications.telegramBotToken',
] as const satisfies readonly ServerSecretKey[]

const isVaultSealedKey = (key: string): boolean =>
  (VAULT_SEALED_SECRET_KEYS as readonly string[]).includes(key)

const ENVELOPE_PREFIX = 'vault:v1:'

/** The binding for a sealed server secret: the key name, so two rows cannot swap. */
const bindingFor = (key: string): SecretBinding => ({
  credentialId: `server-secret:${key}`,
  type: 'server-secret',
  version: 1,
})

function envelopeOf(sealed: SealedSecret): string {
  return `${ENVELOPE_PREFIX}${sealed.keyId}:${sealed.nonce.toString('base64')}:${sealed.ciphertext.toString('base64')}`
}

function parseEnvelope(value: string): SealedSecret | undefined {
  if (!value.startsWith(ENVELOPE_PREFIX)) return undefined
  const [keyId, nonce, ciphertext] = value.slice(ENVELOPE_PREFIX.length).split(':')
  if (!keyId || !nonce || !ciphertext) return undefined
  return {
    keyId,
    nonce: Buffer.from(nonce, 'base64'),
    ciphertext: Buffer.from(ciphertext, 'base64'),
  }
}

// Every query this repository runs, prepared once per store [POD-6147].

const keyIs = () => eq(serverSecrets.key, param(serverSecrets.key, 'key'))

/** One secret's value by key: every value read here, whichever key it names. */
const secretValue = prepared((db: StoreDrizzle) =>
  db.select({ value: serverSecrets.value }).from(serverSecrets).where(keyIs()).prepare(),
)

const deleteSecret = prepared((db: StoreDrizzle) =>
  db.delete(serverSecrets).where(keyIs()).prepare(),
)

const upsertSecret = prepared((db: StoreDrizzle) =>
  db
    .insert(serverSecrets)
    .values({
      key: sql.placeholder('key'),
      value: sql.placeholder('value'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: serverSecrets.key,
      set: { value: sql.placeholder('value'), updatedAt: sql.placeholder('updatedAt') },
    })
    .prepare(),
)

// Both tables call the column `value`; explicit aliases keep the executor's
// named-row adapter from collapsing them before Drizzle decodes the result.
const installationRow = prepared((db: StoreDrizzle) =>
  db
    .select({
      metadata: sql<string>`${meta.value}`.as('installation_metadata'),
      privateKey: sql<string>`${serverSecrets.value}`.as('installation_private_key'),
    })
    .from(meta)
    .innerJoin(serverSecrets, eq(serverSecrets.key, INSTALLATION_PRIVATE_KEY))
    .where(eq(meta.key, INSTALLATION_META_KEY))
    .prepare(),
)

const secretUpdatedAt = prepared((db: StoreDrizzle) =>
  db.select({ updatedAt: serverSecrets.updatedAt }).from(serverSecrets).where(keyIs()).prepare(),
)

const secretPresence = prepared((db: StoreDrizzle) =>
  db
    .select({
      key: serverSecrets.key,
      value: serverSecrets.value,
      updatedAt: serverSecrets.updatedAt,
    })
    .from(serverSecrets)
    .prepare(),
)

export class ServerSecretsRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner
  private vault: Vault | undefined
  private readonly unopenedReported = new Set<string>()

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db() {
    return this.rootDb
  }

  /**
   * The material for one key, or `undefined` when none is configured.
   *
   * The ONLY method that returns a secret value, and it takes exactly one key —
   * see the file comment. Every consumer that injects a credential calls this
   * at the moment of injection rather than holding a copy, so a rotation takes
   * effect on the next use rather than on the next restart.
   */
  /**
   * Store one native login snapshot for the duration of a server-side transfer.
   * The principal is hashed into the private key, so a different principal can
   * never retrieve the row. These rows are intentionally outside the closed
   * settings-secret vocabulary and are never part of presence().
   */
  async putNativeLoginTransfer(
    principalUserId: UserId,
    bundle: PortableCredentialBundleValue,
    updatedAt = new Date().toISOString(),
  ): Promise<string> {
    const transferId = randomUUID()
    await this.writeNativeLoginTransfer(principalUserId, transferId, bundle, updatedAt)
    return transferId
  }

  async getNativeLoginTransfer(
    principalUserId: UserId,
    transferId: string,
  ): Promise<PortableCredentialBundleValue | undefined> {
    const row = await secretValue(this.db).get({
      key: nativeLoginTransferKey(principalUserId, transferId),
    })
    if (!row) return undefined
    try {
      const parsed = PortableCredentialBundle.safeParse(JSON.parse(row.value))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  async clearNativeLoginTransfer(principalUserId: UserId, transferId: string): Promise<void> {
    await deleteSecret(this.db).run({ key: nativeLoginTransferKey(principalUserId, transferId) })
  }

  private async writeNativeLoginTransfer(
    principalUserId: UserId,
    transferId: string,
    bundle: PortableCredentialBundleValue,
    updatedAt: string,
  ): Promise<void> {
    await upsertSecret(this.db).run({
      key: nativeLoginTransferKey(principalUserId, transferId),
      value: JSON.stringify(bundle),
      updatedAt,
    })
  }

  /** Installation key is outside the settings-secret vocabulary and presence projection.
   * Read both rows in one statement so callers never observe mismatched halves. */
  async installationIdentity(): Promise<InstallationIdentity> {
    // Aliased columns: see `installationRow`.
    const row = await installationRow(this.db).get()
    if (!row) throw new Error('installation identity is missing from the database')
    return parseInstallationIdentity(
      'database',
      JSON.stringify({ ...JSON.parse(row.metadata), privateKey: row.privateKey }),
    )
  }

  /** Private installation MAC key; never included in settings presence. */
  async fingerprintKey(): Promise<Buffer> {
    const row = await secretValue(this.db).get({ key: FINGERPRINT_SECRET_KEY })
    if (!row) throw new Error('secret fingerprint key is missing from the database')
    return Buffer.from(row.value, 'hex')
  }

  /**
   * The secret that signs sign-in cookie and bearer values (people and sign-in
   * specification, section 1.7): read, or made on the first call. It lives in
   * the database so that it moves with it on a server move, a backup and a
   * restore. Like the installation key it is outside the settings-secret
   * vocabulary and never part of presence().
   */
  async identitySigningSecret(opts: { create: false }): Promise<string | undefined>
  async identitySigningSecret(opts?: { create?: true }): Promise<string>
  async identitySigningSecret(opts: { create?: boolean } = {}): Promise<string | undefined> {
    return await this.createOrJoinTransaction(async () => {
      const row = await secretValue(this.db).get({ key: IDENTITY_SIGNING_SECRET_KEY })
      if (row) return row.value
      // A store that cannot be written (transfer recovery) makes none.
      if (opts.create === false) return undefined
      const value = randomBytes(32).toString('base64url')
      await upsertSecret(this.db).run({
        key: IDENTITY_SIGNING_SECRET_KEY,
        value,
        updatedAt: new Date().toISOString(),
      })
      return value
    })
  }

  async get(key: ServerSecretKey): Promise<string | undefined> {
    const row = await secretValue(this.db).get({ key })
    if (!row) return undefined
    return isVaultSealedKey(key) ? this.openSealed(key, row.value) : row.value
  }

  /** The vault that seals {@link VAULT_SEALED_SECRET_KEYS}; set by the store at boot. */
  useVault(vault: Vault): void {
    this.vault = vault
  }

  /**
   * A sealed key's plaintext. A row from before the vault (plain text) is
   * returned as it is until the boot seals it. A sealed row the vault cannot open
   * (locked, or reset) reads as absent, which every caller already treats as "not
   * configured"; it is reported once, without the value.
   */
  private openSealed(key: string, value: string): string | undefined {
    const sealed = parseEnvelope(value)
    if (!sealed) return value.startsWith(ENVELOPE_PREFIX) ? undefined : value
    try {
      if (!this.vault) throw new Error('the vault is not open yet')
      return this.vault.open(bindingFor(key), sealed).toString('utf8')
    } catch (error) {
      if (!this.unopenedReported.has(key)) {
        this.unopenedReported.add(key)
        log.warn('a sealed server secret cannot be opened', {
          key,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      return undefined
    }
  }

  /** The stored form of a value: sealed for the vault's keys, refused when it cannot seal. */
  private async storedForm(key: ServerSecretKey, value: string): Promise<string> {
    if (!isVaultSealedKey(key)) return value
    if (!this.vault) throw new Error('The vault is not open, so this secret cannot be stored.')
    const plaintext = Buffer.from(value, 'utf8')
    try {
      return envelopeOf(await this.vault.seal(bindingFor(key), plaintext))
    } finally {
      plaintext.fill(0)
    }
  }

  /**
   * Seal, in place, any of the vault's keys still stored as plain text (rows
   * written before the vault existed). Keeps each row's `updated_at`. Returns how
   * many rows it sealed. Each is read back through the vault before it counts.
   */
  async sealInPlace(): Promise<number> {
    let sealed = 0
    for (const key of VAULT_SEALED_SECRET_KEYS) {
      const row = await secretValue(this.db).get({ key })
      if (!row || row.value.startsWith(ENVELOPE_PREFIX)) continue
      const updatedAt = (await secretUpdatedAt(this.db).get({ key }))?.updatedAt ?? ''
      await upsertSecret(this.db).run({
        key,
        value: await this.storedForm(key, row.value),
        updatedAt: updatedAt || new Date().toISOString(),
      })
      if ((await this.get(key)) !== row.value) {
        throw new Error(`sealing ${key} did not read back`)
      }
      sealed += 1
    }
    return sealed
  }

  /** Vault reset: delete the vault's keys that are stored sealed (they can no longer open). */
  async clearSealed(): Promise<void> {
    for (const key of VAULT_SEALED_SECRET_KEYS) {
      const row = await secretValue(this.db).get({ key })
      if (row?.value.startsWith(ENVELOPE_PREFIX)) await deleteSecret(this.db).run({ key })
    }
  }

  /** {@link get}, with the empty string for absent — for the several consumers
   *  whose downstream shape is a `string` and whose "not configured" test is
   *  already `!value`. Named so the substitution is visible at the call site. */
  async getOrEmpty(key: ServerSecretKey): Promise<string> {
    return (await this.get(key)) ?? ''
  }

  /**
   * Replace one secret. `updatedAt` is the rotation time POD-420 could only
   * return and not persist.
   *
   * A blank is a CLEAR, not a write of `''`: accepting one would put back the
   * ambiguity the keyed store exists to remove, and every caller that "clears by
   * writing empty" would then create a row that reads as configured.
   */
  async set(key: ServerSecretKey, value: string, updatedAt: string): Promise<void> {
    if (value === '') {
      await this.clear(key)
      return
    }
    await upsertSecret(this.db).run({ key, value: await this.storedForm(key, value), updatedAt })
  }

  async clear(key: ServerSecretKey): Promise<void> {
    await deleteSecret(this.db).run({ key })
  }

  /** When this key's secret was last replaced, or `undefined` when absent. */
  async updatedAt(key: ServerSecretKey): Promise<string | undefined> {
    const row = await secretUpdatedAt(this.db).get({ key })
    return row?.updatedAt
  }

  /**
   * The presence projection: one row per key in the closed vocabulary, ALWAYS
   * all of them, so "absent from the list" is never a third state a reader has
   * to distinguish from `present: false`.
   *
   * `fingerprint` is computed by the caller (it needs the server-held MAC key,
   * which is not this layer's business), so this returns it null and the service
   * fills it — see `SettingsService.secretPresenceList`.
   */
  async presence(): Promise<SecretPresenceWire[]> {
    const rows = await secretPresence(this.db).all()
    const byKey = new Map(rows.map((r) => [r.key, r]))
    return SERVER_SECRET_KEYS.map((key) => {
      const row = byKey.get(key)
      return {
        key,
        present: row !== undefined,
        fingerprint: null,
        updatedAt: row?.updatedAt ?? null,
      }
    })
  }
}
