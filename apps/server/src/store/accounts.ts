// workspace-scoped (POD-6959)
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

import { type AccountId, asAccountId, type MachineId, type UserId } from '@podium/model'
import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm'
import type { accounts } from '../migrations/schema'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import { inWorkspace, param, prepared, sameWorkspace, WORKSPACE } from './executor/sync-drizzle'

/** The grantee that means every user of this instance. */
export const SHARED_WITH_EVERYONE = '*'

// LEGACY(remove-after: 2027-05): distinct workspace keys adopted during the personal-key upgrade.
export function earlierWorkspaceKey(accountKey: AccountId): AccountId {
  return ['managed:anthropic', 'managed:openai', 'managed:openrouter'].includes(accountKey)
    ? asAccountId(`${accountKey}:earlier-workspace`)
    : accountKey
}

export interface ManagedAccountRow {
  /** Storage key on `own`/`ownedBy`; the public account id on `getFor`/`listFor`. */
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
  const accountKey = r.accountKey ?? r.ref
  if (!r.ownerUserId || !accountKey) return undefined
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    accountKey,
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

const accountsByCreation = prepared((db, t) =>
  db
    .select()
    .from(t.accounts)
    .where(inWorkspace(t.accounts))
    .orderBy(asc(t.accounts.createdAt), asc(t.accounts.id))
    .prepare(),
)

/** Every owned row WITHOUT its credential, for the admin's keys read. */
const keySummaries = prepared((db, t) =>
  db
    .select({
      ownerUserId: t.accounts.ownerUserId,
      accountKey: t.accounts.accountKey,
      provider: t.accounts.provider,
      kind: t.accounts.kind,
      identity: t.accounts.identity,
      createdAt: t.accounts.createdAt,
      sharedWith: t.accounts.sharedWith,
    })
    .from(t.accounts)
    .where(
      inWorkspace(t.accounts, isNotNull(t.accounts.ownerUserId), isNotNull(t.accounts.accountKey)),
    )
    .orderBy(asc(t.accounts.createdAt), asc(t.accounts.id))
    .prepare(),
)

const accountsOfOwner = prepared((db, t) =>
  db
    .select()
    .from(t.accounts)
    .where(
      inWorkspace(
        t.accounts,
        eq(t.accounts.ownerUserId, param(t.accounts.ownerUserId, 'ownerUserId')),
      ),
    )
    .orderBy(asc(t.accounts.createdAt), asc(t.accounts.id))
    .prepare(),
)

const ownAccount = prepared((db, t) =>
  db
    .select()
    .from(t.accounts)
    .where(
      inWorkspace(
        t.accounts,
        eq(t.accounts.ownerUserId, param(t.accounts.ownerUserId, 'ownerUserId')),
        eq(t.accounts.accountKey, param(t.accounts.accountKey, 'accountKey')),
      ),
    )
    .prepare(),
)

/** Every row of one account id that its owner shares with somebody. */
const sharedAccountsOfKey = prepared((db, t) =>
  db
    .select()
    .from(t.accounts)
    .where(
      inWorkspace(
        t.accounts,
        or(
          eq(t.accounts.accountKey, param(t.accounts.accountKey, 'accountKey')),
          eq(t.accounts.accountKey, param(t.accounts.accountKey, 'earlierKey')),
        ),
        isNotNull(t.accounts.sharedWith),
      ),
    )
    .orderBy(asc(t.accounts.createdAt), asc(t.accounts.id))
    .prepare(),
)

/** Every row someone shares, for the list's "shared with you" rows. */
const sharedAccounts = prepared((db, t) =>
  db
    .select()
    .from(t.accounts)
    .where(inWorkspace(t.accounts, isNotNull(t.accounts.sharedWith)))
    .orderBy(asc(t.accounts.createdAt), asc(t.accounts.id))
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
  ref: sql.placeholder('accountKey'),
}

/**
 * One row per (owner, account id): a reconnect REPLACES the stored material in
 * the owner's row (whatever its storage key, including a pre-POD-6360 one) and
 * leaves its sharing as it was. The conflict target is the
 * `accounts_owner_account_key` unique index; `id` is not in the `set`, so the
 * row keeps its storage key.
 */
const connectAccount = prepared((db, t) =>
  db
    .insert(t.accounts)
    .values({ workspaceId: WORKSPACE, ...connectPlaceholders })
    .onConflictDoUpdate({
      target: [t.accounts.workspaceId, t.accounts.ownerUserId, t.accounts.accountKey],
      set: {
        ref: sql.placeholder('accountKey'),
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

const deleteOwnAccount = prepared((db, t) =>
  db
    .delete(t.accounts)
    .where(
      inWorkspace(
        t.accounts,
        eq(t.accounts.ownerUserId, param(t.accounts.ownerUserId, 'ownerUserId')),
        eq(t.accounts.accountKey, param(t.accounts.accountKey, 'accountKey')),
      ),
    )
    .returning({ id: t.accounts.id })
    .prepare(),
)

const shareOwnAccount = prepared((db, t) =>
  db
    .update(t.accounts)
    .set({ sharedWith: sql.placeholder('sharedWith') })
    .where(
      inWorkspace(
        t.accounts,
        eq(t.accounts.ownerUserId, param(t.accounts.ownerUserId, 'ownerUserId')),
        eq(t.accounts.accountKey, param(t.accounts.accountKey, 'accountKey')),
      ),
    )
    .returning({ id: t.accounts.id })
    .prepare(),
)

const deleteSendsOf = prepared((db, t) =>
  db
    .delete(t.accountMachineSends)
    .where(
      inWorkspace(
        t.accountMachineSends,
        eq(t.accountMachineSends.accountId, param(t.accountMachineSends.accountId, 'accountId')),
      ),
    )
    .prepare(),
)

const ownerIs = (t: StoreTables) =>
  eq(t.accounts.ownerUserId, param(t.accounts.ownerUserId, 'owner'))
const refIs = (t: StoreTables) => eq(t.accounts.accountKey, param(t.accounts.accountKey, 'ref'))

const sentMachines = prepared((db, t) =>
  db
    .select({ machineId: t.accountMachineSends.machineId, sentAt: t.accountMachineSends.sentAt })
    .from(t.accountMachineSends)
    .innerJoin(
      t.accounts,
      and(
        sameWorkspace(t.accounts, t.accountMachineSends),
        eq(t.accounts.id, t.accountMachineSends.accountId),
      ),
    )
    .where(inWorkspace(t.accountMachineSends, ownerIs(t), refIs(t)))
    // The primary key's order after `account_id`: no sort (query-plan audit).
    .orderBy(asc(t.accountMachineSends.machineId))
    .prepare(),
)

/** Every send of the owner's connections, in one read for the Accounts list. */
const sendsOfOwner = prepared((db, t) =>
  db
    .select({
      accountKey: t.accounts.accountKey,
      machineId: t.accountMachineSends.machineId,
      sentAt: t.accountMachineSends.sentAt,
    })
    .from(t.accounts)
    .innerJoin(
      t.accountMachineSends,
      and(
        sameWorkspace(t.accountMachineSends, t.accounts),
        eq(t.accountMachineSends.accountId, t.accounts.id),
      ),
    )
    .where(inWorkspace(t.accounts, ownerIs(t)))
    .prepare(),
)

const deleteSend = prepared((db, t) =>
  db
    .delete(t.accountMachineSends)
    .where(
      inWorkspace(
        t.accountMachineSends,
        eq(t.accountMachineSends.accountId, param(t.accountMachineSends.accountId, 'accountId')),
        eq(t.accountMachineSends.machineId, param(t.accountMachineSends.machineId, 'machineId')),
      ),
    )
    .returning({ machineId: t.accountMachineSends.machineId })
    .prepare(),
)

const insertSend = prepared((db, t) =>
  db
    .insert(t.accountMachineSends)
    .values({
      workspaceId: WORKSPACE,
      accountId: sql.placeholder('accountId'),
      machineId: sql.placeholder('machineId'),
      sentAt: sql.placeholder('sentAt'),
    })
    .onConflictDoNothing()
    .prepare(),
)

/**
 * A member's D11 choice for one native login (POD-6301): copy and use it on
 * every machine in their custody, now and in future.
 */
export interface NativeLoginOptIn {
  harness: string
  fingerprint: string
  enabled: boolean
  /** Grows on every change; a transfer exported under an older one is stale. */
  revision: number
}

/** The last decided copy of a ticked login to one machine (POD-6301). */
export interface NativeLoginTransferRecord {
  harness: string
  fingerprint: string
  machineId: MachineId
  /** `preserved`: the machine had a different login, which was left in place. */
  outcome: 'installed' | 'preserved'
  at: string
}

const optInOwnerIs = (t: StoreTables) =>
  eq(t.nativeLoginOptIns.ownerUserId, param(t.nativeLoginOptIns.ownerUserId, 'owner'))

const optInColumns = (t: StoreTables) => ({
  harness: t.nativeLoginOptIns.harness,
  fingerprint: t.nativeLoginOptIns.fingerprint,
  enabled: t.nativeLoginOptIns.enabled,
  revision: t.nativeLoginOptIns.revision,
})

const optInsOfOwner = prepared((db, t) =>
  db
    .select(optInColumns(t))
    .from(t.nativeLoginOptIns)
    .where(inWorkspace(t.nativeLoginOptIns, optInOwnerIs(t)))
    // The primary key's order after `owner_user_id`: no sort.
    .orderBy(asc(t.nativeLoginOptIns.harness), asc(t.nativeLoginOptIns.fingerprint))
    .prepare(),
)

const optInOf = prepared((db, t) =>
  db
    .select(optInColumns(t))
    .from(t.nativeLoginOptIns)
    .where(
      inWorkspace(
        t.nativeLoginOptIns,
        optInOwnerIs(t),
        eq(t.nativeLoginOptIns.harness, param(t.nativeLoginOptIns.harness, 'harness')),
        eq(t.nativeLoginOptIns.fingerprint, param(t.nativeLoginOptIns.fingerprint, 'fingerprint')),
      ),
    )
    .prepare(),
)

/** Every change bumps the revision, so a transfer can tell it went stale. */
const upsertOptIn = prepared((db, t) =>
  db
    .insert(t.nativeLoginOptIns)
    .values({
      workspaceId: WORKSPACE,
      ownerUserId: sql.placeholder('owner'),
      harness: sql.placeholder('harness'),
      fingerprint: sql.placeholder('fingerprint'),
      enabled: sql.placeholder('enabled'),
      revision: 1,
      updatedAt: sql.placeholder('at'),
    })
    .onConflictDoUpdate({
      target: [
        t.nativeLoginOptIns.workspaceId,
        t.nativeLoginOptIns.ownerUserId,
        t.nativeLoginOptIns.harness,
        t.nativeLoginOptIns.fingerprint,
      ],
      set: {
        enabled: sql.placeholder('enabled'),
        revision: sql`${t.nativeLoginOptIns.revision} + 1`,
        updatedAt: sql.placeholder('at'),
      },
    })
    .prepare(),
)

const transfersOfOwner = prepared((db, t) =>
  db
    .select({
      harness: t.nativeLoginTransfers.harness,
      fingerprint: t.nativeLoginTransfers.fingerprint,
      machineId: t.nativeLoginTransfers.machineId,
      outcome: t.nativeLoginTransfers.outcome,
      at: t.nativeLoginTransfers.at,
    })
    .from(t.nativeLoginTransfers)
    .where(
      inWorkspace(
        t.nativeLoginTransfers,
        eq(t.nativeLoginTransfers.ownerUserId, param(t.nativeLoginTransfers.ownerUserId, 'owner')),
      ),
    )
    // The primary key's order after `owner_user_id`: no sort.
    .orderBy(
      asc(t.nativeLoginTransfers.harness),
      asc(t.nativeLoginTransfers.fingerprint),
      asc(t.nativeLoginTransfers.machineId),
    )
    .prepare(),
)

const upsertTransfer = prepared((db, t) =>
  db
    .insert(t.nativeLoginTransfers)
    .values({
      workspaceId: WORKSPACE,
      ownerUserId: sql.placeholder('owner'),
      harness: sql.placeholder('harness'),
      fingerprint: sql.placeholder('fingerprint'),
      machineId: sql.placeholder('machineId'),
      outcome: sql.placeholder('outcome'),
      revision: sql.placeholder('revision'),
      at: sql.placeholder('at'),
    })
    .onConflictDoUpdate({
      target: [
        t.nativeLoginTransfers.workspaceId,
        t.nativeLoginTransfers.ownerUserId,
        t.nativeLoginTransfers.harness,
        t.nativeLoginTransfers.fingerprint,
        t.nativeLoginTransfers.machineId,
      ],
      set: {
        outcome: sql.placeholder('outcome'),
        revision: sql.placeholder('revision'),
        at: sql.placeholder('at'),
      },
    })
    .prepare(),
)

/** One member's managed provider connections, and their D11 choices. */
export class AccountsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  /** The owner's public account refs, for the custody and discovery APIs. */
  async listFor(ownerUserId: UserId): Promise<ManagedAccountRow[]> {
    return (await this.ownedBy(ownerUserId)).map((row) => ({ ...row, id: row.accountKey }))
  }

  /** The owner's connection only; neither admin rights nor a share changes this read. */
  async getFor(ownerUserId: UserId, id: string): Promise<ManagedAccountRow | undefined> {
    const row = await this.own(ownerUserId, asAccountId(id))
    return row ? { ...row, id: row.accountKey } : undefined
  }

  /** The custody API names the public ref as `id`; connecting writes both aliases. */
  async upsert(row: Omit<ManagedAccountRow, 'accountKey' | 'sharedWith'>): Promise<void> {
    await this.connect({ ...row, accountKey: row.id })
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
    return rowsOf(
      await sharedAccountsOfKey(this.db).all({
        accountKey,
        earlierKey: earlierWorkspaceKey(accountKey),
      }),
    ).filter((row) => row.ownerUserId !== userId && isSharedWith(row, userId))
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
    return await this.createOrJoinTransaction(async () => {
      const row = await ownAccount(this.db).get({ ownerUserId, accountKey })
      if (!row) return false
      await deleteSendsOf(this.db).run({ accountId: row.id })
      return (await deleteOwnAccount(this.db).all({ ownerUserId, accountKey })).length > 0
    })
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

  /** Remove the owner's connection (and every record of where it was sent). */
  async removeFor(ownerUserId: UserId, id: string): Promise<void> {
    await this.disconnect(ownerUserId, asAccountId(id))
  }

  /** Record that the owner sent this connection to a machine (idempotent). A
   *  connection the owner does not have records nothing. */
  async markSent(
    ownerUserId: UserId,
    id: string,
    machineId: MachineId,
    sentAt: string,
  ): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const row = await ownAccount(this.db).get({ ownerUserId, accountKey: asAccountId(id) })
      if (row) await insertSend(this.db).run({ accountId: row.id, machineId, sentAt })
    })
  }

  /** Take back one send (POD-6699). True when a send was recorded and is now
   *  gone; false when the owner has no such connection or never sent it there.
   *  `onRemoved` runs in the same transaction, for the audit row. */
  async unmarkSent(
    ownerUserId: UserId,
    id: string,
    machineId: MachineId,
    onRemoved?: () => Promise<void>,
  ): Promise<boolean> {
    return await this.createOrJoinTransaction(async () => {
      const row = await ownAccount(this.db).get({ ownerUserId, accountKey: asAccountId(id) })
      if (!row) return false
      const removed = (await deleteSend(this.db).all({ accountId: row.id, machineId })).length > 0
      if (removed) await onRemoved?.()
      return removed
    })
  }

  /** Every send of the owner's connections, by public account id (POD-6699). */
  async sendsOf(
    ownerUserId: UserId,
  ): Promise<Map<AccountId, Array<{ machineId: MachineId; sentAt: string }>>> {
    const byAccount = new Map<AccountId, Array<{ machineId: MachineId; sentAt: string }>>()
    for (const row of await sendsOfOwner(this.db).all({ owner: ownerUserId })) {
      if (!row.accountKey) continue
      const list = byAccount.get(row.accountKey) ?? []
      list.push({ machineId: row.machineId, sentAt: row.sentAt })
      byAccount.set(row.accountKey, list)
    }
    return byAccount
  }

  /** The machines the owner sent this connection to. */
  async sentTo(ownerUserId: UserId, id: string): Promise<MachineId[]> {
    return (await sentMachines(this.db).all({ owner: ownerUserId, ref: asAccountId(id) })).map(
      (row) => row.machineId,
    )
  }

  /** Every D11 choice the owner made, ticked or not. Nobody else's. */
  async optInsFor(ownerUserId: UserId): Promise<NativeLoginOptIn[]> {
    return (await optInsOfOwner(this.db).all({ owner: ownerUserId })).map((row) => ({
      harness: row.harness,
      fingerprint: row.fingerprint,
      enabled: row.enabled === 1,
      revision: row.revision,
    }))
  }

  /** The owner's choice for one native login, or undefined when never made. */
  async optInFor(
    ownerUserId: UserId,
    harness: string,
    fingerprint: string,
  ): Promise<NativeLoginOptIn | undefined> {
    const row = await optInOf(this.db).get({ owner: ownerUserId, harness, fingerprint })
    return row
      ? {
          harness: row.harness,
          fingerprint: row.fingerprint,
          enabled: row.enabled === 1,
          revision: row.revision,
        }
      : undefined
  }

  /** Tick or untick the D11 box for one of the owner's native logins. */
  async setOptIn(
    ownerUserId: UserId,
    harness: string,
    fingerprint: string,
    enabled: boolean,
    at: string,
  ): Promise<void> {
    await upsertOptIn(this.db).run({
      owner: ownerUserId,
      harness,
      fingerprint,
      enabled: enabled ? 1 : 0,
      at,
    })
  }

  /** Record how the last copy of a ticked login to a machine was decided. */
  async recordTransfer(
    ownerUserId: UserId,
    record: NativeLoginTransferRecord & { revision: number },
  ): Promise<void> {
    await upsertTransfer(this.db).run({ owner: ownerUserId, ...record })
  }

  /** The owner's decided copies, for their own Accounts hub. */
  async transfersFor(ownerUserId: UserId): Promise<NativeLoginTransferRecord[]> {
    return (await transfersOfOwner(this.db).all({ owner: ownerUserId })).map((row) => ({
      harness: row.harness,
      fingerprint: row.fingerprint,
      machineId: row.machineId,
      outcome: row.outcome === 'installed' ? 'installed' : 'preserved',
      at: row.at,
    }))
  }
}

/** Whether a row's owner shares it with this user (by name or with everyone). */
export const isSharedWith = (row: ManagedAccountRow, userId: UserId): boolean =>
  row.sharedWith.includes(SHARED_WITH_EVERYONE) || row.sharedWith.includes(userId)
