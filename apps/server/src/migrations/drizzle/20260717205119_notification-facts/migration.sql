CREATE TABLE `notification_facts` (
	`fact_key` text NOT NULL,
	`target` text NOT NULL,
	`source` text,
	`issue_id` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`consumed_at` text,
	CONSTRAINT `notification_facts_pk` PRIMARY KEY(`fact_key`, `target`)
);
--> statement-breakpoint
CREATE INDEX `idx_notification_facts_issue` ON `notification_facts` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_notification_facts_expires` ON `notification_facts` (`expires_at`);