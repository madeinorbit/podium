-- POD-6101 (flight deck v6, D8). Issues keep three text fields: description for
-- humans, brief for agents, and acceptance. The rarely used `design` and `notes`
-- fields fold into `brief`, each under its own heading, and are dropped.
-- Blank values carry nothing and are skipped. `activity_notes` is the state panel
-- and is not touched. A changed row takes a new revision, like any other write.
UPDATE `issues` SET
  `brief` =
    CASE WHEN `brief` IS NULL OR trim(`brief`) = '' THEN '' ELSE `brief` || char(10) || char(10) END
    || '## Design' || char(10) || char(10) || `design`,
  `revision` = `revision` + 1
WHERE `design` IS NOT NULL AND trim(`design`) <> '';
--> statement-breakpoint
UPDATE `issues` SET
  `brief` =
    CASE WHEN `brief` IS NULL OR trim(`brief`) = '' THEN '' ELSE `brief` || char(10) || char(10) END
    || '## Notes' || char(10) || char(10) || `notes`,
  `revision` = `revision` + 1
WHERE `notes` IS NOT NULL AND trim(`notes`) <> '';
--> statement-breakpoint
ALTER TABLE `issues` DROP COLUMN `design`;
--> statement-breakpoint
ALTER TABLE `issues` DROP COLUMN `notes`;
--> statement-breakpoint
-- Cached issue payloads still carry the old fields and the old brief. A fresh
-- epoch makes every old cursor rebootstrap from the migrated rows.
UPDATE `feed_identity`
SET `epoch` = 'fold-design-notes-into-brief-' || lower(hex(randomblob(16)))
WHERE `singleton` = 1;
