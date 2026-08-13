CREATE TABLE `root_integration_receipts` (
	`root_issue_id` text NOT NULL,
	`approved_head_sha` text NOT NULL,
	`descendants` text DEFAULT '[]' NOT NULL,
	CONSTRAINT `root_integration_receipts_pk` PRIMARY KEY(`root_issue_id`, `approved_head_sha`),
	CONSTRAINT `fk_root_integration_receipts_root_issue_id_issues_id_fk` FOREIGN KEY (`root_issue_id`) REFERENCES `issues`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER `root_integration_receipts_update_immutable`
BEFORE UPDATE ON `root_integration_receipts`
BEGIN
  SELECT RAISE(ABORT, 'root integration receipt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `root_integration_receipts_delete_immutable`
BEFORE DELETE ON `root_integration_receipts`
BEGIN
  SELECT RAISE(ABORT, 'root integration receipt is immutable');
END;
