CREATE TABLE `identity_invitation` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`member_id` text NOT NULL,
	`token_hash` text NOT NULL UNIQUE,
	`email` text,
	`expires_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`consumed_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `identity_membership` (
	`workspace_id` text NOT NULL,
	`member_id` text NOT NULL,
	`account_id` text,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`invited_email` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `identity_membership_pk` PRIMARY KEY(`workspace_id`, `member_id`),
	CONSTRAINT `fk_identity_membership_account_id_identity_user_id_fk` FOREIGN KEY (`account_id`) REFERENCES `identity_user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `identity_workspace_revision` (
	`workspace_id` text PRIMARY KEY,
	`revision` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `membership_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `identity_invitation_member_idx` ON `identity_invitation` (`workspace_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `identity_invitation_expires_idx` ON `identity_invitation` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_membership_live_account_idx` ON `identity_membership` (`workspace_id`,`account_id`) WHERE account_id is not null and status in ('active', 'disabled');--> statement-breakpoint
CREATE INDEX `identity_membership_account_idx` ON `identity_membership` (`account_id`);--> statement-breakpoint
CREATE INDEX `identity_membership_version_idx` ON `identity_membership` (`workspace_id`,`version`);