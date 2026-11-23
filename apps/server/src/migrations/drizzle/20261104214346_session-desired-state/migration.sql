ALTER TABLE `sessions` ADD `desired` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `desired_force` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `observed_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `lifecycle_failure` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `desired_by_user` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `desired_by_agent` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_lifecycle_pending` ON `sessions` (`machine_id`) WHERE "sessions"."revision" > "sessions"."observed_revision" AND "sessions"."deleted_at" IS NULL;