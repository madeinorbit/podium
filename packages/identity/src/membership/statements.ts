/**
 * The statements of memberships and invitations (people and sign-in
 * specification, sections 1.3 to 1.5, 2.5 and 2.6). Defined once and reused,
 * one definition for both databases, as in `../statements`.
 */
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
} from 'drizzle-orm'
import { type HandleFacts, p, prepared, type SignInRow } from '../statements'

type Tables = HandleFacts['tables']

export type MembershipStatus = 'invited' | 'active' | 'disabled' | 'removed'
export type MembershipRole = 'admin' | 'member'

// ---------------------------------------------------------------------------
// The workspace revision (section 1.4)
// ---------------------------------------------------------------------------

/**
 * Takes the workspace's revision row for the rest of the transaction without
 * changing it, creating it at 0 when the workspace has none. On Postgres this
 * is what makes the checks of a membership operation and its write one step:
 * a second operation on the same workspace waits here. A SQLite write
 * transaction is already exclusive and never runs this.
 */
export const lockRevision = prepared<{ workspaceId: string }, { revision: number }>((db, t) =>
  db
    .insert(t.workspaceRevision)
    .values({ workspaceId: sql.placeholder('workspaceId'), revision: 0 })
    .onConflictDoUpdate({
      target: t.workspaceRevision.workspaceId,
      set: { revision: sql`${t.workspaceRevision.revision}` },
    })
    .returning({ revision: t.workspaceRevision.revision }),
)

/** Adds one to the workspace's revision and answers the new value. */
export const stepRevision = prepared<{ workspaceId: string }, { revision: number }>((db, t) =>
  db
    .insert(t.workspaceRevision)
    .values({ workspaceId: sql.placeholder('workspaceId'), revision: 1 })
    .onConflictDoUpdate({
      target: t.workspaceRevision.workspaceId,
      set: { revision: sql`${t.workspaceRevision.revision} + 1` },
    })
    .returning({ revision: t.workspaceRevision.revision }),
)

// ---------------------------------------------------------------------------
// Memberships (section 1.3)
// ---------------------------------------------------------------------------

export interface MembershipRow {
  workspaceId: string
  memberId: string
  accountId: string | null
  role: string
  status: string
  version: number
  invitedEmail: string | null
  createdBy: string | null
}

const membershipColumns = (t: Tables) => ({
  workspaceId: t.membership.workspaceId,
  memberId: t.membership.memberId,
  accountId: t.membership.accountId,
  role: t.membership.role,
  status: t.membership.status,
  version: t.membership.version,
  invitedEmail: t.membership.invitedEmail,
  createdBy: t.membership.createdBy,
})

const ofWorkspace = (t: Tables) =>
  eq(t.membership.workspaceId, p(t.membership.workspaceId, 'workspaceId'))

/** One membership, by its primary key. */
export const membershipOf = prepared<{ workspaceId: string; memberId: string }, MembershipRow>(
  (db, t) =>
    db
      .select(membershipColumns(t))
      .from(t.membership)
      .where(and(ofWorkspace(t), eq(t.membership.memberId, p(t.membership.memberId, 'memberId')))),
)

/** The live (active or disabled) membership of an account in a workspace; at most one. */
export const liveMembershipOfAccount = prepared<
  { workspaceId: string; accountId: string },
  MembershipRow
>((db, t) =>
  db
    .select(membershipColumns(t))
    .from(t.membership)
    .where(
      and(
        eq(t.membership.accountId, p(t.membership.accountId, 'accountId')),
        ofWorkspace(t),
        inArray(t.membership.status, ['active', 'disabled']),
      ),
    ),
)

/** Every live membership of an account, in any workspace, through the account index. */
export const liveMembershipsOfAccount = prepared<{ accountId: string }, MembershipRow>((db, t) =>
  db
    .select(membershipColumns(t))
    .from(t.membership)
    .where(
      and(
        eq(t.membership.accountId, p(t.membership.accountId, 'accountId')),
        inArray(t.membership.status, ['active', 'disabled']),
      ),
    ),
)

/** Whether an account has an active membership anywhere: the sign-in gate of local accounts. */
export const activeMembershipOfAccount = prepared<{ accountId: string }, { memberId: string }>(
  (db, t) =>
    db
      .select({ memberId: t.membership.memberId })
      .from(t.membership)
      .where(
        and(
          eq(t.membership.accountId, p(t.membership.accountId, 'accountId')),
          eq(t.membership.status, 'active'),
        ),
      )
      .limit(1),
)

/** Whether the workspace has any membership at all. */
export const anyMembership = prepared<{ workspaceId: string }, { memberId: string }>((db, t) =>
  db.select({ memberId: t.membership.memberId }).from(t.membership).where(ofWorkspace(t)).limit(1),
)

