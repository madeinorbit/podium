ALTER TABLE `sessions` ADD `asks_user` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sessions_asking` ON `sessions` (`asks_user`) WHERE "sessions"."asks_user" = 1;--> statement-breakpoint
-- WHETHER A SESSION WAITS FOR THE USER (POD-7104): the value `sessions.asks_user`
-- holds, as the "asking" rule (`ASKING_WHERE`, packages/model) reads the record the
-- session builder makes: not archived, not deleted, and an offer that no later input
-- made stale, or an agent state whose phase is needs_user or errored, or idle on a
-- question or an approval. The agent state is the runtime turn state over the
-- observation checkpoint's turn state over the row's own, each only when it is a JSON
-- object. The triggers below write the column from this view whenever an input changes.
CREATE VIEW `session_asks_user` AS
SELECT `session_id`,
  CASE WHEN `deleted_at` IS NULL AND `archived` = 0 AND (
    `offered`
    OR json_extract(`agent_state`, '$.phase') IN ('needs_user', 'errored')
    OR (json_extract(`agent_state`, '$.phase') = 'idle' AND json_extract(`agent_state`, '$.idle.kind') IN ('question', 'approval'))
  ) THEN 1 ELSE 0 END AS `asks`
FROM (
  SELECT r.`id` AS `session_id`, r.`deleted_at`, r.`archived`,
    EXISTS (
      SELECT 1 FROM `offers` AS o
      WHERE o.`session_id` = r.`id` AND o.`created_at` <> ''
        AND (r.`last_input_at` IS NULL OR NOT (r.`last_input_at` > o.`created_at`))
    ) AS `offered`,
    coalesce(
      (SELECT CASE WHEN coalesce(json_valid(rt.`turn_state_json`), 0) = 1 THEN CASE WHEN json_type(rt.`turn_state_json`) = 'object' THEN rt.`turn_state_json` END END
        FROM `runtime_event_checkpoints` AS rt WHERE rt.`session_id` = r.`id`),
      (SELECT CASE WHEN coalesce(json_valid(oc.`checkpoint_json`), 0) = 1 THEN CASE WHEN json_type(oc.`checkpoint_json`, '$.turnState') = 'object' THEN json_extract(oc.`checkpoint_json`, '$.turnState') END END
        FROM `session_observation_checkpoints` AS oc WHERE oc.`session_id` = r.`id`),
      CASE WHEN coalesce(json_valid(r.`agent_state_json`), 0) = 1 THEN CASE WHEN json_type(r.`agent_state_json`) = 'object' THEN r.`agent_state_json` END END
    ) AS `agent_state`
  FROM `sessions` AS r
);--> statement-breakpoint
CREATE TRIGGER `asks_user__sessions__i` AFTER INSERT ON `sessions` FOR EACH ROW
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` = NEW.`id` AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__sessions__u` AFTER UPDATE OF `agent_state_json`, `last_input_at`, `archived`, `deleted_at` ON `sessions` FOR EACH ROW
WHEN OLD.`agent_state_json` IS NOT NEW.`agent_state_json` OR OLD.`last_input_at` IS NOT NEW.`last_input_at` OR OLD.`archived` IS NOT NEW.`archived` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` = NEW.`id` AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__offers__i` AFTER INSERT ON `offers` FOR EACH ROW
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` = NEW.`session_id` AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__offers__u` AFTER UPDATE OF `session_id`, `created_at` ON `offers` FOR EACH ROW
WHEN OLD.`session_id` IS NOT NEW.`session_id` OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` IN (OLD.`session_id`, NEW.`session_id`) AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__offers__d` AFTER DELETE ON `offers` FOR EACH ROW
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` = OLD.`session_id` AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__runtime__i` AFTER INSERT ON `runtime_event_checkpoints` FOR EACH ROW
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` = NEW.`session_id` AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__runtime__u` AFTER UPDATE OF `session_id`, `turn_state_json` ON `runtime_event_checkpoints` FOR EACH ROW
WHEN OLD.`session_id` IS NOT NEW.`session_id` OR OLD.`turn_state_json` IS NOT NEW.`turn_state_json`
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` IN (OLD.`session_id`, NEW.`session_id`) AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__runtime__d` AFTER DELETE ON `runtime_event_checkpoints` FOR EACH ROW
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` = OLD.`session_id` AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__checkpoint__i` AFTER INSERT ON `session_observation_checkpoints` FOR EACH ROW
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` = NEW.`session_id` AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__checkpoint__u` AFTER UPDATE OF `session_id`, `checkpoint_json` ON `session_observation_checkpoints` FOR EACH ROW
WHEN OLD.`session_id` IS NOT NEW.`session_id` OR OLD.`checkpoint_json` IS NOT NEW.`checkpoint_json`
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` IN (OLD.`session_id`, NEW.`session_id`) AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
CREATE TRIGGER `asks_user__checkpoint__d` AFTER DELETE ON `session_observation_checkpoints` FOR EACH ROW
BEGIN
  UPDATE `sessions` SET `asks_user` = (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`)
    WHERE `sessions`.`id` = OLD.`session_id` AND `sessions`.`asks_user` IS NOT (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`);
END;--> statement-breakpoint
-- The backfill: every row starts at 0, so only the sessions that ask are written.
UPDATE `sessions` SET `asks_user` = 1 WHERE (SELECT v.`asks` FROM `session_asks_user` AS v WHERE v.`session_id` = `sessions`.`id`) = 1;