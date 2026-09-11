CREATE TABLE `member_invites` (
	`id` text PRIMARY KEY,
	`token_hash` text NOT NULL UNIQUE,
	`member_id` text,
	`email` text,
	`role` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `account_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_account_id_unique` ON `users` (`account_id`);