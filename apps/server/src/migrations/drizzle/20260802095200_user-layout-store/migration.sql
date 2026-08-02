-- SIDEBAR / TAB LAYOUT GETS A SERVER ROW (POD-1350).
--
-- docs/multi-user-readiness.md §3.3 and ADR 9 D3 rule 4 put sidebar/tab layout
-- in the per-user family so it follows a person across devices. Until this
-- migration the only home was client ui-state (one browser profile = one
-- person), which blocked the actions boundary from routing those writes through
-- commands (POD-402 / POD-403).
--
-- ONE-SHOT AND IRREVERSIBLE IN PLACE. There are no down migrations; rollback is
-- restoring the pre-migration backup the runner takes at boot.
--
-- NO BACKFILL FROM THE SERVER. Legacy values live in the client's ui-state
-- collection / localStorage. POD-403's one-shot migration reads them on the
-- acting principal, posts them through `layout.set`, then deletes the local
-- keys. A second user on the same device must not re-consume that migration.
-- Creating an empty table here is therefore complete — a COPY would invent
-- nothing the server holds.
--
-- KEY-AT-A-TIME: one row per (user_id, key). A blob would make concurrent
-- multi-device writes of independent keys last-writer-wins over the whole
-- shell. Values are JSON text so booleans and maps round-trip.

CREATE TABLE `user_layout` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `user_layout_pk` PRIMARY KEY(`user_id`, `key`)
);
