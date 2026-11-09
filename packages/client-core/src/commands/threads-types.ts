import type { PodiumClientApi } from '../api'

export interface ThreadsCommands<_TApi extends PodiumClientApi = PodiumClientApi> {
  /** My superagent thread's model and effort, as the prompt box picked them
   *  (POD-6675): a queued edit of its record; `auto` follows the settings role. */
  setBackend: (
    threadId: string,
    choice: { readonly model?: string; readonly effort?: string },
  ) => Promise<void>
}
