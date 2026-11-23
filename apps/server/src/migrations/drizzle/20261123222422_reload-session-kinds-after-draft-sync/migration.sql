-- The published draft_sync_engine field was removed by an already-applied
-- migration. Reload session-derived records without replaying or editing it.
INSERT INTO sync_kind (workspace_id, kind, generation)
SELECT feed.workspace_id, bumped.kind, 1
FROM sync_feed AS feed, (SELECT 'session' AS kind UNION ALL SELECT 'sessionUserState' UNION ALL SELECT 'message') AS bumped
WHERE true
ON CONFLICT (workspace_id, kind) DO UPDATE SET generation = sync_kind.generation + 1;
