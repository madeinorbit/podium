ALTER TABLE `automations` ADD `schedule_kind` text DEFAULT 'cron' NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `run_at` text;--> statement-breakpoint
ALTER TABLE `automations` ADD `target_session_id` text;