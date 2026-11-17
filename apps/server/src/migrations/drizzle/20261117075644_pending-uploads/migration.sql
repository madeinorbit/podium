CREATE TABLE `pending_uploads` (
	`id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`filename` text NOT NULL,
	`entry` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_issue_id` text,
	`claimed_artifact_id` text,
	`workspace_id` text DEFAULT 'local' NOT NULL,
	CONSTRAINT `pending_uploads_pk` PRIMARY KEY(`workspace_id`, `id`),
	CONSTRAINT "pending_uploads_claim_pair" CHECK((claimed_issue_id IS NULL) = (claimed_artifact_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_pending_uploads_created` ON `pending_uploads` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_pending_uploads_claimed` ON `pending_uploads` (`workspace_id`,`claimed_issue_id`);