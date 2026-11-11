import { describe, expect, it } from 'vitest'
import { serverRecordBuilders } from '../sync/record-builders'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

// Data rewrites invalidate every record derived from the touched table.
// Conservative for cascades and joins: reloading one extra kind is safe.
const kindsByTable: Record<string, readonly string[]> = {
  issues: [
    'issueProjection',
    'issueBodies',
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
      expect(missingBumps(migration.sql), migration.name).toEqual([])
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
