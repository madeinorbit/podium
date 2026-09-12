/**
 * Managed-account aggregate — credentials Podium holds and injects at spawn
 * [spec:SP-6454]. Separate from the settings blob on purpose: settings round-trip
 * to the browser wholesale, credentials must not.
 *
 * `credential` never leaves the server. Clients see only `identity` (masked),
 * via accountViews().
 *
 * ---------------------------------------------------------------------------
 * EVERY METHOD TAKES THE OWNER, AND IT IS THE FIRST ARGUMENT (PDM-280)
 * ---------------------------------------------------------------------------
 *
 * The rows live in `managed_credentials`, keyed (owner_user_id, id), so
 * `managed:anthropic` is a SLOT INSIDE one person's credentials rather than the
 * instance's single row. There is no unscoped read here on purpose: a `list()`
 * that answered for everybody is what PDM-271 found being served to every
 * caller, and leaving one available "for internal use" is how it comes back.
 *
 * THE OWNER IS A PARAMETER, NOT A MEMBER OF {@link ManagedAccountRow}. The row
 * type is what `accountViews` projects from, and a viewer's id on it would ship
 * to every client that reads the Accounts hub — the same reasoning
 * `native-login.ts` records for keeping `ownerUserId` beside `NativeLoginAttempt`
 * rather than on it.
 *
 * `provenance` is likewise absent from the row type: it records how a row CAME TO
 * BE (a person connected it, or the PDM-280 upgrade adopted the instance's
 * unowned key for the earliest admin) and no consumer of this repository decides
 * anything by it. {@link AccountsRepository.upsert} writes it explicitly all the
 * same — see there.
 */

import { type AccountId, asAccountId, type UserId } from '@podium/model'
import { and, asc, eq } from 'drizzle-orm'
import { managedCredentials } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { currentTransaction } from './executor/sync-drizzle'

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
function toRow(r: typeof managedCredentials.$inferSelect): ManagedAccountRow {
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

/** RETAINED EXTERNAL-INPUT BRAND CASTS: the legacy account lookup API accepts
 * provider-facing string ids; its query comparisons brand those inputs. */
export class AccountsRepository {
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

  async list(owner: UserId): Promise<ManagedAccountRow[]> {
    return (
      await this.db
        .select()
        .from(managedCredentials)
        .where(eq(managedCredentials.ownerUserId, owner))
        .orderBy(asc(managedCredentials.createdAt))
        .all()
    ).map(toRow)
  }

  async get(owner: UserId, id: string): Promise<ManagedAccountRow | undefined> {
    const row = await this.db
      .select()
      .from(managedCredentials)
      .where(and(eq(managedCredentials.ownerUserId, owner), eq(managedCredentials.id, asAccountId(id))))
      .get()
    return row ? toRow(row) : undefined
  }

  /**
   * `INSERT OR REPLACE` becomes `onConflictDoUpdate` on the primary key.
   *
   * EQUIVALENT HERE, and it was checked rather than assumed (POD-3403 amended
   * checklist item 1 after wave 2 measured the case where it is not).
   * `managed_credentials` has exactly ONE uniqueness constraint — the
   * (owner_user_id, id) primary key, no UNIQUE index — so the conflict target is
   * unambiguous and `DO UPDATE` cannot raise where `OR REPLACE` would have
   * resolved. The insert also names every column, which settles the OTHER
   * difference between the forms: `OR REPLACE` deletes the row and reinserts it,
   * so a column the insert omits would revert to its default, while `DO UPDATE`
   * preserves it. With a full column list the two agree. No table references
   * `managed_credentials`, so the delete-and-reinsert could not have cascaded
   * either.
   *
   * THE CONFLICT TARGET IS THE PAIR (PDM-280), and that is the line doing the
   * work: targeting `id` alone would make one person's reconnect overwrite
   * another person's credential at the same slot — the defect this table exists
   * to remove, reintroduced one level down.
   *
   * `provenance` IS WRITTEN EXPLICITLY rather than left to its column default,
   * because the default only applies to an INSERT. A row the upgrade adopted for
   * the earliest admin carries `adopted-instance-credential`; when that person
   * later connects a key of their own through this method, the row stops being
   * adopted and must say so. Omitting it from the `set` would leave the adoption
   * mark on a credential the owner chose deliberately.
   */
  async upsert(owner: UserId, row: ManagedAccountRow): Promise<void> {
    const values = {
      ownerUserId: owner,
      id: row.id,
      provider: row.provider,
      kind: row.kind,
      credential: row.credential,
      identity: row.identity,
      scope: row.scope,
      createdAt: row.createdAt,
      provenance: 'connected',
    }
    ;await (this.db
      .insert(managedCredentials)
      .values(values))
      .onConflictDoUpdate({
        target: [managedCredentials.ownerUserId, managedCredentials.id],
        set: values,
      })
      .run()
  }

  /**
   * Remove one of THIS owner's credentials.
   *
   * A slot the caller does not hold deletes nothing, and so does a slot nobody
   * holds — which is `accounts.disconnect`'s declared errorConsistency ("an
   * account this principal may not see fails exactly as one that does not
   * exist") satisfied by construction rather than by two error paths kept in
   * agreement.
   */
  async remove(owner: UserId, id: string): Promise<void> {
    await this.db
      .delete(managedCredentials)
      .where(and(eq(managedCredentials.ownerUserId, owner), eq(managedCredentials.id, asAccountId(id))))
      .run()
  }
}
