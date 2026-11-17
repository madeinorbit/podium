ALTER TABLE `sessions` ADD `credential_id` text;
--> statement-breakpoint
-- Invalidate every record derived from the migrated session rows.
INSERT INTO `sync_kind` (`tenant_id`, `kind`, `generation`) VALUES
  ('local', 'session', 1), ('local', 'sessionUserState', 1), ('local', 'message', 1)
ON CONFLICT (`tenant_id`, `kind`) DO UPDATE SET `generation` = `sync_kind`.`generation` + 1;
