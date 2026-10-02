ALTER TABLE `issues` ADD `human_question_attribution` text;
--> statement-breakpoint
-- The domain issue row and its personal state remain authoritative. These are
-- only the retired replication payloads, including their retained history.
DELETE FROM `change_latest` WHERE `entity` = 'issue';
--> statement-breakpoint
DELETE FROM `changes` WHERE `entity` = 'issue';
--> statement-breakpoint
-- Removing a retained tail may lower MAX(seq). A fresh epoch makes every old
-- cursor rebootstrap from normalized truth instead of claiming that old range.
UPDATE `feed_identity`
SET `epoch` = 'issue-record-retired-' || lower(hex(randomblob(16)))
WHERE `singleton` = 1;
