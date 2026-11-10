/**
 * The identity tables on SQLite (people and sign-in specification, section 1).
 *
 * The server re-exports these from its migration schema, so they are created by
 * the server's own migration chain. This package holds no migration files.
 *
 * The library's words differ from ours: its `user` is an account and its
 * `account` is a login method. Times are integer milliseconds, read and written
 * as `Date`. Boolean defaults are SQL literals, as everywhere in the server schema.
 */
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const time = (name: string) => integer(name, { mode: 'timestamp_ms' })

/** An account: a person who can sign in. `email` holds the account identifier. */
export const identityUser = sqliteTable('identity_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(sql`0`),
  image: text('image'),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
})

/** A login method of an account: a password, or a provider in the cloud. */
export const identityAccount = sqliteTable(
  'identity_account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => identityUser.id, { onDelete: 'cascade' }),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: time('access_token_expires_at'),
    refreshTokenExpiresAt: time('refresh_token_expires_at'),
    scope: text('scope'),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
  },
  (table) => [
    index('identity_account_user_idx').on(table.userId),
    // "Which accounts have a password" reads through this, never by a scan.
    index('identity_account_provider_idx').on(table.providerId),
  ],
)

/**
 * A device sign-in. `id` is its public id; `token` holds the SHA-256 of the
 * token, never the token.
 */
export const identitySession = sqliteTable(
  'identity_session',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => identityUser.id, { onDelete: 'cascade' }),
    expiresAt: time('expires_at').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    deviceKind: text('device_kind').notNull(),
    deviceName: text('device_name'),
    deviceId: text('device_id'),
    platform: text('platform'),
    lastSeenAt: time('last_seen_at'),
    fixedExpiry: integer('fixed_expiry', { mode: 'boolean' }).notNull().default(sql`0`),
  },
  (table) => [index('identity_session_user_idx').on(table.userId)],
)

/** The library's verification rows. A self-hosted server writes nothing here. */
export const identityVerification = sqliteTable(
  'identity_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: time('expires_at').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
  },
  (table) => [index('identity_verification_identifier_idx').on(table.identifier)],
)

/** A short-lived, single-use secret that becomes a device sign-in or a new password. */
export const identityOneTimeCode = sqliteTable(
  'identity_one_time_code',
  {
    id: text('id').primaryKey(),
    purpose: text('purpose').notNull(),
    accountId: text('account_id').references(() => identityUser.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').unique(),
    receiverChallenge: text('receiver_challenge'),
    claimId: text('claim_id').unique(),
    approval: text('approval').notNull().default('none'),
    sourceSignInId: text('source_sign_in_id'),
    device: text('device'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    createdBy: text('created_by'),
    createdAt: time('created_at').notNull(),
    expiresAt: time('expires_at').notNull(),
    consumedAt: time('consumed_at'),
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
 * 1.3). One row per member for ever. A self-hosted database holds one
 * workspace, the constant `local`.
 */
export const identityMembership = sqliteTable(
  'identity_membership',
  {
    workspaceId: text('workspace_id').notNull(),
    /** Equal to `users.id`. */
    memberId: text('member_id').notNull(),
    /** Null while invited, and when the account of an ended membership was deleted. */
    accountId: text('account_id').references(() => identityUser.id, { onDelete: 'set null' }),
    role: text('role').notNull(),
    status: text('status').notNull(),
    /** The workspace revision at this membership's last change. */
    version: integer('version').notNull(),
    /** Last revision that changed authority; profile changes preserve it. */
    authorizationVersion: integer('authorization_version').notNull().default(0),
    invitedEmail: text('invited_email'),
    createdBy: text('created_by'),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
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
export const identityWorkspaceRevision = sqliteTable('identity_workspace_revision', {
  workspaceId: text('workspace_id').primaryKey(),
  revision: integer('revision').notNull(),
})

/** A single-use, expiring token for a membership in the invited state (section 1.5). */
export const identityInvitation = sqliteTable(
  'identity_invitation',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    memberId: text('member_id').notNull(),
    /** SHA-256, hex, of the token. */
    tokenHash: text('token_hash').notNull().unique(),
    /** When set, accepting requires an account with this address. */
    email: text('email'),
    expiresAt: time('expires_at').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: time('created_at').notNull(),
    consumedAt: time('consumed_at'),
    revokedAt: time('revoked_at'),
  },
  (table) => [
    // The invitations of one membership, and the pending ones of a workspace.
    index('identity_invitation_member_idx').on(table.workspaceId, table.memberId),
    index('identity_invitation_expires_idx').on(table.expiresAt),
  ],
)

/** The tables this package reads and writes, by one name in both dialects. */
export const sqliteIdentityTables = {
  user: identityUser,
  account: identityAccount,
  session: identitySession,
  verification: identityVerification,
  oneTimeCode: identityOneTimeCode,
  membership: identityMembership,
  workspaceRevision: identityWorkspaceRevision,
  invitation: identityInvitation,
}
