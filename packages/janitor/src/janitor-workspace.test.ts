/**
 * THE JANITOR READS ONE WORKSPACE (POD-7021, POD-6959 design 2.4 "Fleet reads").
 *
 * Every row below sits in workspace `ws_b`. A reader built for `ws_a` observes
 * nothing, and the same reader built for `ws_b` observes each row, so every
 * statement is held to its workspace, joins included. The one cross-workspace
 * read lists the workspaces with a feed.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AutomationDueReader,
  ChangeLogPrunePlanner,
  ConnectScanReader,
  EventLogPrunePlanner,
  IssueAutoArchiveReader,
  listWorkspacesWithFeed,
  MaintenanceCommandsPrunePlanner,
  MessageExpiryReader,
  SessionAutoArchiveReader,
  StewardPollReader,
  WorktreeGcReader,
} from './janitor'

const OLD = '2026-06-01T00:00:00.000Z'
const NOW = '2026-07-18T00:00:00.000Z'
const NOW_MS = Date.parse(NOW)

const opened: SqlDatabase[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

/** The columns the readers read, each table with its workspace column. */
function database(): SqlDatabase {
  const db = openDatabase(':memory:')
  opened.push(db)
  db.exec(`
    CREATE TABLE messages (workspace_id TEXT NOT NULL, id TEXT, lifecycle TEXT, delivery_status TEXT,
      created_at TEXT, expires_at TEXT);
    CREATE INDEX idx_messages_delivery_expiry_implicit ON messages (delivery_status, lifecycle, created_at);
    CREATE INDEX idx_messages_delivery_expiry_explicit ON messages (delivery_status, expires_at);
    CREATE TABLE podium_events (workspace_id TEXT NOT NULL, id INTEGER PRIMARY KEY, ts TEXT);
    CREATE TABLE sync_feed (workspace_id TEXT PRIMARY KEY, head_seq INTEGER, floor_seq INTEGER);
    CREATE TABLE changes (workspace_id TEXT NOT NULL, seq INTEGER, event_time INTEGER,
      PRIMARY KEY (workspace_id, seq));
    CREATE INDEX changes_event_time ON changes (workspace_id, event_time, seq);
    CREATE TABLE maintenance_commands (workspace_id TEXT NOT NULL, applied_at TEXT);
    CREATE TABLE sessions (workspace_id TEXT NOT NULL, id TEXT, issue_id TEXT, stopped_at TEXT,
      owner_user_id TEXT, archived INTEGER, cwd TEXT, status TEXT);
    CREATE TABLE session_user_state (workspace_id TEXT NOT NULL, session_id TEXT, user_id TEXT,
      read_at TEXT);
    CREATE TABLE issues (workspace_id TEXT NOT NULL, id TEXT, parent_id TEXT, stage TEXT,
      closed_reason TEXT, closed_at TEXT, owner_user_id TEXT, archived INTEGER, deleted_at TEXT,
      worktree_path TEXT);
    CREATE TABLE issue_user_state (workspace_id TEXT NOT NULL, issue_id TEXT, user_id TEXT,
      read_at TEXT);
    CREATE TABLE automations (workspace_id TEXT NOT NULL, id TEXT, enabled INTEGER,
      schedule_kind TEXT, cron TEXT, next_run_at TEXT);
    CREATE TABLE steward_state (workspace_id TEXT NOT NULL, key TEXT, value TEXT);
    CREATE TABLE machines (workspace_id TEXT NOT NULL, id TEXT, last_seen_at TEXT);

    INSERT INTO sync_feed VALUES ('ws_a', 0, 1), ('ws_b', 3, 1);
    INSERT INTO messages VALUES ('ws_b', 'msg_b', 'wait', 'stored', '${OLD}', NULL);
    INSERT INTO podium_events VALUES ('ws_b', 1, '${OLD}'), ('ws_b', 2, '${OLD}');
    INSERT INTO changes VALUES ('ws_b', 1, 0), ('ws_b', 2, 0), ('ws_b', 3, 0);
    INSERT INTO maintenance_commands VALUES ('ws_b', '${OLD}');
    INSERT INTO sessions VALUES ('ws_b', 'sess_b', NULL, '${OLD}', 'user_b', 0, '/w', 'exited');
    INSERT INTO session_user_state VALUES ('ws_b', 'sess_b', 'user_b', '${OLD}');
    INSERT INTO issues VALUES ('ws_b', 'iss_b', NULL, 'done', NULL, '${OLD}', 'user_b', 0, NULL, '/wt');
    INSERT INTO issue_user_state VALUES ('ws_b', 'iss_b', 'user_b', '${OLD}');
    INSERT INTO automations VALUES ('ws_b', 'auto_b', 1, 'once', NULL, '${OLD}');
    INSERT INTO steward_state VALUES ('ws_b', 'cursor', '0');
    INSERT INTO machines VALUES ('ws_b', 'mach_b', '${OLD}');
  `)
  return db
}

