CREATE TABLE `quota_windows` (
	`account_key` text NOT NULL,
	`agent` text NOT NULL,
	`window_key` text NOT NULL,
	`resets_at_bucket` integer NOT NULL,
	`label` text NOT NULL,
	`scope_model` text,
	`plan` text,
	`resets_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`window_minutes` integer NOT NULL,
	`first_seen_ms` integer NOT NULL,
	`last_seen_ms` integer NOT NULL,
	`first_percent` real NOT NULL,
	`peak_percent` real NOT NULL,
	`last_percent` real NOT NULL,
	`sample_count` integer NOT NULL,
	`partial` integer NOT NULL,
	`source` text NOT NULL,
	`trail_json` text NOT NULL,
	CONSTRAINT `quota_windows_pk` PRIMARY KEY(`account_key`, `window_key`, `resets_at_bucket`)
);
--> statement-breakpoint
CREATE INDEX `idx_quota_windows_series` ON `quota_windows` (`account_key`,`window_key`,`resets_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_quota_windows_resets` ON `quota_windows` (`resets_at_ms`);