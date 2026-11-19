CREATE TABLE `artifact_uploads` (
	`issue_id` text NOT NULL,
	`upload_id` text NOT NULL,
	`begin_json` text NOT NULL,
	`received_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`workspace_id` text DEFAULT 'local' NOT NULL,
	CONSTRAINT `artifact_uploads_pk` PRIMARY KEY(`workspace_id`, `issue_id`, `upload_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_artifact_uploads_created` ON `artifact_uploads` (`workspace_id`,`created_at`);