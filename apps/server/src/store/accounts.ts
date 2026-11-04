/**
 * Managed-account aggregate — credentials Podium holds and injects at spawn
 * [spec:SP-6454]. Separate from the settings blob on purpose: settings round-trip
 * to the browser wholesale, credentials must not.
 *
 * `credential` never leaves the server. Clients see only `identity` (masked),
 * via accountViews().
 *
 * PER USER, SHARED ONLY EXPLICITLY (POD-6360, user decision 2026-11-04). A row
 * belongs to one user (`ownerUserId`) and answers one public account id
 * (`accountKey`, the `managed:<provider>` a role selects); there is at most one
 * row per (owner, account id). A key reaches another user's agents only through
 * `sharedWith`, which its owner (or an admin) sets: never by default, never as a
 * fallback. `id` is the storage key and is never shown to a client.
 */

import { type AccountId, asAccountId, type UserId } from '@podium/model'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import { accounts } from '../migrations/schema'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

/** The grantee that means every user of this instance. */
export const SHARED_WITH_EVERYONE = '*'

export interface ManagedAccountRow {
  /** Storage key. Never shown to a client; address a row by owner + accountKey. */
  id: AccountId
  /** Whose key this is. */
  ownerUserId: UserId
  /** The public account id a role selects (`managed:anthropic`). */
  accountKey: AccountId
  provider: string
  kind: 'api-key' | 'oauth'
  credential: string
  identity: string
  /** 'role' = selected per role (#216, the only value written today).
   *  'ambient' = injected into every spawn (#214, GitHub). */
  scope: 'role' | 'ambient'
  createdAt: number
  /** Who else may use it: user ids, or {@link SHARED_WITH_EVERYONE}. Empty = private. */
  sharedWith: readonly string[]
}

/**
 * One stored key as an admin's `accounts.keys` sees it (POD-6390): whose it is
 * and who may use it, with the masked identity `connect` stored. There is no
 * credential field, and the query behind it never selects that column.
 */
export interface ManagedKeySummary {
  ownerUserId: UserId
  accountKey: AccountId
  provider: string
  kind: 'api-key' | 'oauth'
  identity: string
  createdAt: number
  sharedWith: readonly string[]
}

/** What a connect writes. Sharing is not part of it: a reconnect keeps it. */
export type ManagedAccountWrite = Omit<ManagedAccountRow, 'id' | 'sharedWith'>

/**
 * `shared_with` as stored: NULL, or a JSON array of strings. FAILS CLOSED: a
 * value this build cannot read shares with nobody, so an unreadable share can
 * only deny.
 */
function parseSharedWith(raw: string | null): readonly string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (grantee): grantee is string => typeof grantee === 'string' && grantee !== '',
    )
  } catch {
    return []
  }
}

const encodeSharedWith = (sharedWith: readonly string[]): string | null => {
  const unique = [...new Set(sharedWith)].sort()
  return unique.length === 0 ? null : JSON.stringify(unique)
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
 *
 * A row with no owner or no account id is nobody's (an older binary wrote it
 * after a rollback, or the store had no admin to own it at migration): it is
 * dropped, so it is never listed and never injected.
 */
function toRow(r: typeof accounts.$inferSelect): ManagedAccountRow | undefined {
  if (!r.ownerUserId || !r.accountKey) return undefined
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    accountKey: r.accountKey,
    provider: r.provider,
    kind: r.kind === 'oauth' ? 'oauth' : 'api-key',
    credential: r.credential,
    identity: r.identity,
    scope: r.scope === 'ambient' ? 'ambient' : 'role',
    createdAt: r.createdAt,
    sharedWith: parseSharedWith(r.sharedWith),
  }
}

const rowsOf = (rows: readonly (typeof accounts.$inferSelect)[]): ManagedAccountRow[] =>
  rows.flatMap((r) => {
    const row = toRow(r)
    return row ? [row] : []
  })

