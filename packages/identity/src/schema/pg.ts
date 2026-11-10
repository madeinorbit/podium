/**
 * The identity tables on Postgres (people and sign-in specification, section 1).
 *
 * podium-cloud re-exports these from its platform schema and generates its own
 * migrations from them. This package holds no migration files.
 *
 * The library tables keep the names the cloud already has (`user`, `session`,
 * `account`, `verification`). The library's `user` is an account and its
 * `account` is a login method.
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/** An account: a person who can sign in. `email` holds the account identifier. */
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})

/**
 * A device sign-in. `id` is its public id; `token` holds the SHA-256 of the
 * token, never the token. `active_organization_id` belongs to the library's
 * organisation extension, which only the cloud configures.
 */
export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: text('active_organization_id'),
    // Existing cloud rows were made by a browser; new rows always state their kind.
    deviceKind: text('device_kind').notNull().default('browser'),
    deviceName: text('device_name'),
    deviceId: text('device_id'),
    platform: text('platform'),
    lastSeenAt: timestamp('last_seen_at'),
    fixedExpiry: boolean('fixed_expiry').notNull().default(false),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
)

/** A login method of an account: a password or a provider. */
export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('account_userId_idx').on(table.userId),
    // "Which accounts have a password" reads through this, never by a scan.
    index('account_providerId_idx').on(table.providerId),
  ],
)

/** The library's verification rows: mail verification, mailed reset, OAuth state. */
export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
)

/** The library's request budget, shared by every cloud process. */
export const rateLimit = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
})

/** A short-lived, single-use secret that becomes a device sign-in or a new password. */
export const identityOneTimeCode = pgTable(
  'identity_one_time_code',
  {
    id: text('id').primaryKey(),
    purpose: text('purpose').notNull(),
    accountId: text('account_id').references(() => user.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').unique(),
    receiverChallenge: text('receiver_challenge'),
    claimId: text('claim_id').unique(),
    approval: text('approval').notNull().default('none'),
    sourceSignInId: text('source_sign_in_id'),
    device: text('device'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
  },
  (table) => [
    index('identity_one_time_code_expires_idx').on(table.expiresAt),
    // A hand-over is authorised by the challenge its receiver chose.
    index('identity_one_time_code_challenge_idx').on(table.receiverChallenge),
    // Deleting an account cascades here.
    index('identity_one_time_code_account_idx').on(table.accountId),
  ],
)

/**
 * "Account A is member M of workspace W with role R", with a status (section
 * 1.3). One row per member for ever.
 */
export const identityMembership = pgTable(
  'identity_membership',
  {
    workspaceId: text('workspace_id').notNull(),
    /** Equal to `users.id` in the workspace database. */
    memberId: text('member_id').notNull(),
    /** Null while invited, and when the account of an ended membership was deleted. */
    accountId: text('account_id').references(() => user.id, { onDelete: 'set null' }),
    role: text('role').notNull(),
    status: text('status').notNull(),
    /** The workspace revision at this membership's last change. */
    version: integer('version').notNull(),
    invitedEmail: text('invited_email'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.memberId] }),
    // An account is at most one live member of a workspace.
    uniqueIndex('identity_membership_live_account_idx')
      .on(table.workspaceId, table.accountId)
      .where(sql`account_id is not null and status in ('active', 'disabled')`),
    // The workspaces of an account; the membership of a device sign-in's account.
    index('identity_membership_account_idx').on(table.accountId),
    // Catch-up reads the changes above a version, in order.
    index('identity_membership_version_idx').on(table.workspaceId, table.version),
  ],
)

/** The counter every membership change of a workspace steps (section 1.4). */
export const identityWorkspaceRevision = pgTable('identity_workspace_revision', {
  workspaceId: text('workspace_id').primaryKey(),
  revision: integer('revision').notNull(),
})

/** A single-use, expiring token for a membership in the invited state (section 1.5). */
export const identityInvitation = pgTable(
  'identity_invitation',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    memberId: text('member_id').notNull(),
    /** SHA-256, hex, of the token. */
    tokenHash: text('token_hash').notNull().unique(),
    /** When set, accepting requires an account with this address. */
    email: text('email'),
    expiresAt: timestamp('expires_at').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (table) => [
    // The invitations of one membership, and the pending ones of a workspace.
    index('identity_invitation_member_idx').on(table.workspaceId, table.memberId),
    index('identity_invitation_expires_idx').on(table.expiresAt),
  ],
)

/** The tables this package reads and writes, by one name in both dialects. */
export const pgIdentityTables = {
  user,
  account,
  session,
  verification,
  rateLimit,
  oneTimeCode: identityOneTimeCode,
  membership: identityMembership,
  workspaceRevision: identityWorkspaceRevision,
  invitation: identityInvitation,
}
