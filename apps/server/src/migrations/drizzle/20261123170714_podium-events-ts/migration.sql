-- POD-7435: retention's age path reads the oldest events through this index,
-- oldest first, and stops at its budget. Ids do not follow ts (a historical
-- transcript replay appends old timestamps under new ids), so the age cutoff
-- cannot ride the row cap's id range.
CREATE INDEX `idx_podium_events_ts` ON `podium_events` (`workspace_id`,`ts`,`id`);
