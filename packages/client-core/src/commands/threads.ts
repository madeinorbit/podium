import { superagentThreadRowId } from '@podium/model'
import type { PodiumClientApi } from '../api'
import { type RecordPatch, UNSET } from '../records'
import type { CommandDeps } from './context'
import type { ThreadsCommands } from './threads-types'
import type { CommandWrites } from './writes'
export function createThreadsCommands<TApi extends PodiumClientApi>(
  rt: CommandDeps<TApi>,
  shared: CommandWrites,
): ThreadsCommands<TApi> {
  const { editRecord } = shared
  return {
    // The prompt box's model and effort are spec fields of my thread's record
    // (POD-6675, ADR 12 D2): one writer, this edit; `auto` clears the field so
    // the thread follows the superagent settings role again.
    setBackend: async (threadId, choice) => {
      const cell = (value: string) => (value === 'auto' ? UNSET : value)
      const patch: RecordPatch<'superagentThread'> = {
        ...(choice.model !== undefined ? { model: cell(choice.model) } : {}),
        ...(choice.effort !== undefined ? { effort: cell(choice.effort) } : {}),
      }
      if (Object.keys(patch).length === 0) return
      await editRecord(
        { kind: 'superagentThread', id: superagentThreadRowId(rt.userId, threadId) },
        patch,
      )
    },
  }
}
