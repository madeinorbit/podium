// LEGACY(remove-after: 2027-06): pre-upgrade password and invitation shapes; removal ends import from older databases.
/** Read-only shapes for the boot import. Excluded from the current schema. */
import type { UserId } from '@podium/model'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Invite tokens are credentials: only their hash is persisted; no sync projection. */
export const memberInvites = sqliteTable('member_invites', {
  id: text().$type<import('@podium/model').InviteId>().primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  memberId: text('member_id').$type<UserId>(),
  email: text(),
  role: text().$type<import('@podium/model').UserRole>().notNull(),
  expiresAt: text('expires_at').notNull(),
  createdBy: text('created_by').$type<UserId>().notNull(),
  createdAt: text('created_at').notNull(),
})

/** Original password hashes are copied unchanged by the boot import. */
export const userCredentials = sqliteTable('user_credentials', {
  userId: text('user_id').$type<UserId>().primaryKey(),
  source: text().notNull(),
  passwordHash: text('password_hash'),
  updatedAt: text('updated_at').notNull(),
})
