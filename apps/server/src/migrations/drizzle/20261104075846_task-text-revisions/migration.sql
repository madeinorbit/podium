CREATE TABLE `issue_text_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`issue_id` text NOT NULL,
	`field` text NOT NULL,
	`body` text NOT NULL,
	`source` text NOT NULL,
	`restored_from` integer,
	`issue_revision` integer,
	`actor` text,
	`on_behalf_of` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_issue_text_revisions_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE,
	CONSTRAINT "issue_text_revisions_field" CHECK(field IN ('description', 'brief')),
	CONSTRAINT "issue_text_revisions_source" CHECK(source IN ('create', 'baseline', 'edit', 'restore'))
);
--> statement-breakpoint
ALTER TABLE `issue_comments` ADD `edited_at` text;--> statement-breakpoint
ALTER TABLE `issue_comments` ADD `edited_by` text;--> statement-breakpoint
ALTER TABLE `issue_comments` ADD `edited_on_behalf_of` text;--> statement-breakpoint
CREATE INDEX `idx_issue_text_revisions_issue_field` ON `issue_text_revisions` (`issue_id`,`field`,`id`);