/** Another active admin than `memberId`: the last one cannot be demoted, disabled or removed. */
export const otherActiveAdmin = prepared<
  { workspaceId: string; memberId: string },
  { memberId: string }
>((db, t) =>
  db
    .select({ memberId: t.membership.memberId })
    .from(t.membership)
    .where(
      and(
        ofWorkspace(t),
        ne(t.membership.memberId, p(t.membership.memberId, 'memberId')),
        eq(t.membership.status, 'active'),
        eq(t.membership.role, 'admin'),
      ),
    )
    .limit(1),
)

export const insertMembership = prepared<{
  workspaceId: string
  memberId: string
  accountId: string | null
  role: string
  status: string
  version: number
  invitedEmail: string | null
  createdBy: string
  now: Date
}>((db, t) =>
  db.insert(t.membership).values({
    workspaceId: sql.placeholder('workspaceId'),
    memberId: sql.placeholder('memberId'),
    accountId: sql.placeholder('accountId'),
    role: sql.placeholder('role'),
    status: sql.placeholder('status'),
    version: sql.placeholder('version'),
    invitedEmail: sql.placeholder('invitedEmail'),
    createdBy: sql.placeholder('createdBy'),
    createdAt: sql.placeholder('now'),
    updatedAt: sql.placeholder('now'),
  }),
)

/** Writes every changeable fact of one membership, with its new version. */
export const updateMembership = prepared<{
  workspaceId: string
  memberId: string
  accountId: string | null
  role: string
  status: string
  version: number
  invitedEmail: string | null
  now: Date
}>((db, t) =>
  db
    .update(t.membership)
    .set({
      accountId: sql.placeholder('accountId'),
      role: sql.placeholder('role'),
      status: sql.placeholder('status'),
      version: sql.placeholder('version'),
      invitedEmail: sql.placeholder('invitedEmail'),
      updatedAt: sql.placeholder('now'),
    })
    .where(and(ofWorkspace(t), eq(t.membership.memberId, p(t.membership.memberId, 'memberId')))),
)

export interface MembershipWithAccountRow extends MembershipRow {
  accountName: string | null
  accountEmail: string | null
  accountImage: string | null
}

const withAccountColumns = (t: Tables) => ({
  ...membershipColumns(t),
  accountName: t.user.name,
  accountEmail: t.user.email,
  accountImage: t.user.image,
})

/** Every membership of a workspace with its account, oldest first. */
export const membershipsOfWorkspace = prepared<{ workspaceId: string }, MembershipWithAccountRow>(
  (db, t) =>
    db
      .select(withAccountColumns(t))
      .from(t.membership)
      .leftJoin(t.user, eq(t.user.id, t.membership.accountId))
      .where(ofWorkspace(t))
      .orderBy(asc(t.membership.createdAt), asc(t.membership.memberId)),
)

/** The memberships changed after a version, in the order they changed (section 11.2). */
export const membershipsAbove = prepared<
  { workspaceId: string; version: number },
  MembershipWithAccountRow
>((db, t) =>
  db
    .select(withAccountColumns(t))
    .from(t.membership)
    .leftJoin(t.user, eq(t.user.id, t.membership.accountId))
    .where(and(ofWorkspace(t), gt(t.membership.version, p(t.membership.version, 'version'))))
    .orderBy(asc(t.membership.version)),
)

/** The members of a workspace whose account has a password. */
export const passwordMembersOfWorkspace = prepared<{ workspaceId: string }, { memberId: string }>(
  (db, t) =>
    db
      .select({ memberId: t.membership.memberId })
      .from(t.membership)
      .innerJoin(t.account, eq(t.account.userId, t.membership.accountId))
      .where(
        and(ofWorkspace(t), eq(t.account.providerId, 'credential'), isNotNull(t.account.password)),
      ),
)

// ---------------------------------------------------------------------------
// Invitations (section 1.5)
// ---------------------------------------------------------------------------

export interface InvitationRow {
  id: string
  workspaceId: string
  memberId: string
  email: string | null
  expiresAt: Date
  consumedAt: Date | null
  revokedAt: Date | null
}

const invitationColumns = (t: Tables) => ({
  id: t.invitation.id,
  workspaceId: t.invitation.workspaceId,
  memberId: t.invitation.memberId,
  email: t.invitation.email,
  expiresAt: t.invitation.expiresAt,
  consumedAt: t.invitation.consumedAt,
  revokedAt: t.invitation.revokedAt,
})

/** Not consumed, not revoked, not expired. */
const usable = (t: Tables) =>
  and(
    isNull(t.invitation.consumedAt),
    isNull(t.invitation.revokedAt),
    gt(t.invitation.expiresAt, p(t.invitation.expiresAt, 'now')),
  )

