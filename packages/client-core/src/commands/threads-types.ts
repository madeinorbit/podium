/**
 * Engine-facing shared types (#262 [spec:SP-3fe2]): the server-config, notice,
 * user-focus, and runtime access seams the non-React engine and the thin React
 * binding both speak. Plain TypeScript — no React imports (that's the point of
 * the engine split: everything here must be consumable by a native/headless
 * client).
 */

import type { PodiumClientApi } from '../api'

export interface ThreadsCommands<_TApi extends PodiumClientApi = PodiumClientApi> {
  /** My superagent thread's model and effort, as the prompt box picked them
   *  (POD-6675): a queued edit of its record; `auto` follows the settings role. */
  setBackend: (
    threadId: string,
    choice: { readonly model?: string; readonly effort?: string },
  ) => Promise<void>
}
