/**
 * Every statement the package itself runs, defined once and reused
 * (people and sign-in specification, section 2.2, statement policy).
 *
 * ONE DEFINITION SERVES BOTH DATABASES. The SQLite and the Postgres tables
 * carry the same property names, and drizzle's two builders share the method
 * names used here, so a statement is written once against "the tables of this
 * handle". The builders' static types do not unify across dialects, so inside
 * a definition the handle and the tables are untyped; each statement declares
 * the values it takes and the row it answers, and the shared suite runs every
 * one of them on both databases.
 *
 * PREPARED ONCE PER HANDLE. On SQLite the handle is the store's one drizzle
 * instance for the life of the process, inside transactions and out, so each
 * statement is prepared exactly once. On Postgres a transaction has its own
 * handle; a statement used inside one is built for that handle and dropped
 * with it.
 *
 * The sign-in library builds its own statements on every call. Those run only
 * where a person performs a ceremony (sign-in, sign-out, renewal, account
 * writes), never on the per-request path.
 */
import {
  and,
  type Column,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  or,
  Param,
  sql,
} from 'drizzle-orm'
import type { pgIdentityTables } from './schema/pg'
import type { sqliteIdentityTables } from './schema/sqlite'

export type IdentityTables = typeof sqliteIdentityTables | typeof pgIdentityTables

export interface HandleFacts {
  // biome-ignore lint/suspicious/noExplicitAny: see the file header; the two dialects' table types do not unify
  readonly tables: any
  readonly dialect: 'sqlite' | 'pg'
}

const handles = new WeakMap<object, HandleFacts>()

/** Tells the statements which tables a drizzle handle (root or transaction) reads. */
export function registerHandle(db: object, tables: IdentityTables, dialect: 'sqlite' | 'pg'): void {
  if (!handles.has(db)) handles.set(db, { tables, dialect })
}

/** A statement prepared for one handle: fill its placeholders and run it. */
export interface Statement<Values, Row> {
  run(values: Values): Promise<Row[]>
}

// biome-ignore lint/suspicious/noExplicitAny: see the file header
type Build = (db: any, t: any) => any

let definitions = 0

/**
 * Defines one statement. `build` ends its chain without `.prepare()`; the
 * definition prepares it, once per handle. The builder is the first argument,
 * as with the server's own `prepared`, so the server's census of per-call
 * builders reads this file the same way it reads a repository.
 */
export function prepared<Values extends object, Row = never>(
  build: Build,
): (db: object) => Statement<Values, Row> {
  definitions += 1
  // Postgres names a prepared statement; SQLite's prepare() ignores the argument.
  const name = `identity_${definitions}`
  const cache = new WeakMap<object, Statement<Values, Row>>()
  return (db) => {
    const hit = cache.get(db)
    if (hit) return hit
    const facts = handles.get(db)
    if (!facts) throw new Error('identity: this database handle was never registered')
    const query = build(db, facts.tables).prepare(name)
    const made: Statement<Values, Row> = {
      async run(values) {
        const result = await query.execute(values)
        return Array.isArray(result) ? (result as Row[]) : []
      },
    }
    cache.set(db, made)
    return made
  }
}

/**
 * A placeholder in a condition, encoded as its column's values are (a Date
 * becomes the stored time). In `set()` and `values()` drizzle binds a bare
 * `sql.placeholder` to its column itself.
 */
export function p(column: Column, name: string): Param {
  return new Param(sql.placeholder(name), column)
}

// ---------------------------------------------------------------------------
// Accounts and login methods
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: string
  name: string
  email: string
  image: string | null
  emailVerified: boolean
}

const accountColumns = (t: HandleFacts['tables']) => ({
  id: t.user.id,
  name: t.user.name,
  email: t.user.email,
  image: t.user.image,
  emailVerified: t.user.emailVerified,
})

export const accountById = prepared<{ id: string }, AccountRow>((db, t) =>
  db
    .select(accountColumns(t))
    .from(t.user)
    .where(eq(t.user.id, p(t.user.id, 'id'))),
)

export const accountByEmail = prepared<{ email: string }, AccountRow>((db, t) =>
  db
    .select(accountColumns(t))
    .from(t.user)
    .where(eq(t.user.email, p(t.user.email, 'email'))),
)

/** The account row locked through an authentication ceremony on Postgres. */
export const accountForAuthentication = prepared<{ id: string }, AccountRow>((db, t) => {
  const query = db
    .select(accountColumns(t))
    .from(t.user)
    .where(eq(t.user.id, p(t.user.id, 'id')))
  return typeof query.for === 'function' ? query.for('update') : query
})

