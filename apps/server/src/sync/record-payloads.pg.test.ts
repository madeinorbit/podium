/**
 * SYNC RECORD PAYLOADS ARE THE SAME BYTES ON BOTH ENGINES [POD-6992, POD-6958 design 2.3 rule 10].
 *
 * A record's payload is `JSON.stringify(record.value)` (`packages/sync/src/authority/authority.ts`),
 * and a device that synced from a SQLite server and one that syncs from Postgres must hold
 * the same bytes. Design 2.3 holds the values equal class by class: canonical ISO timestamps
 * from `timestamptz(3)`, the exact JSON text of `json`, numbers for `bigint`, booleans, and
 * truth-valued fragments read as numbers. This test checks the result end to end.
 *
 * ONE CORPUS, BOTH ENGINES. A SQLite store is written through the server's own paths (a
 * registry booted on it, machines, issues with a parent and a dependency, sessions on them,
 * a daemon's bind of each, mail to a session and to an issue over tRPC), and every row is copied into a fresh Postgres database. Then
 * every record kind's builder (`serverRecordBuilders()`) streams every record from each
 * engine, with the same clock, and each record's `JSON.stringify(record.value)` must be
 * equal byte for byte, with the same ids on both.
 *
 * It runs on the Postgres leg (`server-store-pg`). The Postgres side is the repositories
 * built over the Postgres executor as `store.ts` builds them (`SessionStore` itself does
 * not boot on Postgres until POD-6994).
 */

import { asMachineId, firstAdminMemberId, primeFirstAdminMember } from '@podium/model'
import { SyncRepository } from '@podium/sync'
import { pgSyncTables } from '@podium/sync/adapters/pg/schema'
import { getTableColumns, getTableName, is, sql, Table } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../command-principal'
import type { ControlSend } from '../gateway/daemon-ports'
import * as pgSchema from '../migrations/pg/schema'
import { syncServerTables } from '../migrations/sync-server-tables'
import { SuperagentService } from '../modules/superagent'
import { SessionRegistry } from '../relay'
import { RepoRegistry } from '../repo-registry'
import { appRouter } from '../router'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { SessionStore } from '../store'
import { AgentProfilesRepository } from '../store/agent-profiles'
import { AutomationsRepository } from '../store/automations'
import { CheckoutsRepository } from '../store/checkouts'
import { ConversationsRepository } from '../store/conversations'
import { EffectsRepository } from '../store/effects'
import { EventsRepository } from '../store/events'
import { bindingFor } from '../store/executor/binding'
import type { QueryClient } from '../store/executor/driver'
import type { RootStoreExecutor } from '../store/executor/executor'
import { createPgStoreExecutor } from '../store/executor/pg-driver'
import { legacyWorkspaceQueries, type StoreDrizzle } from '../store/executor/sync-drizzle'
import { GrantsRepository } from '../store/grants'
import { InteractionsRepository } from '../store/interactions'
import { IssuesRepository } from '../store/issues'
import { MachinesRepository } from '../store/machines'
import { MessagesRepository } from '../store/messages'
import { ObservationCheckpointsRepository } from '../store/observation-checkpoints'
import { ReposRepository } from '../store/repos'
import { SessionsRepository } from '../store/sessions'
import { SettingsRepository } from '../store/settings'
import { ShippingRepository } from '../store/shipping'
import { SignInCarryOverRepository } from '../store/sign-in-carry-over'
import { SuperagentRepository } from '../store/superagent'
import { TableWrites } from '../store/table-writes'
import { UserLayoutRepository } from '../store/user-layout'
import { UserReadPositionRepository } from '../store/user-read-position'
import { UsersRepository } from '../store/users'
import { WorkflowsRepository } from '../store/workflows'
import { attachHostDaemon } from '../test-support/host-daemon'
import { clonePgTestDatabase, testStoreEngine } from '../test-support/pg-test-database'
import { useRealMigrationChain } from '../test-support/pre-migrated-store'
import { quietShipping } from '../test-support/statement-count'
import { type RecordReads, serverRecordBuilders } from './record-builders'

const ENGINE = testStoreEngine()
const PG_TABLES = Object.freeze({ ...pgSchema, ...pgSyncTables })
const SQLITE_TABLES = bindingFor('sqlite')
/** One clock for both engines: a record that reads `now` reads the same instant. */
const NOW = Date.parse('2026-11-17T12:00:00.000Z')

/** A fake daemon that answers the connect scan as a real one does (as the pin fixtures do). */
function answeringRepoScans(reg: SessionRegistry): ControlSend {
  return (message) => {
    if (message.type !== 'scanReposRequest') return
    void reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'scanReposResult',
      requestId: message.requestId,
      repositories: message.roots.map((path) => ({ path, kind: 'repository', worktrees: [] })),
      diagnostics: [],
    })
  }
}

