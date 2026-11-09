import type { PodiumClientApi } from '../api'
import type { RecordsApi } from '../records'
import { createAutomationsCommands } from './automations'
import type { AutomationsCommands } from './automations-types'
import type { CommandDeps } from './context'
import { reportCommandFailure } from './failures'
import { createFilesCommands } from './files'
import type { FilesCommands } from './files-types'
import { createIssuesCommands } from './issues'
import type { IssuesCommands } from './issues-types'
import { createPreferencesCommands } from './preferences'
import type { PreferencesCommands } from './preferences-types'
import { createSessionsCommands } from './sessions'
import type { SessionsCommands } from './sessions-types'
import { createThreadsCommands } from './threads'
import type { ThreadsCommands } from './threads-types'
import { createCommandWrites } from './writes'

export type { AutomationsCommands } from './automations-types'
export type { CommandDeps } from './context'
export type { FilesCommands } from './files-types'
export type { IssuesCommands } from './issues-types'
export type { PreferencesCommands } from './preferences-types'
export type {
  SessionEndResult,
  SessionResurrectionResult,
  SessionsCommands,
} from './sessions-types'
export type { ThreadsCommands } from './threads-types'

/** Plain command families over the principal's existing write and request paths. */
export interface Commands<TApi extends PodiumClientApi = PodiumClientApi> {
  readonly sessions: SessionsCommands<TApi>
  readonly issues: IssuesCommands<TApi>
  readonly files: FilesCommands<TApi>
  readonly preferences: PreferencesCommands<TApi>
  readonly automations: AutomationsCommands<TApi>
  readonly threads: ThreadsCommands<TApi>
  readonly records: RecordsApi
}

export function createCommands<TApi extends PodiumClientApi>(
  deps: CommandDeps<TApi>,
): Commands<TApi> {
  const shared = createCommandWrites(deps)
  return {
    sessions: createSessionsCommands(deps, shared),
    issues: createIssuesCommands(deps, shared),
    files: createFilesCommands(deps, shared.reportFailure),
    preferences: createPreferencesCommands(deps, shared),
    automations: createAutomationsCommands(deps, shared),
    threads: createThreadsCommands(deps, shared),
    records: {
      create: reportCommandFailure(shared.records.create, shared.reportFailure),
      edit: reportCommandFailure(shared.records.edit, shared.reportFailure),
      remove: reportCommandFailure(shared.records.remove, shared.reportFailure),
      newId: shared.records.newId,
    },
  }
}
