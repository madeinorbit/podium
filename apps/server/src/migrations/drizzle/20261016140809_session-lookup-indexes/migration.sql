CREATE INDEX `idx_sessions_cwd` ON `sessions` (`cwd`);--> statement-breakpoint
CREATE INDEX `idx_sessions_cwd_folded` ON `sessions` (lower(replace("cwd", '/', '\')));--> statement-breakpoint
CREATE INDEX `idx_sessions_spawned_by` ON `sessions` (`spawned_by`);--> statement-breakpoint
CREATE INDEX `idx_sessions_ref_draft` ON `sessions` (`ref_draft`);--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);