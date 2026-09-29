-- POD-4841: the message record keeps the agent program's own ids for it (its
-- turn id, prompt id, the id it echoed back), as the agent's machine reported
-- them, so the message can be found in that program's history later.
-- Expand-only: one nullable JSON text column, no backfill (older rows have no
-- ids, which is the truth).
ALTER TABLE `messages` ADD `harness_ref_json` text;