/** Locks a password registration that has never proved ownership of its address. */
export const unverifiedPasswordAccount = prepared<{ email: string }, { id: string }>((db, t) => {
  const query = db
    .select({ id: t.user.id })
    .from(t.user)
    .where(
      and(
        eq(t.user.email, p(t.user.email, 'email')),
        eq(t.user.emailVerified, false),
        inArray(
          t.user.id,
          db
            .select({ id: t.account.userId })
            .from(t.account)
            .where(and(eq(t.account.providerId, 'credential'), isNotNull(t.account.password))),
        ),
      ),
    )
  // SQLite's transaction already serialises writers; Postgres locks the row.
  return typeof query.for === 'function' ? query.for('update') : query
})

export const deletePasswordMethod = prepared<{ accountId: string }>((db, t) =>
  db
    .delete(t.account)
    .where(
      and(
        eq(t.account.userId, p(t.account.userId, 'accountId')),
        eq(t.account.providerId, 'credential'),
      ),
    ),
)

/** The password login method of an account, if it has one. */
export const passwordOfAccount = prepared<{ accountId: string }, { password: string | null }>(
  (db, t) =>
    db
      .select({ password: t.account.password })
      .from(t.account)
      .where(
        and(
          eq(t.account.userId, p(t.account.userId, 'accountId')),
          eq(t.account.providerId, 'credential'),
        ),
      ),
)

/**
 * The first two accounts that have a password, through the provider index.
 * Two rows are enough to tell "exactly one" from "several" (section 7).
 */
export const firstPasswordAccounts = prepared<Record<never, never>, { email: string }>((db, t) =>
  db
    .select({ email: t.user.email })
    .from(t.account)
    .innerJoin(t.user, eq(t.user.id, t.account.userId))
    .where(and(eq(t.account.providerId, 'credential'), isNotNull(t.account.password)))
    .limit(2),
)

/** The first two accounts with a generated identifier and a password (section 7.2, case 2). */
export const firstGeneratedPasswordAccounts = prepared<Record<never, never>, { email: string }>(
  (db, t) =>
    db
      .select({ email: t.user.email })
      .from(t.account)
      .innerJoin(t.user, eq(t.user.id, t.account.userId))
      .where(
        and(
          eq(t.account.providerId, 'credential'),
          isNotNull(t.account.password),
          like(t.user.email, 'no-email-%@no-email.invalid'),
        ),
      )
      .limit(2),
)

export const updatePassword = prepared<
  { accountId: string; password: string; now: Date },
  { id: string }
>((db, t) =>
  db
    .update(t.account)
    .set({
      password: sql.placeholder('password'),
      updatedAt: sql.placeholder('now'),
    })
    .where(
      and(
        eq(t.account.userId, p(t.account.userId, 'accountId')),
        eq(t.account.providerId, 'credential'),
      ),
    )
    .returning({ id: t.account.id }),
)

export const insertPasswordMethod = prepared<
  { id: string; accountId: string; password: string; now: Date },
  { id: string }
>((db, t) =>
  db
    .insert(t.account)
    .values({
      id: sql.placeholder('id'),
      // The library names a password login method by the account's own id.
      accountId: sql.placeholder('accountId'),
      providerId: 'credential',
      userId: sql.placeholder('accountId'),
      password: sql.placeholder('password'),
      createdAt: sql.placeholder('now'),
      updatedAt: sql.placeholder('now'),
    })
    .returning({ id: t.account.id }),
)

// ---------------------------------------------------------------------------
// Device sign-ins
// ---------------------------------------------------------------------------

export interface SignInRow {
  id: string
  accountId: string
  kind: string
  deviceName: string | null
  platform: string | null
  createdAt: Date
  lastSeenAt: Date | null
  expiresAt: Date
  fixedExpiry: boolean
}

const signInColumns = (t: HandleFacts['tables']) => ({
  id: t.session.id,
  accountId: t.session.userId,
  kind: t.session.deviceKind,
  deviceName: t.session.deviceName,
  platform: t.session.platform,
  createdAt: t.session.createdAt,
  lastSeenAt: t.session.lastSeenAt,
  expiresAt: t.session.expiresAt,
  fixedExpiry: t.session.fixedExpiry,
})

/**
 * THE RESOLUTION STATEMENT (section 2.5, step 3): the device sign-in with this
 * hashed token, not expired, joined to its account. The membership of that
 * account in the workspace joins onto this same statement (memberships task),
 * so resolving a request stays one statement.
 */
