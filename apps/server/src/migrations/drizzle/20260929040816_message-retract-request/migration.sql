-- POD-4776: a retract is a request the agent's machine answers. Expand-only:
-- two nullable stamps, no backfill. `messages.retract_requested_at` says the
-- sender asked (beside the delivery status it reads "cancelled" or "too late");
-- `queued_messages.retract_requested_at` is a retract still waiting to reach
-- the daemon that holds the row.
ALTER TABLE `messages` ADD `retract_requested_at` text;--> statement-breakpoint
ALTER TABLE `queued_messages` ADD `retract_requested_at` integer;