CREATE TABLE `transcript_costs` (
	`machine_id` text NOT NULL,
	`native_id` text NOT NULL,
	`path` text NOT NULL,
	`harness` text NOT NULL,
	`session_id` text,
	`issue_id` text,
	`scanned_bytes` integer DEFAULT 0 NOT NULL,
	`first_ts_ms` integer DEFAULT 0 NOT NULL,
	`last_ts_ms` integer DEFAULT 0 NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	`models_json` text NOT NULL,
	`window_models_json` text DEFAULT '[]' NOT NULL,
	`window_since_ms` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `transcript_costs_pk` PRIMARY KEY(`machine_id`, `native_id`)
);
--> statement-breakpoint
CREATE INDEX `conversation_segments_path` ON `conversation_segments` (`path`);--> statement-breakpoint
CREATE INDEX `idx_sessions_resume_machine` ON `sessions` (`resume_value`,`machine_id`);--> statement-breakpoint
CREATE INDEX `idx_transcript_costs_issue` ON `transcript_costs` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_transcript_costs_session` ON `transcript_costs` (`session_id`);