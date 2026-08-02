-- THE EVENT-STREAM READ CURSOR GETS A SERVER ROW (POD-1380).
--
-- POD-403 made the client ui-state routing table total and found one key it
-- could not classify: the "you were here" position in the cross-project
-- issue-event log. docs/multi-user-readiness.md 3.3 puts read state in the
-- per-user family so it FOLLOWS a person; kept device-local, a stream read on a
-- laptop is unread on a phone.
--
-- ONE ROW PER (user_id, stream_id). Not a per-user singleton: the family's one
-- key fragment is (userId, entityId), and the feed half is a CLOSED vocabulary
-- (model isReadStreamId) so a free-form string cannot mint rows and a future
-- per-repo stream needs no second table.
--
-- last_event_id IS THE ORDERING; seen_at IS A LABEL. The stored position is
-- max(stored, proposed) and nothing arbitrates on the timestamp, because a
-- device clock is not an ordering. That is why last_event_id is an integer
-- column and not a text timestamp: monotonicity has to be comparable in SQL.
--
-- ONE-SHOT AND IRREVERSIBLE IN PLACE. There are no down migrations; rollback is
-- restoring the pre-migration backup the runner takes at boot.
--
-- NO BACKFILL FROM THE SERVER. The legacy value lives in the client's ui-state
-- collection under `podium:superfeed:cursor`. The client forwards it once,
-- through `readPosition.advance` on the ACTING principal, then deletes the local
-- key. A second user on the same device must not inherit the first one's
-- position, which is exactly what a server-side backfill could not express.
-- An empty table here is therefore complete.
--
-- NO FOREIGN KEY to `users`, matching the layout and preference siblings: a
-- per-user row follows the user and is scrubbed by the user's own deletion path.

CREATE TABLE `user_read_position` (
	`user_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`last_event_id` integer NOT NULL,
	`seen_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `user_read_position_pk` PRIMARY KEY(`user_id`, `stream_id`)
);
