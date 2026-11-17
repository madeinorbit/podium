/**
 * THE MACHINE, REPOSITORY AND PEOPLE STORE GROUP ON THE TEST RUN'S ENGINE [POD-6987,
 * POD-6958 design 2.10].
 *
 * The group's repositories (machines and their record context, grants, repos,
 * checkouts, accounts, users and the sign-in carry-over, server secrets, settings and
 * their audit, agent profiles, the identity upgrade's reads) built as `store.ts` builds
 * them, over the two-engine slice's store (`openSliceStore`): a migrated in-memory
 * SQLite database on the store shard, a clone of the run's Postgres template on the
 * `server-store-pg` lane. Their tests open this instead of a whole `SessionStore`, which
 * cannot boot on Postgres until POD-6994, so the same expectations run on both engines.
 *
 * CHANGE CAPTURE IS NOT WHAT THESE TESTS CHECK. On Postgres every write on a source
 * table captures in its own statement, and the baseline's guard refuses to commit a
 * capture row nobody drained; only a whole store's commit layer drains. So each
 * repository here is a {@link drainedRepository} (and each raw write a
 * {@link drainedWrite}): on Postgres a call runs in one transaction that drops what it
 * captured, on SQLite it is the repository itself. Capture itself is proven by
 * `sync/capture-pg.test.ts`, its oracle and the write census.
 */

import { randomUUID } from 'node:crypto'
import { asWorkspaceId } from '@podium/model'
import type { SQL } from 'drizzle-orm'
import { AccountsRepository } from '../store/accounts'
import { AgentProfilesRepository } from '../store/agent-profiles'
import { CheckoutsRepository } from '../store/checkouts'
import { provisionWorkspaceFeed } from '../store/database'
import type { QueryClient } from '../store/executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from '../store/executor/executor'
import { attachLaneIntentAudit } from '../store/executor/lane-intent-audit'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { instrumentDriver, statementProbeHubFor } from '../store/executor/statement-probe'
import { type GlobalQueries, legacyWorkspaceQueries } from '../store/executor/sync-drizzle'
import { GrantsRepository } from '../store/grants'
import { IdentityUpgradeRepository } from '../store/identity-upgrade'
import { MachinesRepository } from '../store/machines'
import { ReposRepository } from '../store/repos'
import { ServerSecretsRepository } from '../store/server-secrets'
import { SessionsRepository } from '../store/sessions'
import { SettingsRepository } from '../store/settings'
import { SettingsAuditRepository } from '../store/settings-audit'
import { SignInCarryOverRepository } from '../store/sign-in-carry-over'
import { TableWrites } from '../store/table-writes'
import { UsersRepository } from '../store/users'
import { drainedRepository, drainedWrite } from './drained-repository'
import { openMigratedTestDatabase } from './migrated-database'
import { openSliceStore, PG_SLICE_TABLES, type SliceStore } from './pg-slice-tables'
import { clonePgTestDatabase, type TestStoreEngine, testStoreEngine } from './pg-test-database'
import { stageASeam } from './stage-a-seam'

/** The group's repositories on one store of the run's engine. */
export interface PeopleStoreSlice {
  readonly engine: TestStoreEngine
  readonly machines: MachinesRepository
  readonly grants: GrantsRepository
  readonly repos: ReposRepository
  readonly checkouts: CheckoutsRepository
  readonly accounts: AccountsRepository
  readonly users: UsersRepository
  readonly signInCarryOver: SignInCarryOverRepository
  readonly secrets: ServerSecretsRepository
  readonly settings: SettingsRepository
  readonly settingsAudit: SettingsAuditRepository
  readonly agentProfiles: AgentProfilesRepository
  readonly identityUpgrade: IdentityUpgradeRepository
  /** The sessions repository, for the session rows the group's reads resolve. */
  readonly sessions: SessionsRepository
  /** The store's per-table write announcement the repos repository subscribes to. */
  readonly tableWrites: TableWrites
  /**
   * The same repositories NOT drained, for a statement pin. A read captures nothing,
   * so it needs no drain, and on Postgres the drain's own two statements would be
   * counted with the operation's.
   */
  readonly undrained: {
    readonly machines: MachinesRepository
    readonly grants: GrantsRepository
    readonly repos: ReposRepository
    readonly accounts: AccountsRepository
    readonly users: UsersRepository
    readonly sessions: SessionsRepository
  }
  /** Runs `write` in one workspace transaction whose capture is dropped on Postgres. */
  drained<T>(write: () => Promise<T>): Promise<T>
  /** What `countStatements` attaches to: the store's driver, on either engine. */
  readonly probeTarget: { readonly db: object }
  /**
   * Runs one raw write in the workspace's transaction. Written with drizzle's `sql`
   * template, so its values render as each engine's placeholders.
   */
  run(statement: SQL): Promise<void>
  /** Reads rows with one raw statement, as {@link run} writes. */
  all<T>(statement: SQL): Promise<T[]>
  close(): Promise<void>
}

