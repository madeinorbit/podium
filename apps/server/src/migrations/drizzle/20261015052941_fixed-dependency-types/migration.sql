-- POD-6100 (decision D7, 2026-10-14): dependency types become a fixed list —
-- `blocked-by`, `related`, `discovered-from`, `supersedes`, `duplicates` — with
-- a CHECK on `issue_deps.type`. SQLite cannot add a CHECK in place, so the table
-- is rebuilt; its columns, keys and indexes are copied as they were.
--
-- The copy folds every older spelling onto the list. The stored direction does
-- not change (from = the dependent, to = what it depends on), so `blocks` reads
-- "from blocked-by to" as it is:
--   blocks, blocked-by, waits-on  -> blocked-by  (live 2026-10-14: 2281, 13, 11;
--                                    only `blocks` was ever read, so 24 edges
--                                    start to block)
--   duplicate                      -> duplicates  (16)
--   tracks, caused-by, validates   -> related     (the retired vocabulary; none
--                                    live, kept for databases this one never saw)
--   anything else                  -> dropped     (one `bogus` edge live)
-- `DISTINCT` merges an edge stored under two spellings of one type (the primary
-- key includes `type`). Replicas pick the rewrite up from the boot reconcile,
-- which diffs the whole `issueDep` kind against this table.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issue_deps` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`type` text DEFAULT 'blocked-by' NOT NULL,
	CONSTRAINT `issue_deps_pk` PRIMARY KEY(`from_id`, `to_id`, `type`),
	CONSTRAINT `fk_issue_deps_from_id_issues_id_fk` FOREIGN KEY (`from_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_issue_deps_to_id_issues_id_fk` FOREIGN KEY (`to_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE,
	CONSTRAINT "issue_deps_type" CHECK(type IN ('blocked-by', 'related', 'discovered-from', 'supersedes', 'duplicates'))
);
--> statement-breakpoint
INSERT INTO `__new_issue_deps`(`from_id`, `to_id`, `type`)
SELECT DISTINCT `from_id`, `to_id`, `folded` FROM (
	SELECT `from_id`, `to_id`, CASE `type`
		WHEN 'blocks' THEN 'blocked-by'
		WHEN 'waits-on' THEN 'blocked-by'
		WHEN 'duplicate' THEN 'duplicates'
		WHEN 'tracks' THEN 'related'
		WHEN 'caused-by' THEN 'related'
		WHEN 'validates' THEN 'related'
		ELSE `type`
	END AS `folded` FROM `issue_deps`
) WHERE `folded` IN ('blocked-by', 'related', 'discovered-from', 'supersedes', 'duplicates');--> statement-breakpoint
DROP TABLE `issue_deps`;--> statement-breakpoint
ALTER TABLE `__new_issue_deps` RENAME TO `issue_deps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_issue_deps_to` ON `issue_deps` (`to_id`);--> statement-breakpoint
CREATE INDEX `idx_issue_deps_from` ON `issue_deps` (`from_id`);