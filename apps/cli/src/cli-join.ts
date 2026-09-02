import { applyJoin, fetchTargetAppUrl } from '@podium/runtime/setup'

/**
 * Decode a join token and persist a daemon config. Returns the resolved machine name.
 * Thin alias over the shared core `applyJoin` so `podium join-config` and the web setup
 * (`setup.join` tRPC) apply the exact same logic.
 *
 * ASYNC since PDM-34: it first asks the server being joined where its UI lives, so a
 * machine joined from a terminal ends up with the same config as one joined from the
 * setup screen — which is the entire point of this being one shared path. The lookup
 * never fails a join; an unreachable server simply means "the UI is the server".
 */
export async function applyJoinToken(token: string): Promise<{ name: string; warning?: string }> {
  return applyJoin(token, await fetchTargetAppUrl(token))
}
