-- POD-4774: the message record names the entry in the agent's own history it
-- became, as the agent's machine reported it on delivery. Expand-only: two
-- nullable columns, no backfill (older rows stay unnamed, which is the truth).
ALTER TABLE `messages` ADD `transcript_item_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `transcript_item_cursor` text;
