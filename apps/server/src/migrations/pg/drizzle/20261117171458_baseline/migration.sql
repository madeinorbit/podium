CREATE TABLE "account_machine_sends" (
	"account_id" text COLLATE "C",
	"machine_id" text COLLATE "C",
	"sent_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "account_machine_sends_pk" PRIMARY KEY("workspace_id","account_id","machine_id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text COLLATE "C",
	"provider" text COLLATE "C" NOT NULL,
	"kind" text COLLATE "C" NOT NULL,
	"credential" text COLLATE "C" NOT NULL,
	"identity" text COLLATE "C" DEFAULT '' NOT NULL,
	"scope" text COLLATE "C" DEFAULT 'role' NOT NULL,
	"created_at" bigint NOT NULL,
	"owner_user_id" text COLLATE "C",
	"ref" text COLLATE "C",
	"account_key" text COLLATE "C",
	"shared_with" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "accounts_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"id" text COLLATE "C",
	"name" text COLLATE "C" NOT NULL,
	"description" text COLLATE "C" DEFAULT '' NOT NULL,
	"candidates_json" json DEFAULT '[]' NOT NULL,
	"machine_id" text COLLATE "C",
	"instructions" text COLLATE "C" DEFAULT '' NOT NULL,
	"created_by" text COLLATE "C",
	"updated_by" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "agent_profiles_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "agent_profiles_name_unique" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "applied_mutations" (
	"mutation_id" text COLLATE "C",
	"proc" text COLLATE "C" NOT NULL,
	"result" text COLLATE "C" NOT NULL,
	"applied_at" bigint NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "applied_mutations_pk" PRIMARY KEY("workspace_id","mutation_id")
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" text COLLATE "C",
	"machine_id" text COLLATE "C" NOT NULL,
	"session_id" text COLLATE "C" NOT NULL,
	"issue_id" text COLLATE "C",
	"op_json" json NOT NULL,
	"status" text COLLATE "C" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"actor" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"decided_at" timestamp(3) with time zone,
	"result_text" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "approval_requests_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "approval_requests_check_4" CHECK (status IN ('pending','denied','executing','succeeded','failed'))
);
--> statement-breakpoint
CREATE TABLE "artifact_uploads" (
	"issue_id" text COLLATE "C",
	"upload_id" text COLLATE "C",
	"begin_json" json NOT NULL,
	"received_json" json NOT NULL,
	"created_at" bigint NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "artifact_uploads_pk" PRIMARY KEY("workspace_id","issue_id","upload_id")
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text COLLATE "C",
	"actor" text COLLATE "C" DEFAULT 'system:automation-migration' NOT NULL,
	"on_behalf_of" text COLLATE "C" NOT NULL,
	"automation_id" text COLLATE "C" NOT NULL,
	"fired_at" timestamp(3) with time zone NOT NULL,
	"session_id" text COLLATE "C",
	"outcome" text COLLATE "C" NOT NULL,
	"detail" text COLLATE "C",
	"deleted_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "automation_runs_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "automation_runs_check_20" CHECK (outcome IN ('spawned','missed','skipped_overlap','error'))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" text COLLATE "C",
	"owner_user_id" text COLLATE "C" NOT NULL,
	"created_by_actor" text COLLATE "C" NOT NULL,
	"created_by_on_behalf_of" text COLLATE "C" NOT NULL,
	"name" text COLLATE "C" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"repo_path" text COLLATE "C",
	"schedule_kind" text COLLATE "C" DEFAULT 'cron' NOT NULL,
	"cron" text COLLATE "C" NOT NULL,
	"run_at" timestamp(3) with time zone,
	"target_session_id" text COLLATE "C",
	"agent_kind" text COLLATE "C" NOT NULL,
	"model" text COLLATE "C" DEFAULT 'auto' NOT NULL,
	"effort" text COLLATE "C" DEFAULT 'auto' NOT NULL,
	"prompt" text COLLATE "C" NOT NULL,
	"next_run_at" timestamp(3) with time zone,
	"last_run_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone NOT NULL,
	"session_mode" text COLLATE "C" DEFAULT 'fresh' NOT NULL,
	"deleted_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "automations_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "automations_session_mode" CHECK (session_mode IN ('fresh', 'resume'))
);
--> statement-breakpoint
CREATE TABLE "carried_sign_ins" (
	"old_token_hash" text COLLATE "C",
	"device_sign_in_id" text COLLATE "C" NOT NULL,
	"sealed" text COLLATE "C" NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"member_id" text COLLATE "C" NOT NULL,
	"old_label" text COLLATE "C" NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "carried_sign_ins_pk" PRIMARY KEY("workspace_id","old_token_hash")
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"workspace_id" text COLLATE "C",
	"seq" bigint,
	"entity" text COLLATE "C" NOT NULL,
	"entity_id" text COLLATE "C" NOT NULL,
	"op" text COLLATE "C" NOT NULL,
	"payload" json,
	"event_time" bigint NOT NULL,
	"origin_id" text COLLATE "C",
	"causation_id" text COLLATE "C",
	"mutation_id" text COLLATE "C",
	CONSTRAINT "changes_pkey" PRIMARY KEY("workspace_id","seq")
);
--> statement-breakpoint
CREATE TABLE "checkout_lost" (
	"user_id" text COLLATE "C",
	"machine_id" text COLLATE "C",
	"path" text COLLATE "C",
	"root" boolean DEFAULT false NOT NULL,
	"lost_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "checkout_lost_pk" PRIMARY KEY("workspace_id","user_id","machine_id","path")
);
--> statement-breakpoint
CREATE TABLE "checkout_reach" (
	"user_id" text COLLATE "C",
	"machine_id" text COLLATE "C",
	"reach" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "checkout_reach_pk" PRIMARY KEY("workspace_id","user_id","machine_id")
);
--> statement-breakpoint
CREATE TABLE "checkouts" (
	"machine_id" text COLLATE "C",
	"path" text COLLATE "C",
	"root" text COLLATE "C" NOT NULL,
	"kind" text COLLATE "C" NOT NULL,
	"repo_id" text COLLATE "C",
	"branch" text COLLATE "C",
	"origin_url" text COLLATE "C",
	"locked" boolean DEFAULT false NOT NULL,
	"prunable" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"removed_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "checkouts_pk" PRIMARY KEY("workspace_id","machine_id","path")
);
--> statement-breakpoint
CREATE TABLE "client_sessions" (
	"token_hash" text COLLATE "C",
	"user_id" text COLLATE "C" NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"label" text COLLATE "C" DEFAULT 'login' NOT NULL,
	"session_id" text COLLATE "C",
	"device_id" text COLLATE "C",
	"device_name" text COLLATE "C",
	"platform" text COLLATE "C",
	"last_seen_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "client_sessions_pk" PRIMARY KEY("workspace_id","token_hash")
);
--> statement-breakpoint
CREATE TABLE "conversation_identities" (
	"podium_id" text COLLATE "C",
	"parent_podium_id" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "conversation_identities_pk" PRIMARY KEY("workspace_id","podium_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_segment_incarnations" (
	"machine_id" text COLLATE "C",
	"native_id" text COLLATE "C",
	"sequence" bigint,
	"device" text COLLATE "C" NOT NULL,
	"inode" text COLLATE "C" NOT NULL,
	"mirrored_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"retired_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "conversation_segment_incarnations_pk" PRIMARY KEY("workspace_id","machine_id","native_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "conversation_segments" (
	"machine_id" text COLLATE "C",
	"native_id" text COLLATE "C",
	"provider_id" text COLLATE "C" NOT NULL,
	"podium_id" text COLLATE "C" NOT NULL,
	"path" text COLLATE "C",
	"seq_in_conv" bigint NOT NULL,
	"linked_by" text COLLATE "C" NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"mirrored_bytes" bigint DEFAULT 0 NOT NULL,
	"mirrored_at" timestamp(3) with time zone,
	"indexed_bytes" bigint DEFAULT 0 NOT NULL,
	"reported_bytes" bigint,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "conversation_segments_pk" PRIMARY KEY("workspace_id","machine_id","native_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text COLLATE "C",
	"agent_kind" text COLLATE "C" NOT NULL,
	"provider_id" text COLLATE "C" NOT NULL,
	"title" text COLLATE "C",
	"name" text COLLATE "C",
	"summary" text COLLATE "C",
	"project_path" text COLLATE "C",
	"resume_kind" text COLLATE "C",
	"resume_value" text COLLATE "C",
	"created_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone,
	"message_count" bigint,
	"machine_id" text COLLATE "C" NOT NULL,
	"parent_conversation_id" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "conversations_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "delivery_receipts" (
	"id" text COLLATE "C",
	"order_id" text COLLATE "C" NOT NULL,
	"approved_base_sha" text COLLATE "C" NOT NULL,
	"approved_head_sha" text COLLATE "C" NOT NULL,
	"result_commit_sha" text COLLATE "C" NOT NULL,
	"tested_integration_sha" text COLLATE "C" NOT NULL,
	"landed_ref_sha" text COLLATE "C" NOT NULL,
	"destination_sha" text COLLATE "C" NOT NULL,
	"validation_profile_id" text COLLATE "C" NOT NULL,
	"validation_result" text COLLATE "C" NOT NULL,
	"destination" text COLLATE "C" NOT NULL,
	"completed_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "delivery_receipts_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "delivery_receipts_validation_result_check" CHECK (validation_result = 'passed')
);
--> statement-breakpoint
CREATE TABLE "effects" (
	"id" text COLLATE "C",
	"kind" text COLLATE "C" NOT NULL,
	"target_kind" text COLLATE "C" NOT NULL,
	"target_id" text COLLATE "C" NOT NULL,
	"input_json" json NOT NULL,
	"result_json" json,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"status" text COLLATE "C" NOT NULL,
	"error_code" text COLLATE "C",
	"error_message" text COLLATE "C",
	"deadline_at" bigint,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"stage" text COLLATE "C",
	"decision" text COLLATE "C",
	"deciders" text COLLATE "C",
	"started_at" bigint,
	"finished_at" bigint,
	"created_by" text COLLATE "C",
	"actor" text COLLATE "C",
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"deleted_at" bigint,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "effects_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "grant_audiences" (
	"resource_kind" text COLLATE "C",
	"resource_id" text COLLATE "C",
	"grantee" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "grant_audiences_pk" PRIMARY KEY("workspace_id","resource_kind","resource_id","grantee")
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"resource_kind" text COLLATE "C",
	"resource_id" text COLLATE "C",
	"grantee" text COLLATE "C",
	"verb" text COLLATE "C",
	"custody" boolean DEFAULT false NOT NULL,
	"owner" text COLLATE "C" NOT NULL,
	"visibility" text COLLATE "C" NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"actor_kind" text COLLATE "C" NOT NULL,
	"actor_id" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "grants_pk" PRIMARY KEY("workspace_id","resource_kind","resource_id","grantee","verb")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_invitation" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"member_id" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"email" text,
	"expires_at" timestamp NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "identity_membership" (
	"workspace_id" text,
	"member_id" text,
	"account_id" text,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"authorization_version" integer DEFAULT 0 NOT NULL,
	"invited_email" text,
	"created_by" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "identity_membership_pkey" PRIMARY KEY("workspace_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "identity_membership_event" (
	"workspace_id" text,
	"version" integer,
	"member_id" text NOT NULL,
	"account_id" text,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"authorization_version" integer NOT NULL,
	"invited_email" text,
	"created_by" text,
	CONSTRAINT "identity_membership_event_pkey" PRIMARY KEY("workspace_id","version")
);
--> statement-breakpoint
CREATE TABLE "identity_one_time_code" (
	"id" text PRIMARY KEY,
	"purpose" text NOT NULL,
	"account_id" text,
	"code_hash" text UNIQUE,
	"receiver_challenge" text,
	"claim_id" text UNIQUE,
	"approval" text DEFAULT 'none' NOT NULL,
	"source_sign_in_id" text,
	"device" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY,
	"key" text NOT NULL UNIQUE,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"device_kind" text DEFAULT 'browser' NOT NULL,
	"device_name" text,
	"device_id" text,
	"platform" text,
	"last_seen_at" timestamp,
	"fixed_expiry" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_workspace_revision" (
	"workspace_id" text PRIMARY KEY,
	"revision" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_comments" (
	"id" text COLLATE "C",
	"issue_id" text COLLATE "C" NOT NULL,
	"author" text COLLATE "C" NOT NULL,
	"body" text COLLATE "C" NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"actor" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"edited_at" timestamp(3) with time zone,
	"edited_by" text COLLATE "C",
	"edited_on_behalf_of" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_comments_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "issue_deps" (
	"from_id" text COLLATE "C",
	"to_id" text COLLATE "C",
	"type" text COLLATE "C" DEFAULT 'blocked-by',
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_deps_pk" PRIMARY KEY("workspace_id","from_id","to_id","type"),
	CONSTRAINT "issue_deps_type" CHECK (type IN ('blocked-by', 'related', 'discovered-from', 'supersedes', 'duplicates'))
);
--> statement-breakpoint
CREATE TABLE "issue_git_states" (
	"issue_id" text COLLATE "C",
	"facts_json" json NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_git_states_pk" PRIMARY KEY("workspace_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "issue_labels" (
	"issue_id" text COLLATE "C",
	"label_id" bigint,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_labels_pk" PRIMARY KEY("workspace_id","issue_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "issue_message_user_state" (
	"user_id" text COLLATE "C",
	"issue_message_id" text COLLATE "C",
	"read_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_message_user_state_pk" PRIMARY KEY("workspace_id","user_id","issue_message_id")
);
--> statement-breakpoint
CREATE TABLE "issue_messages" (
	"id" text COLLATE "C",
	"issue_id" text COLLATE "C" NOT NULL,
	"from_author" text COLLATE "C" NOT NULL,
	"body" text COLLATE "C" NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"actor" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"status" text COLLATE "C" DEFAULT 'unread' NOT NULL,
	"claimed_by" text COLLATE "C",
	"claimed_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_messages_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "issue_panel_artifacts" (
	"id" text COLLATE "C",
	"issue_id" text COLLATE "C" NOT NULL,
	"position" bigint NOT NULL,
	"path" text COLLATE "C" NOT NULL,
	"value" json NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_panel_artifacts_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "issue_panel_deferred" (
	"id" text COLLATE "C",
	"issue_id" text COLLATE "C" NOT NULL,
	"position" bigint NOT NULL,
	"text" text COLLATE "C" NOT NULL,
	"added_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_panel_deferred_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "issue_panel_states" (
	"id" text COLLATE "C",
	"text" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_panel_states_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "issue_panel_todos" (
	"id" text COLLATE "C",
	"issue_id" text COLLATE "C" NOT NULL,
	"position" bigint NOT NULL,
	"text" text COLLATE "C" NOT NULL,
	"done" boolean NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_panel_todos_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "issue_ref_letters" (
	"issue_id" text COLLATE "C",
	"next_index" bigint NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_ref_letters_pk" PRIMARY KEY("workspace_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "issue_text_revisions" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "issue_text_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"issue_id" text COLLATE "C" NOT NULL,
	"field" text COLLATE "C" NOT NULL,
	"body" text COLLATE "C" NOT NULL,
	"source" text COLLATE "C" NOT NULL,
	"restored_from" bigint,
	"issue_revision" bigint,
	"actor" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C" NOT NULL,
	CONSTRAINT "issue_text_revisions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "issue_text_revisions_field" CHECK (field IN ('description', 'brief')),
	CONSTRAINT "issue_text_revisions_source" CHECK (source IN ('create', 'baseline', 'edit', 'restore'))
);
--> statement-breakpoint
CREATE TABLE "issue_user_state" (
	"user_id" text COLLATE "C",
	"issue_id" text COLLATE "C",
	"read_at" timestamp(3) with time zone,
	"tucked_at" timestamp(3) with time zone,
	"joined_at" timestamp(3) with time zone,
	"joined_via" text COLLATE "C",
	"assigned_at" timestamp(3) with time zone,
	"assigned_by" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issue_user_state_pk" PRIMARY KEY("workspace_id","user_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" text COLLATE "C",
	"owner_user_id" text COLLATE "C" NOT NULL,
	"visibility" text COLLATE "C" DEFAULT 'personal' NOT NULL,
	"created_by_actor" text COLLATE "C" NOT NULL,
	"created_by_on_behalf_of" text COLLATE "C",
	"repo_path" text COLLATE "C" NOT NULL,
	"repo_id" text COLLATE "C",
	"seq" bigint NOT NULL,
	"title" text COLLATE "C" NOT NULL,
	"description" text COLLATE "C" DEFAULT '' NOT NULL,
	"brief" text COLLATE "C",
	"stage" text COLLATE "C" NOT NULL,
	"worktree_path" text COLLATE "C",
	"branch" text COLLATE "C",
	"parent_branch" text COLLATE "C" DEFAULT 'main' NOT NULL,
	"default_agent" text COLLATE "C" NOT NULL,
	"default_model" text COLLATE "C" DEFAULT 'auto' NOT NULL,
	"default_effort" text COLLATE "C" DEFAULT 'auto' NOT NULL,
	"machine_id" text COLLATE "C",
	"agent_profile_id" text COLLATE "C",
	"linear_id" text COLLATE "C",
	"linear_identifier" text COLLATE "C",
	"linear_url" text COLLATE "C",
	"suggested_stage" text COLLATE "C",
	"suggested_reason" text COLLATE "C",
	"blocked_by" json DEFAULT '[]' NOT NULL,
	"dependency_note" text COLLATE "C",
	"pr_url" text COLLATE "C",
	"priority" bigint DEFAULT 2 NOT NULL,
	"type" text COLLATE "C" DEFAULT 'task' NOT NULL,
	"assignee" text COLLATE "C",
	"parent_id" text COLLATE "C",
	"acceptance" text COLLATE "C",
	"due_at" timestamp(3) with time zone,
	"defer_until" text COLLATE "C",
	"closed_reason" text COLLATE "C",
	"closed_at" timestamp(3) with time zone,
	"closed_by_user_id" text COLLATE "C",
	"landed_at" timestamp(3) with time zone,
	"landed_sha" text COLLATE "C",
	"superseded_by" text COLLATE "C",
	"duplicate_of" text COLLATE "C",
	"sort_key" text COLLATE "C",
	"estimate_min" bigint,
	"needs_human" boolean DEFAULT false NOT NULL,
	"human_question" text COLLATE "C",
	"human_question_options" json,
	"human_question_asked_by" text COLLATE "C",
	"human_question_asked_at" timestamp(3) with time zone,
	"human_question_attribution" json,
	"created_at" timestamp(3) with time zone NOT NULL,
	"actor" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"updated_at" timestamp(3) with time zone NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"origin" text COLLATE "C" DEFAULT 'human' NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"audience" text COLLATE "C" DEFAULT 'human' NOT NULL,
	"deleted_at" timestamp(3) with time zone,
	"revision" bigint DEFAULT 1 NOT NULL,
	"coordinator_session_id" text COLLATE "C",
	"started_by_session" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "issues_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "issues_check_1" CHECK (stage IN ('proposed', 'backlog', 'planning', 'in_progress', 'review', 'shipping', 'verifying', 'done')),
	CONSTRAINT "issues_check_2" CHECK (priority BETWEEN 0 AND 4),
	CONSTRAINT "issues_check_3" CHECK (type IN ('task', 'phase', 'decision'))
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "labels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text COLLATE "C" NOT NULL,
	"color" text COLLATE "C",
	"description" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C" NOT NULL,
	CONSTRAINT "labels_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "lock_waiters" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "lock_waiters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repo_id" text COLLATE "C" NOT NULL,
	"name" text COLLATE "C" NOT NULL,
	"session_id" text COLLATE "C" NOT NULL,
	"issue_id" text COLLATE "C",
	"label" text COLLATE "C" NOT NULL,
	"ttl_seconds" bigint DEFAULT 120 NOT NULL,
	"note" text COLLATE "C",
	"enqueued_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C" NOT NULL,
	CONSTRAINT "lock_waiters_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "lock_waiters_workspace_id_repo_id_name_session_id_unique" UNIQUE("workspace_id","repo_id","name","session_id")
);
--> statement-breakpoint
CREATE TABLE "locks" (
	"repo_id" text COLLATE "C",
	"name" text COLLATE "C",
	"holder_session_id" text COLLATE "C",
	"holder_issue_id" text COLLATE "C",
	"holder_label" text COLLATE "C" NOT NULL,
	"note" text COLLATE "C",
	"acquired_at" timestamp(3) with time zone NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "locks_pk" PRIMARY KEY("workspace_id","repo_id","name")
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"revoked_at" timestamp(3) with time zone,
	"superseded_by" text COLLATE "C",
	"id" text COLLATE "C",
	"name" text COLLATE "C" NOT NULL,
	"hostname" text COLLATE "C" NOT NULL,
	"token_hash" text COLLATE "C" NOT NULL,
	"credential_kind" text COLLATE "C" DEFAULT 'bearer-hash' NOT NULL,
	"public_key" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"last_seen_at" timestamp(3) with time zone NOT NULL,
	"inventory_json" json,
	"harness_versions_json" json,
	"podium_managed" boolean DEFAULT true NOT NULL,
	"update_channel" text COLLATE "C" DEFAULT 'stable' NOT NULL,
	"update_channel_override" text COLLATE "C",
	"app_version" text COLLATE "C",
	"wire_schema_digest" text COLLATE "C",
	"install_kind" text COLLATE "C",
	"delivery_caps_json" json,
	"presence_source" text COLLATE "C",
	"service_assignment_json" json DEFAULT '{"server":false,"agentExecution":true}' NOT NULL,
	"assignment_evidence_json" json,
	"availability_json" json,
	"service_report_json" json,
	"build_reported_at" timestamp(3) with time zone,
	"components_json" json,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "machines_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "machines_credential_material" CHECK ((
  ("credential_kind" = 'bearer-hash' AND "token_hash" <> '' AND "public_key" IS NULL)
  OR ("credential_kind" = 'ed25519' AND "token_hash" = '' AND "public_key" IS NOT NULL
      AND length("public_key") = 51 AND substr("public_key", 1, 8) = 'ed25519:')
))
);
--> statement-breakpoint
CREATE TABLE "maintenance_commands" (
	"job_kind" text COLLATE "C",
	"run_key" text COLLATE "C",
	"fencing_token" bigint NOT NULL,
	"result_json" json NOT NULL,
	"applied_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "maintenance_commands_pk" PRIMARY KEY("workspace_id","job_kind","run_key")
);
--> statement-breakpoint
CREATE TABLE "maintenance_leases" (
	"name" text COLLATE "C" PRIMARY KEY,
	"generation_id" text COLLATE "C" NOT NULL,
	"fencing_token" bigint NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"protocol_version" bigint NOT NULL,
	"schema_version" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_reads" (
	"message_id" text COLLATE "C",
	"session_id" text COLLATE "C",
	"read_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "message_reads_pk" PRIMARY KEY("workspace_id","message_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "message_wake_cooldowns" (
	"key" text COLLATE "C",
	"attempted_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "message_wake_cooldowns_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text COLLATE "C",
	"thread_id" text COLLATE "C" NOT NULL,
	"in_reply_to" text COLLATE "C",
	"from_kind" text COLLATE "C" NOT NULL,
	"from_session" text COLLATE "C",
	"from_issue" text COLLATE "C",
	"actor_kind" text COLLATE "C",
	"actor_id" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"delegation_ref" text COLLATE "C",
	"to_kind" text COLLATE "C" NOT NULL,
	"to_id" text COLLATE "C",
	"kind" text COLLATE "C" DEFAULT 'message' NOT NULL,
	"urgency" text COLLATE "C" DEFAULT 'fyi' NOT NULL,
	"lifecycle" text COLLATE "C" DEFAULT 'wait' NOT NULL,
	"body" text COLLATE "C" NOT NULL,
	"attachments_json" json,
	"expires_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone NOT NULL,
	"delivery_status" text COLLATE "C" DEFAULT 'stored' NOT NULL,
	"delivery_held" text COLLATE "C",
	"delivered_at" timestamp(3) with time zone,
	"delivered_to" text COLLATE "C",
	"acked_by" text COLLATE "C",
	"hop" bigint DEFAULT 0 NOT NULL,
	"clamped_from" json,
	"reminded_at" timestamp(3) with time zone,
	"from_name" text COLLATE "C",
	"read_at" timestamp(3) with time zone,
	"injected_at" timestamp(3) with time zone,
	"delivery_deferred_at" timestamp(3) with time zone,
	"delivery_deferred_reason" text COLLATE "C",
	"dead_lettered_at" timestamp(3) with time zone,
	"expects_response" boolean DEFAULT false NOT NULL,
	"fact_key" text COLLATE "C",
	"fact_target" text COLLATE "C",
	"transcript_item_id" text COLLATE "C",
	"transcript_item_cursor" text COLLATE "C",
	"harness_ref_json" json,
	"notice_dismissed_at" timestamp(3) with time zone,
	"retract_requested_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "messages_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "messages_check_5" CHECK (from_kind IN ('operator','superagent','agent','system')),
	CONSTRAINT "messages_check_6" CHECK (to_kind IN ('issue','session','operator')),
	CONSTRAINT "messages_check_7" CHECK (kind IN ('message','ack','notification','question')),
	CONSTRAINT "messages_check_8" CHECK (urgency IN ('fyi','next-turn','interrupt')),
	CONSTRAINT "messages_check_9" CHECK (lifecycle IN ('wait','wake')),
	CONSTRAINT "messages_delivery_status" CHECK (delivery_status IN ('stored','dispatched','reached-machine','typing','typed','accepted','confirmed','cancelled','failed','expired','unknown')),
	CONSTRAINT "messages_delivery_held" CHECK (delivery_held IN ('memory','durable'))
);
--> statement-breakpoint
CREATE TABLE "messaging_issue_topics" (
	"issue_id" text COLLATE "C",
	"chat_id" text COLLATE "C",
	"thread_ref" text COLLATE "C" NOT NULL,
	"superagent_thread_id" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "messaging_issue_topics_pk" PRIMARY KEY("workspace_id","issue_id","chat_id")
);
--> statement-breakpoint
CREATE TABLE "messaging_session_attachments" (
	"chat_id" text COLLATE "C",
	"thread_ref" text COLLATE "C",
	"user_id" text COLLATE "C" NOT NULL,
	"session_id" text COLLATE "C" NOT NULL,
	"attached_at" timestamp(3) with time zone NOT NULL,
	"relayed_item_id" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "messaging_session_attachments_pk" PRIMARY KEY("workspace_id","chat_id","thread_ref")
);
--> statement-breakpoint
CREATE TABLE "meta" (
	"key" text COLLATE "C" PRIMARY KEY,
	"value" text COLLATE "C" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_login_opt_ins" (
	"owner_user_id" text COLLATE "C",
	"harness" text COLLATE "C",
	"fingerprint" text COLLATE "C",
	"enabled" bigint NOT NULL,
	"revision" bigint NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "native_login_opt_ins_pk" PRIMARY KEY("workspace_id","owner_user_id","harness","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "native_login_transfers" (
	"owner_user_id" text COLLATE "C",
	"harness" text COLLATE "C",
	"fingerprint" text COLLATE "C",
	"machine_id" text COLLATE "C",
	"outcome" text COLLATE "C" NOT NULL,
	"revision" bigint NOT NULL,
	"at" text COLLATE "C" NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "native_login_transfers_pk" PRIMARY KEY("workspace_id","owner_user_id","harness","fingerprint","machine_id"),
	CONSTRAINT "native_login_transfers_outcome" CHECK (outcome IN ('installed', 'preserved'))
);
--> statement-breakpoint
CREATE TABLE "notification_facts" (
	"fact_key" text COLLATE "C",
	"target" text COLLATE "C",
	"source" text COLLATE "C",
	"issue_id" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"expires_at" timestamp(3) with time zone,
	"consumed_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "notification_facts_pk" PRIMARY KEY("workspace_id","fact_key","target")
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"session_id" text COLLATE "C",
	"message" text COLLATE "C" NOT NULL,
	"actions" json NOT NULL,
	"artifacts" json,
	"created_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "offers_pk" PRIMARY KEY("workspace_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" text COLLATE "C",
	"kind" text COLLATE "C" NOT NULL,
	"exclusion_group" text COLLATE "C" NOT NULL,
	"state" text COLLATE "C" NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"finished_at" bigint,
	"payload" json NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "operations_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "pending_interactions" (
	"id" text COLLATE "C",
	"session_id" text COLLATE "C" NOT NULL,
	"kind" text COLLATE "C" NOT NULL,
	"payload_json" json NOT NULL,
	"source" text COLLATE "C" NOT NULL,
	"answerable" text COLLATE "C" NOT NULL,
	"fingerprint" text COLLATE "C" NOT NULL,
	"status" text COLLATE "C" DEFAULT 'asked' NOT NULL,
	"policy_verdict" text COLLATE "C",
	"asked_at" timestamp(3) with time zone NOT NULL,
	"expires_at" timestamp(3) with time zone,
	"answered_at" timestamp(3) with time zone,
	"answered_by" text COLLATE "C",
	"answer_json" json,
	"delivered_via" text COLLATE "C",
	"expired_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "pending_interactions_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "pending_interactions_status_check" CHECK (status IN ('asked','answered','expired','superseded')),
	CONSTRAINT "pending_interactions_kind_check" CHECK (kind IN ('permission','question','plan-approval','elicitation','login','recovery')),
	CONSTRAINT "pending_interactions_source_check" CHECK (source IN ('protocol','sdk-callback','hook','screen-classifier'))
);
--> statement-breakpoint
CREATE TABLE "pending_uploads" (
	"id" text COLLATE "C",
	"owner_user_id" text COLLATE "C" NOT NULL,
	"filename" text COLLATE "C" NOT NULL,
	"entry" text COLLATE "C" NOT NULL,
	"media_type" text COLLATE "C" NOT NULL,
	"size" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"claimed_issue_id" text COLLATE "C",
	"claimed_artifact_id" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "pending_uploads_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "pending_uploads_claim_pair" CHECK ((claimed_issue_id IS NULL) = (claimed_artifact_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "pins" (
	"user_id" text COLLATE "C",
	"kind" text COLLATE "C",
	"id" text COLLATE "C",
	"pinned_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "pins_pk" PRIMARY KEY("workspace_id","user_id","kind","id")
);
--> statement-breakpoint
CREATE TABLE "podium_events" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "podium_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ts" text COLLATE "C" NOT NULL,
	"kind" text COLLATE "C" NOT NULL,
	"subject" text COLLATE "C" NOT NULL,
	"repo_path" text COLLATE "C",
	"payload" json DEFAULT '{}' NOT NULL,
	"workspace_id" text COLLATE "C" NOT NULL,
	CONSTRAINT "podium_events_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "queued_messages" (
	"id" text COLLATE "C",
	"session_id" text COLLATE "C" NOT NULL,
	"text" text COLLATE "C" NOT NULL,
	"queued_at" bigint NOT NULL,
	"input_origin" text COLLATE "C" DEFAULT 'unknown' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"delivery_owner" text COLLATE "C",
	"principal_kind" text COLLATE "C" DEFAULT 'system' NOT NULL,
	"principal_ref" text COLLATE "C" DEFAULT 'legacy-session-inbox' NOT NULL,
	"delegation_ref" text COLLATE "C",
	"actor_kind" text COLLATE "C" DEFAULT 'system' NOT NULL,
	"actor_id" text COLLATE "C" DEFAULT 'legacy-session-inbox' NOT NULL,
	"on_behalf_of" text COLLATE "C",
	"source_message_id" text COLLATE "C",
	"delivery" text COLLATE "C" DEFAULT 'when-ready' NOT NULL,
	"attachments_json" json,
	"retract_requested_at" bigint,
	"workspace_id" text COLLATE "C",
	"queue_order" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "queued_messages_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "queued_messages_principal_kind" CHECK (principal_kind IN ('user','agent','system')),
	CONSTRAINT "queued_messages_actor_kind" CHECK (actor_kind IN ('user','agent','system'))
);
--> statement-breakpoint
CREATE TABLE "quota_windows" (
	"account_key" text COLLATE "C",
	"agent" text COLLATE "C" NOT NULL,
	"window_key" text COLLATE "C",
	"resets_at_bucket" bigint,
	"label" text COLLATE "C" NOT NULL,
	"scope_model" text COLLATE "C",
	"plan" text COLLATE "C",
	"resets_at_ms" bigint NOT NULL,
	"started_at_ms" bigint,
	"window_minutes" bigint NOT NULL,
	"first_seen_ms" bigint NOT NULL,
	"last_seen_ms" bigint NOT NULL,
	"first_percent" double precision NOT NULL,
	"peak_percent" double precision NOT NULL,
	"last_percent" double precision NOT NULL,
	"sample_count" bigint NOT NULL,
	"partial" boolean NOT NULL,
	"source" text COLLATE "C" NOT NULL,
	"trail_json" json NOT NULL,
	"owner_user_id" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "quota_windows_pk" PRIMARY KEY("workspace_id","account_key","window_key","resets_at_bucket")
);
--> statement-breakpoint
CREATE TABLE "recap_watermarks" (
	"reader" text COLLATE "C",
	"session_id" text COLLATE "C",
	"watermark" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "recap_watermarks_pk" PRIMARY KEY("workspace_id","reader","session_id")
);
--> statement-breakpoint
CREATE TABLE "repo_draft_seq" (
	"repo_id" text COLLATE "C",
	"next_seq" bigint NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "repo_draft_seq_pk" PRIMARY KEY("workspace_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "repo_prefixes" (
	"repo_id" text COLLATE "C",
	"prefix" text COLLATE "C" NOT NULL,
	"default_parent_branch" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "repo_prefixes_pk" PRIMARY KEY("workspace_id","repo_id"),
	CONSTRAINT "repo_prefixes_prefix_unique" UNIQUE("workspace_id","prefix")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"machine_id" text COLLATE "C",
	"path" text COLLATE "C",
	"origin_url" text COLLATE "C",
	"repo_name" text COLLATE "C",
	"added_at" timestamp(3) with time zone NOT NULL,
	"repo_id" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "repos_pk" PRIMARY KEY("workspace_id","machine_id","path")
);
--> statement-breakpoint
CREATE TABLE "root_integration_receipts" (
	"root_issue_id" text COLLATE "C",
	"approved_head_sha" text COLLATE "C",
	"descendants" json DEFAULT '[]' NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "root_integration_receipts_pk" PRIMARY KEY("workspace_id","root_issue_id","approved_head_sha")
);
--> statement-breakpoint
CREATE TABLE "runtime_event_checkpoints" (
	"session_id" text COLLATE "C",
	"observer_generation" bigint NOT NULL,
	"cursor_json" json NOT NULL,
	"turn_epoch" bigint NOT NULL,
	"closed_turn_epoch" bigint,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"turn_state_json" json,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "runtime_event_checkpoints_pk" PRIMARY KEY("workspace_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "runtime_event_projection_cursors" (
	"projector" text COLLATE "C",
	"last_event_id" bigint NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "runtime_event_projection_cursors_pk" PRIMARY KEY("workspace_id","projector")
);
--> statement-breakpoint
CREATE TABLE "server_secrets" (
	"key" text COLLATE "C" PRIMARY KEY,
	"value" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_drafts" (
	"session_id" text COLLATE "C",
	"text" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"origin" text COLLATE "C",
	"history" json,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "session_drafts_pk" PRIMARY KEY("workspace_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "session_observation_checkpoints" (
	"session_id" text COLLATE "C",
	"schema_version" bigint DEFAULT 1 NOT NULL,
	"provider" text COLLATE "C" NOT NULL,
	"provider_session_id" text COLLATE "C",
	"binding_version" bigint DEFAULT 0 NOT NULL,
	"observation_generation" bigint DEFAULT 0 NOT NULL,
	"checkpoint_json" json,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "session_observation_checkpoints_pk" PRIMARY KEY("workspace_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "session_observation_rebinds" (
	"session_id" text COLLATE "C",
	"provider" text COLLATE "C" NOT NULL,
	"from_provider_session_id" text COLLATE "C",
	"from_binding_version" bigint NOT NULL,
	"from_observation_generation" bigint NOT NULL,
	"to_provider_session_id" text COLLATE "C" NOT NULL,
	"resulting_binding_version" bigint NOT NULL,
	"resulting_observation_generation" bigint NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "session_observation_rebinds_pk" PRIMARY KEY("workspace_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "session_terminal_candidates" (
	"session_id" text COLLATE "C",
	"proof_json" json NOT NULL,
	"confirmed_at" timestamp(3) with time zone,
	"consumed_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "session_terminal_candidates_pk" PRIMARY KEY("workspace_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "session_user_state" (
	"user_id" text COLLATE "C",
	"session_id" text COLLATE "C",
	"read_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "session_user_state_pk" PRIMARY KEY("workspace_id","user_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text COLLATE "C",
	"owner_user_id" text COLLATE "C" NOT NULL,
	"agent_kind" text COLLATE "C" NOT NULL,
	"model" text COLLATE "C",
	"effort" text COLLATE "C",
	"requested_model" text COLLATE "C",
	"requested_effort" text COLLATE "C",
	"account_id" text COLLATE "C",
	"login_harness" text COLLATE "C",
	"cwd" text COLLATE "C" NOT NULL,
	"title" text COLLATE "C" NOT NULL,
	"origin_kind" text COLLATE "C" NOT NULL,
	"conversation_id" text COLLATE "C",
	"resume_kind" text COLLATE "C",
	"resume_value" text COLLATE "C",
	"selected_driver_id" text COLLATE "C",
	"requested_driver_id" text COLLATE "C",
	"bound_driver_id" text COLLATE "C",
	"bound_driver_capabilities" text COLLATE "C",
	"draft_sync_engine" boolean DEFAULT false NOT NULL,
	"agent_color" text COLLATE "C",
	"agent_state_json" json,
	"observed_model" text COLLATE "C",
	"observed_effort" text COLLATE "C",
	"handoff_target_machine_id" text COLLATE "C",
	"conversation_binding" text COLLATE "C",
	"status" text COLLATE "C" NOT NULL,
	"exit_code" bigint,
	"spawn_failure" text COLLATE "C",
	"durable_label" text COLLATE "C" NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"last_active_at" timestamp(3) with time zone NOT NULL,
	"published_last_active_at" timestamp(3) with time zone DEFAULT '-infinity' NOT NULL,
	"last_active_publish_after" bigint DEFAULT 0 NOT NULL,
	"name" text COLLATE "C",
	"archived" boolean DEFAULT false NOT NULL,
	"work_state" text COLLATE "C",
	"machine_id" text COLLATE "C" NOT NULL,
	"last_output_at" timestamp(3) with time zone,
	"last_input_at" timestamp(3) with time zone,
	"last_resumed_at" timestamp(3) with time zone,
	"spawned_by" text COLLATE "C",
	"headless" boolean DEFAULT false NOT NULL,
	"issue_id" text COLLATE "C",
	"stopped_at" timestamp(3) with time zone,
	"stop_reason" text COLLATE "C",
	"oom_killed_at" timestamp(3) with time zone,
	"deleted_at" timestamp(3) with time zone,
	"deleted_by_issue_id" text COLLATE "C",
	"deletion_source" text COLLATE "C",
	"workflow_run_id" text COLLATE "C",
	"workflow_step_id" text COLLATE "C",
	"agent_profile_id" text COLLATE "C",
	"name_source" text COLLATE "C",
	"ref_issue_id" text COLLATE "C",
	"ref_letter" text COLLATE "C",
	"ref_draft" bigint,
	"terminal_cols" bigint DEFAULT 80 NOT NULL,
	"terminal_rows" bigint DEFAULT 24 NOT NULL,
	"working_ms_total" bigint,
	"input_count" bigint DEFAULT 0 NOT NULL,
	"output_count" bigint DEFAULT 0 NOT NULL,
	"activity_count" bigint DEFAULT 0 NOT NULL,
	"delegation" json,
	"created_by_actor_kind" text COLLATE "C",
	"created_by_actor_id" text COLLATE "C",
	"created_by_on_behalf_of" text COLLATE "C",
	"desired" text COLLATE "C",
	"desired_force" boolean DEFAULT false NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"observed_revision" bigint DEFAULT 1 NOT NULL,
	"lifecycle_failure" text COLLATE "C",
	"desired_by_user" text COLLATE "C",
	"desired_by_agent" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "sessions_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "sessions_stop_reason_check" CHECK (stop_reason IS NULL OR stop_reason IN ('self', 'parent', 'forced', 'exited')),
	CONSTRAINT "sessions_created_by_actor_kind" CHECK (created_by_actor_kind IS NULL OR created_by_actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "sessions_created_by_system_has_no_human" CHECK (created_by_actor_kind <> 'system' OR created_by_on_behalf_of IS NULL)
);
--> statement-breakpoint
CREATE TABLE "settings_audit_events" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "settings_audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"command" text COLLATE "C" NOT NULL,
	"outcome" text COLLATE "C" NOT NULL,
	"actor_kind" text COLLATE "C" NOT NULL,
	"actor_id" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"detail_json" json DEFAULT '{}' NOT NULL,
	"redacted_paths" json DEFAULT '[]' NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C" NOT NULL,
	CONSTRAINT "settings_audit_events_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "settings_audit_events_outcome" CHECK (outcome IN ('applied', 'refused')),
	CONSTRAINT "settings_audit_events_actor_kind" CHECK (actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "settings_audit_events_system_has_no_human" CHECK (actor_kind <> 'system' OR on_behalf_of IS NULL)
);
--> statement-breakpoint
CREATE TABLE "ship_attempts" (
	"id" text COLLATE "C",
	"order_id" text COLLATE "C" NOT NULL,
	"expected_source_base_sha" text COLLATE "C" NOT NULL,
	"approved_head_sha" text COLLATE "C" NOT NULL,
	"expected_target_sha" text COLLATE "C" NOT NULL,
	"machine_id" text COLLATE "C" NOT NULL,
	"lease_generation" bigint NOT NULL,
	"started_at" timestamp(3) with time zone NOT NULL,
	"finished_at" timestamp(3) with time zone,
	"outcome" text COLLATE "C",
	"submitted_head_sha" text COLLATE "C" NOT NULL,
	"tested_integration_sha" text COLLATE "C",
	"landed_ref_sha" text COLLATE "C",
	"destination_sha" text COLLATE "C",
	"validation_profile_id" text COLLATE "C",
	"validation_result" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_attempts_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "idx_ship_attempts_id_order" UNIQUE("workspace_id","id","order_id"),
	CONSTRAINT "ship_attempts_generation_check" CHECK (lease_generation >= 0),
	CONSTRAINT "ship_attempts_terminal_pair_check" CHECK ((finished_at IS NULL AND outcome IS NULL) OR (finished_at IS NOT NULL AND outcome IS NOT NULL)),
	CONSTRAINT "ship_attempts_outcome_check" CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ship_attempts_validation_pair_check" CHECK ((validation_profile_id IS NULL AND validation_result IS NULL) OR (validation_profile_id IS NOT NULL AND validation_result IS NOT NULL)),
	CONSTRAINT "ship_attempts_validation_result_check" CHECK (validation_result IS NULL OR validation_result IN ('passed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "ship_effect_envelopes" (
	"effect_key" text COLLATE "C",
	"train_id" text COLLATE "C" NOT NULL,
	"attempt_id" text COLLATE "C" NOT NULL,
	"request_digest" text COLLATE "C" NOT NULL,
	"request_json" json NOT NULL,
	"result_json" json NOT NULL,
	"recorded_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_effect_envelopes_pk" PRIMARY KEY("workspace_id","effect_key")
);
--> statement-breakpoint
CREATE TABLE "ship_evidence" (
	"ref" text COLLATE "C",
	"custody_digest" text COLLATE "C" NOT NULL,
	"content_digest" text COLLATE "C" NOT NULL,
	"source_ref" text COLLATE "C" NOT NULL,
	"content" text COLLATE "C" NOT NULL,
	"materialized_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_evidence_pk" PRIMARY KEY("workspace_id","ref"),
	CONSTRAINT "ship_evidence_custody_digest_check" CHECK (length(custody_digest) = 64 AND translate(custody_digest, '0123456789abcdef', '') = ''),
	CONSTRAINT "ship_evidence_content_digest_check" CHECK (length(content_digest) = 64 AND translate(content_digest, '0123456789abcdef', '') = '')
);
--> statement-breakpoint
CREATE TABLE "ship_holds" (
	"id" text COLLATE "C",
	"order_id" text COLLATE "C" NOT NULL,
	"generation" bigint NOT NULL,
	"reason_code" text COLLATE "C" NOT NULL,
	"headline" text COLLATE "C" NOT NULL,
	"detail" text COLLATE "C" NOT NULL,
	"evidence_refs" text COLLATE "C" DEFAULT '[]' NOT NULL,
	"actions" json DEFAULT '[]' NOT NULL,
	"raised_at" timestamp(3) with time zone NOT NULL,
	"resolved_at" timestamp(3) with time zone,
	"resolution" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_holds_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "ship_holds_generation_check" CHECK (generation > 0),
	CONSTRAINT "ship_holds_resolution_pair_check" CHECK ((resolved_at IS NULL AND resolution IS NULL) OR (resolved_at IS NOT NULL AND resolution IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ship_lane_revisions" (
	"lane_key" text COLLATE "C",
	"revision" bigint NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_lane_revisions_pk" PRIMARY KEY("workspace_id","lane_key")
);
--> statement-breakpoint
CREATE TABLE "ship_order_stack_edges" (
	"upper_order_id" text COLLATE "C",
	"lower_order_id" text COLLATE "C",
	"upper_approved_head_sha" text COLLATE "C" NOT NULL,
	"lower_approved_head_sha" text COLLATE "C" NOT NULL,
	"recorded_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_order_stack_edges_pk" PRIMARY KEY("workspace_id","upper_order_id","lower_order_id"),
	CONSTRAINT "ship_order_stack_edges_distinct_check" CHECK (upper_order_id <> lower_order_id)
);
--> statement-breakpoint
CREATE TABLE "ship_orders" (
	"id" text COLLATE "C",
	"issue_id" text COLLATE "C" NOT NULL,
	"repo_id" text COLLATE "C" NOT NULL,
	"repo_path" text COLLATE "C",
	"machine_id" text COLLATE "C",
	"target_branch" text COLLATE "C" NOT NULL,
	"destination" text COLLATE "C" NOT NULL,
	"approved_base_sha" text COLLATE "C" NOT NULL,
	"approved_head_sha" text COLLATE "C" NOT NULL,
	"descendant_manifest" json DEFAULT '[]' NOT NULL,
	"delivery_depends_on" json DEFAULT '[]' NOT NULL,
	"evidence_manifest_ref" text COLLATE "C",
	"current_integration_receipt" json,
	"provider_ref" text COLLATE "C",
	"requested_by_actor_kind" text COLLATE "C" NOT NULL,
	"requested_by_actor_id" text COLLATE "C" NOT NULL,
	"requested_by_on_behalf_of" text COLLATE "C",
	"requested_at" timestamp(3) with time zone NOT NULL,
	"policy_id" text COLLATE "C" NOT NULL,
	"validation_profile" json,
	"validation_profile_digest" text COLLATE "C",
	"close_mode" text COLLATE "C" NOT NULL,
	"state" text COLLATE "C" NOT NULL,
	"state_changed_at" timestamp(3) with time zone NOT NULL,
	"hold_code" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_orders_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "idx_ship_orders_id_issue" UNIQUE("workspace_id","id","issue_id"),
	CONSTRAINT "ship_orders_state_check" CHECK (state IN ('queued', 'preflight', 'composing', 'validating', 'repairing', 'landing', 'publishing', 'verifying', 'shipped', 'held', 'cancelled')),
	CONSTRAINT "ship_orders_close_mode_check" CHECK (close_mode IN ('after-destination', 'leave-open')),
	CONSTRAINT "ship_orders_hold_code_check" CHECK ((state = 'held' AND hold_code IS NOT NULL) OR (state <> 'held' AND hold_code IS NULL)),
	CONSTRAINT "ship_orders_requested_by_actor_kind_check" CHECK (requested_by_actor_kind IN ('user', 'agent', 'machine', 'system')),
	CONSTRAINT "ship_orders_requested_by_system_has_no_human_check" CHECK (requested_by_actor_kind <> 'system' OR requested_by_on_behalf_of IS NULL)
);
--> statement-breakpoint
CREATE TABLE "ship_recovery_revision" (
	"id" bigint,
	"revision" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_recovery_revision_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "ship_recovery_revision_singleton" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "ship_recovery_work" (
	"key" text COLLATE "C",
	"kind" text COLLATE "C" NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"payload" json NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_recovery_work_pk" PRIMARY KEY("workspace_id","key"),
	CONSTRAINT "ship_recovery_work_kind_check" CHECK (kind IN ('daemon-ack', 'repair-ack', 'descendants'))
);
--> statement-breakpoint
CREATE TABLE "ship_repair_candidates" (
	"order_id" text COLLATE "C" NOT NULL,
	"attempt_id" text COLLATE "C",
	"generation" bigint NOT NULL,
	"sequence" bigint,
	"round" bigint NOT NULL,
	"context_digest" text COLLATE "C" NOT NULL,
	"repair_ref" text COLLATE "C" NOT NULL,
	"candidate_head_sha" text COLLATE "C" NOT NULL,
	"result_token" text COLLATE "C" NOT NULL,
	"recorded_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_repair_candidates_pk" PRIMARY KEY("workspace_id","attempt_id","sequence"),
	CONSTRAINT "ship_repair_candidates_generation_check" CHECK (generation > 0),
	CONSTRAINT "ship_repair_candidates_sequence_check" CHECK (sequence > 0 AND round = sequence),
	CONSTRAINT "ship_repair_candidates_context_check" CHECK (length(context_digest) = 64 AND translate(context_digest, '0123456789abcdef', '') = '')
);
--> statement-breakpoint
CREATE TABLE "ship_steps" (
	"id" text COLLATE "C",
	"order_id" text COLLATE "C" NOT NULL,
	"attempt_id" text COLLATE "C" NOT NULL,
	"effect_key" text COLLATE "C" NOT NULL,
	"idempotency_key" text COLLATE "C" NOT NULL,
	"generation" bigint NOT NULL,
	"input_fence" json NOT NULL,
	"kind" text COLLATE "C" NOT NULL,
	"state" text COLLATE "C" NOT NULL,
	"outcome" text COLLATE "C",
	"summary" text COLLATE "C" NOT NULL,
	"artifact_ref" text COLLATE "C",
	"recorded_at" timestamp(3) with time zone NOT NULL,
	"started_at" timestamp(3) with time zone,
	"finished_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_steps_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "ship_steps_generation_check" CHECK (generation >= 0),
	CONSTRAINT "ship_steps_state_check" CHECK (state IN ('planned', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ship_steps_lifecycle_check" CHECK ((state = 'planned' AND started_at IS NULL AND finished_at IS NULL AND outcome IS NULL)
          OR (state = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND outcome IS NULL)
          OR (state IN ('succeeded', 'failed', 'cancelled') AND started_at IS NOT NULL AND finished_at IS NOT NULL AND outcome IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ship_train_active_claims" (
	"train_id" text COLLATE "C",
	"order_id" text COLLATE "C",
	"attempt_id" text COLLATE "C" NOT NULL,
	"generation" bigint NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_train_active_claims_pk" PRIMARY KEY("workspace_id","train_id","order_id"),
	CONSTRAINT "ship_train_active_claims_generation_check" CHECK (generation > 0)
);
--> statement-breakpoint
CREATE TABLE "ship_train_manifests" (
	"id" text COLLATE "C",
	"version" bigint NOT NULL,
	"subset_id" text COLLATE "C" NOT NULL,
	"repair_round" bigint NOT NULL,
	"canonical_digest" text COLLATE "C" NOT NULL,
	"canonical_json" json NOT NULL,
	"repo_id" text COLLATE "C" NOT NULL,
	"repo_path" text COLLATE "C" NOT NULL,
	"machine_id" text COLLATE "C" NOT NULL,
	"lane_key" text COLLATE "C" NOT NULL,
	"lane_revision" bigint NOT NULL,
	"target_branch" text COLLATE "C" NOT NULL,
	"expected_target_sha" text COLLATE "C" NOT NULL,
	"destination" text COLLATE "C" NOT NULL,
	"provider_ref" json,
	"policy_id" text COLLATE "C" NOT NULL,
	"validation_profile" json NOT NULL,
	"validation_profile_digest" text COLLATE "C" NOT NULL,
	"member_count" bigint NOT NULL,
	"leader_order_id" text COLLATE "C" NOT NULL,
	"leader_attempt_id" text COLLATE "C" NOT NULL,
	"leader_generation" bigint NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"released_at" timestamp(3) with time zone,
	"release_reason" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_train_manifests_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "ship_train_manifests_version_check" CHECK (version = 1),
	CONSTRAINT "ship_train_manifests_repair_round_check" CHECK (repair_round = 0),
	CONSTRAINT "ship_train_manifests_generation_check" CHECK (leader_generation > 0),
	CONSTRAINT "ship_train_manifests_lane_revision_check" CHECK (lane_revision > 0),
	CONSTRAINT "ship_train_manifests_member_count_check" CHECK (member_count > 0),
	CONSTRAINT "ship_train_manifests_release_pair_check" CHECK ((released_at IS NULL AND release_reason IS NULL) OR (released_at IS NOT NULL AND release_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ship_train_members" (
	"train_id" text COLLATE "C",
	"ordinal" bigint,
	"issue_id" text COLLATE "C" NOT NULL,
	"order_id" text COLLATE "C" NOT NULL,
	"attempt_id" text COLLATE "C" NOT NULL,
	"generation" bigint NOT NULL,
	"machine_id" text COLLATE "C" NOT NULL,
	"source_branch" text COLLATE "C" NOT NULL,
	"approved_base_sha" text COLLATE "C" NOT NULL,
	"approved_head_sha" text COLLATE "C" NOT NULL,
	"delivery_depends_on" json NOT NULL,
	"released_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "ship_train_members_pk" PRIMARY KEY("workspace_id","train_id","ordinal"),
	CONSTRAINT "idx_ship_train_members_order" UNIQUE("workspace_id","train_id","order_id"),
	CONSTRAINT "idx_ship_train_members_issue" UNIQUE("workspace_id","train_id","issue_id"),
	CONSTRAINT "idx_ship_train_members_attempt" UNIQUE("workspace_id","train_id","attempt_id"),
	CONSTRAINT "idx_ship_train_members_source" UNIQUE("workspace_id","train_id","source_branch"),
	CONSTRAINT "ship_train_members_ordinal_check" CHECK (ordinal >= 0),
	CONSTRAINT "ship_train_members_generation_check" CHECK (generation > 0)
);
--> statement-breakpoint
CREATE TABLE "snoozes" (
	"user_id" text COLLATE "C",
	"session_id" text COLLATE "C",
	"snoozed_until" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "snoozes_pk" PRIMARY KEY("workspace_id","user_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "steward_state" (
	"key" text COLLATE "C",
	"value" text COLLATE "C" NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "steward_state_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "subscription_deliveries" (
	"subscription_id" text COLLATE "C",
	"event_id" bigint,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "subscription_deliveries_pk" PRIMARY KEY("workspace_id","subscription_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text COLLATE "C",
	"subscriber_kind" text COLLATE "C" NOT NULL,
	"subscriber_id" text COLLATE "C" NOT NULL,
	"event" text COLLATE "C" NOT NULL,
	"source_kind" text COLLATE "C" NOT NULL,
	"source_ref" text COLLATE "C" NOT NULL,
	"deliver_nudge" boolean DEFAULT true NOT NULL,
	"deliver_notify" boolean DEFAULT false NOT NULL,
	"origin" text COLLATE "C" DEFAULT 'custom' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "subscriptions_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "superagent_messages" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "superagent_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_user_id" text COLLATE "C" NOT NULL,
	"role" text COLLATE "C" NOT NULL,
	"content" text COLLATE "C" NOT NULL,
	"tool_calls" json,
	"tool_call_id" text COLLATE "C",
	"tool_name" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"thread_id" text COLLATE "C" DEFAULT 'global' NOT NULL,
	"workspace_id" text COLLATE "C" NOT NULL,
	CONSTRAINT "superagent_messages_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "superagent_pending_turns" (
	"owner_user_id" text COLLATE "C" NOT NULL,
	"turn_id" text COLLATE "C",
	"thread_id" text COLLATE "C" NOT NULL,
	"podium_session_id" text COLLATE "C" NOT NULL,
	"payload_json" json NOT NULL,
	"first_turn" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"actor" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "superagent_pending_turns_pk" PRIMARY KEY("workspace_id","turn_id"),
	CONSTRAINT "superagent_pending_turns_thread_id_unique" UNIQUE("workspace_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "superagent_queued_inputs" (
	"owner_user_id" text COLLATE "C" NOT NULL,
	"input_id" text COLLATE "C",
	"thread_id" text COLLATE "C" NOT NULL,
	"text" text COLLATE "C" NOT NULL,
	"focus_json" json,
	"agent_kind" text COLLATE "C",
	"attach_session_id" text COLLATE "C",
	"model" text COLLATE "C",
	"effort" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"actor" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "superagent_queued_inputs_pk" PRIMARY KEY("workspace_id","input_id")
);
--> statement-breakpoint
CREATE TABLE "superagent_threads" (
	"id" text COLLATE "C",
	"owner_user_id" text COLLATE "C" NOT NULL,
	"kind" text COLLATE "C" NOT NULL,
	"origin_session_id" text COLLATE "C",
	"title" text COLLATE "C",
	"watermark_item_id" text COLLATE "C",
	"watermark_ts" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"repo_path" text COLLATE "C",
	"agent_kind" text COLLATE "C",
	"podium_session_id" text COLLATE "C",
	"harness_session_id" text COLLATE "C",
	"terminal_session_id" text COLLATE "C",
	"model" text COLLATE "C",
	"effort" text COLLATE "C",
	"turn_running" boolean DEFAULT false NOT NULL,
	"last_turn_failure_at" timestamp(3) with time zone,
	"last_turn_failure_message" text COLLATE "C",
	"last_turn_failure_user_text" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "superagent_threads_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "sync_capture" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "sync_capture_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text COLLATE "C" NOT NULL,
	"source" bigint NOT NULL,
	"op" text COLLATE "C" NOT NULL,
	"old_key" text COLLATE "C",
	"new_key" text COLLATE "C",
	"undrained" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_capture_guard" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "sync_capture_guard_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1)
);
--> statement-breakpoint
CREATE TABLE "sync_feed" (
	"workspace_id" text COLLATE "C",
	"feed_id" text COLLATE "C" NOT NULL,
	"epoch" text COLLATE "C" NOT NULL,
	"minted_at" bigint NOT NULL,
	"head_seq" bigint NOT NULL,
	"floor_seq" bigint NOT NULL,
	CONSTRAINT "sync_feed_pk" PRIMARY KEY("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "sync_kind" (
	"workspace_id" text COLLATE "C",
	"kind" text COLLATE "C",
	"generation" bigint NOT NULL,
	CONSTRAINT "sync_kind_pkey" PRIMARY KEY("workspace_id","kind")
);
--> statement-breakpoint
CREATE TABLE "tab_order" (
	"user_id" text COLLATE "C",
	"worktree" text COLLATE "C",
	"ids" json NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "tab_order_pk" PRIMARY KEY("workspace_id","user_id","worktree")
);
--> statement-breakpoint
CREATE TABLE "telegram_chat_bindings" (
	"chat_id" text COLLATE "C",
	"user_id" text COLLATE "C" NOT NULL,
	"bound_at" timestamp(3) with time zone NOT NULL,
	"actor_kind" text COLLATE "C" NOT NULL,
	"actor_id" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"workspace_id" text COLLATE "C",
	CONSTRAINT "telegram_chat_bindings_pk" PRIMARY KEY("workspace_id","chat_id")
);
--> statement-breakpoint
CREATE TABLE "transcript_costs" (
	"machine_id" text COLLATE "C",
	"native_id" text COLLATE "C",
	"path" text COLLATE "C" NOT NULL,
	"harness" text COLLATE "C" NOT NULL,
	"session_id" text COLLATE "C",
	"issue_id" text COLLATE "C",
	"scanned_bytes" bigint DEFAULT 0 NOT NULL,
	"first_ts_ms" bigint DEFAULT 0 NOT NULL,
	"last_ts_ms" bigint DEFAULT 0 NOT NULL,
	"messages" bigint DEFAULT 0 NOT NULL,
	"models_json" json NOT NULL,
	"window_models_json" json DEFAULT '[]' NOT NULL,
	"window_since_ms" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "transcript_costs_pk" PRIMARY KEY("workspace_id","machine_id","native_id")
);
--> statement-breakpoint
CREATE TABLE "transcript_text" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "transcript_text_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" text COLLATE "C" NOT NULL,
	"machine_id" text COLLATE "C" NOT NULL,
	"native_id" text COLLATE "C" NOT NULL,
	"item_uuid" text COLLATE "C",
	"ts" text COLLATE "C",
	"content" text COLLATE "C" NOT NULL,
	"search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', translate(left("content", 250000), '!"#$%&''()*+,-./:;<=>?@[\]^_`{|}~ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĐĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦĨĩĪīĬĭĮįİĲĴĵĶķĹĺĻļĽľĿŁŃńŅņŇňŊŌōŎŏŐőŒŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠơƢƤƦƧƩƬƮƯưƱƲƳƵƷƸƼǄǅǇǈǊǋǍǎǏǐǑǒǓǔǕǗǙǛǞǠǢǤǦǧǨǩǪǫǬǮǰǱǲǴǵǶǷǸǹǺǼǾȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȜȞȟȠȢȤȦȧȨȩȪȬȮȯȰȲȳȺȻȽȾɁɃɄɅɆɈɊɌɎ', '                                aaaaaaæceeeeiiiiðnoooooøuuuuyþaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccddđeeeeeeeeeegggggggghhħiiiiiiiiiĳjjkkllllllŀłnnnnnnŋooooooœrrrrrrssssssssttttŧuuuuuuuuuuuuwwyyyzzzzzzsɓƃƅɔƈɖɗƌǝəɛƒɠɣɩɨƙɯɲɵooƣƥʀƨʃƭʈuuʊʋƴƶʒƹƽǆǆǉǉǌǌaaiioouuǖǘǚǜǟǡǣǥggkkooǭǯjǳǳggƕƿnnǻǽǿaaaaeeeeiiiioooorrrruuuussttȝhhƞȣȥaaeeȫȭooȱyyⱥȼƚⱦɂƀʉʌɇɉɋɍɏ'))) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_outbox" (
	"mutation_id" text COLLATE "C",
	"proc" text COLLATE "C" NOT NULL,
	"input" text COLLATE "C" NOT NULL,
	"queued_at" bigint NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text COLLATE "C",
	"queue_order" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "upstream_outbox_pk" PRIMARY KEY("workspace_id","mutation_id")
);
--> statement-breakpoint
CREATE TABLE "user_dock_shell" (
	"user_id" text COLLATE "C",
	"worktree_key" text COLLATE "C",
	"session_id" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "user_dock_shell_pk" PRIMARY KEY("workspace_id","user_id","worktree_key")
);
--> statement-breakpoint
CREATE TABLE "user_layout" (
	"user_id" text COLLATE "C",
	"key" text COLLATE "C",
	"value" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "user_layout_pk" PRIMARY KEY("workspace_id","user_id","key")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text COLLATE "C",
	"key" text COLLATE "C",
	"value" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "user_preferences_pk" PRIMARY KEY("workspace_id","user_id","key")
);
--> statement-breakpoint
CREATE TABLE "user_read_position" (
	"user_id" text COLLATE "C",
	"stream_id" text COLLATE "C",
	"last_event_id" bigint NOT NULL,
	"seen_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "user_read_position_pk" PRIMARY KEY("workspace_id","user_id","stream_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text COLLATE "C",
	"display_name" text COLLATE "C" NOT NULL,
	"email" text COLLATE "C",
	"account_id" text COLLATE "C",
	"avatar" text COLLATE "C",
	"role" text COLLATE "C" NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"disabled_at" timestamp(3) with time zone,
	"authz_generation" bigint DEFAULT 0 NOT NULL,
	"authz_changed_at" timestamp(3) with time zone,
	"membership_version" bigint DEFAULT 0 NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "users_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "workflow_bindings" (
	"target_kind" text COLLATE "C",
	"target_id" text COLLATE "C",
	"revision_id" text COLLATE "C" NOT NULL,
	"updated_by_kind" text COLLATE "C" NOT NULL,
	"updated_by_id" text COLLATE "C",
	"updated_at" timestamp(3) with time zone NOT NULL,
	"owner_user_id" text COLLATE "C" NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "workflow_bindings_pk" PRIMARY KEY("workspace_id","target_kind","target_id"),
	CONSTRAINT "workflow_bindings_check_13" CHECK (target_kind IN ('global', 'repository', 'issue', 'session')),
	CONSTRAINT "workflow_bindings_check_14" CHECK (updated_by_kind IN ('operator', 'session'))
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "workflow_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workflow_id" text COLLATE "C",
	"run_id" text COLLATE "C",
	"kind" text COLLATE "C" NOT NULL,
	"actor_kind" text COLLATE "C" NOT NULL,
	"actor_id" text COLLATE "C",
	"on_behalf_of" text COLLATE "C",
	"payload_json" json DEFAULT '{}' NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"workspace_id" text COLLATE "C" NOT NULL,
	CONSTRAINT "workflow_events_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "workflow_events_check_19" CHECK (actor_kind IN ('operator', 'session'))
);
--> statement-breakpoint
CREATE TABLE "workflow_revisions" (
	"id" text COLLATE "C",
	"workflow_id" text COLLATE "C" NOT NULL,
	"version" bigint NOT NULL,
	"instructions" text COLLATE "C" NOT NULL,
	"steps_json" json DEFAULT '[]' NOT NULL,
	"created_by_kind" text COLLATE "C" NOT NULL,
	"created_by_id" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"published_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "workflow_revisions_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "workflow_revisions_workspace_id_workflow_id_version_unique" UNIQUE("workspace_id","workflow_id","version"),
	CONSTRAINT "workflow_revisions_check_11" CHECK (version > 0),
	CONSTRAINT "workflow_revisions_check_12" CHECK (created_by_kind IN ('operator', 'session'))
);
--> statement-breakpoint
CREATE TABLE "workflow_run_steps" (
	"run_id" text COLLATE "C",
	"step_id" text COLLATE "C",
	"position" bigint NOT NULL,
	"title" text COLLATE "C" NOT NULL,
	"instructions" text COLLATE "C" DEFAULT '' NOT NULL,
	"completion_guidance" text COLLATE "C" DEFAULT '' NOT NULL,
	"agent_profile_id" text COLLATE "C",
	"agent_profile_json" json,
	"status" text COLLATE "C" NOT NULL,
	"assigned_session_id" text COLLATE "C",
	"attempt" bigint DEFAULT 1 NOT NULL,
	"summary" text COLLATE "C" DEFAULT '' NOT NULL,
	"evidence_json" json DEFAULT '{}' NOT NULL,
	"observation_json" json,
	"warnings_json" json DEFAULT '[]' NOT NULL,
	"started_at" timestamp(3) with time zone,
	"completed_at" timestamp(3) with time zone,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "workflow_run_steps_pk" PRIMARY KEY("workspace_id","run_id","step_id"),
	CONSTRAINT "workflow_run_steps_workspace_id_run_id_position_unique" UNIQUE("workspace_id","run_id","position"),
	CONSTRAINT "workflow_run_steps_check_16" CHECK (position >= 0),
	CONSTRAINT "workflow_run_steps_check_17" CHECK (status IN ('pending', 'active', 'blocked', 'complete', 'skipped')),
	CONSTRAINT "workflow_run_steps_check_18" CHECK (attempt > 0)
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text COLLATE "C",
	"subject_kind" text COLLATE "C" NOT NULL,
	"subject_id" text COLLATE "C" NOT NULL,
	"coordinator_session_id" text COLLATE "C" NOT NULL,
	"revision_id" text COLLATE "C" NOT NULL,
	"status" text COLLATE "C" NOT NULL,
	"supersedes_run_id" text COLLATE "C",
	"started_at" timestamp(3) with time zone NOT NULL,
	"completed_at" timestamp(3) with time zone,
	"owner_user_id" text COLLATE "C" NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "workflow_runs_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "workflow_runs_check_23" CHECK (subject_kind IN ('issue', 'session')),
	CONSTRAINT "workflow_runs_check_24" CHECK (status IN ('active', 'blocked', 'complete', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text COLLATE "C",
	"name" text COLLATE "C" NOT NULL,
	"description" text COLLATE "C" DEFAULT '' NOT NULL,
	"scope" text COLLATE "C" NOT NULL,
	"scope_ref" text COLLATE "C",
	"latest_revision_id" text COLLATE "C",
	"archived_at" timestamp(3) with time zone,
	"created_by_kind" text COLLATE "C" NOT NULL,
	"created_by_id" text COLLATE "C",
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"owner_user_id" text COLLATE "C" NOT NULL,
	"workspace_id" text COLLATE "C",
	CONSTRAINT "workflows_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "workflows_check_21" CHECK (scope IN ('global', 'repository', 'task')),
	CONSTRAINT "workflows_check_22" CHECK (created_by_kind IN ('operator', 'session'))
);
--> statement-breakpoint
CREATE TABLE "workspace_meta" (
	"workspace_id" text COLLATE "C",
	"key" text COLLATE "C",
	"value" text COLLATE "C" NOT NULL,
	CONSTRAINT "workspace_meta_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "workspace_secrets" (
	"workspace_id" text COLLATE "C",
	"key" text COLLATE "C",
	"value" text COLLATE "C" NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "workspace_secrets_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_account_key" ON "accounts" ("workspace_id","owner_user_id","account_key");--> statement-breakpoint
CREATE INDEX "idx_accounts_account_key" ON "accounts" ("workspace_id","account_key");--> statement-breakpoint
CREATE INDEX "idx_applied_mutations_applied_at" ON "applied_mutations" ("workspace_id","applied_at");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_status" ON "approval_requests" ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_artifact_uploads_created" ON "artifact_uploads" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_automation" ON "automation_runs" ("workspace_id","automation_id","fired_at");--> statement-breakpoint
CREATE INDEX "idx_carried_sign_ins_expires" ON "carried_sign_ins" ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_carried_sign_ins_member" ON "carried_sign_ins" ("workspace_id","member_id");--> statement-breakpoint
CREATE INDEX "idx_carried_sign_ins_label" ON "carried_sign_ins" ("workspace_id","old_label");--> statement-breakpoint
CREATE INDEX "changes_entity" ON "changes" ("workspace_id","entity","entity_id","seq");--> statement-breakpoint
CREATE INDEX "changes_event_time" ON "changes" ("workspace_id","event_time","seq");--> statement-breakpoint
CREATE INDEX "idx_checkout_lost_machine" ON "checkout_lost" ("workspace_id","machine_id");--> statement-breakpoint
CREATE INDEX "idx_checkout_reach_machine" ON "checkout_reach" ("workspace_id","machine_id");--> statement-breakpoint
CREATE INDEX "idx_checkouts_root" ON "checkouts" ("workspace_id","machine_id","root");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_client_sessions_session_id" ON "client_sessions" ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_client_sessions_user" ON "client_sessions" ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_client_sessions_expires" ON "client_sessions" ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_client_sessions_label" ON "client_sessions" ("workspace_id","label");--> statement-breakpoint
CREATE INDEX "conversation_segment_incarnations_native" ON "conversation_segment_incarnations" ("workspace_id","machine_id","native_id","sequence");--> statement-breakpoint
CREATE INDEX "conversation_segments_podium" ON "conversation_segments" ("workspace_id","podium_id","seq_in_conv");--> statement-breakpoint
CREATE INDEX "conversation_segments_path" ON "conversation_segments" ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "idx_conversations_project_path" ON "conversations" ("workspace_id","project_path");--> statement-breakpoint
CREATE INDEX "idx_conversations_updated_at" ON "conversations" ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_conversations_top_level_updated" ON "conversations" ("workspace_id","updated_at","id") WHERE "parent_conversation_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_conversations_search" ON "conversations" USING gin (to_tsvector('simple', translate(coalesce("title", '') || ' ' || coalesce("name", '') || ' ' || coalesce("summary", '') || ' ' || coalesce("project_path", ''), '!"#$%&''()*+,-./:;<=>?@[\]^_`{|}~ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĐĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦĨĩĪīĬĭĮįİĲĴĵĶķĹĺĻļĽľĿŁŃńŅņŇňŊŌōŎŏŐőŒŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠơƢƤƦƧƩƬƮƯưƱƲƳƵƷƸƼǄǅǇǈǊǋǍǎǏǐǑǒǓǔǕǗǙǛǞǠǢǤǦǧǨǩǪǫǬǮǰǱǲǴǵǶǷǸǹǺǼǾȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȜȞȟȠȢȤȦȧȨȩȪȬȮȯȰȲȳȺȻȽȾɁɃɄɅɆɈɊɌɎ', '                                aaaaaaæceeeeiiiiðnoooooøuuuuyþaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccddđeeeeeeeeeegggggggghhħiiiiiiiiiĳjjkkllllllŀłnnnnnnŋooooooœrrrrrrssssssssttttŧuuuuuuuuuuuuwwyyyzzzzzzsɓƃƅɔƈɖɗƌǝəɛƒɠɣɩɨƙɯɲɵooƣƥʀƨʃƭʈuuʊʋƴƶʒƹƽǆǆǉǉǌǌaaiioouuǖǘǚǜǟǡǣǥggkkooǭǯjǳǳggƕƿnnǻǽǿaaaaeeeeiiiioooorrrruuuussttȝhhƞȣȥaaeeȫȭooȱyyⱥȼƚⱦɂƀʉʌɇɉɋɍɏ')));--> statement-breakpoint
CREATE UNIQUE INDEX "idx_delivery_receipts_order" ON "delivery_receipts" ("workspace_id","order_id");--> statement-breakpoint
CREATE INDEX "idx_effects_status_deadline" ON "effects" ("workspace_id","status","deadline_at");--> statement-breakpoint
CREATE INDEX "idx_effects_status_finished" ON "effects" ("workspace_id","status","finished_at");--> statement-breakpoint
CREATE INDEX "idx_effects_deleted" ON "effects" ("workspace_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_effects_target" ON "effects" ("workspace_id","target_kind","target_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_effects_kind_target" ON "effects" ("workspace_id","kind","target_kind","target_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_effects_awaiting" ON "effects" ("workspace_id","kind","created_at") WHERE decision = 'awaiting';--> statement-breakpoint
CREATE INDEX "idx_effects_unpublished" ON "effects" ("workspace_id","revision") WHERE revision = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "grants_machine_custodian" ON "grants" ("workspace_id","resource_id") WHERE "resource_kind" = 'machine' AND "custody" = true;--> statement-breakpoint
CREATE INDEX "idx_grants_grantee" ON "grants" ("workspace_id","grantee");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "account_providerId_idx" ON "account" ("provider_id");--> statement-breakpoint
CREATE INDEX "identity_invitation_member_idx" ON "identity_invitation" ("workspace_id","member_id");--> statement-breakpoint
CREATE INDEX "identity_invitation_expires_idx" ON "identity_invitation" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_membership_live_account_idx" ON "identity_membership" ("workspace_id","account_id") WHERE account_id is not null and status in ('active', 'disabled');--> statement-breakpoint
CREATE INDEX "identity_membership_account_idx" ON "identity_membership" ("account_id");--> statement-breakpoint
CREATE INDEX "identity_membership_version_idx" ON "identity_membership" ("workspace_id","version");--> statement-breakpoint
CREATE INDEX "identity_one_time_code_expires_idx" ON "identity_one_time_code" ("expires_at");--> statement-breakpoint
CREATE INDEX "identity_one_time_code_challenge_idx" ON "identity_one_time_code" ("receiver_challenge");--> statement-breakpoint
CREATE INDEX "identity_one_time_code_account_idx" ON "identity_one_time_code" ("account_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE INDEX "idx_issue_comments_issue_time" ON "issue_comments" ("workspace_id","issue_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_issue_deps_to_from" ON "issue_deps" ("workspace_id","to_id","from_id","type");--> statement-breakpoint
CREATE INDEX "idx_issue_deps_from" ON "issue_deps" ("workspace_id","from_id");--> statement-breakpoint
CREATE INDEX "idx_issue_labels_label_id" ON "issue_labels" ("workspace_id","label_id");--> statement-breakpoint
CREATE INDEX "idx_issue_messages_issue_time" ON "issue_messages" ("workspace_id","issue_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_issue_panel_artifacts_order" ON "issue_panel_artifacts" ("workspace_id","issue_id","position","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_issue_panel_artifacts_path" ON "issue_panel_artifacts" ("workspace_id","issue_id","path");--> statement-breakpoint
CREATE INDEX "idx_issue_panel_deferred_order" ON "issue_panel_deferred" ("workspace_id","issue_id","position","id");--> statement-breakpoint
CREATE INDEX "idx_issue_panel_todos_order" ON "issue_panel_todos" ("workspace_id","issue_id","position","id");--> statement-breakpoint
CREATE INDEX "idx_issue_text_revisions_issue_field" ON "issue_text_revisions" ("workspace_id","issue_id","field","id");--> statement-breakpoint
CREATE INDEX "idx_issue_user_state_issue" ON "issue_user_state" ("workspace_id","issue_id");--> statement-breakpoint
CREATE INDEX "idx_issues_deleted_at" ON "issues" ("workspace_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_issues_closed_projection" ON "issues" ("workspace_id","id","stage","closed_reason","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_issues_repo_id_seq" ON "issues" ("workspace_id","repo_id","seq");--> statement-breakpoint
CREATE INDEX "idx_issues_parent" ON "issues" ("workspace_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_issues_seq" ON "issues" ("workspace_id","seq","repo_path","id");--> statement-breakpoint
CREATE INDEX "idx_issues_repo" ON "issues" ("workspace_id","repo_path");--> statement-breakpoint
CREATE INDEX "idx_issues_worktree" ON "issues" ("workspace_id","worktree_path") WHERE "worktree_path" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_issues_worktree_folded" ON "issues" ("workspace_id",lower(replace("worktree_path", '/', '\'))) WHERE "worktree_path" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_issues_superseded_by" ON "issues" ("workspace_id","superseded_by") WHERE "superseded_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_issues_duplicate_of" ON "issues" ("workspace_id","duplicate_of") WHERE "duplicate_of" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_issues_agent_profile" ON "issues" ("workspace_id","agent_profile_id") WHERE "agent_profile_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_labels_name_nocase" ON "labels" ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "idx_lock_waiters_session" ON "lock_waiters" ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_lock_waiters_lock" ON "lock_waiters" ("workspace_id","repo_id","name","id");--> statement-breakpoint
CREATE INDEX "idx_locks_expires" ON "locks" ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_locks_holder_session" ON "locks" ("workspace_id","holder_session_id");--> statement-breakpoint
CREATE INDEX "idx_message_reads_session" ON "message_reads" ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_messages_delivered_to_time" ON "messages" ("workspace_id","delivered_to","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_open_chat" ON "messages" ("workspace_id","created_at") WHERE "from_kind" = 'operator' AND "to_kind" = 'session' AND "notice_dismissed_at" IS NULL AND "delivery_status" NOT IN ('confirmed', 'cancelled');--> statement-breakpoint
CREATE INDEX "idx_messages_from_session_time" ON "messages" ("workspace_id","from_session","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_from_issue" ON "messages" ("workspace_id","from_issue","created_at","id") WHERE "from_issue" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_recipient_time" ON "messages" ("workspace_id","to_kind","to_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_reply" ON "messages" ("workspace_id","in_reply_to","kind") WHERE "in_reply_to" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_thread" ON "messages" ("workspace_id","thread_id");--> statement-breakpoint
CREATE INDEX "idx_messages_recipient_delivery" ON "messages" ("workspace_id","to_kind","to_id","delivery_status","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_delivery_order" ON "messages" ("workspace_id","delivery_status","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_delivery_expiry_explicit" ON "messages" ("workspace_id","delivery_status","expires_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_delivery_expiry_implicit" ON "messages" ("workspace_id","delivery_status","lifecycle","expires_at","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messaging_issue_topics_ref" ON "messaging_issue_topics" ("workspace_id","chat_id","thread_ref");--> statement-breakpoint
CREATE INDEX "idx_messaging_session_attachments_session" ON "messaging_session_attachments" ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_notification_facts_issue" ON "notification_facts" ("workspace_id","issue_id");--> statement-breakpoint
CREATE INDEX "idx_notification_facts_expires" ON "notification_facts" ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_operations_group_state" ON "operations" ("workspace_id","exclusion_group","state");--> statement-breakpoint
CREATE INDEX "idx_operations_kind_created" ON "operations" ("workspace_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_pending_interactions_session_time" ON "pending_interactions" ("workspace_id","session_id","asked_at","id");--> statement-breakpoint
CREATE INDEX "idx_pending_interactions_open" ON "pending_interactions" ("workspace_id","status","asked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pending_interactions_fingerprint" ON "pending_interactions" ("workspace_id","session_id","fingerprint") WHERE status = 'asked';--> statement-breakpoint
CREATE INDEX "idx_pending_uploads_created" ON "pending_uploads" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_pending_uploads_claimed" ON "pending_uploads" ("workspace_id","claimed_issue_id");--> statement-breakpoint
CREATE INDEX "idx_pins_target" ON "pins" ("workspace_id","kind","id");--> statement-breakpoint
CREATE INDEX "idx_podium_events_repo" ON "podium_events" ("workspace_id","repo_path");--> statement-breakpoint
CREATE INDEX "idx_podium_events_kind" ON "podium_events" ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "idx_podium_events_subject" ON "podium_events" ("workspace_id","subject");--> statement-breakpoint
CREATE INDEX "idx_podium_events_kind_subject_ts" ON "podium_events" ("workspace_id","kind","subject","ts");--> statement-breakpoint
CREATE INDEX "idx_podium_events_kind_subject_id" ON "podium_events" ("workspace_id","kind","subject","id");--> statement-breakpoint
CREATE INDEX "queued_messages_session" ON "queued_messages" ("workspace_id","session_id","queue_order");--> statement-breakpoint
CREATE INDEX "idx_quota_windows_series" ON "quota_windows" ("workspace_id","account_key","window_key","resets_at_ms");--> statement-breakpoint
CREATE INDEX "idx_quota_windows_owner" ON "quota_windows" ("workspace_id","owner_user_id","account_key","window_key","resets_at_ms");--> statement-breakpoint
CREATE INDEX "idx_quota_windows_resets" ON "quota_windows" ("workspace_id","resets_at_ms");--> statement-breakpoint
CREATE INDEX "idx_session_user_state_session" ON "session_user_state" ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_pending_activity" ON "sessions" ("workspace_id","last_active_publish_after","id") WHERE "published_last_active_at" < "last_active_at" AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_sessions_deleted_by_issue" ON "sessions" ("workspace_id","deleted_by_issue_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_lifecycle_pending" ON "sessions" ("workspace_id","machine_id") WHERE "revision" > "observed_revision" AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_sessions_deleted_at" ON "sessions" ("workspace_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_resume_machine" ON "sessions" ("workspace_id","resume_value","machine_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_issue" ON "sessions" ("workspace_id","issue_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_ref_issue" ON "sessions" ("workspace_id","ref_issue_id") WHERE "ref_issue_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sessions_machine" ON "sessions" ("workspace_id","machine_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_cwd" ON "sessions" ("workspace_id","cwd");--> statement-breakpoint
CREATE INDEX "idx_sessions_cwd_folded" ON "sessions" ("workspace_id",lower(replace("cwd", '/', '\')));--> statement-breakpoint
CREATE INDEX "idx_sessions_spawned_by" ON "sessions" ("workspace_id","spawned_by");--> statement-breakpoint
CREATE INDEX "idx_sessions_ref_draft" ON "sessions" ("workspace_id","ref_draft");--> statement-breakpoint
CREATE INDEX "idx_sessions_refless_place" ON "sessions" ("workspace_id","machine_id","cwd") WHERE "ref_issue_id" IS NULL AND "ref_draft" IS NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_sessions_refless_issue" ON "sessions" ("workspace_id","issue_id") WHERE "ref_issue_id" IS NULL AND "ref_draft" IS NULL AND "deleted_at" IS NULL AND "issue_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sessions_status" ON "sessions" ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "idx_sessions_headless" ON "sessions" ("workspace_id","headless") WHERE "headless" = true;--> statement-breakpoint
CREATE INDEX "settings_audit_events_command" ON "settings_audit_events" ("workspace_id","command","id");--> statement-breakpoint
CREATE INDEX "settings_audit_events_person" ON "settings_audit_events" ("workspace_id","on_behalf_of","id");--> statement-breakpoint
CREATE INDEX "settings_audit_events_result" ON "settings_audit_events" ("workspace_id","outcome","id");--> statement-breakpoint
CREATE INDEX "idx_ship_attempts_order" ON "ship_attempts" ("workspace_id","order_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_effect_envelopes_attempt_effect" ON "ship_effect_envelopes" ("workspace_id","attempt_id","effect_key");--> statement-breakpoint
CREATE INDEX "idx_ship_evidence_source" ON "ship_evidence" ("workspace_id","custody_digest","source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_holds_order_generation" ON "ship_holds" ("workspace_id","order_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_holds_one_open_order" ON "ship_holds" ("workspace_id","order_id") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_ship_order_stack_edges_lower" ON "ship_order_stack_edges" ("workspace_id","lower_order_id");--> statement-breakpoint
CREATE INDEX "idx_ship_orders_issue" ON "ship_orders" ("workspace_id","issue_id");--> statement-breakpoint
CREATE INDEX "idx_ship_orders_repo_state_id" ON "ship_orders" ("workspace_id","repo_id","state","id");--> statement-breakpoint
CREATE INDEX "idx_ship_orders_predecessors" ON "ship_orders" ("workspace_id","repo_id","state","state_changed_at","id");--> statement-breakpoint
CREATE INDEX "idx_ship_orders_recovery" ON "ship_orders" ("workspace_id","requested_at","id") WHERE state IN ('preflight', 'composing', 'validating', 'repairing', 'landing', 'publishing', 'verifying');--> statement-breakpoint
CREATE INDEX "idx_ship_orders_lane" ON "ship_orders" ("workspace_id","repo_id","destination","requested_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_orders_one_active_issue" ON "ship_orders" ("workspace_id","issue_id") WHERE state NOT IN ('shipped', 'cancelled');--> statement-breakpoint
CREATE INDEX "idx_ship_recovery_work_kind_key" ON "ship_recovery_work" ("workspace_id","kind","key");--> statement-breakpoint
CREATE INDEX "idx_ship_recovery_work_order" ON "ship_recovery_work" ("workspace_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_repair_candidates_ref" ON "ship_repair_candidates" ("workspace_id","repair_ref");--> statement-breakpoint
CREATE INDEX "idx_ship_repair_candidates_order" ON "ship_repair_candidates" ("workspace_id","order_id");--> statement-breakpoint
CREATE INDEX "idx_ship_steps_order" ON "ship_steps" ("workspace_id","order_id","recorded_at");--> statement-breakpoint
CREATE INDEX "idx_ship_steps_effect" ON "ship_steps" ("workspace_id","attempt_id","effect_key","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_steps_attempt_idempotency" ON "ship_steps" ("workspace_id","attempt_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_train_active_claims_order" ON "ship_train_active_claims" ("workspace_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_train_active_claims_attempt" ON "ship_train_active_claims" ("workspace_id","attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_train_manifests_subset" ON "ship_train_manifests" ("workspace_id","subset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_train_manifests_digest" ON "ship_train_manifests" ("workspace_id","canonical_digest");--> statement-breakpoint
CREATE INDEX "idx_ship_train_manifests_open_lane" ON "ship_train_manifests" ("workspace_id","lane_key","created_at","id") WHERE "released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_ship_train_manifests_leader" ON "ship_train_manifests" ("workspace_id","leader_order_id","leader_attempt_id","leader_generation","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ship_train_members_attempt_global" ON "ship_train_members" ("workspace_id","attempt_id");--> statement-breakpoint
CREATE INDEX "idx_ship_train_members_issue_ref" ON "ship_train_members" ("workspace_id","issue_id");--> statement-breakpoint
CREATE INDEX "idx_ship_train_members_live_custody" ON "ship_train_members" ("workspace_id","order_id","attempt_id","generation","released_at");--> statement-breakpoint
CREATE INDEX "idx_snoozes_session" ON "snoozes" ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_subscriber_event" ON "subscriptions" ("workspace_id","subscriber_id","source_kind","event");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_match" ON "subscriptions" ("workspace_id","event","source_kind","source_ref");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_created" ON "subscriptions" ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_superagent_messages_thread" ON "superagent_messages" ("workspace_id","thread_id","id");--> statement-breakpoint
CREATE INDEX "idx_superagent_queued_thread_order" ON "superagent_queued_inputs" ("workspace_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_superagent_threads_owner" ON "superagent_threads" ("workspace_id","owner_user_id","archived","updated_at");--> statement-breakpoint
CREATE INDEX "idx_superagent_threads_running" ON "superagent_threads" ("workspace_id","turn_running");--> statement-breakpoint
CREATE INDEX "idx_transcript_costs_issue" ON "transcript_costs" ("workspace_id","issue_id");--> statement-breakpoint
CREATE INDEX "idx_transcript_costs_session" ON "transcript_costs" ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_transcript_text_segment" ON "transcript_text" ("workspace_id","machine_id","native_id","id");--> statement-breakpoint
CREATE INDEX "idx_transcript_text_search" ON "transcript_text" USING gin ("search");--> statement-breakpoint
CREATE INDEX "idx_user_dock_shell_session" ON "user_dock_shell" ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_user_dock_shell_worktree" ON "user_dock_shell" ("workspace_id","worktree_key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" ("workspace_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_id_unique" ON "users" ("workspace_id","account_id");--> statement-breakpoint
CREATE INDEX "workflow_events_run" ON "workflow_events" ("workspace_id","run_id","id");--> statement-breakpoint
CREATE INDEX "workflow_events_workflow" ON "workflow_events" ("workspace_id","workflow_id","id");--> statement-breakpoint
CREATE INDEX "workflow_revisions_workflow" ON "workflow_revisions" ("workspace_id","workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflow_run_steps_assignee" ON "workflow_run_steps" ("workspace_id","assigned_session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_one_live_subject" ON "workflow_runs" ("workspace_id","subject_kind","subject_id") WHERE "status" IN ('active', 'blocked');--> statement-breakpoint
CREATE INDEX "workflow_runs_coordinator" ON "workflow_runs" ("workspace_id","coordinator_session_id","started_at" desc);--> statement-breakpoint
CREATE INDEX "workflow_runs_status" ON "workflow_runs" ("workspace_id","status","started_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_subject" ON "workflow_runs" ("workspace_id","subject_kind","subject_id","started_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_started" ON "workflow_runs" ("workspace_id","started_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_scope_name_active" ON "workflows" ("workspace_id","scope",COALESCE("scope_ref", ''),"name") WHERE "archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "account_machine_sends" ADD CONSTRAINT "fk_account_machine_sends_account_id_accounts_id_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "accounts"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "fk_automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("workspace_id","automation_id") REFERENCES "automations"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "delivery_receipts" ADD CONSTRAINT "fk_delivery_receipts_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "identity_membership" ADD CONSTRAINT "identity_membership_account_id_user_id_fkey" FOREIGN KEY ("account_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "identity_one_time_code" ADD CONSTRAINT "identity_one_time_code_account_id_user_id_fkey" FOREIGN KEY ("account_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "fk_issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_deps" ADD CONSTRAINT "fk_issue_deps_from_id_issues_id_fk" FOREIGN KEY ("workspace_id","from_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_deps" ADD CONSTRAINT "fk_issue_deps_to_id_issues_id_fk" FOREIGN KEY ("workspace_id","to_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_git_states" ADD CONSTRAINT "fk_issue_git_states_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "fk_issue_labels_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "fk_issue_labels_label_id_labels_id_fk" FOREIGN KEY ("workspace_id","label_id") REFERENCES "labels"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_messages" ADD CONSTRAINT "fk_issue_messages_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_panel_artifacts" ADD CONSTRAINT "fk_issue_panel_artifacts_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_panel_deferred" ADD CONSTRAINT "fk_issue_panel_deferred_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_panel_states" ADD CONSTRAINT "fk_issue_panel_states_id_issues_id_fk" FOREIGN KEY ("workspace_id","id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_panel_todos" ADD CONSTRAINT "fk_issue_panel_todos_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_text_revisions" ADD CONSTRAINT "fk_issue_text_revisions_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "fk_issues_parent_id_issues_id_fk" FOREIGN KEY ("workspace_id","parent_id") REFERENCES "issues"("workspace_id","id") ON DELETE SET NULL ("parent_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "fk_issues_superseded_by_issues_id_fk" FOREIGN KEY ("workspace_id","superseded_by") REFERENCES "issues"("workspace_id","id") ON DELETE SET NULL ("superseded_by");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "fk_issues_duplicate_of_issues_id_fk" FOREIGN KEY ("workspace_id","duplicate_of") REFERENCES "issues"("workspace_id","id") ON DELETE SET NULL ("duplicate_of");--> statement-breakpoint
ALTER TABLE "root_integration_receipts" ADD CONSTRAINT "fk_root_integration_receipts_root_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","root_issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "session_observation_rebinds" ADD CONSTRAINT "session_observation_rebinds_session_id_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "session_observation_checkpoints"("workspace_id","session_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_terminal_candidates" ADD CONSTRAINT "session_terminal_candidates_session_id_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "session_observation_checkpoints"("workspace_id","session_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ship_attempts" ADD CONSTRAINT "fk_ship_attempts_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_effect_envelopes" ADD CONSTRAINT "fk_ship_effect_envelopes_train_id_ship_train_manifests_id_fk" FOREIGN KEY ("workspace_id","train_id") REFERENCES "ship_train_manifests"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_effect_envelopes" ADD CONSTRAINT "fk_ship_effect_envelopes_attempt_id_ship_attempts_id_fk" FOREIGN KEY ("workspace_id","attempt_id") REFERENCES "ship_attempts"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_holds" ADD CONSTRAINT "fk_ship_holds_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_order_stack_edges" ADD CONSTRAINT "fk_ship_order_stack_edges_upper_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","upper_order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_order_stack_edges" ADD CONSTRAINT "fk_ship_order_stack_edges_lower_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","lower_order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_orders" ADD CONSTRAINT "fk_ship_orders_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_recovery_work" ADD CONSTRAINT "fk_ship_recovery_work_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_repair_candidates" ADD CONSTRAINT "fk_ship_repair_candidates_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_repair_candidates" ADD CONSTRAINT "fk_ship_repair_candidates_attempt_id_ship_attempts_id_fk" FOREIGN KEY ("workspace_id","attempt_id") REFERENCES "ship_attempts"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_repair_candidates" ADD CONSTRAINT "fk_ship_repair_candidates_attempt_order" FOREIGN KEY ("workspace_id","attempt_id","order_id") REFERENCES "ship_attempts"("workspace_id","id","order_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_steps" ADD CONSTRAINT "fk_ship_steps_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_steps" ADD CONSTRAINT "fk_ship_steps_attempt_id_ship_attempts_id_fk" FOREIGN KEY ("workspace_id","attempt_id") REFERENCES "ship_attempts"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_active_claims" ADD CONSTRAINT "fk_ship_train_active_claims_train_id_ship_train_manifests_id_fk" FOREIGN KEY ("workspace_id","train_id") REFERENCES "ship_train_manifests"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_active_claims" ADD CONSTRAINT "fk_ship_train_active_claims_member_order" FOREIGN KEY ("workspace_id","train_id","order_id") REFERENCES "ship_train_members"("workspace_id","train_id","order_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_active_claims" ADD CONSTRAINT "fk_ship_train_active_claims_member_attempt" FOREIGN KEY ("workspace_id","train_id","attempt_id") REFERENCES "ship_train_members"("workspace_id","train_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_manifests" ADD CONSTRAINT "fk_ship_train_manifests_leader_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","leader_order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_manifests" ADD CONSTRAINT "fk_ship_train_manifests_leader_attempt_id_ship_attempts_id_fk" FOREIGN KEY ("workspace_id","leader_attempt_id") REFERENCES "ship_attempts"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_members" ADD CONSTRAINT "fk_ship_train_members_train_id_ship_train_manifests_id_fk" FOREIGN KEY ("workspace_id","train_id") REFERENCES "ship_train_manifests"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_members" ADD CONSTRAINT "fk_ship_train_members_issue_id_issues_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "issues"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_members" ADD CONSTRAINT "fk_ship_train_members_order_id_ship_orders_id_fk" FOREIGN KEY ("workspace_id","order_id") REFERENCES "ship_orders"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_members" ADD CONSTRAINT "fk_ship_train_members_attempt_id_ship_attempts_id_fk" FOREIGN KEY ("workspace_id","attempt_id") REFERENCES "ship_attempts"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_members" ADD CONSTRAINT "fk_ship_train_members_attempt_order" FOREIGN KEY ("workspace_id","attempt_id","order_id") REFERENCES "ship_attempts"("workspace_id","id","order_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ship_train_members" ADD CONSTRAINT "fk_ship_train_members_order_issue" FOREIGN KEY ("workspace_id","order_id","issue_id") REFERENCES "ship_orders"("workspace_id","id","issue_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sync_capture" ADD CONSTRAINT "fk_sync_capture_undrained_sync_capture_guard_id_fk" FOREIGN KEY ("undrained") REFERENCES "sync_capture_guard"("id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "workflow_bindings" ADD CONSTRAINT "fk_workflow_bindings_revision_id_workflow_revisions_id_fk" FOREIGN KEY ("workspace_id","revision_id") REFERENCES "workflow_revisions"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD CONSTRAINT "fk_workflow_revisions_workflow_id_workflows_id_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "workflows"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_run_steps" ADD CONSTRAINT "fk_workflow_run_steps_run_id_workflow_runs_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "workflow_runs"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "fk_workflow_runs_revision_id_workflow_revisions_id_fk" FOREIGN KEY ("workspace_id","revision_id") REFERENCES "workflow_revisions"("workspace_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "fk_workflow_runs_supersedes_run_id_workflow_runs_id_fk" FOREIGN KEY ("workspace_id","supersedes_run_id") REFERENCES "workflow_runs"("workspace_id","id") ON DELETE SET NULL ("supersedes_run_id");