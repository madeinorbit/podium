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
import { bigint, boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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

/** The tables this package reads and writes, by one name in both dialects. */
export const pgIdentityTables = {
  user,
  account,
  session,
  verification,
  rateLimit,
  oneTimeCode: identityOneTimeCode,
}
