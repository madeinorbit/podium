-- POD-4885: the delivery status gains `accepted` (the agent program took the
-- message but it is not yet in its history), and the row gains `delivery_held`
-- (how the program holds it: `memory` or `durable`).
--
-- SQLite cannot widen a CHECK in place, so this rebuilds the table, the same
-- way POD-4787 did. Nothing is lost or reworded: every column is copied as it
-- is, the delivery-status CHECK only admits one more value, the new column is
-- nullable with no backfill (no older row was ever accepted), and every index
-- is recreated as it was. An older binary never opens the result: a database
-- newer than the code is refused (apps/daemon/src/convergence.ts).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`in_reply_to` text,
	`from_kind` text NOT NULL,
	`from_session` text,
	`from_issue` text,
	`actor_kind` text,
	`actor_id` text,
	`on_behalf_of` text,
	`delegation_ref` text,
	`to_kind` text NOT NULL,
	`to_id` text,
	`kind` text DEFAULT 'message' NOT NULL,
	`urgency` text DEFAULT 'fyi' NOT NULL,
	`lifecycle` text DEFAULT 'wait' NOT NULL,
	`body` text NOT NULL,
	`attachments_json` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	`delivery_status` text DEFAULT 'stored' NOT NULL,
	`delivery_held` text,
	`delivered_at` text,
	`delivered_to` text,
	`acked_by` text,
	`hop` integer DEFAULT 0 NOT NULL,
	`clamped_from` text,
	`reminded_at` text,
	`from_name` text,
	`read_at` text,
	`injected_at` text,
	`delivery_deferred_at` text,
	`delivery_deferred_reason` text,
	`dead_lettered_at` text,
	`expects_response` integer DEFAULT 0 NOT NULL,
	`fact_key` text,
	`fact_target` text,
	`transcript_item_id` text,
	`transcript_item_cursor` text,
	`harness_ref_json` text,
	`notice_dismissed_at` text,
	`retract_requested_at` text,
	CONSTRAINT "messages_check_5" CHECK(from_kind IN ('operator','superagent','agent','system')),
	CONSTRAINT "messages_check_6" CHECK(to_kind IN ('issue','session','operator')),
	CONSTRAINT "messages_check_7" CHECK(kind IN ('message','ack','notification','question')),
	CONSTRAINT "messages_check_8" CHECK(urgency IN ('fyi','next-turn','interrupt')),
	CONSTRAINT "messages_check_9" CHECK(lifecycle IN ('wait','wake')),
	CONSTRAINT "messages_delivery_status" CHECK(delivery_status IN ('stored','dispatched','reached-machine','typing','typed','accepted','confirmed','cancelled','failed','expired','unknown')),
	CONSTRAINT "messages_delivery_held" CHECK(delivery_held IN ('memory','durable'))
);
--> statement-breakpoint
INSERT INTO `__new_messages`(`id`, `thread_id`, `in_reply_to`, `from_kind`, `from_session`, `from_issue`, `actor_kind`, `actor_id`, `on_behalf_of`, `delegation_ref`, `to_kind`, `to_id`, `kind`, `urgency`, `lifecycle`, `body`, `attachments_json`, `expires_at`, `created_at`, `delivery_status`, `delivered_at`, `delivered_to`, `acked_by`, `hop`, `clamped_from`, `reminded_at`, `from_name`, `read_at`, `injected_at`, `delivery_deferred_at`, `delivery_deferred_reason`, `dead_lettered_at`, `expects_response`, `fact_key`, `fact_target`, `transcript_item_id`, `transcript_item_cursor`, `harness_ref_json`, `notice_dismissed_at`, `retract_requested_at`) SELECT `id`, `thread_id`, `in_reply_to`, `from_kind`, `from_session`, `from_issue`, `actor_kind`, `actor_id`, `on_behalf_of`, `delegation_ref`, `to_kind`, `to_id`, `kind`, `urgency`, `lifecycle`, `body`, `attachments_json`, `expires_at`, `created_at`, `delivery_status`, `delivered_at`, `delivered_to`, `acked_by`, `hop`, `clamped_from`, `reminded_at`, `from_name`, `read_at`, `injected_at`, `delivery_deferred_at`, `delivery_deferred_reason`, `dead_lettered_at`, `expects_response`, `fact_key`, `fact_target`, `transcript_item_id`, `transcript_item_cursor`, `harness_ref_json`, `notice_dismissed_at`, `retract_requested_at` FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_messages_delivered_to` ON `messages` (`delivered_to`);--> statement-breakpoint
CREATE INDEX `idx_messages_open_chat` ON `messages` (`created_at`) WHERE "messages"."from_kind" = 'operator' AND "messages"."to_kind" = 'session' AND "messages"."notice_dismissed_at" IS NULL AND "messages"."delivery_status" NOT IN ('confirmed', 'cancelled');--> statement-breakpoint
CREATE INDEX `idx_messages_from_session` ON `messages` (`from_session`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_recipient_delivery` ON `messages` (`to_kind`,`to_id`,`delivery_status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_delivery_order` ON `messages` (`delivery_status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_delivery_expiry_explicit` ON `messages` (`delivery_status`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_delivery_expiry_implicit` ON `messages` (`delivery_status`,`lifecycle`,`expires_at`,`created_at`,`id`);