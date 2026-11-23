CREATE TABLE `identity_membership_event` (
	`workspace_id` text NOT NULL,
	`version` integer NOT NULL,
	`member_id` text NOT NULL,
	`account_id` text,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`authorization_version` integer NOT NULL,
	`invited_email` text,
	`created_by` text,
	CONSTRAINT `identity_membership_event_pk` PRIMARY KEY(`workspace_id`, `version`)
);
--> statement-breakpoint
-- Seed replay for existing workspaces, including restored member rows. An
-- invitation with an authority revision follows an ended membership: apply
-- its removal even if the old member row has not caught up yet.
INSERT INTO `identity_membership_event`
  (`workspace_id`, `version`, `member_id`, `account_id`, `role`, `status`,
   `authorization_version`, `invited_email`, `created_by`)
SELECT `workspace_id`, `version`, `member_id`, `account_id`, `role`,
  CASE WHEN `status` = 'invited' AND `authorization_version` > 0
    THEN 'removed' ELSE `status` END,
  `authorization_version`, `invited_email`, `created_by`
FROM `identity_membership`;
