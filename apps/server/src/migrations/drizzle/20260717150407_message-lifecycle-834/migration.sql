ALTER TABLE `messages` ADD `read_at` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `injected_at` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `dead_lettered_at` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`in_reply_to` text,
	`from_kind` text NOT NULL,
	`from_session` text,
	`from_issue` text,
	`to_kind` text NOT NULL,
	`to_id` text,
	`kind` text DEFAULT 'message' NOT NULL,
	`urgency` text DEFAULT 'fyi' NOT NULL,
	`lifecycle` text DEFAULT 'wait' NOT NULL,
	`body` text NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`delivered_at` text,
	`delivered_to` text,
	`acked_by` text,
	`hop` integer DEFAULT 0 NOT NULL,
	`clamped_from` text,
	`reminded_at` text,
	`from_name` text,
	`read_at` text,
	`injected_at` text,
	`dead_lettered_at` text,
	CONSTRAINT "messages_check_5" CHECK(from_kind IN ('operator','superagent','agent','system')),
	CONSTRAINT "messages_check_6" CHECK(to_kind IN ('issue','session','operator')),
	CONSTRAINT "messages_check_7" CHECK(kind IN ('message','ack','notification','question')),
	CONSTRAINT "messages_check_8" CHECK(urgency IN ('fyi','next-turn','interrupt')),
	CONSTRAINT "messages_check_9" CHECK(lifecycle IN ('wait','wake')),
	CONSTRAINT "messages_check_10" CHECK(status IN ('queued','delivered','read','dead_letter','expired','cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_messages`(`id`, `thread_id`, `in_reply_to`, `from_kind`, `from_session`, `from_issue`, `to_kind`, `to_id`, `kind`, `urgency`, `lifecycle`, `body`, `expires_at`, `created_at`, `status`, `delivered_at`, `delivered_to`, `acked_by`, `hop`, `clamped_from`, `reminded_at`, `from_name`) SELECT `id`, `thread_id`, `in_reply_to`, `from_kind`, `from_session`, `from_issue`, `to_kind`, `to_id`, `kind`, `urgency`, `lifecycle`, `body`, `expires_at`, `created_at`, `status`, `delivered_at`, `delivered_to`, `acked_by`, `hop`, `clamped_from`, `reminded_at`, `from_name` FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_messages_delivered_to` ON `messages` (`delivered_to`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_recipient` ON `messages` (`to_kind`,`to_id`,`status`);