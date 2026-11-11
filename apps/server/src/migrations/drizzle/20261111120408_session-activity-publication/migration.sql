ALTER TABLE `sessions` ADD `published_last_active_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_active_publish_after` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `published_last_active_at` = `last_active_at`;--> statement-breakpoint
CREATE INDEX `idx_sessions_pending_activity` ON `sessions` (`last_active_publish_after`,`id`) WHERE "sessions"."published_last_active_at" < "sessions"."last_active_at" AND "sessions"."deleted_at" IS NULL;
