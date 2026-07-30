-- USER ACCOUNTS AND THE FIRST ADMIN (POD-1075, ADR 9 D1, docs/multi-user-readiness.md §3.2)
--
-- Podium has had no notion of a user: one shared password, and a client session
-- that is a DEVICE rather than a person. This migration lands the identity
-- tables, gives `client_sessions` a user, and mints the ONE account an upgraded
-- instance has — so that every later ownership backfill has an owner to resolve
-- to, and so Phase 4's machine-ownership migration can assume an admin exists.
--
-- ONE-SHOT AND IRREVERSIBLE IN PLACE. There are no down migrations; rollback is
-- restoring the pre-migration backup the runner takes at boot. Read the three
-- decisions below before changing anything here.
--
-- ---------------------------------------------------------------------------
-- 1. EXISTING SESSIONS ARE ADOPTED, NOT INVALIDATED
-- ---------------------------------------------------------------------------
-- Every row already in `client_sessions` is backfilled with the first admin's
-- id. Nobody is logged out by an upgrade. The alternative — dropping the table
-- and making everyone log in again — is the failure nobody notices until it
-- ships, because a fixture that starts from an empty session table passes
-- either way. `user-accounts.migration.test.ts` seeds real rows into a real
-- pre-migration database and asserts they SURVIVE with the right user.
--
-- ---------------------------------------------------------------------------
-- 2. HAND-EDITED, AND DELIBERATELY
-- ---------------------------------------------------------------------------
-- `drizzle-kit generate` emitted `ALTER TABLE client_sessions ADD user_id text
-- NOT NULL` with no DEFAULT, which SQLite REFUSES outright on a non-empty
-- table — the same fault the POD-380 per-user-state migration hit and recorded.
-- The table is therefore rebuilt with the literal id carried in the SELECT.
--
-- The literal is spelled out rather than imported because a migration is frozen
-- history: if `FIRST_ADMIN_USER_ID` is ever renamed, the rows this statement
-- wrote keep the id they were actually written with. It is `'user:sole'` — the
-- value POD-380's migration already wrote into every pin, snooze and tab-order
-- row, which is why that spelling won the POD-1172 reconciliation and
-- `'instance-owner'` was retired.
--
-- ---------------------------------------------------------------------------
-- 3. THE CREDENTIAL, AND THE FORK THIS RESOLVED
-- ---------------------------------------------------------------------------
-- "The existing password becomes that admin's credential" cannot be implemented
-- by copying a hash: today's shared password is a scrypt hash in `auth.json`
-- (packages/runtime/src/auth-store.ts), a FILE, and SQL cannot read it.
--
-- So the credential row records what is TRUE rather than inventing something:
-- `source = 'instance-password'` with a NULL hash means *this account
-- authenticates with the instance password that already exists*. Nobody is
-- locked out, no secret is moved, and the model has a word for how the first
-- admin logs in. Minting per-account credentials (`source = 'per-user-scrypt'`)
-- lands with the per-user login work in Phase 3 (POD-315).
--
-- The INSERTs are unconditional and run on a FRESH database too, so a new
-- install boots with the first admin already present rather than acquiring one
-- at some later first-login. `INSERT OR IGNORE` guards re-application only.

CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	`disabled_at` text
);
--> statement-breakpoint
CREATE TABLE `user_credentials` (
	`user_id` text PRIMARY KEY,
	`source` text NOT NULL,
	`password_hash` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `grants` (
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`grantee` text NOT NULL,
	`verb` text NOT NULL,
	`owner` text NOT NULL,
	`visibility` text NOT NULL,
	`created_at` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`on_behalf_of` text,
	CONSTRAINT `grants_pk` PRIMARY KEY(`resource_kind`, `resource_id`, `grantee`, `verb`)
);
--> statement-breakpoint
-- THE FIRST ADMIN. An ADMIN because on an upgraded instance it is the only
-- account there is, and somebody must be able to manage secrets, instance
-- settings and the fleet (ADR 9 D1.4/D1.5). ISO-8601 via strftime, matching
-- every other timestamp column in this schema — `datetime('now')` would write
-- the space-separated form that string comparisons then sort wrongly.
INSERT OR IGNORE INTO `users` (`id`, `display_name`, `role`, `created_at`, `disabled_at`)
VALUES ('user:sole', 'Operator', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `user_credentials` (`user_id`, `source`, `password_hash`, `updated_at`)
VALUES ('user:sole', 'instance-password', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
-- ADOPTION. The rebuild is required regardless (SQLite cannot add a NOT NULL
-- column without a default), and the SELECT carries the literal so every
-- existing device session keeps working under the first admin's identity.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_client_sessions` (
	`token_hash` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_client_sessions`(`token_hash`, `user_id`, `created_at`, `expires_at`) SELECT `token_hash`, 'user:sole', `created_at`, `expires_at` FROM `client_sessions`;--> statement-breakpoint
DROP TABLE `client_sessions`;--> statement-breakpoint
ALTER TABLE `__new_client_sessions` RENAME TO `client_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
