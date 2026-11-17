-- THE NOTICE INBOX (POD-6881; credential management spec §13).
--
-- `notices`: one row per notice, for one person. At most one OPEN notice per
-- (recipient, dedupe key), enforced by a partial unique index; resolving sets
-- `resolved_at` and the next emit opens a new row. Open rows stream to their
-- recipient as the per-user record `inboxNotice`.
--
-- `issue_comments.mentions`: the member ids a comment mentions, stored when
-- it is written or edited. NULL on comments written before this migration.
--
-- EXPAND-ONLY: a new table and a nullable column. ROLLBACK: an older build
-- ignores both; drop the table and the column to remove them.
--
CREATE TABLE `notices` (
	`id` text PRIMARY KEY,
	`recipient_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_anchor` text,
	`title` text NOT NULL,
	`body` text,
	`dedupe_key` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text,
	`resolved_at` text
);
--> statement-breakpoint
ALTER TABLE `issue_comments` ADD `mentions` text;--> statement-breakpoint
CREATE UNIQUE INDEX `notices_open_dedupe` ON `notices` (`recipient_user_id`,`dedupe_key`) WHERE "notices"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_notices_dedupe_key` ON `notices` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_notices_recipient_open` ON `notices` (`recipient_user_id`,`resolved_at`,`created_at`,`id`);--> statement-breakpoint
-- Invalidate the notice records (POD-6920's generation rule for a synced table).
INSERT INTO `sync_kind` (`tenant_id`, `kind`, `generation`) VALUES
  ('local', 'inboxNotice', 1)
ON CONFLICT (`tenant_id`, `kind`) DO UPDATE SET `generation` = `sync_kind`.`generation` + 1;
