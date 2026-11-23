import type { SessionId } from '@podium/model'
import {
  INSTANCE_PREFERENCES_ROW_ID,
  pinRowId,
  tabOrderRowId,
  userPreferencesRowId,
} from '@podium/model'
import type { PodiumClientApi } from '../api'
import { type RecordPatch, type RecordRef, UNSET } from '../records'
import type { PinKind } from '../values'
import type { CommandDeps } from './context'
import { reportCommandFailure } from './failures'
import type { PreferencesCommands } from './preferences-types'
import type { CommandWrites } from './writes'
export function createPreferencesCommands<TApi extends PodiumClientApi>(
  rt: CommandDeps<TApi>,
  shared: CommandWrites,
): PreferencesCommands<TApi> {
  const { records } = shared
  const commands: PreferencesCommands<TApi> = {
    setPinned: async (kind: PinKind, id: string, pinned: boolean) => {
      const pin = pinRowId(rt.userId, kind, id)
      if (pinned) await records.create('pin', pin, { userId: rt.userId, kind, entityId: id })
      else await records.remove({ kind: 'pin', id: pin })
    },
    setTabOrder: async (worktree: string, sessionIds: SessionId[]) => {
      const ref: RecordRef<'tabOrder'> = {
        kind: 'tabOrder',
        id: tabOrderRowId(rt.userId, worktree),
      }
      // An empty order is no record.
      if (sessionIds.length === 0) await records.remove(ref)
      else await records.edit(ref, { sessionIds })
    },
    // My personal settings, leaf by leaf (POD-6673): an edit of my
    // `userPreferences` record. `undefined` resets a leaf to its default.
    setPreferences: async (values) => {
      const patch: Record<string, unknown> = {}
      for (const [path, value] of Object.entries(values))
        patch[path] = value === undefined ? UNSET : value
      if (Object.keys(patch).length === 0) return
      await records.edit(
        { kind: 'userPreferences', id: userPreferencesRowId(rt.userId) },
        patch as RecordPatch<'userPreferences'>,
      )
    },
    setInstancePreferences: async (values) => {
      const patch: Record<string, unknown> = {}
      for (const [path, value] of Object.entries(values))
        patch[path] = value === undefined ? UNSET : value
      if (Object.keys(patch).length === 0) return
      await records.edit(
        { kind: 'instancePreferences', id: INSTANCE_PREFERENCES_ROW_ID },
        patch as RecordPatch<'instancePreferences'>,
      )
    },
  }
  return {
    setPinned: reportCommandFailure(commands.setPinned, shared.reportFailure),
    setTabOrder: reportCommandFailure(commands.setTabOrder, shared.reportFailure),
    setPreferences: reportCommandFailure(commands.setPreferences, shared.reportFailure),
    setInstancePreferences: reportCommandFailure(
      commands.setInstancePreferences,
      shared.reportFailure,
    ),
  }
}
