ALTER TABLE `issues` DROP COLUMN `color`;
--> statement-breakpoint
-- Rebootstrap clients so cached task payloads no longer carry the retired field.
UPDATE `feed_identity`
SET `epoch` = 'remove-task-colors-' || lower(hex(randomblob(16)))
WHERE `singleton` = 1;
