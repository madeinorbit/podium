-- POD-7075: THE QUEUE'S ORDER IS A COLUMN. `queued_messages` and `upstream_outbox` were read
-- FIFO by (queued_at, rowid): a wall clock, then SQLite's hidden row order. Postgres has no
-- rowid, so a same-millisecond tie fell to the random primary key there. `queue_order` is the
-- order on both engines: the enqueue INSERT takes one more than its session's highest (one
-- workspace's writers are serialised), and the reads order by it alone.
--
-- Expand-only: two columns added in place. The DEFAULT exists only so the column can be added
-- without a rebuild; every insert names it. Existing rows are numbered in the order they were
-- read until now, (queued_at, rowid): per session for the inbox, per workspace for the parked
-- outbox, which nothing writes any more. The inbox's index follows its new ORDER BY.
ALTER TABLE `queued_messages` ADD `queue_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `upstream_outbox` ADD `queue_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `queued_messages` SET `queue_order` = `numbered`.`n` FROM (SELECT rowid AS `r`, row_number() OVER (PARTITION BY `workspace_id`, `session_id` ORDER BY `queued_at`, rowid) AS `n` FROM `queued_messages`) AS `numbered` WHERE `numbered`.`r` = `queued_messages`.rowid;--> statement-breakpoint
UPDATE `upstream_outbox` SET `queue_order` = `numbered`.`n` FROM (SELECT rowid AS `r`, row_number() OVER (PARTITION BY `workspace_id` ORDER BY `queued_at`, rowid) AS `n` FROM `upstream_outbox`) AS `numbered` WHERE `numbered`.`r` = `upstream_outbox`.rowid;--> statement-breakpoint
DROP INDEX `queued_messages_session`;--> statement-breakpoint
CREATE INDEX `queued_messages_session` ON `queued_messages` (`workspace_id`,`session_id`,`queue_order`);
