-- POD-6775: preserving infrastructure re-key, authorized by POD-6253.
-- Capture the high-water mark before dropping the AUTOINCREMENT table.
CREATE TABLE `sync_feed` (
  `tenant_id` text PRIMARY KEY,
  `feed_id` text NOT NULL,
  `epoch` text NOT NULL,
  `minted_at` integer NOT NULL,
  `head_seq` integer NOT NULL,
  `floor_seq` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `sync_feed` (tenant_id, feed_id, epoch, minted_at, head_seq, floor_seq)
SELECT 'local',
  coalesce((SELECT feed_id FROM feed_identity WHERE singleton = 1), 'feed-' || lower(hex(randomblob(16)))),
  coalesce((SELECT epoch FROM feed_identity WHERE singleton = 1), 'epoch-' || lower(hex(randomblob(16)))),
  coalesce((SELECT minted_at FROM feed_identity WHERE singleton = 1), 0),
  coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0),
  coalesce((SELECT min(seq) FROM changes), coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0) + 1);
--> statement-breakpoint
CREATE TABLE `__new_changes` (
  `tenant_id` text NOT NULL,
  `seq` integer NOT NULL,
  `entity` text NOT NULL,
  `entity_id` text NOT NULL,
  `op` text NOT NULL,
  `payload` text,
  `event_time` integer NOT NULL,
  `origin_id` text,
  `causation_id` text,
  `mutation_id` text,
  CONSTRAINT `changes_pk` PRIMARY KEY(`tenant_id`, `seq`)
);
--> statement-breakpoint
INSERT INTO `__new_changes` SELECT 'local', seq, entity, entity_id, op, payload, event_time, origin_id, causation_id, mutation_id FROM changes ORDER BY seq;
--> statement-breakpoint
DROP TABLE `changes`;
--> statement-breakpoint
ALTER TABLE `__new_changes` RENAME TO `changes`;
--> statement-breakpoint
CREATE INDEX `changes_entity` ON `changes` (`tenant_id`,`entity`,`entity_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `changes_event_time` ON `changes` (`tenant_id`,`event_time`);
--> statement-breakpoint
CREATE TABLE `__new_sync_kind` (
  `tenant_id` text NOT NULL,
  `kind` text NOT NULL,
  `generation` integer NOT NULL,
  CONSTRAINT `sync_kind_pk` PRIMARY KEY(`tenant_id`, `kind`)
);
--> statement-breakpoint
INSERT INTO `__new_sync_kind` SELECT 'local', kind, generation FROM sync_kind;
--> statement-breakpoint
DROP TABLE `sync_kind`;
--> statement-breakpoint
ALTER TABLE `__new_sync_kind` RENAME TO `sync_kind`;
-- No model row or wire shape changes: all per-kind generations are preserved.
