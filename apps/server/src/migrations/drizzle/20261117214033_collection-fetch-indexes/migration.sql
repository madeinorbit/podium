CREATE INDEX `idx_automation_runs_fired` ON `automation_runs` (`fired_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_created_at` ON `conversations` (coalesce("created_at", ''),`id`);--> statement-breakpoint
CREATE INDEX `idx_issues_stage_updated` ON `issues` (`stage`,"updated_at" desc,`id`);--> statement-breakpoint
CREATE INDEX `idx_issues_updated` ON `issues` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_published_active` ON `sessions` (`published_last_active_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_issue_archived` ON `sessions` (`issue_id`,`archived`);