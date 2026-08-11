ALTER TABLE `machines` ADD `update_channel_override` text;
--> statement-breakpoint
-- POD-1882 backfill. EVERY existing value carries over verbatim, including
-- 'stable'. A row's stored channel is the last authority decision this install
-- has on record, and an upgrade is not entitled to reinterpret one of those
-- values as "never chosen" — silently converting 'stable' into inherit would
-- move machines onto a non-stable fleet default without anyone choosing it.
-- Clearing a pin is therefore an explicit act in Settings → Machines ("Fleet
-- default"), never something the migration does on the operator's behalf.
UPDATE `machines` SET `update_channel_override` = `update_channel`;
