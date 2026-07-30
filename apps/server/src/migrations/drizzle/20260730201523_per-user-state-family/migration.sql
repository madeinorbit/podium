-- PER-USER STATE FAMILY (POD-1076; ADR 9 D3 rule 4, ADR 4 Amendment 1 D10,
-- docs/rearch-field-schema-inventory.md §7.1)
--
-- Five singleton columns on three shared entity rows become three tables keyed
-- `(user_id, entity_id)`. `sessions.read_at`, `issues.read_at`,
-- `issues.tucked_at`, `issues.pinned` and `issue_messages.read_at` are facts
-- about a READER, and one column per entity asserts that exactly one person
-- exists. ADR 1's matrix has declared them `per-user-state` since POD-304; this
-- is the storage catching up, and POD-311 pinned the divergence with a tripwire
-- test so that landing it would turn red rather than leaving a stale claim.
--
-- ONE-SHOT AND IRREVERSIBLE IN PLACE. There are no down migrations; rollback is
-- restoring the pre-migration backup the runner takes at boot (`backup.ts`).
--
-- ---------------------------------------------------------------------------
-- 1. HAND-EDITED, AND WHAT drizzle-kit GOT WRONG
-- ---------------------------------------------------------------------------
-- `drizzle-kit generate` emitted the three CREATE TABLEs and the five DROP
-- COLUMNs and NOTHING BETWEEN THEM. Applied as generated it is a clean, silent,
-- total loss of every read marker, every tuck-away and every pin in the
-- database — no error, no NOT NULL violation, three correctly-shaped empty
-- tables. The INSERT ... SELECT block below is the whole point of the migration
-- and drizzle cannot infer it, because a re-key is a DATA move that happens to
-- have DDL either side of it.
--
-- (It did NOT hit POD-380's and POD-1075's `ALTER TABLE ADD <col> NOT NULL with
-- no DEFAULT` fault, because nothing here adds a column to a populated table.
-- Recorded because the absence is informative: that fault is a property of
-- ADD COLUMN, not of re-keying.)
--
-- ---------------------------------------------------------------------------
-- 2. THE OWNER OF EVERY BACKFILLED ROW
-- ---------------------------------------------------------------------------
-- `'user:sole'` — the id POD-1075 mints as the first admin and POD-380 already
-- wrote into every pin, snooze and tab-order row. Every existing marker was made
-- by the one identity the product has had, so it has an unambiguous owner and is
-- backfilled rather than dropped.
--
-- The literal is spelled out rather than imported because a migration is frozen
-- history: if `FIRST_ADMIN_USER_ID` is ever renamed, the rows this statement
-- wrote keep the id they were actually written with.
--
-- ---------------------------------------------------------------------------
-- 3. ONLY NON-DEFAULT MARKERS BECOME ROWS
-- ---------------------------------------------------------------------------
-- The WHERE clauses exclude entities the operator never touched. An absent row
-- and a row of nulls mean the same thing, so writing one per issue would triple
-- the table for no information — and would make "has this person ever
-- interacted with this issue" unanswerable, which the sidebar's decay rules
-- will want.
--
-- ---------------------------------------------------------------------------
-- 4. `pinned` (0/1) BECOMES `pinned_at` (timestamp), AT ONE INSTANT
-- ---------------------------------------------------------------------------
-- The flag carries no time, so every pre-existing pin is stamped with the
-- MIGRATION's instant rather than with a per-row guess such as `updated_at`. A
-- borrowed timestamp would read as ordering data and be wrong; one shared
-- instant is honestly "pinned before we recorded when". Pin ORDER is
-- `issues.sort_key`, which has its own key space for pinned rows and is
-- untouched here.

CREATE TABLE `session_user_state` (
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`read_at` text,
	CONSTRAINT `session_user_state_pk` PRIMARY KEY(`user_id`, `session_id`)
);
--> statement-breakpoint
CREATE TABLE `issue_user_state` (
	`user_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`read_at` text,
	`tucked_at` text,
	`pinned_at` text,
	CONSTRAINT `issue_user_state_pk` PRIMARY KEY(`user_id`, `issue_id`)
);
--> statement-breakpoint
CREATE TABLE `issue_message_user_state` (
	`user_id` text NOT NULL,
	`issue_message_id` text NOT NULL,
	`read_at` text,
	CONSTRAINT `issue_message_user_state_pk` PRIMARY KEY(`user_id`, `issue_message_id`)
);
--> statement-breakpoint
-- THE BACKFILL. Runs BEFORE the drops, obviously — but stated because the
-- generated file had the drops with nothing before them and looked complete.
INSERT INTO `session_user_state` (`user_id`, `session_id`, `read_at`)
SELECT 'user:sole', `id`, `read_at` FROM `sessions` WHERE `read_at` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `issue_user_state` (`user_id`, `issue_id`, `read_at`, `tucked_at`, `pinned_at`)
SELECT 'user:sole', `id`, `read_at`, `tucked_at`,
       CASE WHEN `pinned` = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
FROM `issues`
WHERE `read_at` IS NOT NULL OR `tucked_at` IS NOT NULL OR `pinned` = 1;
--> statement-breakpoint
INSERT INTO `issue_message_user_state` (`user_id`, `issue_message_id`, `read_at`)
SELECT 'user:sole', `id`, `read_at` FROM `issue_messages` WHERE `read_at` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `issue_messages` DROP COLUMN `read_at`;--> statement-breakpoint
ALTER TABLE `issues` DROP COLUMN `tucked_at`;--> statement-breakpoint
ALTER TABLE `issues` DROP COLUMN `pinned`;--> statement-breakpoint
ALTER TABLE `issues` DROP COLUMN `read_at`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `read_at`;
