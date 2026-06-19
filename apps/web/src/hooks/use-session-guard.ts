import { useCallback } from 'react'
import { isSessionWorking } from '@/derive'
import { useStore } from '@/store'
import { useConfirm } from './use-confirm'

/**
 * The close/archive guard (#115). Closing or archiving a session that is still
 * actively working would kill its in-flight turn, so route those two actions
 * through a confirmation popup — but ONLY while the agent is working; an idle
 * session closes/archives immediately, exactly as before.
 *
 * One implementation behind every call site (tab X, sidebar row X, mobile tab,
 * panel archive, home-card archive): the "working" test is the shared
 * `isSessionWorking` (green-dot semantics) and the popup is the app-wide
 * `useConfirm` dialog.
 */
export function useSessionGuard(): {
  /** Close (kill) a session, prompting first if it's still working. */
  guardedKill: (sessionId: string) => Promise<void>
  /** Archive/unarchive a session, prompting first only when archiving a
   *  working session (unarchive is never destructive). */
  guardedArchive: (sessionId: string, archived: boolean) => Promise<void>
} {
  const { sessions, killSession, archiveSession } = useStore()
  const confirm = useConfirm()

  const isWorking = useCallback(
    (sessionId: string): boolean => {
      const session = sessions.find((s) => s.sessionId === sessionId)
      return session ? isSessionWorking(session) : false
    },
    [sessions],
  )

  const guardedKill = useCallback(
    async (sessionId: string) => {
      if (isWorking(sessionId)) {
        const ok = await confirm({
          title: 'Close this session?',
          description: 'This agent is still working — closing it now ends its turn.',
          confirmLabel: 'Close anyway',
        })
        if (!ok) return
      }
      await killSession(sessionId)
    },
    [isWorking, confirm, killSession],
  )

  const guardedArchive = useCallback(
    async (sessionId: string, archived: boolean) => {
      if (archived && isWorking(sessionId)) {
        const ok = await confirm({
          title: 'Archive this session?',
          description: 'This agent is still working — archiving it now ends its turn.',
          confirmLabel: 'Archive anyway',
        })
        if (!ok) return
      }
      await archiveSession(sessionId, archived)
    },
    [isWorking, confirm, archiveSession],
  )

  return { guardedKill, guardedArchive }
}