export const insertInvitation = prepared<{
  id: string
  workspaceId: string
  memberId: string
  tokenHash: string
  email: string | null
  expiresAt: Date
  createdBy: string
  now: Date
}>((db, t) =>
  db.insert(t.invitation).values({
    id: sql.placeholder('id'),
    workspaceId: sql.placeholder('workspaceId'),
    memberId: sql.placeholder('memberId'),
    tokenHash: sql.placeholder('tokenHash'),
    email: sql.placeholder('email'),
    expiresAt: sql.placeholder('expiresAt'),
    createdBy: sql.placeholder('createdBy'),
    createdAt: sql.placeholder('now'),
  }),
)

export const invitationByHash = prepared<{ tokenHash: string }, InvitationRow>((db, t) =>
  db
    .select(invitationColumns(t))
    .from(t.invitation)
    .where(eq(t.invitation.tokenHash, p(t.invitation.tokenHash, 'tokenHash'))),
)

export const invitationById = prepared<{ id: string }, InvitationRow>((db, t) =>
  db
    .select(invitationColumns(t))
    .from(t.invitation)
    .where(eq(t.invitation.id, p(t.invitation.id, 'id'))),
)

/**
 * THE ACCEPTANCE STATEMENT. It changes one row for exactly one of two accepts
 * made at the same moment; the other finds no row and stops.
 */
export const consumeInvitation = prepared<{ id: string; now: Date }, { id: string }>((db, t) =>
  db
    .update(t.invitation)
    .set({ consumedAt: sql.placeholder('now') })
    .where(and(eq(t.invitation.id, p(t.invitation.id, 'id')), usable(t)))
    .returning({ id: t.invitation.id }),
)

export const revokeInvitationById = prepared<{ id: string; now: Date }, { id: string }>((db, t) =>
  db
    .update(t.invitation)
    .set({ revokedAt: sql.placeholder('now') })
    .where(
      and(
        eq(t.invitation.id, p(t.invitation.id, 'id')),
        isNull(t.invitation.consumedAt),
        isNull(t.invitation.revokedAt),
      ),
    )
    .returning({ id: t.invitation.id }),
)

/** Issuing a new invitation for a membership, or ending the membership, revokes its earlier ones. */
export const revokeInvitationsOfMember = prepared<{
  workspaceId: string
  memberId: string
  now: Date
}>((db, t) =>
  db
    .update(t.invitation)
    .set({ revokedAt: sql.placeholder('now') })
    .where(
      and(
        eq(t.invitation.workspaceId, p(t.invitation.workspaceId, 'workspaceId')),
        eq(t.invitation.memberId, p(t.invitation.memberId, 'memberId')),
        isNull(t.invitation.consumedAt),
        isNull(t.invitation.revokedAt),
      ),
    ),
)

/** The usable invitations of a workspace, newest first. */
export const pendingInvitationsOfWorkspace = prepared<
  { workspaceId: string; now: Date },
  { id: string; memberId: string; expiresAt: Date }
>((db, t) =>
  db
    .select({
      id: t.invitation.id,
      memberId: t.invitation.memberId,
      expiresAt: t.invitation.expiresAt,
    })
    .from(t.invitation)
    .where(and(eq(t.invitation.workspaceId, p(t.invitation.workspaceId, 'workspaceId')), usable(t)))
    .orderBy(desc(t.invitation.createdAt)),
)

/** Expired invitations, through the expiry index. */
export const deleteExpiredInvitations = prepared<{ now: Date }>((db, t) =>
  db.delete(t.invitation).where(lt(t.invitation.expiresAt, p(t.invitation.expiresAt, 'now'))),
)

// ---------------------------------------------------------------------------
// Ending a local account (section 2.1): the account ends with its membership
// ---------------------------------------------------------------------------

export const deleteLoginMethodsOfAccount = prepared<{ accountId: string }>((db, t) =>
  db.delete(t.account).where(eq(t.account.userId, p(t.account.userId, 'accountId'))),
)

export const deleteCodesOfAccount = prepared<{ accountId: string }>((db, t) =>
  db
    .delete(t.oneTimeCode)
    .where(eq(t.oneTimeCode.accountId, p(t.oneTimeCode.accountId, 'accountId'))),
)

export const deleteAccount = prepared<{ accountId: string }>((db, t) =>
  db.delete(t.user).where(eq(t.user.id, p(t.user.id, 'accountId'))),
)

// ---------------------------------------------------------------------------
// From a request to a member (section 2.5)
// ---------------------------------------------------------------------------

export interface ResolutionRow extends SignInRow {
  accountEmail: string
  memberId: string | null
  role: string | null
  status: string | null
}

/**
 * THE RESOLUTION STATEMENT (section 2.5, step 3): the device sign-in with this
 * hashed token, not expired, joined to its account and to that account's
 * membership in the workspace. An account can have ended memberships beside a
 * live one (removed, then invited again as a new member), so the live one is
 * taken first.
 */
