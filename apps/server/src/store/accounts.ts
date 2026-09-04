/**
 * Managed-account aggregate — credentials Podium holds and injects at spawn
 * [spec:SP-6454]. Separate from the settings blob on purpose: settings round-trip
 * to the browser wholesale, credentials must not.
 *
 * `credential` never leaves the server. Clients see only `identity` (masked),
 * via accountViews().
 */

import { type AccountId, asAccountId } from '@podium/model'
import { asc, eq } from 'drizzle-orm'
import { accounts } from '../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'

export interface ManagedAccountRow {
  id: AccountId
  provider: string
  kind: 'api-key' | 'oauth'
  credential: string
  identity: string
  /** 'role' = selected per role (#216, the only value written today).
   *  'ambient' = injected into every spawn (#214, GitHub). */
  scope: 'role' | 'ambient'
  createdAt: number
}

/**
 * The stored row, narrowed to the domain row.
 *
 * BOTH TERNARIES ARE DECISIONS AND STAY (spec §6 rule 6). The columns are plain
 * `text()` with no CHECK, so a value outside either union is representable; each
 * ternary picks the CONSERVATIVE member — `api-key` over `oauth`, `role` over
 * `ambient` — so a row that is somehow neither is treated as the narrower
 * capability rather than the broader one. They are not the driver-returned-
 * `unknown` casts the conversion removes.
 */
function toRow(r: typeof accounts.$inferSelect): ManagedAccountRow {
  return {
    id: r.id,
    provider: r.provider,
    kind: r.kind === 'oauth' ? 'oauth' : 'api-key',
    credential: r.credential,
    identity: r.identity,
    scope: r.scope === 'ambient' ? 'ambient' : 'role',
    createdAt: r.createdAt,
  }
}

export class AccountsRepository {
  private readonly rootDb: SyncDrizzle
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

  list(): ManagedAccountRow[] {
    return this.db.select().from(accounts).orderBy(asc(accounts.createdAt)).all().map(toRow)
  }

  get(id: string): ManagedAccountRow | undefined {
    const row = this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, asAccountId(id)))
      .get()
    return row ? toRow(row) : undefined
  }

  /**
   * `INSERT OR REPLACE` becomes `onConflictDoUpdate` on the primary key.
   *
   * EQUIVALENT HERE, and it was checked rather than assumed (POD-3403 amended
   * checklist item 1 after wave 2 measured the case where it is not). `accounts`
   * has exactly ONE uniqueness constraint — the `id` primary key, no UNIQUE
   * index — so the conflict target is unambiguous and `DO UPDATE` cannot raise
   * where `OR REPLACE` would have resolved. The insert also names every one of
   * the seven columns, which settles the OTHER difference between the forms:
   * `OR REPLACE` deletes the row and reinserts it, so a column the insert omits
   * would revert to its default, while `DO UPDATE` preserves it. With a full
   * column list the two agree. No table references `accounts`, so the
   * delete-and-reinsert could not have cascaded either.
   */
  upsert(row: ManagedAccountRow): void {
    const values = {
      id: row.id,
      provider: row.provider,
      kind: row.kind,
      credential: row.credential,
      identity: row.identity,
      scope: row.scope,
      createdAt: row.createdAt,
    }
    this.db
      .insert(accounts)
      .values(values)
      .onConflictDoUpdate({
        target: accounts.id,
        set: values,
      })
      .run()
  }

  remove(id: string): void {
    this.db
      .delete(accounts)
      .where(eq(accounts.id, asAccountId(id)))
      .run()
  }
}
