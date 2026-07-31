CREATE TABLE `settings_audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`command` text NOT NULL,
	`outcome` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`on_behalf_of` text,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`redacted_paths` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "settings_audit_events_outcome" CHECK(outcome IN ('applied', 'refused')),
	CONSTRAINT "settings_audit_events_actor_kind" CHECK(actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "settings_audit_events_system_has_no_human" CHECK(actor_kind <> 'system' OR on_behalf_of IS NULL)
);
--> statement-breakpoint
CREATE INDEX `settings_audit_events_command` ON `settings_audit_events` (`command`,`id`);