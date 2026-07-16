CREATE TABLE `messaging_issue_topics` (
	`issue_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`thread_ref` text NOT NULL,
	`superagent_thread_id` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `messaging_issue_topics_pk` PRIMARY KEY(`issue_id`, `chat_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_messaging_issue_topics_ref` ON `messaging_issue_topics` (`chat_id`,`thread_ref`);