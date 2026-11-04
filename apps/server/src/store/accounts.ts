/**
 * Managed-account aggregate — credentials Podium holds and injects at spawn
 * [spec:SP-6454]. Separate from the settings blob on purpose: settings round-trip
 * to the browser wholesale, credentials must not.
 *
 * `credential` never leaves the server. Clients see only `identity` (masked),
 * via accountViews().
 */

import { type AccountId, asAccountId, type MachineId, type UserId } from '@podium/model'
import { and, asc, eq, sql } from 'drizzle-orm'
import {
  accountMachineSends,
  accounts,
  nativeLoginOptIns,
  nativeLoginTransfers,
} from '../migrations/schema'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

export interface ManagedAccountRow {
  /** The account id members select and sessions record (`managed:anthropic`).
   *  Unique per OWNER, not per instance (POD-6300). */
  id: AccountId
  /** The member this connection belongs to. Nobody else lists, edits or runs
   *  with it, admins included (design §2.5). */
  ownerUserId: UserId
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
 *
 * Only rows with an owner reach here: every query below names the owner.
 */
function toRow(r: typeof accounts.$inferSelect, ownerUserId: UserId): ManagedAccountRow {
  return {
    id: r.ref ?? r.id,
    ownerUserId,
    provider: r.provider,
    kind: r.kind === 'oauth' ? 'oauth' : 'api-key',
    credential: r.credential,
    identity: r.identity,
    scope: r.scope === 'ambient' ? 'ambient' : 'role',
    createdAt: r.createdAt,
  }
}

/** The physical key of a row connected after owners existed: unique per owner,
 *  and never equal to a bare ref, so it cannot collide with a pre-owner row. */
const physicalId = (ownerUserId: UserId, ref: AccountId): AccountId =>
  asAccountId(`${ref}@${ownerUserId}`)

// Every query this repository runs, prepared once per store [POD-6147]. EVERY
// ONE NAMES THE OWNER: there is no instance-wide read of a credential.

const ownerIs = () => eq(accounts.ownerUserId, param(accounts.ownerUserId, 'owner'))
const refIs = () => eq(accounts.ref, param(accounts.ref, 'ref'))

const accountsOfOwner = prepared((db: StoreDrizzle) =>
  db.select().from(accounts).where(ownerIs()).orderBy(asc(accounts.createdAt)).prepare(),
)

const accountOfOwner = prepared((db: StoreDrizzle) =>
  db.select().from(accounts).where(and(ownerIs(), refIs())).prepare(),
)

const accountPlaceholders = {
  id: sql.placeholder('id'),
  provider: sql.placeholder('provider'),
  kind: sql.placeholder('kind'),
  credential: sql.placeholder('credential'),
  identity: sql.placeholder('identity'),
  scope: sql.placeholder('scope'),
  createdAt: sql.placeholder('createdAt'),
  ownerUserId: sql.placeholder('owner'),
  ref: sql.placeholder('ref'),
}

/** A reconnect replaces the owner's credential in place: the row and its
 *  physical id stay, and so do the machines it was sent to. */
const upsertAccount = prepared((db: StoreDrizzle) =>
  db
    .insert(accounts)
    .values(accountPlaceholders)
    .onConflictDoUpdate({
      target: [accounts.ownerUserId, accounts.ref],
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

const deleteAccount = prepared((db: StoreDrizzle) =>
  db.delete(accounts).where(and(ownerIs(), refIs())).prepare(),
)

const deleteSendsOf = prepared((db: StoreDrizzle) =>
  db
    .delete(accountMachineSends)
    .where(eq(accountMachineSends.accountId, param(accountMachineSends.accountId, 'accountId')))
    .prepare(),
)

const sentMachines = prepared((db: StoreDrizzle) =>
  db
    .select({ machineId: accountMachineSends.machineId, sentAt: accountMachineSends.sentAt })
    .from(accountMachineSends)
    .innerJoin(accounts, eq(accounts.id, accountMachineSends.accountId))
    .where(and(ownerIs(), refIs()))
    // The primary key's order after `account_id`: no sort (query-plan audit).
    .orderBy(asc(accountMachineSends.machineId))
    .prepare(),
)

const insertSend = prepared((db: StoreDrizzle) =>
  db
    .insert(accountMachineSends)
    .values({
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

const optInOwnerIs = () =>
  eq(nativeLoginOptIns.ownerUserId, param(nativeLoginOptIns.ownerUserId, 'owner'))

const optInColumns = {
  harness: nativeLoginOptIns.harness,
  fingerprint: nativeLoginOptIns.fingerprint,
  enabled: nativeLoginOptIns.enabled,
  revision: nativeLoginOptIns.revision,
}

const optInsOfOwner = prepared((db: StoreDrizzle) =>
  db
    .select(optInColumns)
    .from(nativeLoginOptIns)
    .where(optInOwnerIs())
    // The primary key's order after `owner_user_id`: no sort.
    .orderBy(asc(nativeLoginOptIns.harness), asc(nativeLoginOptIns.fingerprint))
    .prepare(),
)

const optInOf = prepared((db: StoreDrizzle) =>
  db
    .select(optInColumns)
    .from(nativeLoginOptIns)
    .where(
      and(
        optInOwnerIs(),
        eq(nativeLoginOptIns.harness, param(nativeLoginOptIns.harness, 'harness')),
        eq(nativeLoginOptIns.fingerprint, param(nativeLoginOptIns.fingerprint, 'fingerprint')),
      ),
    )
    .prepare(),
)

/** Every change bumps the revision, so a transfer can tell it went stale. */
const upsertOptIn = prepared((db: StoreDrizzle) =>
  db
    .insert(nativeLoginOptIns)
    .values({
      ownerUserId: sql.placeholder('owner'),
      harness: sql.placeholder('harness'),
      fingerprint: sql.placeholder('fingerprint'),
      enabled: sql.placeholder('enabled'),
      revision: 1,
      updatedAt: sql.placeholder('at'),
    })
    .onConflictDoUpdate({
      target: [
        nativeLoginOptIns.ownerUserId,
        nativeLoginOptIns.harness,
        nativeLoginOptIns.fingerprint,
      ],
      set: {
        enabled: sql.placeholder('enabled'),
        revision: sql`${nativeLoginOptIns.revision} + 1`,
        updatedAt: sql.placeholder('at'),
      },
    })
    .prepare(),
)

const transfersOfOwner = prepared((db: StoreDrizzle) =>
  db
    .select({
      harness: nativeLoginTransfers.harness,
      fingerprint: nativeLoginTransfers.fingerprint,
      machineId: nativeLoginTransfers.machineId,
      outcome: nativeLoginTransfers.outcome,
      at: nativeLoginTransfers.at,
    })
    .from(nativeLoginTransfers)
    .where(eq(nativeLoginTransfers.ownerUserId, param(nativeLoginTransfers.ownerUserId, 'owner')))
    // The primary key's order after `owner_user_id`: no sort.
    .orderBy(
      asc(nativeLoginTransfers.harness),
      asc(nativeLoginTransfers.fingerprint),
      asc(nativeLoginTransfers.machineId),
    )
    .prepare(),
)

const upsertTransfer = prepared((db: StoreDrizzle) =>
  db
    .insert(nativeLoginTransfers)
    .values({
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
        nativeLoginTransfers.ownerUserId,
        nativeLoginTransfers.harness,
        nativeLoginTransfers.fingerprint,
        nativeLoginTransfers.machineId,
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

  /** The owner's connections, oldest first. Nobody else's are reachable. */
  async listFor(ownerUserId: UserId): Promise<ManagedAccountRow[]> {
    return (await accountsOfOwner(this.db).all({ owner: ownerUserId })).map((row) =>
      toRow(row, ownerUserId),
    )
  }

  /** The owner's connection with this account id, or undefined. Another
   *  member's row with the same id is not an answer. */
  async getFor(ownerUserId: UserId, id: string): Promise<ManagedAccountRow | undefined> {
    const row = await accountOfOwner(this.db).get({ owner: ownerUserId, ref: asAccountId(id) })
    return row ? toRow(row, ownerUserId) : undefined
  }

  /**
   * Connect, or reconnect, the owner's account `row.id`. One live credential per
   * (owner, account id): a reconnect replaces the stored material rather than
   * adding a second row. The insert names every column it sets, and the conflict
   * target is the `(owner_user_id, ref)` unique index.
   */
  async upsert(row: ManagedAccountRow): Promise<void> {
    await upsertAccount(this.db).run({
      id: physicalId(row.ownerUserId, row.id),
      provider: row.provider,
      kind: row.kind,
      credential: row.credential,
      identity: row.identity,
      scope: row.scope,
      createdAt: row.createdAt,
      owner: row.ownerUserId,
      ref: row.id,
    })
  }

  /** Remove the owner's connection (and every record of where it was sent). */
  async removeFor(ownerUserId: UserId, id: string): Promise<void> {
    // The sends go with the credential explicitly, not only by the foreign
    // key's cascade, which a connection with foreign keys off would skip.
    await this.createOrJoinTransaction(async () => {
      const row = await accountOfOwner(this.db).get({ owner: ownerUserId, ref: asAccountId(id) })
      if (!row) return
      await deleteSendsOf(this.db).run({ accountId: row.id })
      await deleteAccount(this.db).run({ owner: ownerUserId, ref: asAccountId(id) })
    })
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
      const row = await accountOfOwner(this.db).get({ owner: ownerUserId, ref: asAccountId(id) })
      if (row) await insertSend(this.db).run({ accountId: row.id, machineId, sentAt })
    })
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
