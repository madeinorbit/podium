CREATE TABLE `grant_audiences` (
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`grantee` text NOT NULL,
	CONSTRAINT `grant_audiences_pk` PRIMARY KEY(`resource_kind`, `resource_id`, `grantee`)
);
--> statement-breakpoint
-- Existing live edges seed the durable history. Already revoked pre-upgrade
-- readers existed only in process memory and cannot be recovered after restart.
INSERT OR IGNORE INTO grant_audiences (resource_kind, resource_id, grantee)
SELECT resource_kind, resource_id, grantee FROM grants;
