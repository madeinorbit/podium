// LEGACY(remove-after: 2027-06): every statement of the sign-in carry-over on `client_sessions` and `carried_sign_ins`; removing it signs out whoever still holds only a cookie from before shared sign-in.
/**
 * THE STATEMENTS OF THE SIGN-IN CARRY-OVER (POD-6751;
 * docs/design/sign-in-carry-over.md, sections 4, 5 and 7).
 *
 * An old sign-in is a row of `client_sessions`. It is never read to admit a
 * request: it is consumed by one `delete … returning`, in the transaction that
 * creates the device sign-in it becomes. A carry record lets the same old
 * token get the same answer again for ten minutes.
 *
 * No statement here returns a token, and the hash of one is only ever a key.
 */
import type { UserId } from '@podium/model'
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import {
  param,
  prepared,
  type StoreDrizzle,
  type StoreQueries,
  type TransactionRunner,
} from './executor/sync-drizzle'

/** The labels of old sign-ins a person held. Nothing else is ever honoured (R8). */
export const HONOURED_LABELS = ['login', 'mobile', 'break-glass'] as const
export type HonouredLabel = (typeof HONOURED_LABELS)[number]

/** `meta` key: the instant after which nothing is carried on this server. Written once. */
export const CARRY_OVER_ENDS_AT_KEY = 'signInCarryOver.endsAt'

/**
 * CONSUME (section 4.2, step 1): the old row leaves the table in the statement
 * that reads it, so two requests can never both find it (R10).
 */
const consumeOldSignIn = prepared((db, t) =>
  db
    .delete(t.clientSessions)
    .where(
      and(
        eq(t.clientSessions.tokenHash, param(t.clientSessions.tokenHash, 'tokenHash')),
        inArray(t.clientSessions.label, [...HONOURED_LABELS]),
        gt(t.clientSessions.expiresAt, sql.placeholder('now')),
      ),
    )
    .returning({
      userId: t.clientSessions.userId,
      label: t.clientSessions.label,
      expiresAt: t.clientSessions.expiresAt,
      deviceId: t.clientSessions.deviceId,
      deviceName: t.clientSessions.deviceName,
      platform: t.clientSessions.platform,
    })
    .prepare(),
)

/**
 * Whether the consuming statement would find a row: the same condition, as a
 * read by primary key. A request whose old cookie matches nothing must cause
 * no write (R14), so the transaction that consumes is opened only after this.
 */
const honouredOldSignIn = prepared((db, t) =>
  db
    .select({ tokenHash: t.clientSessions.tokenHash })
    .from(t.clientSessions)
    .where(
      and(
        eq(t.clientSessions.tokenHash, param(t.clientSessions.tokenHash, 'tokenHash')),
        inArray(t.clientSessions.label, [...HONOURED_LABELS]),
        gt(t.clientSessions.expiresAt, sql.placeholder('now')),
      ),
    )
    .prepare(),
)

const insertCarryRecord = prepared((db, t) =>
  db
    .insert(t.carriedSignIns)
    .values({
      oldTokenHash: sql.placeholder('oldTokenHash'),
      deviceSignInId: sql.placeholder('deviceSignInId'),
      sealed: sql.placeholder('sealed'),
      expiresAt: sql.placeholder('expiresAt'),
      memberId: sql.placeholder('memberId'),
      oldLabel: sql.placeholder('oldLabel'),
    })
    .prepare(),
)

/** The unexpired carry record of one old token, by primary key. */
const carryRecordOf = prepared((db, t) =>
  db
    .select({ sealed: t.carriedSignIns.sealed })
    .from(t.carriedSignIns)
    .where(
      and(
        eq(t.carriedSignIns.oldTokenHash, param(t.carriedSignIns.oldTokenHash, 'tokenHash')),
        gt(t.carriedSignIns.expiresAt, sql.placeholder('now')),
      ),
    )
    .prepare(),
)

const deleteCarryRecord = prepared((db, t) =>
  db
    .delete(t.carriedSignIns)
    .where(eq(t.carriedSignIns.oldTokenHash, param(t.carriedSignIns.oldTokenHash, 'tokenHash')))
    .prepare(),
)

const deleteOldSignIn = prepared((db, t) =>
  db
    .delete(t.clientSessions)
    .where(eq(t.clientSessions.tokenHash, param(t.clientSessions.tokenHash, 'tokenHash')))
    .prepare(),
)

const deleteOldSignInsOfMember = prepared((db, t) =>
  db
    .delete(t.clientSessions)
    .where(eq(t.clientSessions.userId, param(t.clientSessions.userId, 'memberId')))
    .prepare(),
)

const deleteCarryRecordsOfMember = prepared((db, t) =>
  db
    .delete(t.carriedSignIns)
    .where(eq(t.carriedSignIns.memberId, param(t.carriedSignIns.memberId, 'memberId')))
    .prepare(),
)

const deleteOldSignInsOfLabel = prepared((db, t) =>
  db
    .delete(t.clientSessions)
    .where(eq(t.clientSessions.label, param(t.clientSessions.label, 'label')))
    .prepare(),
)

const deleteCarryRecordsOfLabel = prepared((db, t) =>
  db
    .delete(t.carriedSignIns)
    .where(eq(t.carriedSignIns.oldLabel, param(t.carriedSignIns.oldLabel, 'label')))
    .prepare(),
)

