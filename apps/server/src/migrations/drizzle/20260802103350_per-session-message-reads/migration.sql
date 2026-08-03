CREATE TABLE `message_reads` (
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`read_at` text NOT NULL,
	CONSTRAINT `message_reads_pk` PRIMARY KEY(`message_id`, `session_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_message_reads_session` ON `message_reads` (`session_id`);