export const signInWithMembership = prepared<
  { token: string; now: Date; workspaceId: string },
  ResolutionRow
>((db, t) =>
  db
    .select({
      id: t.session.id,
      accountId: t.session.userId,
      kind: t.session.deviceKind,
      deviceName: t.session.deviceName,
      platform: t.session.platform,
      createdAt: t.session.createdAt,
      lastSeenAt: t.session.lastSeenAt,
      expiresAt: t.session.expiresAt,
      fixedExpiry: t.session.fixedExpiry,
      accountEmail: t.user.email,
      memberId: t.membership.memberId,
      role: t.membership.role,
      status: t.membership.status,
    })
    .from(t.session)
    .innerJoin(t.user, eq(t.user.id, t.session.userId))
    .leftJoin(t.membership, and(eq(t.membership.accountId, t.session.userId), ofWorkspace(t)))
    .where(
      and(
        eq(t.session.token, p(t.session.token, 'token')),
        gt(t.session.expiresAt, p(t.session.expiresAt, 'now')),
      ),
    )
    .orderBy(
      sql`case ${t.membership.status} when 'active' then 0 when 'disabled' then 1 else 2 end`,
    )
    .limit(1),
)

/**
 * An invitation that waits for this address. An invited membership names no
 * account yet, so it is found by the address it was issued for. Only read for
 * a signed-in account that has no membership in the workspace.
 */
export const invitedMembershipByEmail = prepared<
  { workspaceId: string; email: string },
  { memberId: string }
>((db, t) =>
  db
    .select({ memberId: t.membership.memberId })
    .from(t.membership)
    .where(
      and(
        ofWorkspace(t),
        eq(t.membership.status, 'invited'),
        eq(t.membership.invitedEmail, p(t.membership.invitedEmail, 'email')),
      ),
    )
    .limit(1),
)

/**
 * THE REVALIDATION STATEMENT: the held device sign-in still exists and is not
 * expired, and its account is still this active member with this role.
 */
export const heldSignInStillValid = prepared<
  { id: string; now: Date; workspaceId: string; memberId: string; role: string },
  { id: string }
>((db, t) =>
  db
    .select({ id: t.session.id })
    .from(t.session)
    .innerJoin(t.membership, and(eq(t.membership.accountId, t.session.userId), ofWorkspace(t)))
    .where(
      and(
        eq(t.session.id, p(t.session.id, 'id')),
        gt(t.session.expiresAt, p(t.session.expiresAt, 'now')),
        eq(t.membership.status, 'active'),
        eq(t.membership.memberId, p(t.membership.memberId, 'memberId')),
        eq(t.membership.role, p(t.membership.role, 'role')),
      ),
    ),
)

export interface SameMachineRow {
  memberId: string
  role: string
  accountId: string | null
  /** Whether any account in this database has a password. */
  password: unknown
}

/**
 * THE SAME-MACHINE STATEMENT (section 5.5): the first two active memberships
 * of the workspace, and whether any password login method exists. Two rows
 * are enough to tell "exactly one" from "several".
 */
export const sameMachineFacts = prepared<{ workspaceId: string }, SameMachineRow>((db, t) =>
  db
    .select({
      memberId: t.membership.memberId,
      role: t.membership.role,
      accountId: t.membership.accountId,
      password: sql`${exists(
        db
          .select({ one: sql`1` })
          .from(t.account)
          .where(and(eq(t.account.providerId, 'credential'), isNotNull(t.account.password))),
      )}`,
    })
    .from(t.membership)
    .where(and(ofWorkspace(t), eq(t.membership.status, 'active')))
    .limit(2),
)

const liveSignInsOfWorkspace = (t: Tables) =>
  and(
    ofWorkspace(t),
    inArray(t.membership.status, ['active', 'disabled']),
    gt(t.session.expiresAt, p(t.session.expiresAt, 'now')),
  )

/** The unexpired sign-ins of the workspace's live members, latest expiry first. */
export const signInsOfWorkspace = prepared<
  { workspaceId: string; now: Date; limit: number },
  SignInRow
>((db, t) =>
  db
    .select({
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
    .from(t.membership)
    .innerJoin(t.session, eq(t.session.userId, t.membership.accountId))
    .where(liveSignInsOfWorkspace(t))
    .orderBy(desc(t.session.expiresAt))
    .limit(sql.placeholder('limit')),
)

export const countSignInsOfWorkspace = prepared<
  { workspaceId: string; now: Date },
  { total: number }
>((db, t) =>
  db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(t.membership)
    .innerJoin(t.session, eq(t.session.userId, t.membership.accountId))
    .where(liveSignInsOfWorkspace(t)),
)
