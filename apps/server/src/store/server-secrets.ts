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
import { SERVER_SECRET_KEYS, type SecretPresenceWire, type ServerSecretKey } from '@podium/model'
import { PortableCredentialBundle } from '@podium/protocol'
import type { PortableCredentialBundle as PortableCredentialBundleValue } from '@podium/protocol'
import type { SqlDatabase } from '@podium/runtime/sqlite'

interface SecretRow {
  key: string
  value: string
  updated_at: string
}

function nativeLoginTransferKey(principalUserId: string, transferId: string): string {
  const principal = createHash('sha256').update(principalUserId).digest('hex')
  return 'native-login-transfer:' + principal + ':' + transferId
}

export class ServerSecretsRepository {
  constructor(private readonly db: SqlDatabase) {}

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
  putNativeLoginTransfer(
    principalUserId: string,
    bundle: PortableCredentialBundleValue,
    updatedAt = new Date().toISOString(),
  ): string {
    const transferId = randomUUID()
    this.writeNativeLoginTransfer(principalUserId, transferId, bundle, updatedAt)
    return transferId
  }

  getNativeLoginTransfer(
    principalUserId: string,
    transferId: string,
  ): PortableCredentialBundleValue | undefined {
    const row = this.db
      .prepare('SELECT value FROM server_secrets WHERE key = ?')
      .get(nativeLoginTransferKey(principalUserId, transferId)) as { value: string } | undefined
    if (!row) return undefined
    try {
      const parsed = PortableCredentialBundle.safeParse(JSON.parse(row.value))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  clearNativeLoginTransfer(principalUserId: string, transferId: string): void {
    this.db
      .prepare('DELETE FROM server_secrets WHERE key = ?')
      .run(nativeLoginTransferKey(principalUserId, transferId))
  }

  private writeNativeLoginTransfer(
    principalUserId: string,
    transferId: string,
    bundle: PortableCredentialBundleValue,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO server_secrets (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(
        nativeLoginTransferKey(principalUserId, transferId),
        JSON.stringify(bundle),
        updatedAt,
      )
  }

  get(key: ServerSecretKey): string | undefined {
    const row = this.db.prepare('SELECT value FROM server_secrets WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  /** {@link get}, with the empty string for absent — for the several consumers
   *  whose downstream shape is a `string` and whose "not configured" test is
   *  already `!value`. Named so the substitution is visible at the call site. */
  getOrEmpty(key: ServerSecretKey): string {
    return this.get(key) ?? ''
  }

  /**
   * Replace one secret. `updatedAt` is the rotation time POD-420 could only
   * return and not persist.
   *
   * A blank is a CLEAR, not a write of `''`: accepting one would put back the
   * ambiguity the keyed store exists to remove, and every caller that "clears by
   * writing empty" would then create a row that reads as configured.
   */
  set(key: ServerSecretKey, value: string, updatedAt: string): void {
    if (value === '') {
      this.clear(key)
      return
    }
    this.db
      .prepare(
        'INSERT INTO server_secrets (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, updatedAt)
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
  apiKeyFor(provider: string): string | undefined {
    const candidate = `apiKeys.${provider}`
    if (!(SERVER_SECRET_KEYS as readonly string[]).includes(candidate)) return undefined
    return this.get(candidate as ServerSecretKey)
  }

  clear(key: ServerSecretKey): void {
    this.db.prepare('DELETE FROM server_secrets WHERE key = ?').run(key)
  }

  /** When this key's secret was last replaced, or `undefined` when absent. */
  updatedAt(key: ServerSecretKey): string | undefined {
    const row = this.db.prepare('SELECT updated_at FROM server_secrets WHERE key = ?').get(key) as
      | { updated_at: string }
      | undefined
    return row?.updated_at
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
  presence(): SecretPresenceWire[] {
    const rows = this.db
      .prepare('SELECT key, value, updated_at FROM server_secrets')
      .all() as SecretRow[]
    const byKey = new Map(rows.map((r) => [r.key, r]))
    return SERVER_SECRET_KEYS.map((key) => {
      const row = byKey.get(key)
      return {
        key,
        present: row !== undefined,
        fingerprint: null,
        updatedAt: row?.updated_at ?? null,
      }
    })
  }
}
