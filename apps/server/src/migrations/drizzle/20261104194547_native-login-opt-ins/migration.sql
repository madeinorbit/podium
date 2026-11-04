-- THE D11 CHECKBOX (POD-6301; docs/design/multi-user-instance.md §2.5, §4.6;
-- September addendum §4-5).
--
-- `native_login_opt_ins` holds each member's choice for one native CLI login
-- (harness + identity fingerprint): copy and use it on every machine they hold
-- custody of, now and in future. Unticked by default. `native_login_transfers`
-- records how the last copy to each machine was decided (installed, or a
-- different login there was preserved). Neither holds credential bytes.
--
-- WHAT AN UPGRADE KEEPS. Before this release Podium copied a member's native
-- logins between their own machines with no choice at all. So that an existing
-- install keeps copying exactly as before, every native login already observed
-- on a machine in someone's custody is ticked for that custodian (the person
-- the login belongs to, design §2.5). Logins detected later start unticked, and
-- a fresh install ticks nothing: the person decides in onboarding or Settings.
-- UPGRADE NOTE (CHANGELOG, Unreleased): on a new install, logins are no longer
-- copied to your other machines until you tick "use on all my machines".
--
-- Expand-only: two new tables and one insert. Nothing is dropped or rebuilt.
CREATE TABLE `native_login_opt_ins` (
	`owner_user_id` text NOT NULL,
	`harness` text NOT NULL,
	`fingerprint` text NOT NULL,
	`enabled` integer NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `native_login_opt_ins_pk` PRIMARY KEY(`owner_user_id`, `harness`, `fingerprint`)
);
--> statement-breakpoint
CREATE TABLE `native_login_transfers` (
	`owner_user_id` text NOT NULL,
	`harness` text NOT NULL,
	`fingerprint` text NOT NULL,
	`machine_id` text NOT NULL,
	`outcome` text NOT NULL,
	`revision` integer NOT NULL,
	`at` text NOT NULL,
	CONSTRAINT `native_login_transfers_pk` PRIMARY KEY(`owner_user_id`, `harness`, `fingerprint`, `machine_id`),
	CONSTRAINT "native_login_transfers_outcome" CHECK(outcome IN ('installed', 'preserved'))
);
--> statement-breakpoint
INSERT OR IGNORE INTO `native_login_opt_ins`
  (`owner_user_id`, `harness`, `fingerprint`, `enabled`, `revision`, `updated_at`)
SELECT DISTINCT
  `g`.`grantee`,
  json_extract(`a`.`value`, '$.kind'),
  json_extract(`a`.`value`, '$.login.identity.fingerprint'),
  1,
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `machines` AS `m`
JOIN `grants` AS `g`
  ON `g`.`resource_kind` = 'machine'
  AND `g`.`resource_id` = `m`.`id`
  AND `g`.`verb` = 'manage'
  AND `g`.`custody` = 1
-- An unreadable inventory contributes nothing rather than failing the upgrade.
JOIN json_each(
  CASE WHEN json_valid(`m`.`inventory_json`) THEN `m`.`inventory_json` ELSE '{}' END,
  '$.agents'
) AS `a`
WHERE `m`.`revoked_at` IS NULL
  AND `m`.`inventory_json` IS NOT NULL
  AND json_valid(`m`.`inventory_json`)
  AND json_extract(`a`.`value`, '$.login.state') = 'in'
  AND json_extract(`a`.`value`, '$.login.identity.fingerprint') IS NOT NULL
  AND json_extract(`a`.`value`, '$.kind') IS NOT NULL;
