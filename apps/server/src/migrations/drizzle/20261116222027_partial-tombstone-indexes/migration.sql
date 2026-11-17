DROP INDEX IF EXISTS `idx_effects_deleted`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_issues_deleted_at`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_issues_parent`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_sessions_deleted_at`;--> statement-breakpoint
CREATE INDEX `idx_effects_tombstones` ON `effects` (`deleted_at`) WHERE "effects"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_issues_tombstones` ON `issues` (`deleted_at`) WHERE "issues"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_issues_children` ON `issues` (`parent_id`) WHERE "issues"."parent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sessions_tombstones` ON `sessions` (`deleted_at`) WHERE "sessions"."deleted_at" IS NOT NULL;