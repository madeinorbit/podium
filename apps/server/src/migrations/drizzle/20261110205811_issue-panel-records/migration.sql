CREATE TABLE `issue_panel_artifacts` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`position` integer NOT NULL,
	`path` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `fk_issue_panel_artifacts_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `issue_panel_deferred` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`added_at` text NOT NULL,
	CONSTRAINT `fk_issue_panel_deferred_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `issue_panel_states` (
	`id` text PRIMARY KEY,
	`text` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_issue_panel_states_id_issues_id_fk` FOREIGN KEY (`id`) REFERENCES `issues`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `issue_panel_todos` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`done` integer NOT NULL,
	CONSTRAINT `fk_issue_panel_todos_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_issue_panel_artifacts_order` ON `issue_panel_artifacts` (`issue_id`,`position`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_issue_panel_artifacts_path` ON `issue_panel_artifacts` (`issue_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_issue_panel_deferred_order` ON `issue_panel_deferred` (`issue_id`,`position`,`id`);--> statement-breakpoint
CREATE INDEX `idx_issue_panel_todos_order` ON `issue_panel_todos` (`issue_id`,`position`,`id`);--> statement-breakpoint
-- Backfill before contracting the issue row. The runner wraps every statement
-- in this migration in one transaction. Reject malformed nonempty input instead
-- of dropping data that the former tolerant panel decoder could not read.
CREATE TABLE `__panel_migration_validation` (`ok` integer CONSTRAINT `panel_data_must_be_valid_before_column_drop` CHECK (`ok` = 1));
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues
WHERE panel IS NOT NULL AND CASE WHEN json_valid(panel) THEN json_type(panel) <> 'object' ELSE 1 END;
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues WHERE panel IS NOT NULL AND json_type(panel, '$.todos') IS NOT NULL AND json_type(panel, '$.todos') <> 'array';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues WHERE panel IS NOT NULL AND json_type(panel, '$.artifacts') IS NOT NULL AND json_type(panel, '$.artifacts') <> 'array';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues WHERE panel IS NOT NULL AND json_type(panel, '$.deferred') IS NOT NULL AND json_type(panel, '$.deferred') <> 'array';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.todos') j WHERE CASE WHEN j.type = 'object' THEN (json_type(j.value, '$.text') IS NOT 'text' OR json_type(j.value, '$.done') NOT IN ('true','false') OR json_type(j.value, '$.done') IS NULL) ELSE 1 END;
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE CASE WHEN j.type = 'object' THEN (json_type(j.value, '$.path') IS NOT 'text' OR json_type(j.value, '$.addedAt') IS NOT 'text') ELSE 1 END;
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.deferred') j WHERE CASE WHEN j.type = 'object' THEN (json_type(j.value, '$.text') IS NOT 'text' OR json_type(j.value, '$.addedAt') IS NOT 'text') ELSE 1 END;
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.title') IS NOT NULL AND json_type(j.value, '$.title') <> 'text';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.sourceKind') IS NOT NULL AND json_type(j.value, '$.sourceKind') <> 'text';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.chatUploadId') IS NOT NULL AND json_type(j.value, '$.chatUploadId') <> 'text';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.chatUploadOwner') IS NOT NULL AND json_type(j.value, '$.chatUploadOwner') <> 'text';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.artifactId') IS NOT NULL AND json_type(j.value, '$.artifactId') <> 'text';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.entry') IS NOT NULL AND json_type(j.value, '$.entry') <> 'text';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.tracking') IS NOT NULL AND json_type(j.value, '$.tracking') <> 'text';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.files') IS NOT NULL AND json_type(j.value, '$.files') <> 'array';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.sourcePaths') IS NOT NULL AND json_type(j.value, '$.sourcePaths') <> 'array';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_type(j.value, '$.untrackedPaths') IS NOT NULL AND json_type(j.value, '$.untrackedPaths') <> 'array';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j, json_each(j.value, '$.sourcePaths') f WHERE f.type <> 'text';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j, json_each(j.value, '$.untrackedPaths') f WHERE f.type <> 'text';
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j, json_each(j.value, '$.files') f WHERE CASE WHEN f.type = 'object' THEN json_type(f.value, '$.path') IS NOT 'text' OR json_type(f.value, '$.size') IS NULL OR json_type(f.value, '$.size') NOT IN ('integer','real') ELSE 1 END;
--> statement-breakpoint
INSERT INTO `__panel_migration_validation` SELECT 0 FROM issues i, json_each(i.panel, '$.artifacts') j WHERE json_extract(j.value, '$.sourceKind') NOT IN ('terminal-evidence','creation-attachment') OR json_extract(j.value, '$.tracking') NOT IN ('tracked','untracked','unknown');
--> statement-breakpoint
INSERT INTO issue_panel_todos (id, issue_id, position, text, done)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-8' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), i.id, CAST(j.key AS INTEGER), json_extract(j.value, '$.text'), json_extract(j.value, '$.done')
FROM issues i, json_each(i.panel, '$.todos') j;
--> statement-breakpoint
INSERT INTO issue_panel_artifacts (id, issue_id, position, path, value)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-8' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), i.id, CAST(j.key AS INTEGER), json_extract(j.value, '$.path'), j.value
FROM issues i, json_each(i.panel, '$.artifacts') j;
--> statement-breakpoint
INSERT INTO issue_panel_deferred (id, issue_id, position, text, added_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-8' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), i.id, CAST(j.key AS INTEGER), json_extract(j.value, '$.text'), json_extract(j.value, '$.addedAt')
FROM issues i, json_each(i.panel, '$.deferred') j;
--> statement-breakpoint
INSERT INTO issue_panel_states (id, text, updated_at)
SELECT id, COALESCE(activity_notes, ''), COALESCE(notes_updated_at, updated_at) FROM issues WHERE activity_notes IS NOT NULL OR notes_updated_at IS NOT NULL;
--> statement-breakpoint
DROP TABLE `__panel_migration_validation`;
--> statement-breakpoint
UPDATE feed_identity SET epoch = 'issue-panel-records-' || lower(hex(randomblob(16)));
--> statement-breakpoint
ALTER TABLE `issues` DROP COLUMN `activity_notes`;--> statement-breakpoint
ALTER TABLE `issues` DROP COLUMN `notes_updated_at`;--> statement-breakpoint
ALTER TABLE `issues` DROP COLUMN `panel`;