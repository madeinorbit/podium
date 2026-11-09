import type { SessionId } from '@podium/model'
import type { PodiumClientApi } from '../api'
import type { PinKind } from '../values'

export interface PreferencesCommands<_TApi extends PodiumClientApi = PodiumClientApi> {
  /** Pin or unpin a session, issue, worktree or repo: my `pin` record
   *  (POD-6673). Readers read the pool's pin models. */
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  /** My manual session order of one worktree: my `tabOrder` record (POD-6673). */
  setTabOrder: (worktree: string, sessionIds: SessionId[]) => Promise<void>
  /** Change my personal settings, by leaf path (`sidebar.repoOrder`,
   *  `roles.coding.model`): an edit of my `userPreferences` record (POD-6673),
   *  shown at once and on every device of mine. `undefined` resets a leaf. */
  setPreferences: (values: Readonly<Record<string, unknown>>) => Promise<void>
  /** Change instance settings by leaf path, through its synced admin-owned record. */
  setInstancePreferences: (values: Readonly<Record<string, unknown>>) => Promise<void>
}
