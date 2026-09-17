ALTER TABLE `sessions` ADD `delegation` text;
--> statement-breakpoint
-- Existing rows have no recorded scope override. The server authors subtree/none,
-- never widening from the daemon's synthesized 'all'. Recorded attribution wins.
-- For pre-attribution rows ONLY, an exactly single-member database proves owner
-- and acting member are identical. Multiple-member databases leave these rows
-- without delegation (quarantined until explicit authorization); the migration
-- runner logs their count once when this migration is applied.
UPDATE sessions SET delegation = json_object(
  'actor', id,
  'onBehalfOf', CASE WHEN created_by_actor_kind IN ('system', 'machine') THEN NULL
    ELSE COALESCE(created_by_on_behalf_of, owner_user_id) END,
  'grantedScope', json(CASE WHEN issue_id IS NULL THEN '{"kind":"none"}'
    ELSE json_object('kind', 'subtree', 'rootId', issue_id) END),
  'parentBindingId', CASE WHEN created_by_actor_kind = 'agent' THEN created_by_actor_id
    WHEN spawned_by LIKE 'session:%' THEN substr(spawned_by, 9) ELSE NULL END,
  'revision', 1
) WHERE delegation IS NULL AND (
  created_by_actor_kind IN ('system', 'machine')
  OR (created_by_actor_kind IN ('user', 'agent') AND created_by_on_behalf_of IS NOT NULL)
  OR (created_by_actor_kind IS NULL AND created_by_on_behalf_of IS NULL
    AND (SELECT count(*) FROM users) = 1
    AND owner_user_id = (SELECT id FROM users LIMIT 1))
);
