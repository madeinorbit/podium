/**
 * Engine-facing shared types (#262 [spec:SP-3fe2]): the server-config, notice,
 * and user-focus seams the non-React engine and the thin React binding both
 * speak. Plain TypeScript — no React imports (that's the point of the engine
 * split: everything here must be consumable by a native/headless client).
 */

import type { MainView } from '../router'

/** The two endpoints the shared store needs to reach a Podium server. */
export interface StoreServerConfig {
  httpOrigin: string
  wsClientUrl: string
}

/** UI-notice seam: web wires this to sonner toasts; mobile to its own surface. */
export interface StoreNotices {
  error(message: string): void
  info(message: string, description?: string): void
}

export const NOOP_NOTICES: StoreNotices = { error: () => {}, info: () => {} }

export function defaultFormatError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

/** What this client has on screen, sent with every superagent turn (#225). Mirrors
 *  the server's `UserFocus` zod schema (apps/server/src/modules/superagent/global.ts). */
export interface UserFocus {
  view?: MainView
  worktreePath?: string
  issueId?: string
  focusedSessionId?: string
  visibleSessionIds?: string[]
  filePath?: string
}
