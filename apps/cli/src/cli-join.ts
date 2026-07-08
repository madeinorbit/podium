import { applyJoin } from '@podium/core/setup'

/**
 * Decode a join token and persist a daemon config. Returns the resolved machine name.
 * Thin alias over the shared core `applyJoin` so `podium join-config` and the web setup
 * (`setup.join` tRPC) apply the exact same logic.
 */
export function applyJoinToken(token: string): { name: string; warning?: string } {
  return applyJoin(token)
}
