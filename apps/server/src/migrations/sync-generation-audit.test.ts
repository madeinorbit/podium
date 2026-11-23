import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { serverRecordBuilders } from '../sync/record-builders'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

// Data rewrites invalidate every record derived from the touched table.
// Conservative for cascades and joins: reloading one extra kind is safe.
const kindsByTable: Record<string, readonly string[]> = {
  issues: [
    'issueProjection',
    'issueBrief',
    'issueDescription',
    'issueDep',
    'issueUserState',
    'issueGitState',
    'issuePanelTodo',
    'issuePanelArtifact',
    'issuePanelDeferred',
    'issuePanelState',
    'session',
  ],
  issue_deps: ['issueDep'],
  issue_labels: ['issueProjection'],
  issue_user_state: ['issueUserState'],
  issue_git_states: ['issueGitState'],
  issue_panel_todos: ['issuePanelTodo'],
  issue_panel_artifacts: ['issuePanelArtifact'],
  issue_panel_deferred: ['issuePanelDeferred'],
  issue_panel_states: ['issuePanelState'],
  sessions: ['session', 'sessionUserState', 'message'],
  session_user_state: ['sessionUserState'],
  snoozes: ['sessionUserState'],
  messages: ['message'],
  podium_events: ['issueEvent'],
  subscriptions: ['subscription'],
  pending_interactions: ['pendingInteraction'],
  machines: ['machine', 'machineAccess'],
  users: ['machineAccess', 'sessionUserState'],
  grants: ['machineAccess'],
  repos: ['repo', 'checkout', 'session'],
  repo_prefixes: ['repo', 'session'],
  checkouts: ['checkout'],
  user_layout: ['userLayout'],
  user_read_position: ['userReadPosition'],
  pins: ['pin'],
  tab_order: ['tabOrder'],
  user_preferences: ['userPreferences'],
  meta: ['instancePreferences', 'machine'],
  // The settings blob moved here with the meta split (POD-7013).
  workspace_meta: ['instancePreferences'],
  agent_profiles: ['agentProfile'],
  superagent_threads: ['superagentThread'],
  notices: ['inboxNotice'],
  concertmaster_entries: ['concertmasterEntry'],
  effects: ['effect'],
  automations: ['automation'],
  automation_runs: ['automationRun'],
  workflows: ['workflow'],
  workflow_revisions: ['workflow', 'workflowRevision', 'workflowRun'],
  workflow_bindings: ['workflowBinding'],
  workflow_runs: ['workflowRun'],
  workflow_run_steps: ['workflowRun'],
  conversation_identities: ['conversation'],
  conversation_segments: ['conversation'],
  conversations: ['conversation'],
  ship_orders: ['shipOrder', 'shipLane'],
  ship_holds: ['shipOrder', 'shipLane'],
  delivery_receipts: ['shipOrder', 'shipLane'],
  ship_order_stack_edges: ['shipLane'],
}

/**
 * Migrations that rewrite a record-bearing table and change NO record value, each
 * with the reason. One entry per migration, never a rule over a statement form: a
 * later migration of the same shape is checked like any other until it is listed
 * here with its own reason. A listed migration that does not exist fails the test.
 */
const NO_RECORD_CHANGE: Readonly<Record<string, string>> = {
  '20261117054120_session-launch-posture':
    'adds nullable observed_mode and launch_posture_json columns without a backfill; ' +
    'existing sessions still project neither optional value, and no stored record value changes',
  '20261117220206_session-asks-user':
    'materializes the offer/checkpoint asking predicate in sessions.asks_user; ' +
    'the session record does not include this query-only flag (session-asks-user.test.ts ' +
    'checks its backfill and maintenance against the live predicate)',
  '20261118101144_workspace-column':
    "adds the workspace_id partition column and renames the sync tables' tenant_id; " +
    'the column is part of no record value or wire payload (POD-7012), and capture ' +
    'keys are held by their own manifest test (POD-7021)',
  '20261118101227_workspace-meta-split':
    'moves the workspace keys from meta to workspace_meta; the instance preferences ' +
    'blob is moved unchanged and the fleet keys the machine record reads stay in meta ' +
    '(workspace-meta-split.test.ts: "builds the same instance preferences record after ' +
    'the split as before it", and its install-key and other-table cases)',
  '20261118101338_workspace-keys':
    'rebuilds every workspace table with keys that lead with workspace_id, copying every row, ' +
    'its rowid and every column unchanged; no record value or wire payload carries the ' +
    'workspace (POD-6959 design 2.6, "no kind generation bump"). workspace-keys.test.ts holds ' +
    'every row of every table equal before and after.',
}

