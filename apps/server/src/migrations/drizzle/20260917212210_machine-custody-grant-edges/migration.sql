ALTER TABLE `grants` ADD `custody` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `grants_machine_custodian` ON `grants` (`resource_id`) WHERE "grants"."resource_kind" = 'machine' AND "grants"."custody" = 1;--> statement-breakpoint
-- Preserve recorded personal access; there is no owner inference in this migration.
INSERT INTO grants (resource_kind, resource_id, grantee, verb, owner, visibility, created_at, actor_kind, actor_id, on_behalf_of, custody)
SELECT 'machine', id, owner_user_id, 'use', owner_user_id, 'owned-compute', created_at, 'user', owner_user_id, owner_user_id, 0
FROM machines WHERE owner_user_id IS NOT NULL
ON CONFLICT(resource_kind, resource_id, grantee, verb) DO NOTHING;
--> statement-breakpoint
INSERT INTO grants (resource_kind, resource_id, grantee, verb, owner, visibility, created_at, actor_kind, actor_id, on_behalf_of, custody)
SELECT 'machine', id, owner_user_id, 'manage', owner_user_id, 'owned-compute', created_at, 'user', owner_user_id, owner_user_id, 1
FROM machines WHERE owner_user_id IS NOT NULL
ON CONFLICT(resource_kind, resource_id, grantee, verb) DO UPDATE SET custody = 1;
--> statement-breakpoint
INSERT INTO grant_audiences (resource_kind, resource_id, grantee)
SELECT resource_kind, resource_id, grantee FROM grants WHERE resource_kind = 'machine'
ON CONFLICT(resource_kind, resource_id, grantee) DO NOTHING;
--> statement-breakpoint
ALTER TABLE `machines` DROP COLUMN `owner_user_id`;