/** The storage key of a NEW row. Rows from before POD-6360 keep their old id. */
const storageIdFor = (ownerUserId: UserId, accountKey: AccountId): AccountId =>
  asAccountId(`${accountKey}@${ownerUserId}`)

// Every query this repository runs, prepared once per store [POD-6147].

const accountsByCreation = prepared((db: StoreDrizzle) =>
  db.select().from(accounts).orderBy(asc(accounts.createdAt), asc(accounts.id)).prepare(),
)

/** Every owned row WITHOUT its credential, for the admin's keys read. */
const keySummaries = prepared((db: StoreDrizzle) =>
  db
    .select({
      ownerUserId: accounts.ownerUserId,
      accountKey: accounts.accountKey,
      provider: accounts.provider,
      kind: accounts.kind,
      identity: accounts.identity,
      createdAt: accounts.createdAt,
      sharedWith: accounts.sharedWith,
    })
    .from(accounts)
    .where(and(isNotNull(accounts.ownerUserId), isNotNull(accounts.accountKey)))
    .orderBy(asc(accounts.createdAt), asc(accounts.id))
    .prepare(),
)

const accountsOfOwner = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(accounts)
    .where(eq(accounts.ownerUserId, param(accounts.ownerUserId, 'ownerUserId')))
    .orderBy(asc(accounts.createdAt), asc(accounts.id))
    .prepare(),
)

const ownAccount = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.ownerUserId, param(accounts.ownerUserId, 'ownerUserId')),
        eq(accounts.accountKey, param(accounts.accountKey, 'accountKey')),
      ),
    )
    .prepare(),
)

/** Every row of one account id that its owner shares with somebody. */
const sharedAccountsOfKey = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.accountKey, param(accounts.accountKey, 'accountKey')),
        isNotNull(accounts.sharedWith),
      ),
    )
    .orderBy(asc(accounts.createdAt), asc(accounts.id))
    .prepare(),
)

/** Every row someone shares, for the list's "shared with you" rows. */
const sharedAccounts = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(accounts)
    .where(isNotNull(accounts.sharedWith))
    .orderBy(asc(accounts.createdAt), asc(accounts.id))
    .prepare(),
)

const connectPlaceholders = {
  id: sql.placeholder('id'),
  ownerUserId: sql.placeholder('ownerUserId'),
  accountKey: sql.placeholder('accountKey'),
  provider: sql.placeholder('provider'),
  kind: sql.placeholder('kind'),
  credential: sql.placeholder('credential'),
  identity: sql.placeholder('identity'),
  scope: sql.placeholder('scope'),
  createdAt: sql.placeholder('createdAt'),
}

/**
 * One row per (owner, account id): a reconnect REPLACES the stored material in
 * the owner's row (whatever its storage key, including a pre-POD-6360 one) and
 * leaves its sharing as it was. The conflict target is the
 * `accounts_owner_account_key` unique index; `id` is not in the `set`, so the
 * row keeps its storage key.
 */
const connectAccount = prepared((db: StoreDrizzle) =>
  db
    .insert(accounts)
    .values(connectPlaceholders)
    .onConflictDoUpdate({
      target: [accounts.ownerUserId, accounts.accountKey],
      set: {
        provider: sql.placeholder('provider'),
        kind: sql.placeholder('kind'),
        credential: sql.placeholder('credential'),
        identity: sql.placeholder('identity'),
        scope: sql.placeholder('scope'),
        createdAt: sql.placeholder('createdAt'),
      },
    })
    .prepare(),
)

const deleteOwnAccount = prepared((db: StoreDrizzle) =>
  db
    .delete(accounts)
    .where(
      and(
        eq(accounts.ownerUserId, param(accounts.ownerUserId, 'ownerUserId')),
        eq(accounts.accountKey, param(accounts.accountKey, 'accountKey')),
      ),
    )
    .returning({ id: accounts.id })
    .prepare(),
)

