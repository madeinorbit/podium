-- DOCK SHELL GETS A SERVER ROW (POD-4436, Phase 2 step 2 of POD-4414).
--
-- Which shell belongs to a worktree is a server fact so the same dock shell opens
-- on every device and the lifetime policy can bind a shell to its owning worktree.
-- Until this migration the only home was client ui-state (podium.dockShells, one
-- browser profile = one dock), which blocked the lifetime rule from answering
-- owning worktree exactly.
--
-- ONE-SHOT AND IRREVERSIBLE IN PLACE. There are no down migrations; rollback is
-- restoring the pre-migration backup the runner takes at boot.
--
-- NO BACKFILL FROM THE SERVER. Legacy maps live in client ui-state and remain valid
-- as a cache until the server answers, then the server wins. Creating an empty table
-- here is therefore complete.
--
-- PER-(USER, WORKTREE) UNIQUENESS IS THE CONSTRAINT: two devices opening the same
-- worktree at once must not create two shells. forWorktree claims the row
-- (INSERT ... ON CONFLICT DO NOTHING) before creating the session.

CREATE TABLE `user_dock_shell` (
	`user_id` text NOT NULL,
	`worktree_key` text NOT NULL,
	`session_id` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `user_dock_shell_pk` PRIMARY KEY(`user_id`, `worktree_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_user_dock_shell_session` ON `user_dock_shell` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_user_dock_shell_worktree` ON `user_dock_shell` (`worktree_key`);