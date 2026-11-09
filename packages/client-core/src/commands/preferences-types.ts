/**
 * Engine-facing shared types (#262 [spec:SP-3fe2]): the server-config, notice,
 * user-focus, and runtime access seams the non-React engine and the thin React
 * binding both speak. Plain TypeScript — no React imports (that's the point of
 * the engine split: everything here must be consumable by a native/headless
 * client).
 */

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