const shareOwnAccount = prepared((db: StoreDrizzle) =>
  db
    .update(accounts)
    .set({ sharedWith: sql.placeholder('sharedWith') })
    .where(
      and(
        eq(accounts.ownerUserId, param(accounts.ownerUserId, 'ownerUserId')),
        eq(accounts.accountKey, param(accounts.accountKey, 'accountKey')),
      ),
    )
    .returning({ id: accounts.id })
    .prepare(),
)

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
    return this.rootDb
  }

  /** Every owned row, whoever owns it. For audits and tests; never a client answer. */
  async list(): Promise<ManagedAccountRow[]> {
    return rowsOf(await accountsByCreation(this.db).all())
  }

  /**
   * Every owned key without its credential, oldest first: what an admin may see
   * of other users' keys. A row with no owner is nobody's and is left out, as
   * {@link toRow} drops it.
   */
  async summaries(): Promise<ManagedKeySummary[]> {
    return (await keySummaries(this.db).all()).flatMap((r) =>
      r.ownerUserId && r.accountKey
        ? [
            {
              ownerUserId: r.ownerUserId,
              accountKey: r.accountKey,
              provider: r.provider,
              kind: r.kind === 'oauth' ? ('oauth' as const) : ('api-key' as const),
              identity: r.identity,
              createdAt: r.createdAt,
              sharedWith: parseSharedWith(r.sharedWith),
            },
          ]
        : [],
    )
  }

  /** One user's own keys. */
  async ownedBy(ownerUserId: UserId): Promise<ManagedAccountRow[]> {
    return rowsOf(await accountsOfOwner(this.db).all({ ownerUserId }))
  }

  /** One user's own key for one account id. */
  async own(ownerUserId: UserId, accountKey: AccountId): Promise<ManagedAccountRow | undefined> {
    const row = await ownAccount(this.db).get({ ownerUserId, accountKey })
    return row ? toRow(row) : undefined
  }

  /**
   * The keys for one account id that OTHER users share with this user, by name
   * or with everyone, oldest first. The caller's own key is not among them.
   */
  async sharedWith(userId: UserId, accountKey: AccountId): Promise<ManagedAccountRow[]> {
    return rowsOf(await sharedAccountsOfKey(this.db).all({ accountKey })).filter(
      (row) => row.ownerUserId !== userId && isSharedWith(row, userId),
    )
  }

  /** Every key other users share with this user, oldest first. */
  async sharedWithUser(userId: UserId): Promise<ManagedAccountRow[]> {
    return rowsOf(await sharedAccounts(this.db).all()).filter(
      (row) => row.ownerUserId !== userId && isSharedWith(row, userId),
    )
  }

  /**
   * Store (or replace) the owner's key for one account id. A new row gets a
   * storage key of its own; an existing one keeps its key and its sharing.
   */
  async connect(row: ManagedAccountWrite): Promise<void> {
    await connectAccount(this.db).run({
      id: storageIdFor(row.ownerUserId, row.accountKey),
      ownerUserId: row.ownerUserId,
      accountKey: row.accountKey,
      provider: row.provider,
      kind: row.kind,
      credential: row.credential,
      identity: row.identity,
      scope: row.scope,
      createdAt: row.createdAt,
    })
  }

  /** Delete the owner's key for one account id. False when they had none. */
  async disconnect(ownerUserId: UserId, accountKey: AccountId): Promise<boolean> {
    return (await deleteOwnAccount(this.db).all({ ownerUserId, accountKey })).length > 0
  }

  /**
   * Replace who the owner shares one key with. An empty list makes it private.
   * False when the owner has no key for that account id.
   */
  async share(
    ownerUserId: UserId,
    accountKey: AccountId,
    sharedWith: readonly string[],
  ): Promise<boolean> {
    const encoded = encodeSharedWith(sharedWith)
    return (
      (await shareOwnAccount(this.db).all({ ownerUserId, accountKey, sharedWith: encoded }))
        .length > 0
    )
  }
}

/** Whether a row's owner shares it with this user (by name or with everyone). */
export const isSharedWith = (row: ManagedAccountRow, userId: UserId): boolean =>
  row.sharedWith.includes(SHARED_WITH_EVERYONE) || row.sharedWith.includes(userId)
