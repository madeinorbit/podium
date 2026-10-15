-- POD-6114: workflows move onto agent profiles, and the execution profiles go.
-- A workflow step names an agent profile; a run pins it on its step rows
-- (agent_profile_id / agent_profile_json). The old step reference is carried
-- over so a run that named a profile still says so (it reads as unavailable:
-- an execution profile id names no agent profile). Its snapshot is not: it
-- was a different shape. Then the reviewed contract step: execution_profiles
-- (0 rows on the operator's instance, 2026-10-14) and the two
-- execution_profile_id columns are dropped.
ALTER TABLE `workflow_run_steps` ADD `agent_profile_id` text;--> statement-breakpoint
ALTER TABLE `workflow_run_steps` ADD `agent_profile_json` text;--> statement-breakpoint
UPDATE `workflow_run_steps` SET `agent_profile_id` = `execution_profile_id` WHERE `execution_profile_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `execution_profiles`;--> statement-breakpoint
ALTER TABLE `workflow_run_steps` DROP COLUMN `execution_profile_id`;--> statement-breakpoint
ALTER TABLE `workflow_run_steps` DROP COLUMN `execution_profile_json`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `execution_profile_id`;
