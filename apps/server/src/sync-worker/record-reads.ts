// workspace-scoped (POD-6959)
/**
 * The record builders' reads over a read-only database handle (POD-6763): the
 * same repositories the server holds, built over the connection the sync
 * worker opens, with no SessionStore, migrations, authority or writers. Every
 * read shares the caller's snapshot when the caller has opened a transaction.
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
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { AgentProfilesRepository } from '../store/agent-profiles'
import { AutomationsRepository } from '../store/automations'
import { CheckoutsRepository } from '../store/checkouts'
import { ConversationsRepository } from '../store/conversations'
import { EffectsRepository } from '../store/effects'
import { EventsRepository } from '../store/events'
import { createBunStoreExecutor } from '../store/executor/bun-driver'
import { legacyWorkspaceQueries } from '../store/executor/sync-drizzle'
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

/** What the reads are for: the workspace (self-hosted when omitted), effects and the clock. */
export interface RecordReadsOptions {
  readonly effectExecutors: Pick<EffectExecutorRegistry, 'get'>
  readonly now?: () => number
  readonly workspaceId?: WorkspaceId
}

/** The reads of one workspace over an executor's queries the caller already holds. */
export function recordReadsOf(
  base: ReturnType<typeof createBunStoreExecutor>['queries'],
  options: RecordReadsOptions,
): RecordReads {
  // One handle for every repository: a definition's bound view is cached per handle.
  const workspaceId = options.workspaceId ?? SELF_HOSTED_WORKSPACE_ID
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
