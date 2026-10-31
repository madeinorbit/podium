-- First Flights is for accounts created after this version first runs.
-- Seed every account on upgrade, regardless of creation date or release date.
-- The runner captures whether any migration was applied BEFORE this batch:
-- older migrations create a first admin on fresh installs, which must stay
-- eligible. Later accounts on established servers also stay eligible because
-- the migration ledger runs this once. Existing progress and switches survive.
-- Schema migration precedes construction of the layout service, so seed its
-- user_layout storage directly in the same transaction as the migration receipt.
INSERT OR IGNORE INTO user_layout (user_id, key, value, updated_at)
SELECT users.id, moments.key,
       json_quote(strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users CROSS JOIN (
  SELECT 'tips.seen.first-prompt' AS key
  UNION ALL SELECT 'tips.seen.first-send'
  UNION ALL SELECT 'tips.seen.ask-anything'
  UNION ALL SELECT 'tips.seen.team-forms'
  UNION ALL SELECT 'tips.seen.first-proposal'
  UNION ALL SELECT 'tips.seen.first-offer'
  UNION ALL SELECT 'tips.seen.first-artifact'
) AS moments
WHERE {{existing-install}} = 1;
