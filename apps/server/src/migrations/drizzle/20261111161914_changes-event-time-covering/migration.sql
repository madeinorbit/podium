-- Retention reads the tenant's age range without loading change payloads.
-- The composite primary key does not make seq an implicit index column.
DROP INDEX `changes_event_time`;
--> statement-breakpoint
CREATE INDEX `changes_event_time` ON `changes` (`tenant_id`,`event_time`,`seq`);
