ALTER TABLE `approval_requests` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `on_behalf_of` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `actor` text DEFAULT 'system:automation-migration' NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `on_behalf_of` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `created_by_actor` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `created_by_on_behalf_of` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `execution_profiles` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `issue_comments` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `issue_comments` ADD `on_behalf_of` text;--> statement-breakpoint
ALTER TABLE `issue_messages` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `issue_messages` ADD `on_behalf_of` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `issues` ADD `visibility` text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE `issues` ADD `created_by_actor` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `issues` ADD `created_by_on_behalf_of` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `on_behalf_of` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `superagent_messages` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `superagent_pending_turns` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `superagent_pending_turns` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `superagent_pending_turns` ADD `on_behalf_of` text;--> statement-breakpoint
ALTER TABLE `superagent_queued_inputs` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `superagent_queued_inputs` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `superagent_queued_inputs` ADD `on_behalf_of` text;--> statement-breakpoint
ALTER TABLE `superagent_threads` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_bindings` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `owner_user_id` text DEFAULT 'user:sole' NOT NULL;