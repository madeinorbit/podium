CREATE TABLE `session_terminal_candidates` (
	`session_id` text PRIMARY KEY,
	`proof_json` text NOT NULL,
	`confirmed_at` text,
	`consumed_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_session_terminal_candidates_session_id_session_observation_checkpoints_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_observation_checkpoints`(`session_id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `input_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `output_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `activity_count` integer DEFAULT 0 NOT NULL;