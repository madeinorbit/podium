-- CREDENTIAL MANAGEMENT (POD-6857; credential management design §4, §7, §8, §13).
--
-- `credentials` and `credential_secrets`: a member's provider credentials, the secret sealed
-- by the vault under the workspace's data key (`vault_key`, one row per workspace, wrapped by
-- the installation's outside key file). `credential_placements` and `credential_machines`:
-- what Podium put on a machine for a credential, and the machines its owner allowed.
-- `notices`: one row per notice, for one person; open rows stream to their recipient as the
-- per-user record `inboxNotice`. `issue_comments.mentions`: the member ids a comment mentions.
-- `sessions.credential_id`, `effective_auth`, `credential_mismatch`: what a session runs on.
--
-- Every new table is a workspace table: its keys lead with `workspace_id` (POD-6959).
-- EXPAND-ONLY: new tables and nullable columns. ROLLBACK: an older build ignores them.
--
CREATE TABLE `credential_machines` (
	`credential_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`allowed_by` text NOT NULL,
	`created_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	CONSTRAINT `credential_machines_pk` PRIMARY KEY(`workspace_id`, `credential_id`, `machine_id`),
	CONSTRAINT `fk_credential_machines_credential_id_credentials_id_fk` FOREIGN KEY (`workspace_id`,`credential_id`) REFERENCES `credentials`(`workspace_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `credential_placements` (
	`credential_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`kind` text NOT NULL,
	`home_id` text,
	`state` text DEFAULT 'present' NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	`workspace_id` text NOT NULL,
	CONSTRAINT `credential_placements_pk` PRIMARY KEY(`workspace_id`, `credential_id`, `machine_id`, `kind`),
	CONSTRAINT `fk_credential_placements_credential_id_credentials_id_fk` FOREIGN KEY (`workspace_id`,`credential_id`) REFERENCES `credentials`(`workspace_id`,`id`) ON DELETE CASCADE,
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
	`workspace_id` text NOT NULL,
	CONSTRAINT `credential_secrets_pk` PRIMARY KEY(`workspace_id`, `credential_id`, `version`),
	CONSTRAINT `fk_credential_secrets_credential_id_credentials_id_fk` FOREIGN KEY (`workspace_id`,`credential_id`) REFERENCES `credentials`(`workspace_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`identity` text DEFAULT '{}' NOT NULL,
	`identity_fingerprint` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`status_reason` text,
	`expires_at` text,
	`verified_at` text,
	`limit_reached_until` text,
	`legacy_id` text,
	`legacy_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	CONSTRAINT `credentials_pk` PRIMARY KEY(`workspace_id`, `id`),
	CONSTRAINT "credentials_status" CHECK(status IN ('ok', 'attention', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE `notices` (
	`id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_anchor` text,
	`title` text NOT NULL,
	`body` text,
	`dedupe_key` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text,
	`resolved_at` text,
	`workspace_id` text NOT NULL,
	CONSTRAINT `notices_pk` PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `vault_key` (
	`id` integer NOT NULL,
	`key_id` text NOT NULL,
	`wrapped_data_key` text NOT NULL,
	`created_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	CONSTRAINT `vault_key_pk` PRIMARY KEY(`workspace_id`, `id`),
	CONSTRAINT "vault_key_one_row" CHECK(id = 1)
);
--> statement-breakpoint
ALTER TABLE `issue_comments` ADD `mentions` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `credential_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `effective_auth` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `credential_mismatch` text;--> statement-breakpoint
CREATE INDEX `idx_credential_placements_pending` ON `credential_placements` (`workspace_id`,`machine_id`,`credential_id`,`kind`) WHERE "credential_placements"."state" = 'removal-pending';--> statement-breakpoint
CREATE INDEX `idx_credentials_owner` ON `credentials` (`workspace_id`,`owner_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_credentials_identity` ON `credentials` (`workspace_id`,`owner_user_id`,`type`,`identity_fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_legacy_id` ON `credentials` (`workspace_id`,`legacy_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_owner_legacy_key` ON `credentials` (`workspace_id`,`owner_user_id`,`legacy_key`);--> statement-breakpoint
CREATE INDEX `idx_credentials_expiry` ON `credentials` (`workspace_id`,`expires_at`) WHERE "credentials"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notices_open_dedupe` ON `notices` (`workspace_id`,`recipient_user_id`,`dedupe_key`) WHERE "notices"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_notices_dedupe_key` ON `notices` (`workspace_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_notices_open` ON `notices` (`workspace_id`,`resolved_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_notices_recipient_open` ON `notices` (`workspace_id`,`recipient_user_id`,`resolved_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_credential` ON `sessions` (`workspace_id`,`credential_id`) WHERE "sessions"."credential_id" IS NOT NULL AND "sessions"."deleted_at" IS NULL;--> statement-breakpoint
-- Invalidate every record derived from the changed session rows, and the notice records,
-- in every workspace that has a feed (POD-6920's generation rule, keyed per workspace).
INSERT INTO `sync_kind` (`workspace_id`, `kind`, `generation`)
SELECT feed.`workspace_id`, bumped.`kind`, 1
FROM `sync_feed` AS feed, (SELECT 'session' AS kind UNION ALL SELECT 'sessionUserState' UNION ALL SELECT 'message' UNION ALL SELECT 'inboxNotice') AS bumped
WHERE true
ON CONFLICT (`workspace_id`, `kind`) DO UPDATE SET `generation` = `sync_kind`.`generation` + 1;