export const signInByToken = prepared<{ token: string; now: Date }, SignInRow>((db, t) =>
  db
    .select(signInColumns(t))
    .from(t.session)
    .innerJoin(t.user, eq(t.user.id, t.session.userId))
    .where(
      and(
        eq(t.session.token, p(t.session.token, 'token')),
        gt(t.session.expiresAt, p(t.session.expiresAt, 'now')),
      ),
    ),
)

/** Written at most once per five minutes per sign-in: `stale` is five minutes before now. */
export const touchLastSeen = prepared<{ id: string; now: Date; stale: Date }>((db, t) =>
  db
    .update(t.session)
    .set({ lastSeenAt: sql.placeholder('now') })
    .where(
      and(
        eq(t.session.id, p(t.session.id, 'id')),
        or(
          isNull(t.session.lastSeenAt),
          lt(t.session.lastSeenAt, p(t.session.lastSeenAt, 'stale')),
        ),
      ),
    ),
)

export const signInsOfAccount = prepared<{ accountId: string; now: Date }, SignInRow>((db, t) =>
  db
    .select(signInColumns(t))
    .from(t.session)
    .where(
      and(
        eq(t.session.userId, p(t.session.userId, 'accountId')),
        gt(t.session.expiresAt, p(t.session.expiresAt, 'now')),
      ),
    )
    .orderBy(desc(t.session.createdAt)),
)

export const signInById = prepared<{ id: string; now: Date }, SignInRow>((db, t) =>
  db
    .select(signInColumns(t))
    .from(t.session)
    .where(
      and(
        eq(t.session.id, p(t.session.id, 'id')),
        gt(t.session.expiresAt, p(t.session.expiresAt, 'now')),
      ),
    ),
)

export const deleteSignIn = prepared<{ id: string }, { accountId: string }>((db, t) =>
  db
    .delete(t.session)
    .where(eq(t.session.id, p(t.session.id, 'id')))
    .returning({ accountId: t.session.userId }),
)

export const deleteSignInOfAccount = prepared<
  { id: string; accountId: string },
  { accountId: string }
>((db, t) =>
  db
    .delete(t.session)
    .where(
      and(
        eq(t.session.id, p(t.session.id, 'id')),
        eq(t.session.userId, p(t.session.userId, 'accountId')),
      ),
    )
    .returning({ accountId: t.session.userId }),
)

export const deleteSignInsOfAccount = prepared<{ accountId: string }, { id: string }>((db, t) =>
  db
    .delete(t.session)
    .where(eq(t.session.userId, p(t.session.userId, 'accountId')))
    .returning({ id: t.session.id }),
)

export const deleteSignInsOfAccountExcept = prepared<
  { accountId: string; except: string },
  { id: string }
>((db, t) =>
  db
    .delete(t.session)
    .where(
      and(
        eq(t.session.userId, p(t.session.userId, 'accountId')),
        ne(t.session.id, p(t.session.id, 'except')),
      ),
    )
    .returning({ id: t.session.id }),
)

/** A device that signs in again replaces its earlier sign-in. */
export const deleteEarlierSignInsOfDevice = prepared<
  { accountId: string; deviceId: string; except: string },
  { id: string }
>((db, t) =>
  db
    .delete(t.session)
    .where(
      and(
        eq(t.session.userId, p(t.session.userId, 'accountId')),
        eq(t.session.deviceId, p(t.session.deviceId, 'deviceId')),
        ne(t.session.id, p(t.session.id, 'except')),
      ),
    )
    .returning({ id: t.session.id }),
)

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------

export interface CodeRow {
  id: string
  purpose: string
  accountId: string | null
  receiverChallenge: string | null
  claimId: string | null
  approval: string
  sourceSignInId: string | null
  device: string | null
  failedAttempts: number
  expiresAt: Date
  consumedAt: Date | null
}

const codeColumns = (t: HandleFacts['tables']) => ({
  id: t.oneTimeCode.id,
  purpose: t.oneTimeCode.purpose,
  accountId: t.oneTimeCode.accountId,
  receiverChallenge: t.oneTimeCode.receiverChallenge,
  claimId: t.oneTimeCode.claimId,
  approval: t.oneTimeCode.approval,
  sourceSignInId: t.oneTimeCode.sourceSignInId,
  device: t.oneTimeCode.device,
  failedAttempts: t.oneTimeCode.failedAttempts,
  expiresAt: t.oneTimeCode.expiresAt,
  consumedAt: t.oneTimeCode.consumedAt,
})

