CREATE TABLE `concertmaster_entries` (
	`id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`artifacts_json` text,
	`sender_user_id` text,
	`attachments_json` text,
	`number` integer,
	`ask_kind` text,
	`detail` text,
	`options_json` text,
	`status` text,
	`answer` text,
	`settled_at` text,
	`settled_by` text,
	`workspace_id` text NOT NULL,
	CONSTRAINT `concertmaster_entries_pk` PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `concertmaster` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_concertmaster_entries_session` ON `concertmaster_entries` (`workspace_id`,`session_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `concertmaster_entries_ask_number` ON `concertmaster_entries` (`workspace_id`,`session_id`,`number`);;--> statement-breakpoint
-- Invalidate every record derived from the changed session rows, and the new kind's,
-- in every workspace that has a feed (POD-6920's generation rule, keyed per workspace).
INSERT INTO `sync_kind` (`workspace_id`, `kind`, `generation`)
SELECT feed.`workspace_id`, bumped.`kind`, 1
FROM `sync_feed` AS feed, (SELECT 'session' AS kind UNION ALL SELECT 'sessionUserState' UNION ALL SELECT 'message' UNION ALL SELECT 'concertmasterEntry') AS bumped
WHERE true
ON CONFLICT (`workspace_id`, `kind`) DO UPDATE SET `generation` = `sync_kind`.`generation` + 1;