/** Every reader's observations for `workspace`, as counts. */
async function observed(db: SqlDatabase, workspace: string) {
  const archive = { cutoffReadAt: NOW, limit: 100 }
  return {
    expiry: (
      await new MessageExpiryReader(db, workspace).read({
        now: NOW,
        waitImplicitCutoff: NOW,
        limit: 100,
      })
    ).length,
    events: (
      await new EventLogPrunePlanner(db, workspace).plan({
        maxAgeDays: 1,
        maxRows: 1_000,
        batchSize: 10,
        nowMs: NOW_MS,
      })
    ).length,
    changes: (
      await new ChangeLogPrunePlanner(db, workspace).plan({
        keepRows: 0,
        maxAgeMs: 1,
        batchSize: 10,
        nowMs: NOW_MS,
      })
    ).map((batch) => batch.tenantId),
    commands: (
      await new MaintenanceCommandsPrunePlanner(db, workspace).plan({
        maxAgeMs: 1,
        batchSize: 10,
        nowMs: NOW_MS,
      })
    ).length,
    sessions: (await new SessionAutoArchiveReader(db, workspace).read(archive)).length,
    issues: (await new IssueAutoArchiveReader(db, workspace).read(archive)).length,
    worktrees: (
      await new WorktreeGcReader(db, workspace).read({
        cutoffClosedAt: NOW,
        mode: 'propose',
        afterDays: 1,
        limit: 100,
      })
    ).length,
    automations: new AutomationDueReader(db, workspace).read(NOW).length,
    steward: new StewardPollReader(db, workspace).read() === null ? 0 : 1,
    machines: new ConnectScanReader(db, workspace).read(NOW, 'local').length,
  }
}

describe('the janitor reads one workspace (POD-7021)', () => {
  it("observes none of another workspace's rows, and each of its own", async () => {
    const db = database()
    expect(await observed(db, 'ws_a')).toEqual({
      expiry: 0,
      events: 0,
      changes: [],
      commands: 0,
      sessions: 0,
      issues: 0,
      worktrees: 0,
      automations: 0,
      steward: 0,
      machines: 0,
    })
    expect(await observed(db, 'ws_b')).toEqual({
      expiry: 1,
      events: 1,
      changes: ['ws_b'],
      commands: 1,
      sessions: 1,
      issues: 1,
      worktrees: 1,
      automations: 1,
      steward: 1,
      machines: 1,
    })
  })

  it("joins on the row's own workspace", async () => {
    const db = database()
    // A's state rows for B's session and issue, and a live session of A in B's checkout.
    db.exec(`
      DELETE FROM session_user_state; DELETE FROM issue_user_state;
      INSERT INTO session_user_state VALUES ('ws_a', 'sess_b', 'user_b', '${OLD}');
      INSERT INTO issue_user_state VALUES ('ws_a', 'iss_b', 'user_b', '${OLD}');
      INSERT INTO sessions VALUES ('ws_a', 'sess_a', NULL, NULL, 'user_a', 0, '/wt', 'live');
    `)
    const archive = { cutoffReadAt: NOW, limit: 100 }
    expect(await new SessionAutoArchiveReader(db, 'ws_b').read(archive)).toEqual([])
    expect(await new IssueAutoArchiveReader(db, 'ws_b').read(archive)).toEqual([])
    // A's live session does not hold B's checkout.
    expect(
      await new WorktreeGcReader(db, 'ws_b').read({
        cutoffClosedAt: NOW,
        mode: 'propose',
        afterDays: 1,
        limit: 100,
      }),
    ).toHaveLength(1)
  })

  it('lists the workspaces with a feed in one read', () => {
    expect(listWorkspacesWithFeed(database())).toEqual(['ws_a', 'ws_b'])
  })
})
