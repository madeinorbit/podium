import type { PodiumClientApi } from '../api'
import type { RecordsApi } from '../records'
import { createAutomationsCommands } from './automations'
import type { AutomationsCommands } from './automations-types'
import type { CommandDeps } from './context'
import { createFilesCommands } from './files'
import { reportCommandFailures } from './failures'
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

export type { CommandDeps } from './context'
export type { AutomationsCommands } from './automations-types'
export type { FilesCommands } from './files-types'
export type { IssuesCommands } from './issues-types'
export type { PreferencesCommands } from './preferences-types'
export type { SessionsCommands } from './sessions-types'
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
  const reported = <T extends object>(family: T): T =>
    reportCommandFailures(family, shared.reportFailure)
  return {
    sessions: reported(createSessionsCommands(deps, shared)),
    issues: reported(createIssuesCommands(deps, shared)),
    files: reported(createFilesCommands(deps)),
    preferences: reported(createPreferencesCommands(deps, shared)),
    automations: reported(createAutomationsCommands(deps, shared)),
    threads: reported(createThreadsCommands(deps, shared)),
    records: reported(shared.records),
  }
}