/** Not consumed and not expired. */
const live = (t: HandleFacts['tables']) =>
  and(
    isNull(t.oneTimeCode.consumedAt),
    gt(t.oneTimeCode.expiresAt, p(t.oneTimeCode.expiresAt, 'now')),
  )

export const insertCode = prepared<{
  id: string
  purpose: string
  accountId: string | null
  codeHash: string | null
  receiverChallenge: string | null
  device: string | null
  createdBy: string | null
  now: Date
  expiresAt: Date
}>((db, t) =>
  db.insert(t.oneTimeCode).values({
    id: sql.placeholder('id'),
    purpose: sql.placeholder('purpose'),
    accountId: sql.placeholder('accountId'),
    codeHash: sql.placeholder('codeHash'),
    receiverChallenge: sql.placeholder('receiverChallenge'),
    device: sql.placeholder('device'),
    createdBy: sql.placeholder('createdBy'),
    createdAt: sql.placeholder('now'),
    expiresAt: sql.placeholder('expiresAt'),
  }),
)

/**
 * A receiving device claims a pairing code: the code stops working as a code,
 * and the claim id and the device's own challenge take its place.
 */
export const claimPairingCode = prepared<
  { codeHash: string; now: Date; claimId: string; challenge: string; device: string },
  { id: string; expiresAt: Date }
>((db, t) =>
  db
    .update(t.oneTimeCode)
    .set({
      codeHash: null,
      claimId: sql.placeholder('claimId'),
      receiverChallenge: sql.placeholder('challenge'),
      device: sql.placeholder('device'),
      approval: 'pending',
    })
    .where(
      and(
        eq(t.oneTimeCode.codeHash, p(t.oneTimeCode.codeHash, 'codeHash')),
        eq(t.oneTimeCode.purpose, 'pair-device'),
        isNull(t.oneTimeCode.claimId),
        live(t),
      ),
    )
    .returning({ id: t.oneTimeCode.id, expiresAt: t.oneTimeCode.expiresAt }),
)

export const codeById = prepared<{ id: string }, CodeRow>((db, t) =>
  db
    .select(codeColumns(t))
    .from(t.oneTimeCode)
    .where(eq(t.oneTimeCode.id, p(t.oneTimeCode.id, 'id'))),
)

export const decideCode = prepared<
  { id: string; accountId: string; decision: string; now: Date },
  { id: string }
>((db, t) =>
  db
    .update(t.oneTimeCode)
    .set({ approval: sql.placeholder('decision') })
    .where(
      and(
        eq(t.oneTimeCode.id, p(t.oneTimeCode.id, 'id')),
        eq(t.oneTimeCode.accountId, p(t.oneTimeCode.accountId, 'accountId')),
        eq(t.oneTimeCode.approval, 'pending'),
        live(t),
      ),
    )
    .returning({ id: t.oneTimeCode.id }),
)

/** The live hand-over attempt a receiver began with this challenge, not yet authorised. */
export const openAttemptByChallenge = prepared<
  { challenge: string; now: Date },
  { id: string; expiresAt: Date }
>((db, t) =>
  db
    .select({ id: t.oneTimeCode.id, expiresAt: t.oneTimeCode.expiresAt })
    .from(t.oneTimeCode)
    .where(
      and(
        eq(t.oneTimeCode.receiverChallenge, p(t.oneTimeCode.receiverChallenge, 'challenge')),
        eq(t.oneTimeCode.purpose, 'hand-over'),
        isNull(t.oneTimeCode.accountId),
        live(t),
      ),
    ),
)

/** Binds an account and a code to a hand-over attempt nobody authorised yet. */
export const authoriseAttempt = prepared<
  {
    id: string
    now: Date
    accountId: string
    codeHash: string
    sourceSignInId: string
    expiresAt: Date
  },
  { id: string }
>((db, t) =>
  db
    .update(t.oneTimeCode)
    .set({
      accountId: sql.placeholder('accountId'),
      codeHash: sql.placeholder('codeHash'),
      sourceSignInId: sql.placeholder('sourceSignInId'),
      expiresAt: sql.placeholder('expiresAt'),
    })
    .where(
      and(
        eq(t.oneTimeCode.id, p(t.oneTimeCode.id, 'id')),
        isNull(t.oneTimeCode.accountId),
        live(t),
      ),
    )
    .returning({ id: t.oneTimeCode.id }),
)

