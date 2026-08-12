-- POD-678: seed the installed world from whatever the change log still retains.
--
-- This is the best the log can give and it is deliberately NOT the whole world:
-- the rows this backfill cannot find are exactly the ones retention already
-- deleted, which is the bug. What it buys is that the FIRST boot on the new
-- schema serves the same world it served before the migration rather than an
-- empty one, and every entity kind that reconciles its full truth at boot
-- (issues, their projections and edges, sessions, conversations) fills in the
-- remainder on that same boot — the dedup baseline seeds from this table, so an
-- entity missing here re-stages as a first sighting and installs itself.
--
-- `op = 'upsert'` and a non-null payload because `change_latest` holds live
-- states only: a tombstone is not a thing that is there, and a corrupt row is
-- not a state any reader could install.
INSERT INTO `change_latest` (`entity`, `entity_id`, `seq`, `payload`)
SELECT c.`entity`, c.`entity_id`, c.`seq`, c.`payload`
  FROM `changes` c
  JOIN (
    SELECT `entity`, `entity_id`, MAX(`seq`) AS `seq`
      FROM `changes`
     GROUP BY `entity`, `entity_id`
  ) m
    ON m.`entity` = c.`entity`
   AND m.`entity_id` = c.`entity_id`
   AND m.`seq` = c.`seq`
 WHERE c.`op` = 'upsert' AND c.`payload` IS NOT NULL;
