-- APPROVALS AS EFFECT RECORDS (POD-6674; ADR 12 D5 E2).
--
-- An agent's approval request is an `effects` row of kind `approval` with a
-- human gate: `decision` is `awaiting` until its person decides, then
-- `approve` (the effect trigger runs it) or `deny` (it ends `cancelled`). The
-- rows of `approval_requests` are copied in under the same ids, so an agent CLI
-- polling `approvals.get` for an `apr_…` id keeps its answer.
--
-- WHAT IS COPIED, AND HOW.
--   pending   -> pending,   decision `awaiting`, stage `awaiting-approval`
--   executing -> running,   decision `approve`,  stage `executing`; the boot
--                sweep hands it to the approval executor's recovery, which
--                waits for the daemon's late result or settles it `unknown`
--                after the stall deadline. It is never sent to a daemon again.
--   succeeded -> succeeded, failed -> failed, denied -> cancelled: ended rows
--                are written as TOMBSTONES (`deleted_at`), so years of decided
--                requests do not enter the feed. They stay readable by id
--                until the effect sweep purges tombstones past retention; the
--                issue activity log keeps every step, as before.
-- A live copied row carries `revision = 0`: the server's boot step republishes
-- each one through the effects write funnel (revision 0 -> 1), which is what
-- puts it on the change log, so every device receives it.
--
-- `deciders` names who a gated record is routed to (a JSON array of user
-- ids, set when the agent asks); a copied row leaves it NULL, which routes it to
-- its creator, the asking session's owner, as before.
--
-- EXPAND-ONLY. Two nullable columns and new rows; `approval_requests` stays (a
-- LEGACY table) so a rollback is a binary swap. Its undecided rows are marked
-- failed here, so a binary rolled back past this release never shows a request
-- that the effect record may already have run.
ALTER TABLE `effects` ADD `decision` text;
--> statement-breakpoint
ALTER TABLE `effects` ADD `deciders` text;
--> statement-breakpoint
INSERT OR IGNORE INTO `effects` (
  `id`, `kind`, `target_kind`, `target_id`, `input_json`, `result_json`,
  `cancel_requested`, `status`, `error_code`, `error_message`, `deadline_at`,
  `attempts`, `stage`, `decision`, `started_at`, `finished_at`, `created_by`,
  `actor`, `created_at`, `updated_at`, `revision`, `deleted_at`
)
SELECT
  a.`id`,
  'approval',
  CASE WHEN a.`issue_id` IS NOT NULL THEN 'issue' ELSE 'session' END,
  COALESCE(a.`issue_id`, a.`session_id`),
  json_object(
    'op', json(a.`op_json`),
    'machineId', a.`machine_id`,
    'sessionId', a.`session_id`,
    'issueId', a.`issue_id`
  ),
  CASE
    WHEN a.`result_text` IS NOT NULL AND a.`status` <> 'failed'
      THEN json_object('resultText', a.`result_text`)
  END,
  0,
  CASE a.`status`
    WHEN 'pending' THEN 'pending'
    WHEN 'executing' THEN 'running'
    WHEN 'succeeded' THEN 'succeeded'
    WHEN 'denied' THEN 'cancelled'
    ELSE 'failed'
  END,
  CASE WHEN a.`status` = 'failed' THEN 'failed' END,
  CASE WHEN a.`status` = 'failed' THEN COALESCE(a.`result_text`, 'failed') END,
  NULL,
  CASE WHEN a.`status` IN ('executing', 'succeeded', 'failed') THEN 1 ELSE 0 END,
  CASE a.`status`
    WHEN 'pending' THEN 'awaiting-approval'
    WHEN 'executing' THEN 'executing'
  END,
  CASE a.`status`
    WHEN 'pending' THEN 'awaiting'
    WHEN 'denied' THEN 'deny'
    ELSE 'approve'
  END,
  CASE
    WHEN a.`status` IN ('executing', 'succeeded', 'failed') AND a.`decided_at` IS NOT NULL
      THEN CAST((julianday(a.`decided_at`) - 2440587.5) * 86400000 AS INTEGER)
  END,
  CASE
    WHEN a.`status` IN ('succeeded', 'failed', 'denied')
      THEN CAST((julianday(COALESCE(a.`decided_at`, a.`created_at`)) - 2440587.5) * 86400000 AS INTEGER)
  END,
  COALESCE(a.`on_behalf_of`, (SELECT s.`owner_user_id` FROM `sessions` s WHERE s.`id` = a.`session_id`)),
  COALESCE(a.`actor`, 'session:' || a.`session_id`),
  CAST((julianday(a.`created_at`) - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday(COALESCE(a.`decided_at`, a.`created_at`)) - 2440587.5) * 86400000 AS INTEGER),
  CASE WHEN a.`status` IN ('pending', 'executing') THEN 0 ELSE 1 END,
  CASE
    WHEN a.`status` IN ('succeeded', 'failed', 'denied')
      THEN CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  END
FROM `approval_requests` a;
--> statement-breakpoint
UPDATE `approval_requests`
SET `status` = 'failed',
    `result_text` = 'moved to an effect record by a newer Podium (POD-6674); decide it there'
WHERE `status` IN ('pending', 'executing');
--> statement-breakpoint
CREATE INDEX `idx_effects_awaiting` ON `effects` (`kind`,`created_at`) WHERE decision = 'awaiting';--> statement-breakpoint
CREATE INDEX `idx_effects_unpublished` ON `effects` (`revision`) WHERE revision = 0;
