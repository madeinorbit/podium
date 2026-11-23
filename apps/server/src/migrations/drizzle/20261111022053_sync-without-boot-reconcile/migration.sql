-- POD-6221: the boot log reconcile is replaced by per-kind reload tokens.
-- Bootstrap reads the model tables; historical repairs run once, here, rather
-- than scanning history at every start. These statements preserve the repairs
-- previously made by healDanglingIssueReferences, repairSubagentEvidence and
-- the superagent thread boot pass.
CREATE INDEX `idx_superagent_threads_running` ON `superagent_threads` (`turn_running`);
--> statement-breakpoint
UPDATE `sessions`
SET `issue_id` = CASE
      WHEN `issue_id` IS NOT NULL AND `issue_id` NOT IN (SELECT `id` FROM `issues`)
      THEN NULL ELSE `issue_id` END,
    `ref_letter` = CASE
      WHEN `ref_issue_id` IS NOT NULL AND `ref_issue_id` NOT IN (SELECT `id` FROM `issues`)
      THEN NULL ELSE `ref_letter` END,
    `ref_issue_id` = CASE
      WHEN `ref_issue_id` IS NOT NULL AND `ref_issue_id` NOT IN (SELECT `id` FROM `issues`)
      THEN NULL ELSE `ref_issue_id` END
WHERE (`issue_id` IS NOT NULL AND `issue_id` NOT IN (SELECT `id` FROM `issues`))
   OR (`ref_issue_id` IS NOT NULL AND `ref_issue_id` NOT IN (SELECT `id` FROM `issues`));
--> statement-breakpoint
DELETE FROM `issue_ref_letters` WHERE `issue_id` NOT IN (SELECT `id` FROM `issues`);
--> statement-breakpoint
UPDATE `conversation_segments` SET `path` = NULL
WHERE `path` LIKE '%/subagents/%'
  AND `path` NOT LIKE '%/' || `native_id` || '.jsonl';
--> statement-breakpoint
UPDATE `superagent_threads`
SET `turn_running` = EXISTS (
  SELECT 1 FROM `superagent_pending_turns` WHERE `thread_id` = `superagent_threads`.`id`
);
--> statement-breakpoint
INSERT OR IGNORE INTO `superagent_threads`
  (`id`, `owner_user_id`, `kind`, `created_at`, `updated_at`)
SELECT 'global', `id`, 'global', `created_at`, `created_at` FROM `users`
WHERE `disabled_at` IS NULL AND `role` = 'admin'
ORDER BY `created_at`, `id` LIMIT 1;
--> statement-breakpoint
INSERT OR IGNORE INTO `superagent_threads`
  (`id`, `owner_user_id`, `kind`, `created_at`, `updated_at`)
SELECT 'global:' || `id`, `id`, 'global', `created_at`, `created_at` FROM `users`
WHERE `disabled_at` IS NULL AND `role` IN ('admin', 'member')
  AND NOT EXISTS (
    SELECT 1 FROM `superagent_threads`
    WHERE `owner_user_id` = `users`.`id` AND `kind` = 'global'
  );
--> statement-breakpoint
-- The approval migration used revision zero to queue log seeding. No seed is
-- needed now, but preserve the normal revision before those records are used.
UPDATE `effects` SET `revision` = 1 WHERE `revision` = 0;
--> statement-breakpoint
-- Invalidate every previously synced kind once. This covers historical data
-- rewrites and records that the old post-commit publishers could have missed.
-- A later data migration bumps only the kinds whose model rows it rewrites.
INSERT INTO `sync_kind` (`kind`, `generation`) VALUES
  ('conversation', 1), ('issueGitState', 1), ('machine', 1), ('machineAccess', 1),
  ('repo', 1), ('issueProjection', 1), ('issueBodies', 1),
  ('issuePanelTodo', 1), ('issuePanelArtifact', 1), ('issuePanelDeferred', 1), ('issuePanelState', 1),
  ('issueDep', 1), ('issueUserState', 1), ('subscription', 1),
  ('shipOrder', 1), ('shipLane', 1), ('automation', 1), ('automationRun', 1),
  ('userLayout', 1), ('userReadPosition', 1), ('pin', 1), ('tabOrder', 1), ('userPreferences', 1),
  ('sessionUserState', 1), ('superagentThread', 1), ('agentProfile', 1),
  ('workflow', 1), ('workflowRevision', 1), ('workflowBinding', 1), ('workflowRun', 1),
  ('instancePreferences', 1), ('effect', 1), ('checkout', 1),
  ('issueEvent', 1), ('pendingInteraction', 1), ('message', 1), ('session', 1)
ON CONFLICT (`kind`) DO UPDATE SET `generation` = `sync_kind`.`generation` + 1;
