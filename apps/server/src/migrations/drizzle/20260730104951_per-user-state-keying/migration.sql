-- PER-USER STATE KEYING (POD-380, docs/multi-user-readiness.md §3.3)
--
-- `pins`, `snoozes` and `tab_order` become keyed (user_id, entity) instead of
-- being instance-wide singletons. Every existing row belongs to the one identity
-- the product has had until now — SOLE_USER_ID in
-- packages/model/src/user-state/session-state.ts — so it is BACKFILLED with that
-- id rather than left NULL.
--
-- HAND-EDITED, and deliberately. `drizzle-kit generate` emitted two faults for
-- this change and both destroy data:
--
--   1. `ALTER TABLE x ADD user_id text NOT NULL` with no DEFAULT, which SQLite
--      refuses outright on a non-empty table; and
--   2. an `INSERT INTO __new_x(...) SELECT ...` that OMITTED `user_id`, so every
--      pre-existing pin, snooze and saved tab order would have violated the new
--      NOT NULL and been lost.
--
-- The table rebuild is required regardless (SQLite cannot alter a primary key),
-- so the redundant ADD COLUMN statements are dropped and the SELECT carries the
-- literal user id. The literal is spelled out rather than imported because a
-- migration is frozen history: if SOLE_USER_ID is ever renamed, the rows this
-- statement wrote keep the id they were actually written with.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_snoozes` (
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`snoozed_until` text,
	`created_at` text NOT NULL,
	CONSTRAINT `snoozes_pk` PRIMARY KEY(`user_id`, `session_id`)
);
--> statement-breakpoint
INSERT INTO `__new_snoozes`(`user_id`, `session_id`, `snoozed_until`, `created_at`) SELECT 'user:sole', `session_id`, `snoozed_until`, `created_at` FROM `snoozes`;--> statement-breakpoint
DROP TABLE `snoozes`;--> statement-breakpoint
ALTER TABLE `__new_snoozes` RENAME TO `snoozes`;--> statement-breakpoint
CREATE TABLE `__new_tab_order` (
	`user_id` text NOT NULL,
	`worktree` text NOT NULL,
	`ids` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `tab_order_pk` PRIMARY KEY(`user_id`, `worktree`)
);
--> statement-breakpoint
INSERT INTO `__new_tab_order`(`user_id`, `worktree`, `ids`, `updated_at`) SELECT 'user:sole', `worktree`, `ids`, `updated_at` FROM `tab_order`;--> statement-breakpoint
DROP TABLE `tab_order`;--> statement-breakpoint
ALTER TABLE `__new_tab_order` RENAME TO `tab_order`;--> statement-breakpoint
CREATE TABLE `__new_pins` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`pinned_at` text NOT NULL,
	CONSTRAINT `pins_pk` PRIMARY KEY(`user_id`, `kind`, `id`)
);
--> statement-breakpoint
INSERT INTO `__new_pins`(`user_id`, `kind`, `id`, `pinned_at`) SELECT 'user:sole', `kind`, `id`, `pinned_at` FROM `pins`;--> statement-breakpoint
DROP TABLE `pins`;--> statement-breakpoint
ALTER TABLE `__new_pins` RENAME TO `pins`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
