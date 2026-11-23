// workspace-scoped (POD-6959)
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
 *
 * ---------------------------------------------------------------------------
 * ONE WORKSPACE'S SECRETS, AND THE INSTALL'S (POD-7013, POD-6959 design 2.1)
 * ---------------------------------------------------------------------------
 *
 * The repository is built for one workspace. Its settings secrets, its
 * fingerprint key and its members' native login transfers are that workspace's
 * rows of `workspace_secrets`. The installation key and the identity signing
 * secret belong to the install: they stay in `server_secrets` (and `meta`), read
 * through global definitions, the same for every workspace.
 */

import { randomBytes } from 'node:crypto'
import { createLogger } from '@podium/logger'
import { SERVER_SECRET_KEYS, type SecretPresenceWire, type ServerSecretKey } from '@podium/model'
import {
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
  type InstallationIdentity,
  parseInstallationIdentity,
} from '@podium/runtime/installation-identity'
import { eq, sql } from 'drizzle-orm'
import { FINGERPRINT_SECRET_KEY } from '../fingerprint-key-import'
import type { SealedSecret, SecretBinding, Vault } from '../modules/credentials/vault'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import { inWorkspace, param, prepared, preparedGlobal, WORKSPACE } from './executor/sync-drizzle'

/** Internal key of the sign-in signing secret; not a settings secret. */
export const IDENTITY_SIGNING_SECRET_KEY = 'identity.signingSecret'

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

// ---- the workspace's secrets: `workspace_secrets` ----

const keyIs = (t: StoreTables) =>
  inWorkspace(t.workspaceSecrets, eq(t.workspaceSecrets.key, param(t.workspaceSecrets.key, 'key')))

/** One secret's value by key: every workspace value read here, whichever key it names. */
const secretValue = prepared((db, t) =>
  db.select({ value: t.workspaceSecrets.value }).from(t.workspaceSecrets).where(keyIs(t)).prepare(),
)

const deleteSecret = prepared((db, t) => db.delete(t.workspaceSecrets).where(keyIs(t)).prepare())

const upsertSecret = prepared((db, t) =>
  db
    .insert(t.workspaceSecrets)
    .values({
      workspaceId: WORKSPACE,
      key: sql.placeholder('key'),
      value: sql.placeholder('value'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: [t.workspaceSecrets.workspaceId, t.workspaceSecrets.key],
      set: { value: sql.placeholder('value'), updatedAt: sql.placeholder('updatedAt') },
    })
    .prepare(),
)

/** A first write that keeps a row already there: the fingerprint key is minted once. */
const insertSecretIfAbsent = prepared((db, t) =>
  db
    .insert(t.workspaceSecrets)
    .values({
      workspaceId: WORKSPACE,
      key: sql.placeholder('key'),
      value: sql.placeholder('value'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoNothing({ target: [t.workspaceSecrets.workspaceId, t.workspaceSecrets.key] })
    .prepare(),
)

const secretUpdatedAt = prepared((db, t) =>
  db
    .select({ updatedAt: t.workspaceSecrets.updatedAt })
    .from(t.workspaceSecrets)
    .where(keyIs(t))
    .prepare(),
)

const secretPresence = prepared((db, t) =>
  db
    .select({
      key: t.workspaceSecrets.key,
      value: t.workspaceSecrets.value,
      updatedAt: t.workspaceSecrets.updatedAt,
    })
    .from(t.workspaceSecrets)
    .where(inWorkspace(t.workspaceSecrets))
    .prepare(),
)

// ---- the install's secrets: `server_secrets` and `meta` ----

/** The identity signing secret, one per install. */
const identitySecretValue = preparedGlobal((db, t) =>
  db
    .select({ value: t.serverSecrets.value })
    .from(t.serverSecrets)
    .where(eq(t.serverSecrets.key, IDENTITY_SIGNING_SECRET_KEY))
    .prepare(),
)

const insertIdentitySecret = preparedGlobal((db, t) =>
  db
    .insert(t.serverSecrets)
    .values({
      key: IDENTITY_SIGNING_SECRET_KEY,
      value: sql.placeholder('value'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: t.serverSecrets.key,
      set: { value: sql.placeholder('value'), updatedAt: sql.placeholder('updatedAt') },
    })
    .prepare(),
)

// Both tables call the column `value`; explicit aliases keep the executor's
// named-row adapter from collapsing them before Drizzle decodes the result.
const installationRow = preparedGlobal((db, t) =>
  db
    .select({
      metadata: sql<string>`${t.meta.value}`.as('installation_metadata'),
      privateKey: sql<string>`${t.serverSecrets.value}`.as('installation_private_key'),
    })
    .from(t.meta)
    .innerJoin(t.serverSecrets, eq(t.serverSecrets.key, INSTALLATION_PRIVATE_KEY))
    .where(eq(t.meta.key, INSTALLATION_META_KEY))
    .prepare(),
)

export class ServerSecretsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner
  private vault: Vault | undefined
  private readonly unopenedReported = new Set<string>()

  /** One workspace's queries: its secrets are that workspace's (POD-7013). */
  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query handle, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  /**
   * The material for one key, or `undefined` when none is configured.
   *
   * The ONLY method that returns a secret value, and it takes exactly one key —
   * see the file comment. Every consumer that injects a credential calls this
   * at the moment of injection rather than holding a copy, so a rotation takes
   * effect on the next use rather than on the next restart.
   */
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

  /**
   * The workspace's private MAC key of secret fingerprints; never included in
   * settings presence. The boot workspace's is imported at boot
   * (`fingerprint-key-import.ts`, which keeps a legacy key file's bytes); any
   * other workspace's is minted here on first use, once: a concurrent first use
   * keeps the row the other wrote.
   */
  async fingerprintKey(): Promise<Buffer> {
    const row = await secretValue(this.db).get({ key: FINGERPRINT_SECRET_KEY })
    if (row) return Buffer.from(row.value, 'hex')
    return await this.createOrJoinTransaction(async () => {
      await insertSecretIfAbsent(this.db).run({
        key: FINGERPRINT_SECRET_KEY,
        value: randomBytes(32).toString('hex'),
        updatedAt: new Date().toISOString(),
      })
      const minted = await secretValue(this.db).get({ key: FINGERPRINT_SECRET_KEY })
      if (!minted) throw new Error('secret fingerprint key is missing from the database')
      return Buffer.from(minted.value, 'hex')
    })
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
      const row = await identitySecretValue(this.db).get()
      if (row) return row.value
      // A store that cannot be written (transfer recovery) makes none.
      if (opts.create === false) return undefined
      const value = randomBytes(32).toString('base64url')
      await insertIdentitySecret(this.db).run({ value, updatedAt: new Date().toISOString() })
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
