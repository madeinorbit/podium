/**
 * The record builders' reads over a read-only database handle (POD-6763): the
 * same repositories the server holds, built over the connection the sync
 * worker opens, with no SessionStore, migrations, authority or writers. Every
 * read shares the caller's snapshot when the caller has opened a transaction.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { syncServerTables } from '../migrations/sync-server-tables'
import type { EffectExecutorRegistry } from '../modules/effects/registry'
import { AgentProfilesRepository } from '../store/agent-profiles'
import { AutomationsRepository } from '../store/automations'
import { CheckoutsRepository } from '../store/checkouts'
import { ConversationsRepository } from '../store/conversations'
import { EffectsRepository } from '../store/effects'
import { EventsRepository } from '../store/events'
import { createBunStoreExecutor } from '../store/executor/bun-driver'
import { InteractionsRepository } from '../store/interactions'
import { IssuesRepository } from '../store/issues'
import { GrantsRepository } from '../store/grants'
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

/** The reads over an executor's queries the caller already holds. */
export function recordReadsOf(
  q: ReturnType<typeof createBunStoreExecutor>['queries'],
  options: { effectExecutors: Pick<EffectExecutorRegistry, 'get'>; now?: () => number },
): RecordReads {
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
      sync: new SyncRepository(q, syncServerTables),
    },
    effectExecutors: options.effectExecutors,
    now: options.now ?? Date.now,
  }
}

/** Build the reads; the caller closes the returned executor. */
export function recordReadsOver(
  database: SqlDatabase,
  options: { effectExecutors: Pick<EffectExecutorRegistry, 'get'>; now?: () => number },
): { reads: RecordReads; close: () => Promise<void> } {
  const executor = createBunStoreExecutor({ database })
  return {
    reads: recordReadsOf(executor.queries, options),
    close: async () => await executor.close(),
  }
}
