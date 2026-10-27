-- First Flights rollout cutoff: 2026-10-27T17:00:00Z. Account age, not server
-- age or shared issue activity, decides eligibility. A new member on an old
-- server still gets tips. The cutoff also excludes the synthetic first admin
-- created by earlier migrations on a fresh install. This migration runs once;
-- it never resets progress or a person's on/off choice on subsequent boots.
INSERT OR IGNORE INTO user_layout (user_id, key, value, updated_at)
SELECT users.id, moments.key,
       json_quote('2026-10-27T17:00:00.000Z'), '2026-10-27T17:00:00.000Z'
FROM users CROSS JOIN (
  SELECT 'tips.seen.first-prompt' AS key
  UNION ALL SELECT 'tips.seen.first-send'
  UNION ALL SELECT 'tips.seen.ask-anything'
  UNION ALL SELECT 'tips.seen.team-forms'
  UNION ALL SELECT 'tips.seen.first-proposal'
  UNION ALL SELECT 'tips.seen.first-offer'
  UNION ALL SELECT 'tips.seen.first-artifact'
) AS moments
WHERE julianday(users.created_at) < julianday('2026-10-27T17:00:00Z');
