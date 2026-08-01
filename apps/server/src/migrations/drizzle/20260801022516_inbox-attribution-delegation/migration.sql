ALTER TABLE `messages` ADD `actor_kind` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `actor_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `on_behalf_of` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `delegation_ref` text;--> statement-breakpoint
ALTER TABLE `queued_messages` ADD `principal_kind` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `queued_messages` ADD `principal_ref` text DEFAULT 'legacy-session-inbox' NOT NULL;--> statement-breakpoint
ALTER TABLE `queued_messages` ADD `delegation_ref` text;--> statement-breakpoint
ALTER TABLE `queued_messages` ADD `actor_kind` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `queued_messages` ADD `actor_id` text DEFAULT 'legacy-session-inbox' NOT NULL;--> statement-breakpoint
ALTER TABLE `queued_messages` ADD `on_behalf_of` text;--> statement-breakpoint
ALTER TABLE `queued_messages` ADD `source_message_id` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_queued_messages` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`text` text NOT NULL,
	`queued_at` integer NOT NULL,
	`input_origin` text DEFAULT 'unknown' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`principal_kind` text DEFAULT 'system' NOT NULL,
	`principal_ref` text DEFAULT 'legacy-session-inbox' NOT NULL,
	`delegation_ref` text,
	`actor_kind` text DEFAULT 'system' NOT NULL,
	`actor_id` text DEFAULT 'legacy-session-inbox' NOT NULL,
	`on_behalf_of` text,
	`source_message_id` text,
	CONSTRAINT "queued_messages_principal_kind" CHECK(principal_kind IN ('user','agent','system')),
	CONSTRAINT "queued_messages_actor_kind" CHECK(actor_kind IN ('user','agent','system'))
);
--> statement-breakpoint
INSERT INTO `__new_queued_messages`(`id`, `session_id`, `text`, `queued_at`, `input_origin`, `attempts`) SELECT `id`, `session_id`, `text`, `queued_at`, `input_origin`, `attempts` FROM `queued_messages`;--> statement-breakpoint
DROP TABLE `queued_messages`;--> statement-breakpoint
ALTER TABLE `__new_queued_messages` RENAME TO `queued_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `queued_messages_session` ON `queued_messages` (`session_id`,`queued_at`);