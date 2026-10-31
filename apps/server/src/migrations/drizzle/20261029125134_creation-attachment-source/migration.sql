-- Creation attachments were uploaded straight to the permanent store without
-- source provenance. Only their reserved attachment paths and snapshot fields
-- identify them. Daemon evidence has sourcePaths and must keep its provenance.
WITH legacy_attachments AS (
  SELECT issues.id AS issue_id, artifact.key AS artifact_index
  FROM issues, json_each(
    CASE WHEN json_valid(issues.panel) THEN
      CASE WHEN json_type(issues.panel, '$.artifacts') = 'array' THEN issues.panel ELSE '{}' END
    ELSE '{}' END,
    '$.artifacts'
  ) AS artifact
  WHERE CASE WHEN artifact.type = 'object' THEN
    json_type(artifact.value, '$.sourceKind') IS NULL
    AND json_type(artifact.value, '$.chatUploadId') IS NULL
    AND json_type(artifact.value, '$.sourcePaths') IS NULL
    AND json_type(artifact.value, '$.artifactId') = 'text'
    AND json_type(artifact.value, '$.entry') = 'text'
    AND json_extract(artifact.value, '$.path') GLOB 'attachments/*/*'
  ELSE 0 END
), patched_panels AS (
  SELECT issues.id, json_set(issues.panel, '$.artifacts', (
    SELECT json_group_array(json(
      CASE WHEN artifact.key IN (
        SELECT artifact_index FROM legacy_attachments WHERE issue_id = issues.id
      ) THEN json_set(artifact.value, '$.sourceKind', 'creation-attachment')
      ELSE issues.panel -> ('$.artifacts[' || artifact.key || ']') END
    ))
    FROM json_each(issues.panel, '$.artifacts') AS artifact
  )) AS panel
  FROM issues
  WHERE issues.id IN (SELECT issue_id FROM legacy_attachments)
)
UPDATE issues SET
  panel = (SELECT panel FROM patched_panels WHERE patched_panels.id = issues.id),
  revision = revision + 1
WHERE id IN (SELECT id FROM patched_panels);
--> statement-breakpoint
-- Replicas must reload the migrated provenance rather than replay old panels.
UPDATE feed_identity
SET epoch = 'creation-attachment-source-' || lower(hex(randomblob(16)))
WHERE singleton = 1;
