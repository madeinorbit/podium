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
  '20261117050304_workspace-column':
    "adds the workspace_id partition column and renames the sync tables' tenant_id; " +
    'the column is part of no record value or wire payload (POD-7012), and capture ' +
    'keys are held by their own manifest test (POD-7021)',
  '20261117060140_workspace-meta-split':
    'moves the workspace keys from meta to workspace_meta; the instance preferences ' +
    'blob is moved unchanged and the fleet keys the machine record reads stay in meta ' +
    '(workspace-meta-split.test.ts: "builds the same instance preferences record after ' +
    'the split as before it", and its install-key and other-table cases)',
  '20261117104939_workspace-keys':
    'rebuilds every workspace table with keys that lead with workspace_id, copying every row, ' +
    'its rowid and every column unchanged; no record value or wire payload carries the ' +
    'workspace (POD-6959 design 2.6, "no kind generation bump"). workspace-keys.test.ts holds ' +
    'every row of every table equal before and after.',
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
      expect(missingBumps(migration.sql), migration.name).toEqual([])
    }
  })

  it('lists only migrations that exist and do rewrite a record-bearing table', () => {
    for (const name of Object.keys(NO_RECORD_CHANGE)) {
      const migration = DRIZZLE_MIGRATIONS.find((m) => m.name === name)
      expect(migration, name).toBeDefined()
      // An entry for a migration the audit would pass anyway is dead weight.
      expect(missingBumps(migration?.sql ?? ''), name).not.toEqual([])
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
