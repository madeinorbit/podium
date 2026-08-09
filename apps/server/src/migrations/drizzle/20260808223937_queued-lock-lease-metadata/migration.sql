ALTER TABLE `lock_waiters` ADD `ttl_seconds` integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE `lock_waiters` ADD `note` text;