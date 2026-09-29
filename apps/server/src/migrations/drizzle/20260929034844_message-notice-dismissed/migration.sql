-- POD-4764: a person's chat message that failed, expired or was lost track of
-- stays on every device's feed until its sender dismisses it. Expand-only: one
-- nullable stamp and a partial index for the feed's boot read.
ALTER TABLE `messages` ADD `notice_dismissed_at` text;--> statement-breakpoint
-- Failures from before this release were already shown (or not) by the old
-- chat; they are history, not new notices. Stamped so an upgrade does not
-- raise every old failure at once.
UPDATE `messages` SET `notice_dismissed_at` = COALESCE(`dead_lettered_at`, `created_at`) WHERE `from_kind` = 'operator' AND `delivery_status` IN ('failed', 'expired');--> statement-breakpoint
CREATE INDEX `idx_messages_open_chat` ON `messages` (`created_at`) WHERE "messages"."from_kind" = 'operator' AND "messages"."to_kind" = 'session' AND "messages"."notice_dismissed_at" IS NULL AND "messages"."delivery_status" NOT IN ('confirmed', 'cancelled');
