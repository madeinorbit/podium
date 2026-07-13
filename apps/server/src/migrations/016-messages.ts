import type { SqlDatabase } from '@podium/runtime/sqlite'

/**
 * Unified agent messaging (#237) [spec:SP-34d7]: the one `messages` table every
 * inter-agent / superagent / system / UI communication rides, with the delivery
 * ledger as columns on the row. Evolves `issue_messages` — existing mail rows
 * are copied in one shot (best-effort field mapping); the legacy table stays in
 * place for now (inbox/claim readers migrate in a later stage, then it drops).
 */
export function up(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      thread_id    TEXT NOT NULL,
      in_reply_to  TEXT,
      from_kind    TEXT NOT NULL
        CHECK (from_kind IN ('operator','superagent','agent','system')),
      from_session TEXT,
      from_issue   TEXT,
      to_kind      TEXT NOT NULL
        CHECK (to_kind IN ('issue','session','operator')),
      to_id        TEXT,
      kind         TEXT NOT NULL DEFAULT 'message'
        CHECK (kind IN ('message','ack','notification','question')),
      urgency      TEXT NOT NULL DEFAULT 'fyi'
        CHECK (urgency IN ('fyi','next-turn','interrupt')),
      lifecycle    TEXT NOT NULL DEFAULT 'wait'
        CHECK (lifecycle IN ('wait','wake')),
      body         TEXT NOT NULL,
      expires_at   TEXT,
      created_at   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','delivered','expired','cancelled')),
      delivered_at TEXT,
      delivered_to TEXT,
      acked_by     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(to_kind, to_id, status);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_messages_delivered_to ON messages(delivered_to);
  `)
  // One-shot copy of the legacy mailbox. Mapping (best-effort):
  //   from_author 'operator'   → from_kind operator
  //   from_author 'issue:#N'   → from_kind agent, from_issue = the raw ref
  //                              (sender seq→id resolution is ambiguous across
  //                              repos, so the ref string is kept as-is)
  //   anything else            → from_kind system (approval-broker, lock grants…)
  //   status unread → queued · read/claimed → delivered (delivered_at from the
  //   read/claim stamp; the receiving session was never recorded).
  db.exec(`
    INSERT OR IGNORE INTO messages
      (id, thread_id, from_kind, from_issue, to_kind, to_id, kind, urgency,
       lifecycle, body, created_at, status, delivered_at)
    SELECT
      id, id,
      CASE
        WHEN from_author = 'operator' THEN 'operator'
        WHEN from_author LIKE 'issue:#%' THEN 'agent'
        ELSE 'system'
      END,
      CASE WHEN from_author LIKE 'issue:#%' THEN from_author ELSE NULL END,
      'issue', issue_id, 'message', 'fyi',
      'wait', body, created_at,
      CASE WHEN status = 'unread' THEN 'queued' ELSE 'delivered' END,
      CASE WHEN status = 'unread' THEN NULL ELSE COALESCE(claimed_at, read_at, created_at) END
    FROM issue_messages
  `)
}