// Released migrations are immutable. Each exception names a later corrective
// migration whose bumps must cover the original rewrite; it is not a claim that
// the original migration changed no published record.
const LATER_GENERATION_BUMPS: Readonly<Record<string, string>> = {
  '20261123165931_remove-draft-sync-engine': '20261123222422_reload-session-kinds-after-draft-sync',
}

function missingBumps(sql: string): string[] {
  const statements = sql.replace(/--[^\n]*/g, '').split(';')
  const rewritten = new Set<string>()
  const bumped = new Set<string>()
  for (const statement of statements) {
    for (const match of statement.matchAll(
      /\b(?:UPDATE|DELETE\s+FROM|INSERT(?:\s+OR\s+\w+)?\s+INTO|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|RENAME\s+TO)\s+[`"]?(\w+)[`"]?/gi,
    )) {
      for (const kind of kindsByTable[match[1]!] ?? []) rewritten.add(kind)
    }
    if (
      /\b(?:INTO|UPDATE)\s+[`"]?sync_kind\b/i.test(statement) &&
      /generation\s*[`"]?\s*(?:=|\))/i.test(statement)
    ) {
      for (const match of statement.matchAll(/'([A-Za-z]+)'/g)) bumped.add(match[1]!)
    }
  }
  return [...rewritten].filter((kind) => !bumped.has(kind)).sort()
}

describe('synced data migration generations', () => {
  const foundation = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_sync-kind-generations'))

  it('every later model rewrite invalidates the affected record kinds', () => {
    expect(foundation).toBeGreaterThan(0)
    for (const migration of DRIZZLE_MIGRATIONS.slice(foundation + 1)) {
      if (NO_RECORD_CHANGE[migration.name]) continue
      const repair = DRIZZLE_MIGRATIONS.find(
        (candidate) => candidate.name === LATER_GENERATION_BUMPS[migration.name],
      )
      expect(missingBumps(`${migration.sql}\n${repair?.sql ?? ''}`), migration.name).toEqual([])
    }
  })

  it('requires each released rewrite repair to exist later and cover every affected kind', () => {
    for (const [name, repairName] of Object.entries(LATER_GENERATION_BUMPS)) {
      const originalIndex = DRIZZLE_MIGRATIONS.findIndex((m) => m.name === name)
      const repairIndex = DRIZZLE_MIGRATIONS.findIndex((m) => m.name === repairName)
      expect(originalIndex, name).toBeGreaterThan(foundation)
      expect(repairIndex, repairName).toBeGreaterThan(originalIndex)
      expect(NO_RECORD_CHANGE[name], name).toBeUndefined()
      const originalSql = DRIZZLE_MIGRATIONS[originalIndex]?.sql ?? ''
      const repairSql = DRIZZLE_MIGRATIONS[repairIndex]?.sql ?? ''
      expect(missingBumps(originalSql), name).not.toEqual([])
      expect(missingBumps(`${originalSql}\n${repairSql}`), repairName).toEqual([])
      expect(
        missingBumps(`${originalSql}\n${repairSql.replace("'sessionUserState'", "'unused'")}`),
      ).toContain('sessionUserState')
    }
  })

  it('keeps the released draft-sync removal unchanged', () => {
    const removal = DRIZZLE_MIGRATIONS.find((m) => m.name.endsWith('_remove-draft-sync-engine'))
    expect(removal?.sql).toBe('ALTER TABLE `sessions` DROP COLUMN `draft_sync_engine`;')
  })

  it('lists only migrations that exist and do rewrite a record-bearing table', () => {
    for (const name of Object.keys(NO_RECORD_CHANGE)) {
      const migration = DRIZZLE_MIGRATIONS.find((m) => m.name === name)
      expect(migration, name).toBeDefined()
      // An entry for a migration the audit would pass anyway is dead weight.
      expect(missingBumps(migration?.sql ?? ''), name).not.toEqual([])
    }
  })

  it('the later repair reloads every workspace without replaying the applied draft-sync removal', () => {
    const removal = DRIZZLE_MIGRATIONS.find((m) => m.name.endsWith('_remove-draft-sync-engine'))
    const migration = DRIZZLE_MIGRATIONS.find((m) =>
      m.name.endsWith('_reload-session-kinds-after-draft-sync'),
    )
    if (!removal || !migration) throw new Error('draft sync removal or reload migration is missing')
    const db = openDatabase(':memory:')
    try {
      db.exec(`
        CREATE TABLE sessions (workspace_id TEXT, id TEXT, title TEXT, draft_sync_engine INTEGER);
        CREATE TABLE sync_feed (workspace_id TEXT PRIMARY KEY);
        CREATE TABLE sync_kind (
          workspace_id TEXT, kind TEXT, generation INTEGER,
          PRIMARY KEY (workspace_id, kind)
        );
        INSERT INTO sessions VALUES ('ws_a', 's1', 'kept', 1), ('ws_b', 's1', 'also kept', 0);
        INSERT INTO sync_feed VALUES ('ws_a'), ('ws_b'), ('ws_empty');
        INSERT INTO sync_kind VALUES
          ('ws_a', 'session', 7), ('ws_a', 'message', 3),
          ('ws_a', 'sessionUserState', 4), ('ws_a', 'pin', 8);
      `)
      // The old migration has already run when an installed database upgrades.
      db.exec(removal.sql)
      db.exec(migration.sql)
      expect(db.prepare('SELECT * FROM sessions ORDER BY workspace_id').all()).toEqual([
        { workspace_id: 'ws_a', id: 's1', title: 'kept' },
        { workspace_id: 'ws_b', id: 's1', title: 'also kept' },
      ])
      expect(db.prepare('SELECT * FROM sync_kind ORDER BY workspace_id, kind').all()).toEqual([
        { workspace_id: 'ws_a', kind: 'message', generation: 4 },
        { workspace_id: 'ws_a', kind: 'pin', generation: 8 },
        { workspace_id: 'ws_a', kind: 'session', generation: 8 },
        { workspace_id: 'ws_a', kind: 'sessionUserState', generation: 5 },
        { workspace_id: 'ws_b', kind: 'message', generation: 1 },
        { workspace_id: 'ws_b', kind: 'session', generation: 1 },
        { workspace_id: 'ws_b', kind: 'sessionUserState', generation: 1 },
        { workspace_id: 'ws_empty', kind: 'message', generation: 1 },
        { workspace_id: 'ws_empty', kind: 'session', generation: 1 },
        { workspace_id: 'ws_empty', kind: 'sessionUserState', generation: 1 },
      ])
    } finally {
      db.close()
    }
  })

  it('refuses a model rewrite whose generation bump is missing', () => {
    const transition = DRIZZLE_MIGRATIONS.find((m) =>
      m.name.endsWith('_sync-without-boot-reconcile'),
    )!
    expect(missingBumps(transition.sql.replace("('session', 1)", "('unused', 1)"))).toContain(
      'session',
    )
    expect(missingBumps("UPDATE pending_interactions SET status = 'expired';")).toEqual([
      'pendingInteraction',
    ])
  })
})
it('covers every registered record kind', () => {
  expect([...new Set(Object.values(kindsByTable).flat())].sort()).toEqual(
    [...serverRecordBuilders().kinds()].sort(),
  )
})
