CREATE TABLE `effects` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`input_json` text NOT NULL,
	`result_json` text,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`deadline_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`stage` text,
	`started_at` integer,
	`finished_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_effects_status_deadline` ON `effects` (`status`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `idx_effects_status_finished` ON `effects` (`status`,`finished_at`);--> statement-breakpoint
CREATE INDEX `idx_effects_deleted` ON `effects` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_effects_target` ON `effects` (`target_kind`,`target_id`,`created_at`);