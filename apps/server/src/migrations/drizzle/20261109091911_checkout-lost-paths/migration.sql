-- A MEMBER'S LOST CHECKOUTS ARE KEPT UNTIL THEIR READS COVER THEM AGAIN (POD-6644).
--
-- `checkout_lost`: per member, machine and path, the checkouts an access-row
-- write took out of the member's reach. The feed evicts every one of them on
-- each later move of that member's access row, so a device that was away
-- across several writes still receives the evicts when it catches up. A path
-- leaves when the member's reach covers it again. Server-only, never on the
-- wire. Replaces `checkout_reach.lost` (the lost kind), which is no longer
-- written or read; a later contract migration drops that column.
--
-- EXPAND-ONLY. One new table. ROLLBACK: a binary swap; an older server
-- ignores the table, and `DROP TABLE checkout_lost` removes it.
CREATE TABLE `checkout_lost` (
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`path` text NOT NULL,
	`root` integer DEFAULT 0 NOT NULL,
	`lost_at` text NOT NULL,
	CONSTRAINT `checkout_lost_pk` PRIMARY KEY(`user_id`, `machine_id`, `path`)
);
--> statement-breakpoint
CREATE INDEX `idx_checkout_lost_machine` ON `checkout_lost` (`machine_id`);
