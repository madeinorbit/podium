ALTER TABLE `superagent_threads` ADD `model` text;--> statement-breakpoint
ALTER TABLE `superagent_threads` ADD `effort` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_superagent_queued_inputs` (
	`owner_user_id` text DEFAULT 'user:sole' NOT NULL,
	`input_id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`text` text NOT NULL,
	`focus_json` text,
	`created_at` text NOT NULL,
	`actor` text,
	`on_behalf_of` text
);
--> statement-breakpoint
INSERT INTO `__new_superagent_queued_inputs`(`owner_user_id`, `input_id`, `thread_id`, `text`, `focus_json`, `created_at`, `actor`, `on_behalf_of`) SELECT `owner_user_id`, `input_id`, `thread_id`, `text`, `focus_json`, `created_at`, `actor`, `on_behalf_of` FROM `superagent_queued_inputs`;--> statement-breakpoint
DROP TABLE `superagent_queued_inputs`;--> statement-breakpoint
ALTER TABLE `__new_superagent_queued_inputs` RENAME TO `superagent_queued_inputs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_superagent_queued_thread_order` ON `superagent_queued_inputs` (`thread_id`,`created_at`);