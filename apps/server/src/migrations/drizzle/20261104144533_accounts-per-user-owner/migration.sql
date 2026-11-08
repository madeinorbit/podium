-- MANAGED PROVIDER KEYS BECOME PER USER (POD-6360, user decision 2026-11-04).
--
-- Each row gets an owner, its public account id, and an explicit sharing list.
-- Expand-only: three nullable columns, a backfill, two indexes.
--
-- The backfill records today's behaviour explicitly, so nobody's agents break:
-- every existing key was one instance-wide row that every user's agents used,
-- so it becomes owned by the first admin (the earliest active admin, as
-- `UsersRepository.earliestAdmin` picks it) and shared with everyone (`["*"]`).
-- The admin can revoke that share afterwards. On a store with no active admin
-- the owner stays NULL, and a row without an owner is never injected.
ALTER TABLE `accounts` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `account_key` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `shared_with` text;--> statement-breakpoint
UPDATE `accounts` SET
  `owner_user_id` = (
    SELECT `id` FROM `users`
    WHERE `role` = 'admin' AND `disabled_at` IS NULL
    ORDER BY `created_at`, `id`
    LIMIT 1
  ),
  `account_key` = `id`,
  `shared_with` = '["*"]'
WHERE `owner_user_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_owner_account_key` ON `accounts` (`owner_user_id`,`account_key`);--> statement-breakpoint
CREATE INDEX `idx_accounts_account_key` ON `accounts` (`account_key`);
