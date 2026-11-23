// workspace-scoped (POD-6959)
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
import { asc, eq, sql } from 'drizzle-orm'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import { inWorkspace, param, prepared, WORKSPACE } from './executor/sync-drizzle'

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

/** One member's D11 choices and the copies made under them. */
export class NativeLoginsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  /** One workspace's queries: its members' choices are that workspace's (POD-6959). */
  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access [POD-3221 spec rule 34a]. */
  protected get db(): WorkspaceDb {
    return this.scope
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
