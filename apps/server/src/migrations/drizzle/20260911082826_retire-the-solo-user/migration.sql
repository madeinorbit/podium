-- RETIRING THE SOLO USER (A2, spec: hosted sign-in §8 "The solo user retired")
--
-- The first admin stops being a literal. POD-1075 wrote `'user:sole'` into the
-- one account row and into every owner column's DEFAULT, so "who owns this" was
-- answerable by a build rather than by a database. This migration mints that
-- member an ordinary `mem_` id, rewrites every reference to it, and takes the
-- defaults away so nothing can ever write the literal again.
--
-- ONE-SHOT AND IRREVERSIBLE IN PLACE, like every migration here: there are no
-- down migrations, and rollback is the pre-migration backup the runner takes at
-- boot. Read the four decisions below before changing anything.
--
-- ---------------------------------------------------------------------------
-- 1. THE ID IS MINTED PER INSTALLATION, AND WHERE IT COMES FROM
-- ---------------------------------------------------------------------------
-- `{{mint:mem_}}` is substituted by the runner with one freshly minted branded
-- KSUID at the moment this migration is applied (`mintIdsIn` in
-- ../../index.ts) — the same `mem_` mint every other member row will get, from
-- the same code, so this row is not a special case of anything.
--
-- The alternative was a `mem_` CONSTANT frozen into this file, which needs no
-- mechanism and is wrong for the reason the literal was wrong: every
-- installation on earth would share one member id, which is a shared literal
-- wearing a prefix. The other alternative — minting in SQL — means base62 long
-- division over a 160-bit value as a recursive CTE, frozen forever, testable
-- only against itself.
--
-- Every occurrence of the token in this file resolves to the SAME id: the
-- substitution is per prefix, because these statements are one re-key and must
-- all name one member.
--
-- ---------------------------------------------------------------------------
-- 2. THE LITERAL IS SPELLED OUT, AS FROZEN HISTORY
-- ---------------------------------------------------------------------------
-- `'user:sole'` is written here rather than imported, for the reason the POD-1075
-- migration gives for spelling it: a migration is frozen history, and these
-- statements must keep matching the rows that were actually written, whatever
-- the model later calls that value. `SOLE_USER_ID` still exists in
-- `packages/model`, and after this migration it names only two things, both of
-- them history — what the frozen migrations spell, and the login identifier A3
-- accepts for a first member whose email is still empty.
--
-- ---------------------------------------------------------------------------
-- 3. WHY SIXTY-SIX UPDATES AND NOT TWELVE
-- ---------------------------------------------------------------------------
-- The brief names about a dozen `owner_user_id` columns, which are the ones
-- carrying a DEFAULT. They are not the only references: the literal also sits in
-- every `on_behalf_of`, every `actor` / `actor_id` / `created_by_id` written by a
-- human, `grants.grantee` and `grants.owner`, `issues.assignee`, the six
-- per-user-state tables, `client_sessions.user_id` (so nobody is logged out by an
-- upgrade) and `user_credentials.user_id` (so the password still works). Missing
-- one leaves a row owned by an id that names nothing, which reads as a valid
-- principal and is refused by every check — the failure mode is "a pin nobody can
-- see" rather than an error.
--
-- So the list is every column of every table that can hold a user id, derived
-- from the schema rather than from the brief, and
-- `retire-the-solo-user.test.ts` re-derives it from the LIVE schema and fails if
-- any text column anywhere still holds the literal after this runs. That test is
-- the real guarantee; this list is its subject.
--
-- A row whose value is not the literal is untouched: an instance that already
-- invited other members keeps their ids, and re-applying this migration finds
-- nothing to do.
--
-- ---------------------------------------------------------------------------
-- 4. AND THEN THE DEFAULTS GO
-- ---------------------------------------------------------------------------
-- Everything after the re-key is `drizzle-kit generate`'s own output for
-- removing `.default('user:sole')` from thirteen columns in `schema.ts`: SQLite
-- cannot drop a column default in place, so each table is rebuilt in the
-- create/copy/drop/rename shape, and the indexes are recreated at the end.
--
-- Dropping the default is what makes the retirement permanent, and it is
-- enforced BEFORE runtime: with no default, drizzle's insert type makes
-- `ownerUserId` REQUIRED, so every write that used to lean on the default is a
-- compile error naming the file that has to decide whose row it is writing.
--
-- The re-key runs FIRST so the rebuilds copy values that are already correct.

