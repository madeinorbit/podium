-- POD-6692 (POD-5620 design 1.1, 1.12 decision (b)): an issue's pin is a pin
-- record like every other pin. Each person's issue pin moves from
-- `issue_user_state.pinned_at` into `pins` (kind 'issue', the issue id), with
-- its original time, so the pinned order is kept. A pin that is already there
-- keeps its own row.
INSERT OR IGNORE INTO `pins` (`user_id`, `kind`, `id`, `pinned_at`)
SELECT `user_id`, 'issue', `issue_id`, `pinned_at`
FROM `issue_user_state`
WHERE `pinned_at` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `issue_user_state` DROP COLUMN `pinned_at`;
--> statement-breakpoint
-- A row with every marker null means "nothing", and the store deletes it rather
-- than keeping one (store/issues.ts `setIssueUserState`). Rows that held only a
-- pin are such rows now. The boot reconcile publishes their removal and the new
-- pins on the change log.
DELETE FROM `issue_user_state`
WHERE `read_at` IS NULL
  AND `tucked_at` IS NULL
  AND `joined_at` IS NULL
  AND `joined_via` IS NULL
  AND `assigned_at` IS NULL
  AND `assigned_by` IS NULL;
