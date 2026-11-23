-- A SESSION BELONGS TO WHOEVER STARTED IT (POD-6283; docs/design/multi-user-instance.md §2.3).
--
-- Until this release, a session started on a task was stored with the TASK's
-- owner as `sessions.owner_user_id` (session-start.ts and createdOwnership both
-- let the issue owner win). The person who actually started it, or for whom an
-- agent started it, is named by the server-authored `delegation.onBehalfOf` and
-- by `created_by_on_behalf_of`. Session authorization now reads `owner_user_id`
-- alone, so a row where they differ would leave Bob's agent on Alice's task in
-- Alice's hands and refuse Bob.
--
-- THE NEW OWNER IS THE DELEGATION'S HUMAN, else the recorded starter. The
-- delegation comes first because it is what the machine binds by: the daemon
-- stamps every resume receipt with `delegation.onBehalfOf` and the server
-- accepts a receipt only from the row's owner, so an owner taken from anywhere
-- else would leave the session unable to bind or resume
-- (`session-owner-binding.test.ts`). The two agree on every row session-start
-- wrote; the order only matters if they ever do not.
--
-- The correction applies where
--   - the instance has more than one member (a one-member instance is left
--     exactly as it was),
--   - that human differs from the stored owner, and
--   - that human is an active member (not disabled, and still a row in
--     `users`). A row whose starter is gone or disabled keeps its owner rather
--     than being handed to nobody.
--
-- Data only, no schema change: nothing is dropped or narrowed, and the
-- pre-migration backup the runner takes at boot is the rollback. Rows with
-- neither a delegation human nor a recorded starter are untouched.
UPDATE `sessions`
SET `owner_user_id` = COALESCE(json_extract(`delegation`, '$.onBehalfOf'), `created_by_on_behalf_of`)
WHERE COALESCE(json_extract(`delegation`, '$.onBehalfOf'), `created_by_on_behalf_of`) IS NOT NULL
  AND `owner_user_id` IS NOT COALESCE(json_extract(`delegation`, '$.onBehalfOf'), `created_by_on_behalf_of`)
  AND (SELECT COUNT(*) FROM `users`) > 1
  AND COALESCE(json_extract(`delegation`, '$.onBehalfOf'), `created_by_on_behalf_of`)
    IN (SELECT `id` FROM `users` WHERE `disabled_at` IS NULL);
