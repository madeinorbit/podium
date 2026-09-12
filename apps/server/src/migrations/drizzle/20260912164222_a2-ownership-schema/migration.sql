CREATE TABLE `issue_participants` (
	`issue_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` text NOT NULL,
	`added_by_actor_kind` text NOT NULL,
	`added_by_actor_id` text NOT NULL,
	`added_by_on_behalf_of` text,
	CONSTRAINT `issue_participants_pk` PRIMARY KEY(`issue_id`, `user_id`, `role`),
	CONSTRAINT `fk_issue_participants_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE,
	CONSTRAINT "issue_participants_role_check" CHECK(role IN ('collaborator', 'follower')),
	CONSTRAINT "issue_participants_actor_kind_check" CHECK(added_by_actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "issue_participants_system_has_no_human_check" CHECK(added_by_actor_kind <> 'system' OR added_by_on_behalf_of IS NULL)
);
--> statement-breakpoint
CREATE TABLE `ownership_migration_dispositions` (
	`migration` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`prior_owner` text NOT NULL,
	`resolved_owner` text,
	`retired_assignee` text,
	`disposition` text NOT NULL,
	`decided_at` text NOT NULL,
	CONSTRAINT `ownership_migration_dispositions_pk` PRIMARY KEY(`migration`, `entity_kind`, `entity_id`),
	CONSTRAINT "ownership_migration_dispositions_disposition_check" CHECK(disposition IN (
        'adopted-assignee-as-owner',
        'kept-owner-assignee-was-agent-label',
        'kept-owner-assignee-unknown-account'
      )),
	CONSTRAINT "ownership_migration_dispositions_owner_move_check" CHECK(CASE disposition
        WHEN 'adopted-assignee-as-owner' THEN resolved_owner IS NOT prior_owner
        ELSE resolved_owner IS prior_owner
      END)
);
--> statement-breakpoint
ALTER TABLE `issue_user_state` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `issue_user_state` ADD `assignment_dismissed_at` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `assignment_revision` integer;--> statement-breakpoint
ALTER TABLE `issues` ADD `input_revision` integer;--> statement-breakpoint
CREATE INDEX `idx_issue_participants_user` ON `issue_participants` (`user_id`);