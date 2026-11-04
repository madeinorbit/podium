-- THE MEMBER AUTHORIZATION GENERATION (POD-6293; docs/design/multi-user-instance.md
-- §2.1, §4.5).
--
-- Every change to what a member may do (disable, enable, role change, removal,
-- signing out everywhere) steps `authz_generation` and stamps `authz_changed_at`
-- in the same transaction. Live connections are closed or rescoped from that
-- commit's publication, and work queued at or before `authz_changed_at` is
-- refused when it is dispatched.
--
-- Expand-only: two columns, one with a default and one nullable. Existing
-- members start at generation 0 with no change time, so nothing queued or open
-- on an upgraded instance is treated differently. An older binary ignores both.
ALTER TABLE `users` ADD `authz_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `authz_changed_at` text;