/** The repositories, wired to one another as `store.ts` wires them. */
function repositoriesOver(queries: SliceStore['queries'], tableWrites: TableWrites) {
  const grants = new GrantsRepository(queries)
  const machines = new MachinesRepository(queries, grants, grants.machineRecordWrites)
  const signInCarryOver = new SignInCarryOverRepository(queries)
  return {
    machines,
    grants,
    repos: new ReposRepository(queries, () => undefined, tableWrites),
    checkouts: new CheckoutsRepository(queries),
    accounts: new AccountsRepository(queries),
    users: new UsersRepository(queries, machines, grants, signInCarryOver),
    signInCarryOver,
    secrets: new ServerSecretsRepository(queries),
    settings: new SettingsRepository(queries),
    settingsAudit: new SettingsAuditRepository(queries),
    agentProfiles: new AgentProfilesRepository(queries),
    identityUpgrade: new IdentityUpgradeRepository(queries),
    sessions: new SessionsRepository(queries),
  }
}

/** The group's repositories over one workspace's slice, each drained on Postgres. */
function sliceOver(slice: SliceStore): PeopleStoreSlice {
  const { queries } = slice
  const tableWrites = new TableWrites()
  const drained = <R extends object>(repository: R): R => drainedRepository(slice, repository)
  const repositories = repositoriesOver(queries, tableWrites)
  const undrained = repositoriesOver(queries, new TableWrites())
  return {
    engine: slice.engine,
    machines: drained(repositories.machines),
    grants: drained(repositories.grants),
    repos: drained(repositories.repos),
    checkouts: drained(repositories.checkouts),
    accounts: drained(repositories.accounts),
    users: drained(repositories.users),
    signInCarryOver: drained(repositories.signInCarryOver),
    secrets: drained(repositories.secrets),
    settings: drained(repositories.settings),
    settingsAudit: drained(repositories.settingsAudit),
    agentProfiles: drained(repositories.agentProfiles),
    identityUpgrade: drained(repositories.identityUpgrade),
    sessions: drained(repositories.sessions),
    tableWrites,
    undrained: {
      machines: undrained.machines,
      grants: undrained.grants,
      repos: undrained.repos,
      accounts: undrained.accounts,
      users: undrained.users,
      sessions: undrained.sessions,
    },
    drained: async <T>(write: () => Promise<T>): Promise<T> =>
      await drainedWrite(slice, async () => await queries.createOrJoinTransaction(write)),
    probeTarget: slice.probeTarget,
    run: async (statement: SQL): Promise<void> => {
      await drainedWrite(slice, async () => {
        await queries.createOrJoinTransaction(async () => {
          await queries.rootDb.run(statement)
        })
      })
    },
    all: async <T>(statement: SQL): Promise<T[]> =>
      (await queries.createOrJoinTransaction(
        async () => await queries.rootDb.all(statement),
      )) as T[],
    close: async () => await slice.close(),
  }
}

/** The group's repositories on a fresh store of the test run's engine. */
export async function openPeopleStoreSlice(): Promise<PeopleStoreSlice> {
  return sliceOver(await openSliceStore())
}

/** One workspace's repositories in a database that several workspaces share. */
export interface WorkspacePeopleSlice extends PeopleStoreSlice {
  readonly workspaceId: string
}

/**
 * The group's repositories for each of `ids`, in that order, over ONE fresh database
 * of the run's engine, every workspace provisioned as `StoreDatabase.provisionWorkspace`
 * provisions it. Closing any of them closes the database for all.
 */
export async function openPeopleStoreSlices<const Ids extends readonly [string, ...string[]]>(
  ids: Ids,
): Promise<{ readonly [K in keyof Ids]: WorkspacePeopleSlice }> {
  let engine: TestStoreEngine
  let base: GlobalQueries
  let probeTarget: { readonly db: object }
  let close: () => Promise<void>
  if (testStoreEngine() !== 'pg') {
    const database = openMigratedTestDatabase()
    engine = 'sqlite'
    base = stageASeam(database)
    probeTarget = { db: database }
    close = async () => database.close()
  } else {
    const { url } = await clonePgTestDatabase()
    const connection = {}
    const hub = statementProbeHubFor(connection)
    attachLaneIntentAudit(hub)
    const executor: RootStoreExecutor<QueryClient> = createStoreExecutor<QueryClient>({
      driver: instrumentDriver(createPgStoreDriver({ url, poolSize: 2 }), hub),
      queryLayer: pgQueryLayer(PG_SLICE_TABLES),
      startOpen: true,
    })
    engine = 'pg'
    base = executor.queries
    probeTarget = { db: connection }
    close = async () => await executor.close()
  }
  try {
    await base.createOrJoinTransaction(async () => {
      for (const id of ids) {
        await provisionWorkspaceFeed(base.db).run({
          workspaceId: id,
          feedId: randomUUID(),
          epoch: randomUUID(),
          mintedAt: Date.now(),
        })
      }
    })
    const slices = ids.map((id) => {
      const queries = legacyWorkspaceQueries(base, asWorkspaceId(id))
      const slice: SliceStore = { engine, queries, probeTarget, close }
      return { ...sliceOver(slice), workspaceId: id }
    })
    return slices as unknown as { readonly [K in keyof Ids]: WorkspacePeopleSlice }
  } catch (error) {
    await close()
    throw error
  }
}
