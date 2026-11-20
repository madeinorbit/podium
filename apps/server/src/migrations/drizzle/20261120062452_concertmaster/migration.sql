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
CREATE UNIQUE INDEX `concertmaster_entries_ask_number` ON `concertmaster_entries` (`workspace_id`,`session_id`,`number`);