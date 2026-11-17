/**
 * THE D11 CHOICES AND THEIR COPIES (POD-6301; multi-user design §2.5, §4.6).
 *
 * A member's "use this login on all machines I hold custody of" tick for each
 * native login (`native_login_opt_ins`), and how the last copy of a ticked
 * login to each machine was decided (`native_login_transfers`). Login
 * propagation reads and writes them (`modules/machines/login-propagation.ts`).
 * They lived beside the old managed keys until those were removed (plan Task 21).
 */

import type { MachineId, UserId } from '@podium/model'
import { and, asc, eq, sql } from 'drizzle-orm'
import { nativeLoginOptIns, nativeLoginTransfers } from '../migrations/schema'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

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

/** One member's D11 choices and the copies made under them. */
export class NativeLoginsRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access [POD-3221 spec rule 34a]. */
  protected get db() {
    return this.rootDb
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