UPDATE `users` SET `id` = '{{mint:mem_}}' WHERE `id` = 'user:sole';
--> statement-breakpoint
UPDATE `approval_requests` SET `actor` = '{{mint:mem_}}' WHERE `actor` = 'user:sole';
--> statement-breakpoint
UPDATE `approval_requests` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `automation_runs` SET `actor` = '{{mint:mem_}}' WHERE `actor` = 'user:sole';
--> statement-breakpoint
UPDATE `automation_runs` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `automations` SET `created_by_actor` = '{{mint:mem_}}' WHERE `created_by_actor` = 'user:sole';
--> statement-breakpoint
UPDATE `automations` SET `created_by_on_behalf_of` = '{{mint:mem_}}' WHERE `created_by_on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `automations` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `client_sessions` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `execution_profiles` SET `created_by_id` = '{{mint:mem_}}' WHERE `created_by_id` = 'user:sole';
--> statement-breakpoint
UPDATE `execution_profiles` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `grants` SET `actor_id` = '{{mint:mem_}}' WHERE `actor_id` = 'user:sole';
--> statement-breakpoint
UPDATE `grants` SET `grantee` = '{{mint:mem_}}' WHERE `grantee` = 'user:sole';
--> statement-breakpoint
UPDATE `grants` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `grants` SET `owner` = '{{mint:mem_}}' WHERE `owner` = 'user:sole';
--> statement-breakpoint
UPDATE `issue_comments` SET `actor` = '{{mint:mem_}}' WHERE `actor` = 'user:sole';
--> statement-breakpoint
UPDATE `issue_comments` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `issue_message_user_state` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `issue_messages` SET `actor` = '{{mint:mem_}}' WHERE `actor` = 'user:sole';
--> statement-breakpoint
UPDATE `issue_messages` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `issue_user_state` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `issues` SET `actor` = '{{mint:mem_}}' WHERE `actor` = 'user:sole';
--> statement-breakpoint
UPDATE `issues` SET `assignee` = '{{mint:mem_}}' WHERE `assignee` = 'user:sole';
--> statement-breakpoint
UPDATE `issues` SET `created_by_actor` = '{{mint:mem_}}' WHERE `created_by_actor` = 'user:sole';
--> statement-breakpoint
UPDATE `issues` SET `created_by_on_behalf_of` = '{{mint:mem_}}' WHERE `created_by_on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `issues` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `issues` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `machines` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `messages` SET `actor_id` = '{{mint:mem_}}' WHERE `actor_id` = 'user:sole';
--> statement-breakpoint
UPDATE `messages` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `pins` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `queued_messages` SET `actor_id` = '{{mint:mem_}}' WHERE `actor_id` = 'user:sole';
--> statement-breakpoint
UPDATE `queued_messages` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `session_user_state` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `sessions` SET `created_by_actor_id` = '{{mint:mem_}}' WHERE `created_by_actor_id` = 'user:sole';
--> statement-breakpoint
UPDATE `sessions` SET `created_by_on_behalf_of` = '{{mint:mem_}}' WHERE `created_by_on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `sessions` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `settings_audit_events` SET `actor_id` = '{{mint:mem_}}' WHERE `actor_id` = 'user:sole';
--> statement-breakpoint
UPDATE `settings_audit_events` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
-- The runner applies this entire migration atomically. Install a narrower guard
-- BEFORE replacing the unconditional guard: only this migration's exact member
-- re-key is allowed, and no other approval evidence may change. Restore the
-- original guard before leaving the transaction; rollback restores it on failure.
CREATE TRIGGER `ship_orders_member_rekey_guard` BEFORE UPDATE OF
  `issue_id`, `repo_id`, `target_branch`, `destination`, `approved_base_sha`,
  `approved_head_sha`, `descendant_manifest`, `delivery_depends_on`,
  `evidence_manifest_ref`, `current_integration_receipt`, `provider_ref`,
  `requested_by_actor_kind`, `requested_by_actor_id`, `requested_by_on_behalf_of`,
  `requested_at`, `policy_id`, `validation_profile`, `validation_profile_digest`, `close_mode`
ON `ship_orders`
WHEN NOT (
  NEW.`issue_id` IS OLD.`issue_id`
  AND NEW.`repo_id` IS OLD.`repo_id`
  AND NEW.`target_branch` IS OLD.`target_branch`
  AND NEW.`destination` IS OLD.`destination`
  AND NEW.`approved_base_sha` IS OLD.`approved_base_sha`
  AND NEW.`approved_head_sha` IS OLD.`approved_head_sha`
  AND NEW.`descendant_manifest` IS OLD.`descendant_manifest`
  AND NEW.`delivery_depends_on` IS OLD.`delivery_depends_on`
  AND NEW.`evidence_manifest_ref` IS OLD.`evidence_manifest_ref`
  AND NEW.`current_integration_receipt` IS OLD.`current_integration_receipt`
  AND NEW.`provider_ref` IS OLD.`provider_ref`
  AND NEW.`requested_by_actor_kind` IS OLD.`requested_by_actor_kind`
  AND NEW.`requested_at` IS OLD.`requested_at`
  AND NEW.`policy_id` IS OLD.`policy_id`
  AND NEW.`validation_profile` IS OLD.`validation_profile`
  AND NEW.`validation_profile_digest` IS OLD.`validation_profile_digest`
  AND NEW.`close_mode` IS OLD.`close_mode`
  AND (NEW.`requested_by_actor_id` IS OLD.`requested_by_actor_id` OR (OLD.`requested_by_actor_id` IS 'user:sole' AND NEW.`requested_by_actor_id` IS '{{mint:mem_}}'))
  AND (NEW.`requested_by_on_behalf_of` IS OLD.`requested_by_on_behalf_of` OR (OLD.`requested_by_on_behalf_of` IS 'user:sole' AND NEW.`requested_by_on_behalf_of` IS '{{mint:mem_}}'))
)
BEGIN
  SELECT RAISE(ABORT, 'ship order approval is immutable');
END;
--> statement-breakpoint
DROP TRIGGER `ship_orders_frozen_fields`;
--> statement-breakpoint
UPDATE `ship_orders` SET `requested_by_actor_id` = '{{mint:mem_}}' WHERE `requested_by_actor_id` = 'user:sole';
--> statement-breakpoint
UPDATE `ship_orders` SET `requested_by_on_behalf_of` = '{{mint:mem_}}' WHERE `requested_by_on_behalf_of` = 'user:sole';
--> statement-breakpoint
CREATE TRIGGER `ship_orders_frozen_fields` BEFORE UPDATE OF
  `issue_id`, `repo_id`, `target_branch`, `destination`, `approved_base_sha`,
  `approved_head_sha`, `descendant_manifest`, `delivery_depends_on`,
  `evidence_manifest_ref`, `current_integration_receipt`, `provider_ref`,
  `requested_by_actor_kind`, `requested_by_actor_id`, `requested_by_on_behalf_of`,
  `requested_at`, `policy_id`, `validation_profile`, `validation_profile_digest`, `close_mode`
ON `ship_orders`
BEGIN
  SELECT RAISE(ABORT, 'ship order approval is immutable');
END;
--> statement-breakpoint
DROP TRIGGER `ship_orders_member_rekey_guard`;
--> statement-breakpoint
UPDATE `snoozes` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `superagent_messages` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `superagent_pending_turns` SET `actor` = '{{mint:mem_}}' WHERE `actor` = 'user:sole';
--> statement-breakpoint
UPDATE `superagent_pending_turns` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `superagent_pending_turns` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `superagent_queued_inputs` SET `actor` = '{{mint:mem_}}' WHERE `actor` = 'user:sole';
--> statement-breakpoint
UPDATE `superagent_queued_inputs` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `superagent_queued_inputs` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `superagent_threads` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `tab_order` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `telegram_chat_bindings` SET `actor_id` = '{{mint:mem_}}' WHERE `actor_id` = 'user:sole';
--> statement-breakpoint
UPDATE `telegram_chat_bindings` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `telegram_chat_bindings` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `user_credentials` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `user_layout` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `user_preferences` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `user_read_position` SET `user_id` = '{{mint:mem_}}' WHERE `user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `workflow_bindings` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `workflow_bindings` SET `updated_by_id` = '{{mint:mem_}}' WHERE `updated_by_id` = 'user:sole';
--> statement-breakpoint
UPDATE `workflow_events` SET `actor_id` = '{{mint:mem_}}' WHERE `actor_id` = 'user:sole';
--> statement-breakpoint
UPDATE `workflow_events` SET `on_behalf_of` = '{{mint:mem_}}' WHERE `on_behalf_of` = 'user:sole';
--> statement-breakpoint
UPDATE `workflow_revisions` SET `created_by_id` = '{{mint:mem_}}' WHERE `created_by_id` = 'user:sole';
--> statement-breakpoint
UPDATE `workflow_runs` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
UPDATE `workflows` SET `created_by_id` = '{{mint:mem_}}' WHERE `created_by_id` = 'user:sole';
--> statement-breakpoint
UPDATE `workflows` SET `owner_user_id` = '{{mint:mem_}}' WHERE `owner_user_id` = 'user:sole';
--> statement-breakpoint
-- THE REPLICATION FEED, for the same reason. `changes` and `change_latest` hold
-- the JSON a replica bootstraps and catches up from, and a session's projection
-- carries its owner (`ownerUserId` in @podium/protocol's terminal and headless
-- messages) — so a node bootstrapped after this migration would otherwise
-- materialise rows owned by an id the authority no longer knows.
--
-- A byte substitution rather than a JSON rewrite, and it is exact: `"user:sole"`
-- WITH its quotes is a complete JSON string token, and the id is the only thing
-- in this database ever spelled that way. The `LIKE` keeps it off every row that
-- does not mention it.
UPDATE `changes` SET `payload` = replace(`payload`, '"user:sole"', '"{{mint:mem_}}"') WHERE `payload` LIKE '%"user:sole"%';
--> statement-breakpoint
UPDATE `change_latest` SET `payload` = replace(`payload`, '"user:sole"', '"{{mint:mem_}}"') WHERE `payload` LIKE '%"user:sole"%';
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_automation_runs` (
	`id` text PRIMARY KEY,
	`actor` text DEFAULT 'system:automation-migration' NOT NULL,
	`on_behalf_of` text NOT NULL,
	`automation_id` text NOT NULL,
	`fired_at` text NOT NULL,
	`session_id` text,
	`outcome` text NOT NULL,
	`detail` text,
	`deleted_at` text,
	CONSTRAINT `fk_automation_runs_automation_id_automations_id_fk` FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "automation_runs_check_20" CHECK(outcome IN ('spawned','missed','skipped_overlap','error'))
);
--> statement-breakpoint
INSERT INTO `__new_automation_runs`(`id`, `actor`, `on_behalf_of`, `automation_id`, `fired_at`, `session_id`, `outcome`, `detail`, `deleted_at`) SELECT `id`, `actor`, `on_behalf_of`, `automation_id`, `fired_at`, `session_id`, `outcome`, `detail`, `deleted_at` FROM `automation_runs`;--> statement-breakpoint
DROP TABLE `automation_runs`;--> statement-breakpoint
ALTER TABLE `__new_automation_runs` RENAME TO `automation_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_automations` (
	`id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`created_by_actor` text NOT NULL,
	`created_by_on_behalf_of` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`repo_path` text,
	`schedule_kind` text DEFAULT 'cron' NOT NULL,
	`cron` text NOT NULL,
	`run_at` text,
	`target_session_id` text,
	`agent_kind` text NOT NULL,
	`model` text DEFAULT 'auto' NOT NULL,
	`effort` text DEFAULT 'auto' NOT NULL,
	`prompt` text NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`created_at` text NOT NULL,
	`session_mode` text DEFAULT 'fresh' NOT NULL,
	`deleted_at` text,
	CONSTRAINT "automations_session_mode" CHECK(session_mode IN ('fresh', 'resume'))
);
--> statement-breakpoint
INSERT INTO `__new_automations`(`id`, `owner_user_id`, `created_by_actor`, `created_by_on_behalf_of`, `name`, `enabled`, `repo_path`, `schedule_kind`, `cron`, `run_at`, `target_session_id`, `agent_kind`, `model`, `effort`, `prompt`, `next_run_at`, `last_run_at`, `created_at`, `session_mode`, `deleted_at`) SELECT `id`, `owner_user_id`, `created_by_actor`, `created_by_on_behalf_of`, `name`, `enabled`, `repo_path`, `schedule_kind`, `cron`, `run_at`, `target_session_id`, `agent_kind`, `model`, `effort`, `prompt`, `next_run_at`, `last_run_at`, `created_at`, `session_mode`, `deleted_at` FROM `automations`;--> statement-breakpoint
DROP TABLE `automations`;--> statement-breakpoint
ALTER TABLE `__new_automations` RENAME TO `automations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_execution_profiles` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL CONSTRAINT `execution_profiles_name_unique` UNIQUE,
	`account_id` text NOT NULL,
	`machine_id` text,
	`harness` text NOT NULL,
	`model` text DEFAULT 'auto' NOT NULL,
	`effort` text DEFAULT 'auto' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`owner_user_id` text NOT NULL,
	CONSTRAINT "execution_profiles_check_15" CHECK(created_by_kind IN ('operator', 'session'))
);
--> statement-breakpoint
INSERT INTO `__new_execution_profiles`(`id`, `name`, `account_id`, `machine_id`, `harness`, `model`, `effort`, `created_by_kind`, `created_by_id`, `created_at`, `updated_at`, `owner_user_id`) SELECT `id`, `name`, `account_id`, `machine_id`, `harness`, `model`, `effort`, `created_by_kind`, `created_by_id`, `created_at`, `updated_at`, `owner_user_id` FROM `execution_profiles`;--> statement-breakpoint
DROP TABLE `execution_profiles`;--> statement-breakpoint
ALTER TABLE `__new_execution_profiles` RENAME TO `execution_profiles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issues` (
	`id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`visibility` text DEFAULT 'personal' NOT NULL,
	`created_by_actor` text NOT NULL,
	`created_by_on_behalf_of` text,
	`repo_path` text NOT NULL,
	`repo_id` text,
	`seq` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`brief` text,
	`stage` text NOT NULL,
	`worktree_path` text,
	`branch` text,
	`parent_branch` text DEFAULT 'main' NOT NULL,
	`default_agent` text NOT NULL,
	`default_model` text DEFAULT 'auto' NOT NULL,
	`default_effort` text DEFAULT 'auto' NOT NULL,
	`machine_id` text,
	`linear_id` text,
	`linear_identifier` text,
	`linear_url` text,
	`activity_notes` text,
	`notes_updated_at` text,
	`suggested_stage` text,
	`suggested_reason` text,
	`blocked_by` text DEFAULT '[]' NOT NULL,
	`dependency_note` text,
	`pr_url` text,
	`priority` integer DEFAULT 2 NOT NULL,
	`type` text DEFAULT 'task' NOT NULL,
	`assignee` text,
	`parent_id` text,
	`design` text,
	`acceptance` text,
	`notes` text,
	`due_at` text,
	`defer_until` text,
	`closed_reason` text,
	`closed_at` text,
	`landed_at` text,
	`landed_sha` text,
	`superseded_by` text,
	`duplicate_of` text,
	`sort_key` text,
	`color` text,
	`estimate_min` integer,
	`needs_human` integer DEFAULT 0 NOT NULL,
	`human_question` text,
	`human_question_options` text,
	`human_question_asked_by` text,
	`human_question_asked_at` text,
	`panel` text,
	`created_at` text NOT NULL,
	`actor` text,
	`on_behalf_of` text,
	`updated_at` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`origin` text DEFAULT 'human' NOT NULL,
	`draft` integer DEFAULT 0 NOT NULL,
	`audience` text DEFAULT 'human' NOT NULL,
	`deleted_at` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`coordinator_session_id` text,
	`started_by_session` text,
	CONSTRAINT `fk_issues_parent_id_issues_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_superseded_by_issues_id_fk` FOREIGN KEY (`superseded_by`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issues_duplicate_of_issues_id_fk` FOREIGN KEY (`duplicate_of`) REFERENCES `issues`(`id`) ON DELETE SET NULL,
	CONSTRAINT "issues_check_1" CHECK(stage IN ('proposed', 'backlog', 'planning', 'in_progress', 'review', 'shipping', 'verifying', 'done')),
	CONSTRAINT "issues_check_2" CHECK(priority BETWEEN 0 AND 4),
	CONSTRAINT "issues_check_3" CHECK(type IN ('task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone', 'automation'))
);
--> statement-breakpoint
INSERT INTO `__new_issues`(`id`, `owner_user_id`, `visibility`, `created_by_actor`, `created_by_on_behalf_of`, `repo_path`, `repo_id`, `seq`, `title`, `description`, `brief`, `stage`, `worktree_path`, `branch`, `parent_branch`, `default_agent`, `default_model`, `default_effort`, `machine_id`, `linear_id`, `linear_identifier`, `linear_url`, `activity_notes`, `notes_updated_at`, `suggested_stage`, `suggested_reason`, `blocked_by`, `dependency_note`, `pr_url`, `priority`, `type`, `assignee`, `parent_id`, `design`, `acceptance`, `notes`, `due_at`, `defer_until`, `closed_reason`, `closed_at`, `landed_at`, `landed_sha`, `superseded_by`, `duplicate_of`, `sort_key`, `color`, `estimate_min`, `needs_human`, `human_question`, `human_question_options`, `human_question_asked_by`, `human_question_asked_at`, `panel`, `created_at`, `actor`, `on_behalf_of`, `updated_at`, `archived`, `origin`, `draft`, `audience`, `deleted_at`, `revision`, `coordinator_session_id`, `started_by_session`) SELECT `id`, `owner_user_id`, `visibility`, `created_by_actor`, `created_by_on_behalf_of`, `repo_path`, `repo_id`, `seq`, `title`, `description`, `brief`, `stage`, `worktree_path`, `branch`, `parent_branch`, `default_agent`, `default_model`, `default_effort`, `machine_id`, `linear_id`, `linear_identifier`, `linear_url`, `activity_notes`, `notes_updated_at`, `suggested_stage`, `suggested_reason`, `blocked_by`, `dependency_note`, `pr_url`, `priority`, `type`, `assignee`, `parent_id`, `design`, `acceptance`, `notes`, `due_at`, `defer_until`, `closed_reason`, `closed_at`, `landed_at`, `landed_sha`, `superseded_by`, `duplicate_of`, `sort_key`, `color`, `estimate_min`, `needs_human`, `human_question`, `human_question_options`, `human_question_asked_by`, `human_question_asked_at`, `panel`, `created_at`, `actor`, `on_behalf_of`, `updated_at`, `archived`, `origin`, `draft`, `audience`, `deleted_at`, `revision`, `coordinator_session_id`, `started_by_session` FROM `issues`;--> statement-breakpoint
DROP TABLE `issues`;--> statement-breakpoint
ALTER TABLE `__new_issues` RENAME TO `issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`agent_kind` text NOT NULL,
	`model` text,
	`effort` text,
	`requested_model` text,
	`requested_effort` text,
	`account_id` text,
	`login_harness` text,
	`cwd` text NOT NULL,
	`title` text NOT NULL,
	`origin_kind` text NOT NULL,
	`conversation_id` text,
	`resume_kind` text,
	`resume_value` text,
	`selected_driver_id` text,
	`requested_driver_id` text,
	`conversation_binding` text,
	`status` text NOT NULL,
	`exit_code` integer,
	`spawn_failure` text,
	`durable_label` text NOT NULL,
	`created_at` text NOT NULL,
	`last_active_at` text NOT NULL,
	`name` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`work_state` text,
	`machine_id` text NOT NULL,
	`last_output_at` text,
	`last_input_at` text,
	`last_resumed_at` text,
	`spawned_by` text,
	`headless` integer DEFAULT 0 NOT NULL,
	`issue_id` text,
	`stopped_at` text,
	`stop_reason` text,
	`oom_killed_at` text,
	`deleted_at` text,
	`deleted_by_issue_id` text,
	`deletion_source` text,
	`workflow_run_id` text,
	`workflow_step_id` text,
	`execution_profile_id` text,
	`name_source` text,
	`ref_issue_id` text,
	`ref_letter` text,
	`ref_draft` integer,
	`terminal_cols` integer DEFAULT 80 NOT NULL,
	`terminal_rows` integer DEFAULT 24 NOT NULL,
	`working_ms_total` integer,
	`input_count` integer DEFAULT 0 NOT NULL,
	`output_count` integer DEFAULT 0 NOT NULL,
	`activity_count` integer DEFAULT 0 NOT NULL,
	`created_by_actor_kind` text,
	`created_by_actor_id` text,
	`created_by_on_behalf_of` text,
	CONSTRAINT "sessions_stop_reason_check" CHECK(stop_reason IS NULL OR stop_reason IN ('self', 'parent', 'forced', 'exited')),
	CONSTRAINT "sessions_created_by_actor_kind" CHECK(created_by_actor_kind IS NULL OR created_by_actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "sessions_created_by_system_has_no_human" CHECK(created_by_actor_kind <> 'system' OR created_by_on_behalf_of IS NULL)
);
--> statement-breakpoint
INSERT INTO `__new_sessions`(`id`, `owner_user_id`, `agent_kind`, `model`, `effort`, `account_id`, `login_harness`, `cwd`, `title`, `origin_kind`, `conversation_id`, `resume_kind`, `resume_value`, `conversation_binding`, `status`, `exit_code`, `spawn_failure`, `durable_label`, `created_at`, `last_active_at`, `name`, `archived`, `work_state`, `machine_id`, `last_output_at`, `last_input_at`, `last_resumed_at`, `spawned_by`, `headless`, `issue_id`, `stopped_at`, `stop_reason`, `deleted_at`, `deleted_by_issue_id`, `deletion_source`, `workflow_run_id`, `workflow_step_id`, `execution_profile_id`, `name_source`, `ref_issue_id`, `ref_letter`, `ref_draft`, `terminal_cols`, `terminal_rows`, `working_ms_total`, `input_count`, `output_count`, `activity_count`, `created_by_actor_kind`, `created_by_actor_id`, `created_by_on_behalf_of`, `requested_model`, `requested_effort`, `selected_driver_id`, `requested_driver_id`, `oom_killed_at`) SELECT `id`, `owner_user_id`, `agent_kind`, `model`, `effort`, `account_id`, `login_harness`, `cwd`, `title`, `origin_kind`, `conversation_id`, `resume_kind`, `resume_value`, `conversation_binding`, `status`, `exit_code`, `spawn_failure`, `durable_label`, `created_at`, `last_active_at`, `name`, `archived`, `work_state`, `machine_id`, `last_output_at`, `last_input_at`, `last_resumed_at`, `spawned_by`, `headless`, `issue_id`, `stopped_at`, `stop_reason`, `deleted_at`, `deleted_by_issue_id`, `deletion_source`, `workflow_run_id`, `workflow_step_id`, `execution_profile_id`, `name_source`, `ref_issue_id`, `ref_letter`, `ref_draft`, `terminal_cols`, `terminal_rows`, `working_ms_total`, `input_count`, `output_count`, `activity_count`, `created_by_actor_kind`, `created_by_actor_id`, `created_by_on_behalf_of`, `requested_model`, `requested_effort`, `selected_driver_id`, `requested_driver_id`, `oom_killed_at` FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_superagent_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`owner_user_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text,
	`tool_call_id` text,
	`tool_name` text,
	`created_at` text NOT NULL,
	`thread_id` text DEFAULT 'global' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_superagent_messages`(`id`, `owner_user_id`, `role`, `content`, `tool_calls`, `tool_call_id`, `tool_name`, `created_at`, `thread_id`) SELECT `id`, `owner_user_id`, `role`, `content`, `tool_calls`, `tool_call_id`, `tool_name`, `created_at`, `thread_id` FROM `superagent_messages`;--> statement-breakpoint
DROP TABLE `superagent_messages`;--> statement-breakpoint
ALTER TABLE `__new_superagent_messages` RENAME TO `superagent_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_superagent_pending_turns` (
	`owner_user_id` text NOT NULL,
	`turn_id` text PRIMARY KEY,
	`thread_id` text NOT NULL CONSTRAINT `superagent_pending_turns_thread_id_unique` UNIQUE,
	`podium_session_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`first_turn` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`actor` text,
	`on_behalf_of` text
);
--> statement-breakpoint
INSERT INTO `__new_superagent_pending_turns`(`owner_user_id`, `turn_id`, `thread_id`, `podium_session_id`, `payload_json`, `first_turn`, `created_at`, `actor`, `on_behalf_of`) SELECT `owner_user_id`, `turn_id`, `thread_id`, `podium_session_id`, `payload_json`, `first_turn`, `created_at`, `actor`, `on_behalf_of` FROM `superagent_pending_turns`;--> statement-breakpoint
DROP TABLE `superagent_pending_turns`;--> statement-breakpoint
ALTER TABLE `__new_superagent_pending_turns` RENAME TO `superagent_pending_turns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_superagent_queued_inputs` (
	`owner_user_id` text NOT NULL,
	`input_id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`text` text NOT NULL,
	`focus_json` text,
	`agent_kind` text,
	`attach_session_id` text,
	`created_at` text NOT NULL,
	`actor` text,
	`on_behalf_of` text
);
--> statement-breakpoint
INSERT INTO `__new_superagent_queued_inputs`(`owner_user_id`, `input_id`, `thread_id`, `text`, `focus_json`, `agent_kind`, `attach_session_id`, `created_at`, `actor`, `on_behalf_of`) SELECT `owner_user_id`, `input_id`, `thread_id`, `text`, `focus_json`, `agent_kind`, `attach_session_id`, `created_at`, `actor`, `on_behalf_of` FROM `superagent_queued_inputs`;--> statement-breakpoint
DROP TABLE `superagent_queued_inputs`;--> statement-breakpoint
ALTER TABLE `__new_superagent_queued_inputs` RENAME TO `superagent_queued_inputs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_superagent_threads` (
	`id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`origin_session_id` text,
	`title` text,
	`watermark_item_id` text,
	`watermark_ts` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`repo_path` text,
	`agent_kind` text,
	`podium_session_id` text,
	`harness_session_id` text,
	`terminal_session_id` text,
	`model` text,
	`effort` text
);
--> statement-breakpoint
INSERT INTO `__new_superagent_threads`(`id`, `owner_user_id`, `kind`, `origin_session_id`, `title`, `watermark_item_id`, `watermark_ts`, `created_at`, `updated_at`, `archived`, `repo_path`, `agent_kind`, `podium_session_id`, `harness_session_id`, `terminal_session_id`, `model`, `effort`) SELECT `id`, `owner_user_id`, `kind`, `origin_session_id`, `title`, `watermark_item_id`, `watermark_ts`, `created_at`, `updated_at`, `archived`, `repo_path`, `agent_kind`, `podium_session_id`, `harness_session_id`, `terminal_session_id`, `model`, `effort` FROM `superagent_threads`;--> statement-breakpoint
DROP TABLE `superagent_threads`;--> statement-breakpoint
ALTER TABLE `__new_superagent_threads` RENAME TO `superagent_threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_bindings` (
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`updated_by_kind` text NOT NULL,
	`updated_by_id` text,
	`updated_at` text NOT NULL,
	`owner_user_id` text NOT NULL,
	CONSTRAINT `workflow_bindings_pk` PRIMARY KEY(`target_kind`, `target_id`),
	CONSTRAINT `fk_workflow_bindings_revision_id_workflow_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `workflow_revisions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "workflow_bindings_check_13" CHECK(target_kind IN ('global', 'repository', 'issue', 'session')),
	CONSTRAINT "workflow_bindings_check_14" CHECK(updated_by_kind IN ('operator', 'session'))
);
--> statement-breakpoint
INSERT INTO `__new_workflow_bindings`(`target_kind`, `target_id`, `revision_id`, `updated_by_kind`, `updated_by_id`, `updated_at`, `owner_user_id`) SELECT `target_kind`, `target_id`, `revision_id`, `updated_by_kind`, `updated_by_id`, `updated_at`, `owner_user_id` FROM `workflow_bindings`;--> statement-breakpoint
DROP TABLE `workflow_bindings`;--> statement-breakpoint
ALTER TABLE `__new_workflow_bindings` RENAME TO `workflow_bindings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_runs` (
	`id` text PRIMARY KEY,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`coordinator_session_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`status` text NOT NULL,
	`supersedes_run_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`owner_user_id` text NOT NULL,
	CONSTRAINT `fk_workflow_runs_revision_id_workflow_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `workflow_revisions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_workflow_runs_supersedes_run_id_workflow_runs_id_fk` FOREIGN KEY (`supersedes_run_id`) REFERENCES `workflow_runs`(`id`) ON DELETE SET NULL,
	CONSTRAINT "workflow_runs_check_23" CHECK(subject_kind IN ('issue', 'session')),
	CONSTRAINT "workflow_runs_check_24" CHECK(status IN ('active', 'blocked', 'complete', 'superseded'))
);
--> statement-breakpoint
INSERT INTO `__new_workflow_runs`(`id`, `subject_kind`, `subject_id`, `coordinator_session_id`, `revision_id`, `status`, `supersedes_run_id`, `started_at`, `completed_at`, `owner_user_id`) SELECT `id`, `subject_kind`, `subject_id`, `coordinator_session_id`, `revision_id`, `status`, `supersedes_run_id`, `started_at`, `completed_at`, `owner_user_id` FROM `workflow_runs`;--> statement-breakpoint
DROP TABLE `workflow_runs`;--> statement-breakpoint
ALTER TABLE `__new_workflow_runs` RENAME TO `workflow_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflows` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`scope` text NOT NULL,
	`scope_ref` text,
	`latest_revision_id` text,
	`archived_at` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`owner_user_id` text NOT NULL,
	CONSTRAINT "workflows_check_21" CHECK(scope IN ('global', 'repository', 'task')),
	CONSTRAINT "workflows_check_22" CHECK(created_by_kind IN ('operator', 'session'))
);
--> statement-breakpoint
INSERT INTO `__new_workflows`(`id`, `name`, `description`, `scope`, `scope_ref`, `latest_revision_id`, `archived_at`, `created_by_kind`, `created_by_id`, `created_at`, `updated_at`, `owner_user_id`) SELECT `id`, `name`, `description`, `scope`, `scope_ref`, `latest_revision_id`, `archived_at`, `created_by_kind`, `created_by_id`, `created_at`, `updated_at`, `owner_user_id` FROM `workflows`;--> statement-breakpoint
DROP TABLE `workflows`;--> statement-breakpoint
ALTER TABLE `__new_workflows` RENAME TO `workflows`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_automation_runs_automation` ON `automation_runs` (`automation_id`,`fired_at`);--> statement-breakpoint
CREATE INDEX `idx_issues_deleted_at` ON `issues` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_issues_closed_projection` ON `issues` (`id`,`stage`,`closed_reason`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_issues_repo_id_seq` ON `issues` (`repo_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_issues_parent` ON `issues` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_repo` ON `issues` (`repo_path`);--> statement-breakpoint
CREATE INDEX `idx_sessions_deleted_by_issue` ON `sessions` (`deleted_by_issue_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_deleted_at` ON `sessions` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_resume_machine` ON `sessions` (`resume_value`,`machine_id`);--> statement-breakpoint
CREATE INDEX `idx_superagent_queued_thread_order` ON `superagent_queued_inputs` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_runs_one_live_subject` ON `workflow_runs` (`subject_kind`,`subject_id`) WHERE "workflow_runs"."status" IN ('active', 'blocked');--> statement-breakpoint
CREATE INDEX `workflow_runs_coordinator` ON `workflow_runs` (`coordinator_session_id`,"started_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_scope_name_active` ON `workflows` (`scope`,COALESCE("scope_ref", ''),`name`) WHERE "workflows"."archived_at" IS NULL;