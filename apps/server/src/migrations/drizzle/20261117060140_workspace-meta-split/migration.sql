-- POD-7013 (POD-6959 design 2.1): meta and server_secrets each hold one class of key. The keys
-- that belong to a workspace move to the new workspace_meta and workspace_secrets, under the one
-- workspace of a self-hosted install, 'local', and leave the install tables. The lists are
-- WORKSPACE_META_KEYS and WORKSPACE_SECRET_KEYS in store/workspace-manifest.ts, spelled out here
-- because a migration is frozen history; migrations/workspace-meta-split.test.ts ties the two.
-- Any other key, an install key or one this build does not know, stays where it is.
CREATE TABLE `workspace_meta` (
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `workspace_meta_pk` PRIMARY KEY(`workspace_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `workspace_secrets` (
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `workspace_secrets_pk` PRIMARY KEY(`workspace_id`, `key`)
);

--> statement-breakpoint
INSERT INTO `workspace_meta` (`workspace_id`, `key`, `value`)
SELECT 'local', `key`, `value` FROM `meta`
WHERE `key` IN ('settings', 'model_catalog', 'identity.appliedMembershipVersion',
    'signInCarryOver.endsAt', 'retired_solo_member_id', 'legacy_mutation_receipt_cutoff',
    'upstream_sync_cursor', 'upstream_sessions', 'upstream_conversations', 'upstream_issues')
  OR `key` GLOB 'model_catalog:*' OR `key` GLOB 'setup_enrollment:*' OR `key` GLOB 'data_migration:*';
--> statement-breakpoint
DELETE FROM `meta`
WHERE `key` IN ('settings', 'model_catalog', 'identity.appliedMembershipVersion',
    'signInCarryOver.endsAt', 'retired_solo_member_id', 'legacy_mutation_receipt_cutoff',
    'upstream_sync_cursor', 'upstream_sessions', 'upstream_conversations', 'upstream_issues')
  OR `key` GLOB 'model_catalog:*' OR `key` GLOB 'setup_enrollment:*' OR `key` GLOB 'data_migration:*';
--> statement-breakpoint
INSERT INTO `workspace_secrets` (`workspace_id`, `key`, `value`, `updated_at`)
SELECT 'local', `key`, `value`, `updated_at` FROM `server_secrets`
WHERE `key` IN ('apiKeys.openrouter', 'apiKeys.anthropic', 'apiKeys.openai',
    'integrations.linearApiKey', 'notifications.telegramBotToken', 'settings.fingerprintKey')
  OR `key` GLOB 'native-login-transfer:*';
--> statement-breakpoint
DELETE FROM `server_secrets`
WHERE `key` IN ('apiKeys.openrouter', 'apiKeys.anthropic', 'apiKeys.openai',
    'integrations.linearApiKey', 'notifications.telegramBotToken', 'settings.fingerprintKey')
  OR `key` GLOB 'native-login-transfer:*';
