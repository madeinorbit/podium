-- PERSONAL TASK RECORDS (POD-6290; docs/design/multi-user-instance.md §2.2,
-- §4.4).
--
-- A member's sidebar is built from the tasks they started or joined plus a
-- removable "assigned to you by X" row, never from everything they can read.
-- Both live on the member's own `issue_user_state` row, beside their read, tuck
-- and pin markers: `joined_at`/`joined_via` ('start' | 'agent' | 'join') record
-- the first time and way they came to the task, `assigned_at`/`assigned_by` the
-- assignment row. The same start and join records define the task's
-- collaborators. None of them grants access.
--
-- BACKFILL. Rows written before this release carry no record, so an upgraded
-- instance would start with empty personal sets. Each existing task's assignee
-- (`owner_user_id`) and its human creator (`created_by_on_behalf_of`), where
-- either names a member, get a 'start' record dated the task's creation; so
-- does each member who owns a session on the task, dated that session's
-- creation, so collaborators match the work already done. On a one-member
-- instance that member owns and created every task, so their set holds every
-- task they had before. A record already present is kept, so a rerun writes
-- nothing new.
--
-- Expand-only: four nullable columns and new rows in an existing table.
-- Nothing is dropped, renamed or rebuilt; an older binary ignores the columns.
ALTER TABLE `issue_user_state` ADD `joined_at` text;--> statement-breakpoint
ALTER TABLE `issue_user_state` ADD `joined_via` text;--> statement-breakpoint
ALTER TABLE `issue_user_state` ADD `assigned_at` text;--> statement-breakpoint
ALTER TABLE `issue_user_state` ADD `assigned_by` text;--> statement-breakpoint
INSERT INTO `issue_user_state` (`user_id`, `issue_id`, `joined_at`, `joined_via`)
SELECT `owner_user_id`, `id`, `created_at`, 'start' FROM `issues`
WHERE `owner_user_id` IN (SELECT `id` FROM `users`)
ON CONFLICT (`user_id`, `issue_id`) DO UPDATE
SET `joined_at` = COALESCE(`issue_user_state`.`joined_at`, excluded.`joined_at`),
    `joined_via` = COALESCE(`issue_user_state`.`joined_via`, excluded.`joined_via`);
--> statement-breakpoint
INSERT INTO `issue_user_state` (`user_id`, `issue_id`, `joined_at`, `joined_via`)
SELECT `created_by_on_behalf_of`, `id`, `created_at`, 'start' FROM `issues`
WHERE `created_by_on_behalf_of` IN (SELECT `id` FROM `users`)
ON CONFLICT (`user_id`, `issue_id`) DO UPDATE
SET `joined_at` = COALESCE(`issue_user_state`.`joined_at`, excluded.`joined_at`),
    `joined_via` = COALESCE(`issue_user_state`.`joined_via`, excluded.`joined_via`);
--> statement-breakpoint
INSERT INTO `issue_user_state` (`user_id`, `issue_id`, `joined_at`, `joined_via`)
SELECT `owner_user_id`, `issue_id`, MIN(`created_at`), 'start' FROM `sessions`
WHERE `issue_id` IN (SELECT `id` FROM `issues`)
  AND `owner_user_id` IN (SELECT `id` FROM `users`)
GROUP BY `owner_user_id`, `issue_id`
ON CONFLICT (`user_id`, `issue_id`) DO UPDATE
SET `joined_at` = COALESCE(`issue_user_state`.`joined_at`, excluded.`joined_at`),
    `joined_via` = COALESCE(`issue_user_state`.`joined_via`, excluded.`joined_via`);
