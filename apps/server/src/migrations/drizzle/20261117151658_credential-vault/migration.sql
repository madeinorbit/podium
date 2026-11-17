CREATE TABLE `credential_machines` (
	`credential_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`allowed_by` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `credential_machines_pk` PRIMARY KEY(`credential_id`, `machine_id`),
	CONSTRAINT `fk_credential_machines_credential_id_credentials_id_fk` FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `credential_placements` (
	`credential_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'present' NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	CONSTRAINT `credential_placements_pk` PRIMARY KEY(`credential_id`, `machine_id`, `kind`),
	CONSTRAINT `fk_credential_placements_credential_id_credentials_id_fk` FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON DELETE CASCADE,
	CONSTRAINT "credential_placements_kind" CHECK(kind IN ('home', 'propagated-file')),
	CONSTRAINT "credential_placements_state" CHECK(state IN ('present', 'removal-pending', 'removed'))
);
--> statement-breakpoint
CREATE TABLE `credential_secrets` (
	`credential_id` text NOT NULL,
	`version` integer NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`key_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `credential_secrets_pk` PRIMARY KEY(`credential_id`, `version`),
	CONSTRAINT `fk_credential_secrets_credential_id_credentials_id_fk` FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`identity` text DEFAULT '{}' NOT NULL,
	`identity_fingerprint` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`status_reason` text,
	`expires_at` text,
	`verified_at` text,
	`legacy_id` text,
	`legacy_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "credentials_status" CHECK(status IN ('ok', 'attention', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE `vault_key` (
	`id` integer PRIMARY KEY,
	`key_id` text NOT NULL,
	`wrapped_data_key` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "vault_key_one_row" CHECK(id = 1)
);
--> statement-breakpoint
CREATE INDEX `idx_credentials_owner` ON `credentials` (`owner_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_credentials_identity` ON `credentials` (`owner_user_id`,`type`,`identity_fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_legacy_id` ON `credentials` (`legacy_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_owner_legacy_key` ON `credentials` (`owner_user_id`,`legacy_key`);