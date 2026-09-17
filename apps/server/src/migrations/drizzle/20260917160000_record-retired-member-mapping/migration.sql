-- Record the one-time bridge from the retired pre-account literal to the
-- member id minted by 20260911082826_retire-the-solo-user.  The row is durable
-- input to the ledger import and to the old-daemon ingress shim; it is not an
-- alias table or a replacement identity resolver.
INSERT INTO `meta` (`key`, `value`)
SELECT 'retired_solo_member_id', `id`
FROM `users`
WHERE `id` <> 'user:sole'
  AND (SELECT count(*) FROM `users`) = 1
  AND NOT EXISTS (SELECT 1 FROM `meta` WHERE `key` = 'retired_solo_member_id');
--> statement-breakpoint
-- The shipped retirement migration already rewrites ordinary owner columns
-- and feed payloads. These carriers were discovered in customer databases and
-- are part of the same one-time correction. Historical janitor backup tables
-- are intentionally not replayed by the application and remain untouched.
UPDATE `podium_events`
SET `payload` = replace(`payload`, '"user:sole"',
  '"' || (SELECT `value` FROM `meta` WHERE `key` = 'retired_solo_member_id') || '"')
WHERE `payload` LIKE '%"user:sole"%'
  AND EXISTS (SELECT 1 FROM `meta` WHERE `key` = 'retired_solo_member_id');
--> statement-breakpoint
UPDATE `changes`
SET `entity_id` = (SELECT `value` FROM `meta` WHERE `key` = 'retired_solo_member_id')
WHERE `entity_id` = 'user:sole'
  AND EXISTS (SELECT 1 FROM `meta` WHERE `key` = 'retired_solo_member_id');
--> statement-breakpoint
UPDATE `change_latest`
SET `entity_id` = (SELECT `value` FROM `meta` WHERE `key` = 'retired_solo_member_id')
WHERE `entity_id` = 'user:sole'
  AND EXISTS (SELECT 1 FROM `meta` WHERE `key` = 'retired_solo_member_id');
--> statement-breakpoint
UPDATE `feed_identity`
SET `epoch` = 'owner-rewrite-' || lower(hex(randomblob(16)))
WHERE `singleton` = 1
  AND EXISTS (SELECT 1 FROM `meta` WHERE `key` = 'retired_solo_member_id');
