DROP INDEX IF EXISTS `idx_subscriptions_subscriber`;--> statement-breakpoint
CREATE INDEX `idx_subscriptions_subscriber_event` ON `subscriptions` (`subscriber_id`,`source_kind`,`event`);--> statement-breakpoint
CREATE INDEX `idx_subscriptions_match` ON `subscriptions` (`event`,`source_kind`,`source_ref`);--> statement-breakpoint
CREATE INDEX `idx_subscriptions_created` ON `subscriptions` (`created_at`,`id`);