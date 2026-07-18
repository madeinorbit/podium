CREATE TABLE `message_wake_cooldowns` (
	`key` text PRIMARY KEY,
	`attempted_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_messages_recipient_order` ON `messages` (`to_kind`,`to_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_queue_order` ON `messages` (`status`,`created_at`,`id`);