-- POD-6646 (ADR 12 D1): `reconnecting` is no longer a session status. It said
-- only that the machine's daemon link was down right now, which every reader now
-- derives from the machine's live connection. A row that still reads
-- `reconnecting` had an agent that was meant to keep running while the link was
-- down, which is `live` (the agent-computing predicate already read it so).
UPDATE `sessions` SET `status` = 'live' WHERE `status` = 'reconnecting';
--> statement-breakpoint
-- The change log carries session payloads too: rewrite them the same way so a
-- replay or a bootstrap never hands a client the retired value.
UPDATE `change_latest`
SET `payload` = json_set(`payload`, '$.status', 'live')
WHERE `entity` = 'session'
  AND json_valid(`payload`)
  AND json_extract(`payload`, '$.status') = 'reconnecting';
--> statement-breakpoint
UPDATE `changes`
SET `payload` = json_set(`payload`, '$.status', 'live')
WHERE `entity` = 'session'
  AND json_valid(`payload`)
  AND json_extract(`payload`, '$.status') = 'reconnecting';
--> statement-breakpoint
-- Rebootstrap clients so a saved replica no longer holds the retired value.
UPDATE `feed_identity`
SET `epoch` = 'session-reconnecting-is-live-' || lower(hex(randomblob(16)))
WHERE `singleton` = 1;
