ALTER TABLE `credentials` ADD `limit_reached_until` text;--> statement-breakpoint
CREATE INDEX `idx_credential_placements_pending` ON `credential_placements` (`machine_id`,`credential_id`,`kind`) WHERE "credential_placements"."state" = 'removal-pending';--> statement-breakpoint
CREATE INDEX `idx_credentials_expiry` ON `credentials` (`expires_at`) WHERE "credentials"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sessions_credential` ON `sessions` (`credential_id`) WHERE "sessions"."credential_id" IS NOT NULL AND "sessions"."deleted_at" IS NULL;