/** What every redemption requires of the row (section 2.8, step 1). */
const redeemable = (t: HandleFacts['tables']) =>
  and(
    live(t),
    isNotNull(t.oneTimeCode.accountId),
    inArray(t.oneTimeCode.approval, ['none', 'approved']),
  )

/**
 * THE REDEMPTION STATEMENT, by code. It changes one row for exactly one of two
 * redemptions made at the same moment.
 */
export const consumeByCode = prepared<{ codeHash: string; now: Date }, CodeRow>((db, t) =>
  db
    .update(t.oneTimeCode)
    .set({ consumedAt: sql.placeholder('now') })
    .where(
      and(
        eq(t.oneTimeCode.codeHash, p(t.oneTimeCode.codeHash, 'codeHash')),
        ne(t.oneTimeCode.purpose, 'password-reset'),
        redeemable(t),
      ),
    )
    .returning(codeColumns(t)),
)

/** The redemption statement, by the claim id of a claimed pairing code. */
export const consumeByClaim = prepared<{ claimId: string; now: Date }, CodeRow>((db, t) =>
  db
    .update(t.oneTimeCode)
    .set({ consumedAt: sql.placeholder('now') })
    .where(and(eq(t.oneTimeCode.claimId, p(t.oneTimeCode.claimId, 'claimId')), redeemable(t)))
    .returning(codeColumns(t)),
)

/** Direct redemption routes have no status pollers. Remove their spent rows. */
export const deleteRedeemedCode = prepared<{ id: string }>((db, t) =>
  db
    .delete(t.oneTimeCode)
    .where(
      and(eq(t.oneTimeCode.id, p(t.oneTimeCode.id, 'id')), isNotNull(t.oneTimeCode.consumedAt)),
    ),
)

export const discardTransferClaim = prepared<{ id: string }>((db, t) =>
  db
    .delete(t.oneTimeCode)
    .where(
      and(
        eq(t.oneTimeCode.id, p(t.oneTimeCode.id, 'id')),
        eq(t.oneTimeCode.purpose, 'transfer-claim'),
        isNull(t.oneTimeCode.consumedAt),
      ),
    ),
)

export const consumeResetCode = prepared<{ codeHash: string; now: Date }, CodeRow>((db, t) =>
  db
    .update(t.oneTimeCode)
    .set({ consumedAt: sql.placeholder('now') })
    .where(
      and(
        eq(t.oneTimeCode.codeHash, p(t.oneTimeCode.codeHash, 'codeHash')),
        eq(t.oneTimeCode.purpose, 'password-reset'),
        redeemable(t),
      ),
    )
    .returning(codeColumns(t)),
)

/** A live claim that still waits for its decision. */
export const pendingClaim = prepared<{ claimId: string; now: Date }, CodeRow>((db, t) =>
  db
    .select(codeColumns(t))
    .from(t.oneTimeCode)
    .where(
      and(
        eq(t.oneTimeCode.claimId, p(t.oneTimeCode.claimId, 'claimId')),
        eq(t.oneTimeCode.approval, 'pending'),
        live(t),
      ),
    ),
)

/** One wrong verifier; the fifth denies the attempt. */
export const recordWrongVerifier = prepared<{ id: string }>((db, t) =>
  db
    .update(t.oneTimeCode)
    .set({
      failedAttempts: sql`${t.oneTimeCode.failedAttempts} + 1`,
      approval: sql`case when ${t.oneTimeCode.failedAttempts} + 1 >= 5 then 'denied' else ${t.oneTimeCode.approval} end`,
    })
    .where(eq(t.oneTimeCode.id, p(t.oneTimeCode.id, 'id'))),
)

export const liveResetCode = prepared<
  { codeHash: string; now: Date },
  { accountId: string; email: string; expiresAt: Date }
>((db, t) =>
  db
    .select({ accountId: t.user.id, email: t.user.email, expiresAt: t.oneTimeCode.expiresAt })
    .from(t.oneTimeCode)
    .innerJoin(t.user, eq(t.user.id, t.oneTimeCode.accountId))
    .where(
      and(
        eq(t.oneTimeCode.codeHash, p(t.oneTimeCode.codeHash, 'codeHash')),
        eq(t.oneTimeCode.purpose, 'password-reset'),
        live(t),
      ),
    ),
)

/** Expired codes, through the expiry index. */
export const deleteExpiredCodes = prepared<{ now: Date }>((db, t) =>
  db.delete(t.oneTimeCode).where(lt(t.oneTimeCode.expiresAt, p(t.oneTimeCode.expiresAt, 'now'))),
)
