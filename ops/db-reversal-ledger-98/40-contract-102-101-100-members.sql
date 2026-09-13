--
-- REVERSE MIGRATION TO LEDGER 98 -- 102 + 101 + 100, THE MEMBER COLUMNS
--
-- Part of ops/db-reversal-ledger-98. Applied by revert-to-ledger-98.sh, which
-- wraps the whole set in ONE transaction: either the database reaches ledger 98
-- or it is left exactly as it was found. Nothing here is a drizzle migration --
-- this repo's migrations are forward-only by design (scripts/audit-expand-only-
-- migrations.ts says so in its header) and there is no `down` concept to use.
-- See 00-preflight.sql for why this is a one-shot script and not a migration.
--

-- 102 `member-avatar`      ADDed `users.avatar`.
-- 101 `member-invites`     CREATEd `member_invites`, ADDed `users.account_id`
--                          and its unique index.
-- 100 `member-login-email` ADDed `users.email` and its unique index on
--                          lower(email).
--
-- Preflight has already refused to run if any of the three columns holds a
-- value, so the rebuild below loses nothing. Both unique indexes go with the
-- table; neither exists at ledger 98.

DROP TABLE "member_invites";

CREATE TABLE "__rev_stash_users" AS SELECT * FROM "users";

DROP TABLE "users";

CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	`disabled_at` text
);

INSERT INTO "users" ("id", "display_name", "role", "created_at", "disabled_at")
SELECT "id", "display_name", "role", "created_at", "disabled_at"
FROM "__rev_stash_users" AS s;

DROP TABLE "__rev_stash_users";
