DROP INDEX IF EXISTS `idx_issue_comments_issue`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_issue_deps_to`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_issue_messages_issue`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_messages_delivered_to`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_messages_from_session`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_pending_interactions_session`;--> statement-breakpoint
CREATE INDEX `idx_client_sessions_user` ON `client_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_client_sessions_expires` ON `client_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_client_sessions_label` ON `client_sessions` (`label`);--> statement-breakpoint
CREATE INDEX `idx_grants_grantee` ON `grants` (`grantee`);--> statement-breakpoint
CREATE INDEX `idx_issue_comments_issue_time` ON `issue_comments` (`issue_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_issue_deps_to_from` ON `issue_deps` (`to_id`,`from_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_issue_messages_issue_time` ON `issue_messages` (`issue_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_issue_user_state_issue` ON `issue_user_state` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_worktree` ON `issues` (`worktree_path`) WHERE "issues"."worktree_path" IS NOT NULL AND "issues"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_issues_superseded_by` ON `issues` (`superseded_by`) WHERE "issues"."superseded_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_issues_duplicate_of` ON `issues` (`duplicate_of`) WHERE "issues"."duplicate_of" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_issues_agent_profile` ON `issues` (`agent_profile_id`) WHERE "issues"."agent_profile_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_delivered_to_time` ON `messages` (`delivered_to`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_from_session_time` ON `messages` (`from_session`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_from_issue` ON `messages` (`from_issue`,`created_at`,`id`) WHERE "messages"."from_issue" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_recipient_time` ON `messages` (`to_kind`,`to_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_reply` ON `messages` (`in_reply_to`,`kind`) WHERE "messages"."in_reply_to" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_pending_interactions_session_time` ON `pending_interactions` (`session_id`,`asked_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_pins_target` ON `pins` (`kind`,`id`);--> statement-breakpoint
CREATE INDEX `idx_session_user_state_session` ON `session_user_state` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_issue` ON `sessions` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_ref_issue` ON `sessions` (`ref_issue_id`) WHERE "sessions"."ref_issue_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sessions_machine` ON `sessions` (`machine_id`);--> statement-breakpoint
CREATE INDEX `idx_ship_evidence_source` ON `ship_evidence` (`custody_digest`,`source_ref`);--> statement-breakpoint
CREATE INDEX `idx_ship_repair_candidates_order` ON `ship_repair_candidates` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_ship_train_manifests_open_lane` ON `ship_train_manifests` (`lane_key`,`created_at`,`id`) WHERE "ship_train_manifests"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_ship_train_members_issue_ref` ON `ship_train_members` (`issue_id`);--> statement-breakpoint
CREATE INDEX `idx_snoozes_session` ON `snoozes` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_superagent_messages_thread` ON `superagent_messages` (`thread_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_superagent_threads_owner` ON `superagent_threads` (`owner_user_id`,`archived`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_status` ON `workflow_runs` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_subject` ON `workflow_runs` (`subject_kind`,`subject_id`,`started_at`);