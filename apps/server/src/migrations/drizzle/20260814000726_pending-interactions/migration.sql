CREATE TABLE `pending_interactions` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`source` text NOT NULL,
	`answerable` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'asked' NOT NULL,
	`policy_verdict` text,
	`asked_at` text NOT NULL,
	`expires_at` text,
	`answered_at` text,
	`answered_by` text,
	`answer_json` text,
	`delivered_via` text,
	`expired_at` text,
	CONSTRAINT "pending_interactions_status_check" CHECK(status IN ('asked','answered','expired')),
	CONSTRAINT "pending_interactions_kind_check" CHECK(kind IN ('permission','question','plan-approval','elicitation','login','recovery')),
	CONSTRAINT "pending_interactions_source_check" CHECK(source IN ('protocol','sdk-callback','hook','screen-classifier'))
);
--> statement-breakpoint
CREATE INDEX `idx_pending_interactions_session` ON `pending_interactions` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_pending_interactions_open` ON `pending_interactions` (`status`,`asked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pending_interactions_fingerprint` ON `pending_interactions` (`session_id`,`fingerprint`) WHERE status = 'asked';