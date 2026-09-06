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

import { createHash, randomUUID } from 'node:crypto'
import {
  SERVER_SECRET_KEYS,
  type SecretPresenceWire,
  type ServerSecretKey,
  type UserId,
} from '@podium/model'
import type { PortableCredentialBundle as PortableCredentialBundleValue } from '@podium/protocol'
import { PortableCredentialBundle } from '@podium/protocol'
import { eq } from 'drizzle-orm'
import { serverSecrets } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { currentTransaction } from './executor/sync-drizzle'

function nativeLoginTransferKey(principalUserId: UserId, transferId: string): string {
  const principal = createHash('sha256').update(principalUserId).digest('hex')
  return 'native-login-transfer:' + principal + ':' + transferId
}

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
    return currentTransaction() ?? this.rootDb
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
    const row = await this.db
      .select({ value: serverSecrets.value })
      .from(serverSecrets)
      .where(eq(serverSecrets.key, nativeLoginTransferKey(principalUserId, transferId)))
      .get()
    if (!row) return undefined
    try {
      const parsed = PortableCredentialBundle.safeParse(JSON.parse(row.value))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  async clearNativeLoginTransfer(principalUserId: UserId, transferId: string): Promise<void> {
    await this.db
      .delete(serverSecrets)
      .where(eq(serverSecrets.key, nativeLoginTransferKey(principalUserId, transferId)))
      .run()
  }

  private async writeNativeLoginTransfer(
    principalUserId: UserId,
    transferId: string,
    bundle: PortableCredentialBundleValue,
    updatedAt: string,
  ): Promise<void> {
    ;await (this.db
      .insert(serverSecrets)
      .values({
        key: nativeLoginTransferKey(principalUserId, transferId),
        value: JSON.stringify(bundle),
        updatedAt,
      }))
      .onConflictDoUpdate({
        target: serverSecrets.key,
        set: { value: JSON.stringify(bundle), updatedAt },
      })
      .run()
  }

  async get(key: ServerSecretKey): Promise<string | undefined> {
    const row = await this.db
      .select({ value: serverSecrets.value })
      .from(serverSecrets)
      .where(eq(serverSecrets.key, key))
      .get()
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
    ;await (this.db
      .insert(serverSecrets)
      .values({ key, value, updatedAt }))
      .onConflictDoUpdate({ target: serverSecrets.key, set: { value, updatedAt } })
      .run()
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
    await this.db.delete(serverSecrets).where(eq(serverSecrets.key, key)).run()
  }

  /** When this key's secret was last replaced, or `undefined` when absent. */
  async updatedAt(key: ServerSecretKey): Promise<string | undefined> {
    const row = await this.db
      .select({ updatedAt: serverSecrets.updatedAt })
      .from(serverSecrets)
      .where(eq(serverSecrets.key, key))
      .get()
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
    const rows = await this.db
      .select({
        key: serverSecrets.key,
        value: serverSecrets.value,
        updatedAt: serverSecrets.updatedAt,
      })
      .from(serverSecrets)
      .all()
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