/** The SQLite corpus: a store written through the server's own paths. */
async function sqliteCorpus(): Promise<SessionStore> {
  const store = await SessionStore.open(':memory:', undefined, {
    workspace: SELF_HOSTED_WORKSPACE_ID,
  })
  primeFirstAdminMember(await firstAdminMemberId(store))
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  try {
    await attachHostDaemon(reg, answeringRepoScans(reg), { repos: ['/repo'] })
    await quietShipping(reg)
    const owner = firstAdminMemberId()
    for (let i = 0; i < 2; i++) {
      await store.machines.upsertMachine({
        id: asMachineId(`mach_other_${i}`),
        name: `Other ${i}`,
        hostname: `other-${i}`,
        tokenHash: `token-${i}`,
        ownerUserId: owner,
        assignment: { server: false, agentExecution: true },
      })
    }
    const writer = reg.issues.reports.store.serverWriter
    const parent = await reg.issues.crud.create(writer, {
      repoPath: '/repo',
      title: 'A parent with "quotes", ünïcode and a tab\t',
      startNow: false,
      parentBranch: 'main',
    })
    const children: string[] = []
    const sessions: string[] = []
    for (let i = 0; i < 3; i++) {
      const issue = await reg.issues.crud.create(writer, {
        repoPath: '/repo',
        title: `Child ${i}`,
        startNow: false,
        parentBranch: 'main',
        parentId: parent.id,
      } as never)
      children.push(issue.id)
      const cwd = `/repo/w${i}`
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'codex',
        cwd,
        issueId: issue.id,
      })
      await reg.gateway.routeDaemonFrame(store.hostMachineId, {
        type: 'bind',
        sessionId,
        cmd: 'codex',
        cwd,
        agentKind: 'codex',
        geometry: { cols: 80, rows: 24 },
      } as never)
      sessions.push(sessionId)
    }
    await reg.issues.hierarchy.addDep(
      writer,
      children[1] as string,
      children[0] as string,
      'blocked-by',
    )
    // Mail through the client's own door, to a session and to an issue.
    const repos = new RepoRegistry(reg, reg.sessionStore)
    const superagent = await SuperagentService.create(reg.modules, repos, reg.sessionStore)
    const call = appRouter.createCaller({
      registry: reg,
      repos,
      superagent,
      // The operator as `test-support/capabilities.ts` mints it, for this store's admin.
      capability: {
        role: 'admin',
        scope: { kind: 'owned', userId: owner },
        actorUser: owner,
        onBehalfOf: owner,
      },
      principal: userCommandPrincipal(owner, 'admin'),
    })
    for (let i = 0; i < 3; i++) {
      await call.messages.send({
        to: sessions[0] as never,
        body: `to the session ${i}: "quoted" ✓`,
      })
      await call.messages.send({ to: children[2] as never, body: `to the issue ${i}` })
    }
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
    await reg.modules.sessions.flushBroadcasts()
  } finally {
    await reg.dispose()
  }
  return store
}

/** Copy every row of the SQLite store into the Postgres database, below any capture. */
async function copyInto(
  store: SessionStore,
  executor: RootStoreExecutor<QueryClient>,
): Promise<number> {
  const from = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
  const to = executor.queries.rootDb
  const copies: { table: PgTable; rows: Record<string, unknown>[] }[] = []
  for (const [key, sqliteTable] of Object.entries(SQLITE_TABLES)) {
    if (!is(sqliteTable, Table)) continue
    const name = getTableName(sqliteTable as Table)
    if (name === 'sync_capture' || name === 'sync_capture_guard') continue
    const pgTable = (PG_TABLES as Record<string, unknown>)[key]
    if (!is(pgTable, PgTable)) continue
    const rows = (await from.select().from(sqliteTable as never)) as Record<string, unknown>[]
    if (rows.length > 0) copies.push({ table: pgTable, rows })
  }
  let copied = 0
  await executor.transact(async () => {
    // Foreign keys are triggers, which replica mode skips: rows arrive in any order.
    await to.run(sql.raw('SET LOCAL session_replication_role = replica'))
    for (const { table, rows } of copies) {
      const width = Math.max(1, Object.keys(getTableColumns(table)).length)
      const chunk = Math.max(1, Math.floor(20_000 / width))
      for (let i = 0; i < rows.length; i += chunk) {
        await to.insert(table as never).values(rows.slice(i, i + chunk) as never)
      }
      copied += rows.length
    }
  })
  return copied
}

