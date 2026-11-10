CREATE TABLE `identity_account` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`password` text,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_identity_account_user_id_identity_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `identity_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `identity_one_time_code` (
	`id` text PRIMARY KEY,
	`purpose` text NOT NULL,
	`account_id` text,
	`code_hash` text UNIQUE,
	`receiver_challenge` text,
	`claim_id` text UNIQUE,
	`approval` text DEFAULT 'none' NOT NULL,
	`source_sign_in_id` text,
	`device` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	CONSTRAINT `fk_identity_one_time_code_account_id_identity_user_id_fk` FOREIGN KEY (`account_id`) REFERENCES `identity_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `identity_session` (
	`id` text PRIMARY KEY,
	`token` text NOT NULL UNIQUE,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`device_kind` text NOT NULL,
	`device_name` text,
	`device_id` text,
	`platform` text,
	`last_seen_at` integer,
	`fixed_expiry` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_identity_session_user_id_identity_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `identity_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `identity_user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identity_verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `identity_account_user_idx` ON `identity_account` (`user_id`);--> statement-breakpoint
CREATE INDEX `identity_account_provider_idx` ON `identity_account` (`provider_id`);--> statement-breakpoint
CREATE INDEX `identity_one_time_code_expires_idx` ON `identity_one_time_code` (`expires_at`);--> statement-breakpoint
CREATE INDEX `identity_one_time_code_challenge_idx` ON `identity_one_time_code` (`receiver_challenge`);--> statement-breakpoint
CREATE INDEX `identity_one_time_code_account_idx` ON `identity_one_time_code` (`account_id`);--> statement-breakpoint
CREATE INDEX `identity_session_user_idx` ON `identity_session` (`user_id`);--> statement-breakpoint
CREATE INDEX `identity_verification_identifier_idx` ON `identity_verification` (`identifier`);