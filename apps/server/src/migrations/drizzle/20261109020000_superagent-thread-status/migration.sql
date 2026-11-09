ALTER TABLE `superagent_threads` ADD `turn_running` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `superagent_threads` ADD `last_turn_failure_at` text;--> statement-breakpoint
ALTER TABLE `superagent_threads` ADD `last_turn_failure_message` text;--> statement-breakpoint
ALTER TABLE `superagent_threads` ADD `last_turn_failure_user_text` text;
