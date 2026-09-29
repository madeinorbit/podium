-- POD-4795: interrupt and file sends ride the durable queue. Expand-only: the
-- delivery mode (existing rows are when-ready, which is what they always were)
-- and the staged file refs a row carries to the daemon.
ALTER TABLE `queued_messages` ADD `delivery` text DEFAULT 'when-ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `queued_messages` ADD `attachments_json` text;