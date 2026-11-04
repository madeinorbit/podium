-- QUOTA WINDOWS GET AN OWNER (POD-6300; docs/design/multi-user-instance.md §4.6).
--
-- A quota window row is keyed by provider account, not by person. Its quota is
-- that of a native login, and a machine's native logins belong to the machine's
-- custodian, so the server now records that custodian on the row when it opens
-- it, and `quota.history` shows a member only their own rows. Fixing the owner at
-- record time keeps a row with its member after the login is switched or logged
-- out, or the machine is removed. A row recorded on a machine nobody looks after
-- has no owner and answers to nobody.
--
-- Rows written before this release have no recorded machine, so they go to the
-- earliest active admin, the same rule as provider connections (Q2). They were
-- visible to every member until now, so this discloses nothing new; on a
-- one-member instance that member is the earliest admin and sees exactly the
-- rows they saw before.
--
-- Expand-only: one nullable column, one index.
ALTER TABLE `quota_windows` ADD `owner_user_id` text;--> statement-breakpoint
CREATE INDEX `idx_quota_windows_owner` ON `quota_windows` (`owner_user_id`,`account_key`,`window_key`,`resets_at_ms`);--> statement-breakpoint
UPDATE `quota_windows`
SET `owner_user_id` = (
  SELECT `id` FROM `users`
  WHERE `role` = 'admin' AND `disabled_at` IS NULL
  ORDER BY `created_at`, `id`
  LIMIT 1
)
WHERE `owner_user_id` IS NULL;
