-- THE CHECKOUTS ON EACH MACHINE (POD-6644; design POD-5620 §1.12).
--
-- Each registered repository root and each of its worktrees, as the machine's
-- daemon last reported them; the synced `checkout` record is this row. Before
-- it, worktrees were never stored: every client asked `discovery.refreshRepos`,
-- which scanned every online machine on each boot and reconnect.
--
-- BACK-FILL: every registered root (`repos`) becomes a `repository` row with no
-- branch yet, so the apps show the roots before the first scan answers; the
-- boot reconcile puts the rows on the change log. Worktrees appear at the
-- machine's first scan after the upgrade (its daemon's next connect).
--
-- EXPAND-ONLY. One new table, nothing else touched. ROLLBACK: a binary swap;
-- an older server ignores the table, and `DROP TABLE checkouts` removes it.
CREATE TABLE `checkouts` (
	`machine_id` text NOT NULL,
	`path` text NOT NULL,
	`root` text NOT NULL,
	`kind` text NOT NULL,
	`repo_id` text,
	`branch` text,
	`origin_url` text,
	`locked` integer DEFAULT false NOT NULL,
	`prunable` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `checkouts_pk` PRIMARY KEY(`machine_id`, `path`)
);
--> statement-breakpoint
CREATE INDEX `idx_checkouts_root` ON `checkouts` (`machine_id`,`root`);--> statement-breakpoint
INSERT OR IGNORE INTO `checkouts` (`machine_id`, `path`, `root`, `kind`, `repo_id`, `branch`, `origin_url`, `locked`, `prunable`, `updated_at`)
SELECT `machine_id`, `path`, `path`, 'repository', `repo_id`, NULL, `origin_url`, 0, 0, `added_at` FROM `repos`;
