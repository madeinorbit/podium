// workspace-scoped (POD-6959)
/**
 * The record builders' reads over a read-only connection (POD-6763): the same
 * repositories the server holds, built over the executor of the sync worker's
 * read session (`read-session.ts`, SQLite or Postgres, POD-6991), with no
 * SessionStore, migrations, authority or writers. Every read shares the
 * session's snapshot. {@link recordReadsOver} is the SQLite form for scripts
 * and tests that hold a bun:sqlite handle.
 *
 * ONE WORKSPACE'S READS (POD-7021). Every repository is built over the queries
 * of the request's workspace, as a workspace's store builds them: the sync
 * repository's statements are that workspace's, and each other repository's
 * bind to it as its own scoping task moves it onto the workspace handle.
 */

import type { WorkspaceId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { syncServerTables } from '../migrations/sync-server-tables'
import type { EffectExecutorRegistry } from '../modules/effects/registry'
import { AgentProfilesRepository } from '../store/agent-profiles'
import { AutomationsRepository } from '../store/automations'
import { CheckoutsRepository } from '../store/checkouts'
import { ConcertmasterRepository } from '../store/concertmaster'
import { ConversationsRepository } from '../store/conversations'
import { EffectsRepository } from '../store/effects'
import { EventsRepository } from '../store/events'
import { createBunStoreExecutor } from '../store/executor/bun-driver'
import { type GlobalQueries, legacyWorkspaceQueries } from '../store/executor/sync-drizzle'
import { GrantsRepository } from '../store/grants'
import { InteractionsRepository } from '../store/interactions'
import { IssuesRepository } from '../store/issues'
import { MachinesRepository } from '../store/machines'
import { MessagesRepository } from '../store/messages'
import { NoticesRepository } from '../store/notices'
import { ObservationCheckpointsRepository } from '../store/observation-checkpoints'
import { ReposRepository } from '../store/repos'
import { SessionsRepository } from '../store/sessions'
import { SettingsRepository } from '../store/settings'
import { ShippingRepository } from '../store/shipping'
import { SuperagentRepository } from '../store/superagent'
import { TableWrites } from '../store/table-writes'
import { UserLayoutRepository } from '../store/user-layout'
import { UserReadPositionRepository } from '../store/user-read-position'
import { UsersRepository } from '../store/users'
import { WorkflowsRepository } from '../store/workflows'
import type { RecordReads } from '../sync/record-builders'

const unsupported = (): never => {
  throw new Error('record builders cannot use writer state')
}

/** What the reads are for: the explicitly bound workspace, effects and the clock. */
export interface RecordReadsOptions {
  readonly effectExecutors: Pick<EffectExecutorRegistry, 'get'>
  readonly now?: () => number
  readonly workspaceId: WorkspaceId
}

/** The reads of one workspace over an executor's queries (either engine's) the caller holds. */
export function recordReadsOf(base: GlobalQueries, options: RecordReadsOptions): RecordReads {
  // One handle for every repository: a definition's bound view is cached per handle.
  const workspaceId = options.workspaceId
  if (!workspaceId) throw new Error('record reads require an explicit workspace')
  const q = legacyWorkspaceQueries(base, workspaceId)
  return {
    store: {
      issues: new IssuesRepository(q, unsupported),
      machines: new MachinesRepository(q),
      grants: new GrantsRepository(q),
      conversations: new ConversationsRepository(q),
      sessions: new SessionsRepository(q),
      users: new UsersRepository(q),
      shipping: new ShippingRepository(q),
      automations: new AutomationsRepository(q),
      layout: new UserLayoutRepository(q),
      readPositions: new UserReadPositionRepository(q),
      events: new EventsRepository(q),
      interactions: new InteractionsRepository(q),
      messages: new MessagesRepository(q),
      effects: new EffectsRepository(q),
      superagent: new SuperagentRepository(q),
      agentProfiles: new AgentProfilesRepository(q),
      workflows: new WorkflowsRepository(q),
      checkouts: new CheckoutsRepository(q),
      notices: new NoticesRepository(q),
      concertmaster: new ConcertmasterRepository(q),
      settings: new SettingsRepository(q),
      // The session record's satellites and joins (POD-6764): reads only.
      observationCheckpoints: new ObservationCheckpointsRepository(q),
      // Nothing writes on this connection, so nothing announces a write.
      repos: new ReposRepository(q, unsupported, new TableWrites()),
      sync: new SyncRepository(q, syncServerTables, workspaceId),
    },
    effectExecutors: options.effectExecutors,
    now: options.now ?? Date.now,
  }
}

/** Build the reads; the caller closes the returned executor. */
export function recordReadsOver(
  database: SqlDatabase,
  options: RecordReadsOptions,
): { reads: RecordReads; close: () => Promise<void> } {
  const executor = createBunStoreExecutor({ database })
  return {
    reads: recordReadsOf(executor.queries, options),
    close: async () => await executor.close(),
  }
}
