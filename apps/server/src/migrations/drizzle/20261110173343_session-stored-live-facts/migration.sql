ALTER TABLE `sessions` ADD `draft_sync_engine` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `agent_color` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `observed_model` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `observed_effort` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `handoff_target_machine_id` text;