/** The record builders' reads over the Postgres executor, composed as `store.ts` composes them. */
function pgRecordReads(executor: RootStoreExecutor<QueryClient>): RecordReads {
  const queries = legacyWorkspaceQueries(executor.queries, SELF_HOSTED_WORKSPACE_ID)
  const observationCheckpoints = new ObservationCheckpointsRepository(queries)
  const sessions = new SessionsRepository(queries, async (id) => {
    await observationCheckpoints.purge(id)
  })
  let repos: ReposRepository | undefined
  const issues = new IssuesRepository(
    queries,
    async (repoPath, machineId) =>
      await (repos as ReposRepository).resolveIssueRepoId(repoPath, machineId),
  )
  repos = new ReposRepository(
    queries,
    async (repoId, repoPath) => await issues.assignRepoIdToIssuesUnder(repoId, repoPath),
    new TableWrites(),
  )
  const grants = new GrantsRepository(queries)
  const machines = new MachinesRepository(queries, grants, grants.machineRecordWrites)
  const users = new UsersRepository(
    queries,
    machines,
    grants,
    new SignInCarryOverRepository(queries),
  )
  const store = {
    issues,
    sessions,
    users,
    shipping: new ShippingRepository(queries),
    automations: new AutomationsRepository(queries),
    layout: new UserLayoutRepository(queries),
    readPositions: new UserReadPositionRepository(queries),
    events: new EventsRepository(queries),
    interactions: new InteractionsRepository(queries),
    messages: new MessagesRepository(queries),
    effects: new EffectsRepository(queries),
    superagent: new SuperagentRepository(queries),
    agentProfiles: new AgentProfilesRepository(queries),
    workflows: new WorkflowsRepository(queries),
    checkouts: new CheckoutsRepository(queries),
    settings: new SettingsRepository(queries),
    machines,
    grants,
    conversations: new ConversationsRepository(queries),
    observationCheckpoints,
    repos,
    sync: new SyncRepository(queries, syncServerTables, SELF_HOSTED_WORKSPACE_ID),
  }
  return {
    store: store as unknown as RecordReads['store'],
    effectExecutors: { get: () => undefined },
    now: () => NOW,
  }
}

/** Every record of every kind, as `JSON.stringify(record.value)` by kind and id. */
async function payloads(reads: RecordReads): Promise<Map<string, Map<string, string>>> {
  const registry = serverRecordBuilders()
  const out = new Map<string, Map<string, string>>()
  for (const kind of registry.kinds()) {
    const records = new Map<string, string>()
    for await (const page of registry.get(kind).streamAll(reads)) {
      for (const record of page) records.set(record.id, JSON.stringify(record.value))
    }
    out.set(kind, records)
  }
  return out
}

/** Where two strings first differ, with a little context, for a failure message. */
function firstDifference(a: string, b: string): string {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  const from = Math.max(0, at - 40)
  return `at ${at}: SQLite …${a.slice(from, at + 60)}… Postgres …${b.slice(from, at + 60)}…`
}

describe.runIf(ENGINE === 'pg')('record payloads on both engines (Postgres leg)', () => {
  let store: SessionStore
  let executor: RootStoreExecutor<QueryClient>
  let copied = 0
  beforeAll(async () => {
    // SQLite is the reference engine here; the leg's opener refuses it by default.
    useRealMigrationChain()
    store = await sqliteCorpus()
    const { url } = await clonePgTestDatabase('file')
    executor = createPgStoreExecutor({ url, poolSize: 2, pgTables: PG_TABLES, startOpen: true })
    copied = await copyInto(store, executor)
  }, 180_000)
  afterAll(async () => {
    await executor?.close()
    await store?.close()
  })

  it('builds every record with the same JSON bytes on SQLite and on Postgres', async () => {
    const sqlite = await payloads({
      store,
      effectExecutors: { get: () => undefined },
      now: () => NOW,
    })
    const pg = await payloads(pgRecordReads(executor))
    const differences: string[] = []
    const counts: string[] = []
    let compared = 0
    for (const [kind, records] of sqlite) {
      const other = pg.get(kind) ?? new Map<string, string>()
      if (records.size > 0) counts.push(`${kind} ${records.size}`)
      for (const [id, payload] of records) {
        const theirs = other.get(id)
        if (theirs === undefined) differences.push(`${kind} ${id}: only on SQLite`)
        else if (theirs !== payload) {
          differences.push(`${kind} ${id}: ${firstDifference(payload, theirs)}`)
        } else compared++
      }
      for (const id of other.keys()) {
        if (!records.has(id)) differences.push(`${kind} ${id}: only on Postgres`)
      }
    }
    console.log(
      `record payloads: ${copied} rows copied, ${compared} records equal byte for byte over ${counts.length} kinds (${counts.join(', ')}), ${differences.length} differences`,
    )
    for (const line of differences) console.log(`DIFFERENT ${line}`)
    expect(differences).toEqual([])
    // A corpus that built nothing would pass.
    expect(compared).toBeGreaterThan(20)
    expect(counts.length).toBeGreaterThan(6)
  }, 120_000)
})
