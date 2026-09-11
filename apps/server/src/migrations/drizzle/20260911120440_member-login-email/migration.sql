ALTER TABLE `users` ADD `email` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (lower("email"));