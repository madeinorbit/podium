-- PROVIDER CONNECTIONS GET AN OWNER (POD-6300; docs/design/multi-user-instance.md
-- §2.5, §4.6, decision Q2).
--
-- Until this release a managed connection (an API key or a Claude setup-token)
-- was one instance-wide row per provider, used by every spawn. From now on it
-- belongs to one member: only its owner lists, edits or runs with it.
--
-- `ref` is the account id members select and sessions record
-- (`managed:anthropic`); the same ref exists once per owner, which is what the
-- unique `(owner_user_id, ref)` index says. Existing rows keep their primary key,
-- which already was their ref, so an older binary rolled back to still finds them.
--
-- WHO OWNS AN EXISTING ROW. Q2 gives it to the custodian of the machine it was
-- captured on where that is known, otherwise to the earliest admin. No existing
-- row records a source machine (keys were pasted into the server, and the table
-- has no machine column), so every existing row takes the "otherwise" branch and
-- goes to the earliest active admin. UPGRADE NOTE (CHANGELOG, Unreleased): on an
-- instance with several members, every existing managed connection now belongs
-- to the earliest admin; other members connect their own. On a one-member
-- instance that member IS the earliest admin, so every connection stays theirs
-- and behaves exactly as before.
--
-- Expand-only: two nullable columns, one index, one new table. Nothing is
-- dropped, renamed or rebuilt.
CREATE TABLE `account_machine_sends` (
	`account_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`sent_at` text NOT NULL,
	CONSTRAINT `account_machine_sends_pk` PRIMARY KEY(`account_id`, `machine_id`),
	CONSTRAINT `fk_account_machine_sends_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `ref` text;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_owner_ref` ON `accounts` (`owner_user_id`,`ref`);--> statement-breakpoint
UPDATE `accounts`
SET `ref` = `id`,
    `owner_user_id` = (
      SELECT `id` FROM `users`
      WHERE `role` = 'admin' AND `disabled_at` IS NULL
      ORDER BY `created_at`, `id`
      LIMIT 1
    )
WHERE `owner_user_id` IS NULL;
