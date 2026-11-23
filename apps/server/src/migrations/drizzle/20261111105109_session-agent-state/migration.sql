ALTER TABLE `sessions` ADD `agent_state_json` text;
--> statement-breakpoint
-- Invalidate every record derived from the migrated session rows.
INSERT INTO `sync_kind` (`kind`, `generation`) VALUES
  ('session', 1), ('sessionUserState', 1), ('message', 1)
ON CONFLICT (`kind`) DO UPDATE SET `generation` = `sync_kind`.`generation` + 1;
