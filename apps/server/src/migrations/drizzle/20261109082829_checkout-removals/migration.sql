-- CHECKOUT REMOVALS REACH THEIR READERS, AND ONLY THEM (POD-6644 follow-ups).
--
-- A registered root is readable with MANAGE or USE on its machine, a worktree
-- only with USE.
--
-- 1. `checkouts.removed_at`: an unregistered root keeps its row as a tombstone,
--    so its removal still reaches the members who could read the root (a
--    MANAGE-only member included). Registering the path again clears it.
--    Worktree rows are still deleted.
-- 2. `checkout_reach`: per member and machine, the checkout reach the server
--    last wrote with the member's access row (what lost reach takes away is
--    `checkout_lost`, the next migration). The feed never sends a checkout id
--    to a member who could not read it. Server-only, never on the wire. Empty
--    after the upgrade; the boot's access-row write fills it, which loses
--    nothing because nothing was lost yet.
--
-- EXPAND-ONLY. One nullable column and one new table. ROLLBACK: a binary swap;
-- an older server ignores both (it shows a tombstoned root as live until the
-- next scan removes it). `DROP TABLE checkout_reach` and
-- `ALTER TABLE checkouts DROP COLUMN removed_at` remove them.
CREATE TABLE `checkout_reach` (
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`reach` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `checkout_reach_pk` PRIMARY KEY(`user_id`, `machine_id`)
);
--> statement-breakpoint
ALTER TABLE `checkouts` ADD `removed_at` text;--> statement-breakpoint
CREATE INDEX `idx_checkout_reach_machine` ON `checkout_reach` (`machine_id`);
