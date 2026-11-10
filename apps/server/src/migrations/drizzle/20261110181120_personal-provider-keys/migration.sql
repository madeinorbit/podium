-- LEGACY(remove-after: 2027-05): adopt pre-personal workspace provider keys; keep this frozen upgrade history.
-- No credential is overwritten. An equal personal key becomes shared; a
-- different one keeps its identity and sharing, with the workspace key adopted
-- as a separate account. Deletes happen only after a matching managed row exists.
WITH first_admin AS (
  SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL
  ORDER BY created_at, id LIMIT 1
), legacy AS (
  SELECT substr(key, 9) AS provider, value AS credential
  FROM server_secrets
  WHERE key IN ('apiKeys.anthropic', 'apiKeys.openai', 'apiKeys.openrouter') AND value <> ''
)
INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at, owner_user_id, account_key, ref, shared_with)
SELECT 'managed:' || legacy.provider || '@' || first_admin.id, legacy.provider,
  'api-key', legacy.credential,
  CASE WHEN length(legacy.credential) <= 8 THEN '""""'
    ELSE substr(legacy.credential, 1, 4) || '…' || substr(legacy.credential, -4) END,
  'role', CAST(strftime('%s', 'now') AS integer) * 1000, first_admin.id,
  'managed:' || legacy.provider, 'managed:' || legacy.provider, '["*"]'
FROM legacy CROSS JOIN first_admin
WHERE NOT EXISTS (
  SELECT 1 FROM accounts WHERE owner_user_id = first_admin.id AND account_key = 'managed:' || legacy.provider
);
--> statement-breakpoint
UPDATE accounts SET shared_with = '["*"]'
WHERE owner_user_id = (
  SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at, id LIMIT 1
) AND kind = 'api-key' AND EXISTS (
  SELECT 1 FROM server_secrets WHERE key IN ('apiKeys.anthropic', 'apiKeys.openai', 'apiKeys.openrouter')
    AND accounts.account_key = 'managed:' || substr(server_secrets.key, 9)
    AND accounts.credential = server_secrets.value AND server_secrets.value <> ''
);
--> statement-breakpoint
WITH first_admin AS (
  SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at, id LIMIT 1
), legacy AS (
  SELECT substr(key, 9) AS provider, value AS credential
  FROM server_secrets
  WHERE key IN ('apiKeys.anthropic', 'apiKeys.openai', 'apiKeys.openrouter') AND value <> ''
)
INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at, owner_user_id, account_key, ref, shared_with)
SELECT 'managed:' || legacy.provider || ':earlier-workspace@' || first_admin.id, legacy.provider,
  'api-key', legacy.credential,
  CASE WHEN length(legacy.credential) <= 8 THEN '""""'
    ELSE substr(legacy.credential, 1, 4) || '…' || substr(legacy.credential, -4) END,
  'role', CAST(strftime('%s', 'now') AS integer) * 1000, first_admin.id,
  'managed:' || legacy.provider || ':earlier-workspace', 'managed:' || legacy.provider || ':earlier-workspace', '["*"]'
FROM legacy CROSS JOIN first_admin
WHERE EXISTS (
  SELECT 1 FROM accounts WHERE owner_user_id = first_admin.id AND account_key = 'managed:' || legacy.provider
    AND credential <> legacy.credential
) AND NOT EXISTS (
  SELECT 1 FROM accounts WHERE owner_user_id = first_admin.id AND account_key = 'managed:' || legacy.provider || ':earlier-workspace'
);
--> statement-breakpoint
DELETE FROM server_secrets
WHERE key IN ('apiKeys.anthropic', 'apiKeys.openai', 'apiKeys.openrouter')
  AND (value = '' OR EXISTS (
    SELECT 1 FROM accounts WHERE owner_user_id = (
      SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at, id LIMIT 1
    ) AND kind = 'api-key' AND provider = substr(server_secrets.key, 9)
      AND credential = server_secrets.value AND shared_with = '["*"]'
  ));