// THE SWEEP (section 7). Through idx_client_sessions_expires and
// idx_carried_sign_ins_expires.
const deleteExpiredOldSignIns = prepared((db, t) =>
  db
    .delete(t.clientSessions)
    .where(lte(t.clientSessions.expiresAt, sql.placeholder('now')))
    .prepare(),
)

const deleteExpiredCarryRecords = prepared((db, t) =>
  db
    .delete(t.carriedSignIns)
    .where(lte(t.carriedSignIns.expiresAt, sql.placeholder('now')))
    .prepare(),
)

// THE END OF THE PERIOD: both tables are emptied, whatever a row says.
const deleteEveryOldSignIn = prepared((db, t) => db.delete(t.clientSessions).prepare())
const deleteEveryCarryRecord = prepared((db, t) => db.delete(t.carriedSignIns).prepare())

/** How many old sign-ins could still be carried: for the boot log and the period. */
const countHonouredOldSignIns = prepared((db, t) =>
  db
    .select({ count: sql<number>`count(*)` })
    .from(t.clientSessions)
    .where(inArray(t.clientSessions.label, [...HONOURED_LABELS]))
    .prepare(),
)

const periodEnd = prepared((db, t) =>
  db
    .select({ value: t.meta.value })
    .from(t.meta)
    .where(eq(t.meta.key, CARRY_OVER_ENDS_AT_KEY))
    .prepare(),
)

/** Written once: a later start never moves the end of the period. */
const insertPeriodEnd = prepared((db, t) =>
  db
    .insert(t.meta)
    .values({ key: CARRY_OVER_ENDS_AT_KEY, value: sql.placeholder('value') })
    .onConflictDoNothing()
    .prepare(),
)

/** What the consuming statement hands back: enough to describe the new device, never a token. */
export interface ConsumedOldSignIn {
  memberId: UserId
  label: HonouredLabel
  expiresAt: string
  deviceId: string | null
  deviceName: string | null
  platform: string | null
}

export interface CarryRecord {
  oldTokenHash: string
  deviceSignInId: string
  sealed: string
  expiresAt: string
  memberId: UserId
  oldLabel: HonouredLabel
}

export class SignInCarryOverRepository {
  private readonly db: StoreDrizzle
  private readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.db = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** One write transaction of the store; the identity package's operations inside join it. */
  transaction<T>(run: () => Promise<T>): Promise<T> {
    return this.createOrJoinTransaction(run)
  }

  /**
   * Whether this hash names an old sign-in that can be consumed, or a carry
   * record that can be repeated: two reads by primary key and no write. It
   * decides nothing; `consume` and `sealedOf` do, inside the transaction.
   */
  async matches(tokenHash: string, now: string): Promise<boolean> {
    if (await honouredOldSignIn(this.db).get({ tokenHash, now })) return true
    return (await carryRecordOf(this.db).get({ tokenHash, now })) !== undefined
  }

  /** Deletes the unexpired old sign-in of an honoured label and answers what it was. */
  async consume(tokenHash: string, now: string): Promise<ConsumedOldSignIn | undefined> {
    const [row] = await consumeOldSignIn(this.db).all({ tokenHash, now })
    if (!row) return undefined
    return {
      memberId: row.userId,
      label: row.label as HonouredLabel,
      expiresAt: row.expiresAt,
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      platform: row.platform,
    }
  }

  async record(record: CarryRecord): Promise<void> {
    await insertCarryRecord(this.db).run({ ...record })
  }

  /** The sealed answer of an unexpired carry record. */
  async sealedOf(tokenHash: string, now: string): Promise<string | undefined> {
    return (await carryRecordOf(this.db).get({ tokenHash, now }))?.sealed
  }

  async forget(tokenHash: string): Promise<void> {
    await deleteCarryRecord(this.db).run({ tokenHash })
  }

  /** Sign-out with an old cookie: its row and its carry record (R18). */
  async endForToken(tokenHash: string): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      await deleteOldSignIn(this.db).run({ tokenHash })
      await deleteCarryRecord(this.db).run({ tokenHash })
    })
  }

  /** Every old sign-in of a member and their carry records (R16). */
  async endForMember(memberId: UserId): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      await deleteOldSignInsOfMember(this.db).run({ memberId })
      await deleteCarryRecordsOfMember(this.db).run({ memberId })
    })
  }

  /** Every old sign-in of a label and their carry records (R17). */
  async endByLabel(label: HonouredLabel): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      await deleteOldSignInsOfLabel(this.db).run({ label })
      await deleteCarryRecordsOfLabel(this.db).run({ label })
    })
  }

  async deleteExpired(now: string): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      await deleteExpiredOldSignIns(this.db).run({ now })
      await deleteExpiredCarryRecords(this.db).run({ now })
    })
  }

  async deleteEverything(): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      await deleteEveryOldSignIn(this.db).run()
      await deleteEveryCarryRecord(this.db).run()
    })
  }

  async countHonoured(): Promise<number> {
    return Number((await countHonouredOldSignIns(this.db).get())?.count ?? 0)
  }

  async periodEnd(): Promise<string | undefined> {
    return (await periodEnd(this.db).get())?.value
  }

  async writePeriodEndIfAbsent(value: string): Promise<void> {
    await insertPeriodEnd(this.db).run({ value })
  }
}
