CREATE TABLE `messaging_session_attachments` (
	`chat_id` text NOT NULL,
	`thread_ref` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`attached_at` text NOT NULL,
	`relayed_item_id` text,
	CONSTRAINT `messaging_session_attachments_pk` PRIMARY KEY(`chat_id`, `thread_ref`)
);
--> statement-breakpoint
CREATE INDEX `idx_messaging_session_attachments_session` ON `messaging_session_attachments` (`session_id`);