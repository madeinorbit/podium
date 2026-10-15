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

import {
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
  parseInstallationIdentity,
  type InstallationIdentity,
} from '@podium/runtime/installation-identity'
import { createHash, randomUUID } from 'node:crypto'
import {
  SERVER_SECRET_KEYS,
  type SecretPresenceWire,
  type ServerSecretKey,
  type UserId,
} from '@podium/model'
import type { PortableCredentialBundle as PortableCredentialBundleValue } from '@podium/protocol'
import { PortableCredentialBundle } from '@podium/protocol'
import { eq, sql } from 'drizzle-orm'
import { FINGERPRINT_SECRET_KEY } from '../fingerprint-key-import'
import { meta, serverSecrets } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

function nativeLoginTransferKey(principalUserId: UserId, transferId: string): string {
  const principal = createHash('sha256').update(principalUserId).digest('hex')
  return 'native-login-transfer:' + principal + ':' + transferId
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

  async get(key: ServerSecretKey): Promise<string | undefined> {
    const row = await secretValue(this.db).get({ key })
    return row?.value
  }

  /** {@link get}, with the empty string for absent — for the several consumers
   *  whose downstream shape is a `string` and whose "not configured" test is
   *  already `!value`. Named so the substitution is visible at the call site. */
  async getOrEmpty(key: ServerSecretKey): Promise<string> {
    return await this.get(key) ?? ''
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
    await upsertSecret(this.db).run({ key, value, updatedAt })
  }

  /**
   * The provider API key for an LLM backend's provider, or `undefined`.
   *
   * A CHECKED lookup rather than a cast. `LlmBackend.provider` includes `codex`,
   * which authenticates off a local login and has no row in this vocabulary — so
   * `apiKeys.codex` is not a `ServerSecretKey` and asserting it were one would be
   * a well-typed lie that happens to return `undefined` today. An unrecognised
   * provider answers "no key", which is what every caller already handles.
   */
  async apiKeyFor(provider: string): Promise<string | undefined> {
    const candidate = `apiKeys.${provider}`
    if (!(SERVER_SECRET_KEYS as readonly string[]).includes(candidate)) return undefined
    return await this.get(candidate as ServerSecretKey)
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
