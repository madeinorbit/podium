/**
 * STATEMENTS PER OPERATION, FOR AN A/B ACROSS POD-6147.
 *
 * Runs one fixed script of repository operations on a store built the way
 * production builds one and prints, per operation, the statements the store's
 * statement probe saw (text and declared intent), in order. Preparing queries
 * once must not change WHICH statements an operation runs: run this at the
 * parent commit and at the candidate and diff the two JSON documents. The only
 * expected difference is the placeholder count of a variable IN list, which the
 * candidate pads to a bucket size.
 *
 * It uses only repository APIs that exist on both sides of the change.
 *
 *   bun --conditions=@podium/source apps/server/scripts/prepared-statement-census.ts > counts.json
 */

import { asSessionId, asUserId } from '@podium/model'
import { users } from '../src/migrations/schema'
import { probeStatements, type StatementProbeHolder } from '../src/store/executor'
import { issueRowFixture } from '../src/test-support/issue-row'
import { openTestStore } from '../src/test-support/open-test-store'

const store = await openTestStore(':memory:')
const queries = (store as unknown as {
  queries: {
    rootDb: { insert: (t: typeof users) => { values: (v: object) => { run: () => Promise<unknown> } } }
    createOrJoinTransaction: <T>(fn: () => Promise<T>) => Promise<T>
  }
}).queries

const seen: string[] = []
probeStatements(store as unknown as StatementProbeHolder, (observation) => {
  seen.push(`${observation.intent} ${observation.sql}`)
})

const out: Record<string, { statements: number; sql: string[]; error?: string }> = {}
const op = async (name: string, fn: () => Promise<unknown>) => {
  seen.length = 0
  let error: string | undefined
  try {
    await fn()
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  out[name] = { statements: seen.length, sql: [...seen], ...(error ? { error } : {}) }
}

const S1 = asSessionId('census-s1')
const ALICE = asUserId('user:census-alice')
const session = (id: string) => ({
  id: asSessionId(id),
  ownerUserId: ALICE,
  agentKind: 'claude-code' as const,
  cwd: '/census',
  title: 'census',
  name: null,
  nameSource: null,
  originKind: 'spawn' as const,
  conversationId: null,
  resumeKind: null,
  resumeValue: `resume-${id}`,
  status: 'live' as const,
  exitCode: null,
  spawnFailure: null,
  durableLabel: `label-${id}`,
  createdAt: '2026-10-15T00:00:00.000Z',
  lastActiveAt: '2026-10-15T00:00:00.000Z',
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: 'machine-census' as never,
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
})

await op('users.insert(raw seed)', async () =>
  await queries.rootDb
    .insert(users)
    .values({ id: ALICE, displayName: 'alice', role: 'admin', createdAt: '2026-10-15T00:00:00.000Z', disabledAt: null })
    .run(),
)
await op('users.get', async () => await store.users.get(ALICE))
await op('users.list', async () => await store.users.list())
await op('users.earliestAdmin', async () => await store.users.earliestAdmin())

await op('sessions.upsertSession', async () => await store.sessions.upsertSession(session('census-s1')))
await op('sessions.upsertSession(again)', async () => await store.sessions.upsertSession(session('census-s1')))
await op('sessions.getSession', async () => await store.sessions.getSession(S1))
await op('sessions.getSessions(3)', async () => await store.sessions.getSessions(['census-s1', 'x', 'y']))
await op('sessions.findSessionByResumeValue', async () => await store.sessions.findSessionByResumeValue('resume-census-s1'))
await op('sessions.loadSessions', async () => await store.sessions.loadSessions())
await op('sessions.setPin', async () => await store.sessions.setPin(ALICE, 'panel', 'census-s1', true))
await op('sessions.listPins', async () => await store.sessions.listPins(ALICE))
await op('sessions.markSessionRead', async () => await store.sessions.markSessionRead(ALICE, S1, '2026-10-15T00:00:01.000Z'))
await op('sessions.setSnooze', async () => await store.sessions.setSnooze(ALICE, S1, null))
await op('sessions.listSnoozes', async () => await store.sessions.listSnoozes(ALICE))
await op('sessions.setOffer', async () =>
  await store.sessions.setOffer(S1, { message: 'm', actions: [], createdAt: '2026-10-15T00:00:00.000Z' } as never),
)
await op('sessions.listOffers', async () => await store.sessions.listOffers())
await op('sessions.setDraft', async () => await store.sessions.setDraft(S1, 'draft'))
await op('sessions.loadDrafts', async () => await store.sessions.loadDrafts())
await op('sessions.softDeleteSessions', async () =>
  await store.sessions.softDeleteSessions(['census-s1'], '2026-10-15T00:00:02.000Z', 'standalone'),
)
await op('sessions.loadDeletedSessions', async () => await store.sessions.loadDeletedSessions())
await op('sessions.purgeSession', async () => await store.sessions.purgeSession(S1))

await op('machines.listMachines', async () => await store.machines.listMachines())
await op('machines.getMachine', async () => await store.machines.getMachine('machine-census'))
await op('grants.listForResource', async () => await store.grants.listForResource('machine', 'machine-census'))
await op('grants.listForResources(2)', async () => await store.grants.listForResources('machine', ['a', 'b']))

await op('issues.upsertIssue', async () =>
  await store.issues.upsertIssue(issueRowFixture({ id: 'iss_census', parentId: null, supersededBy: null, duplicateOf: null })),
)
await op('issues.getIssue', async () => await store.issues.getIssue('iss_census'))
await op('issues.getIssues(2)', async () => await store.issues.getIssues(['iss_census', 'iss_missing']))
await op('issues.listIssueRows', async () => await store.issues.listIssueRows())

await op('settings.getSettings', async () => await store.settings.getSettings())
await op('layout.set', async () => await store.layout.set(ALICE, 'sidebarWidth', 300, '2026-10-15T00:00:00.000Z'))
await op('layout.getSnapshot', async () => await store.layout.getSnapshot(ALICE))
await op('secrets.presence', async () => await store.secrets.presence())
await op('accounts.list', async () => await store.accounts.list())
await op('locks.getLock', async () => await store.locks.getLock('repo_census' as never, 'merge'))
await op('workflows.listWorkflows', async () => await store.workflows.listWorkflows())
await op('workflows.listWorkflows(scope)', async () => await store.workflows.listWorkflows({ scope: 'global' as never }))
await op('automations.list', async () => await store.automations.list())
await op('interactions.listOpen', async () => await store.interactions.listOpen())
await op('approvals.listPending', async () => await store.approvals.listPending())
await op('events.appendEvent', async () =>
  await store.events.appendEvent({ ts: '2026-10-15T00:00:00.000Z', kind: 'census', subject: 'census' }),
)
await op('events.listEventsSince', async () => await store.events.listEventsSince(0, { kinds: ['census'], limit: 10 }))
await op('sync.appendChanges', async () =>
  await store.sync.appendChanges([{ entity: 'issueProjection', entityId: 'iss_census', op: 'upsert', payload: '{}' }], 1),
)
await op('sync.latestChangeStates', async () => await store.sync.latestChangeStates())
await op('transaction(two reads)', async () =>
  await queries.createOrJoinTransaction(async () => {
    await store.users.get(ALICE)
    await store.issues.getIssue('iss_census')
  }),
)

console.log(JSON.stringify(out, null, 1))
await store.close()
process.exit(0)
