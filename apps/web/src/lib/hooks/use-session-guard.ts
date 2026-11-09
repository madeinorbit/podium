import { useClientRuntime, useCommands } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { isSessionWorking } from '@podium/client-core/values'
import type { SessionId } from '@podium/model/browser'
import { useCallback, useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { useConfirm } from './use-confirm'

/**
 * The session-teardown guard (#115, reshaped by POD-1077).
 *
 * TWO DIFFERENT RISKS, TWO DIFFERENT RULES — the original guard had one, keyed
 * on "is the agent working", and applied it to actions with very different
 * consequences:
 *
 *  - `guardedEnd` and `guardedArchive` ask only while the agent is WORKING,
 *    because the loss is the in-flight turn and nothing else; an idle session
 *    ends immediately, exactly as before.
 *  - `guardedDelete` ALWAYS asks. Deleting tombstones the row — the transcript
 *    and the session's whole record go, and no resume brings them back — so the
 *    thing worth confirming is not the turn, it is the permanence. Under the old
 *    rule an idle session's entire history went in one unconfirmed click, from a
 *    menu row labelled "Close".
 *
 * One implementation behind every call site (tab X, sidebar row X, mobile tab,
 * panel archive, home-card archive): the "working" test is the shared
 * `isSessionWorking` (green-dot semantics) and the popup is the app-wide
 * `useConfirm` dialog.
 */
function useSessionGuardInputs(
  scopedSessionId: SessionId | undefined,
  knownWorking: boolean | undefined,
  supplied: readonly SessionView[],
) {
  const owner = useClientRuntime<Trpc>()
  const commandModules = useCommands<Trpc>()

  const actions = useMemo(() => {
    const { killSession, archive: archiveSession, stop: endSession } = commandModules.sessions
    return { killSession, archiveSession, endSession }
  }, [owner])
  const scoped = supplied.find((session) => session.sessionId === scopedSessionId)
  return {
    ...actions,
    sessions: supplied,
    scopedWorking: knownWorking ?? (scoped ? isSessionWorking(scoped) : false),
  }
}

export function useSessionGuard(
  scopedSessionId: SessionId | undefined,
  knownWorking: boolean | undefined,
  /** Pool hosts supply their sessions for the lifetime of this mount. */
  suppliedSessions: readonly SessionView[],
): {
  /** Delete (kill) a session — ALWAYS confirms; the row does not come back. */
  guardedDelete: (sessionId: SessionId) => Promise<void>
  /** Clean end [spec:SP-9904] — stops the process, frees the worktree, keeps the
   *  row. Prompts first only while the agent is working. A server refusal
   *  (e.g. an unsaved working tree) shows on the session's own bar. */
  guardedEnd: (sessionId: SessionId) => Promise<void>
  /** Archive/unarchive a session, prompting first only when archiving a
   *  working session (unarchive is never destructive). */
  guardedArchive: (sessionId: SessionId, archived: boolean) => Promise<void>
} {
  const { scopedWorking, sessions, killSession, archiveSession, endSession } =
    useSessionGuardInputs(scopedSessionId, knownWorking, suppliedSessions)
  const confirm = useConfirm()

  const isWorking = useCallback(
    (sessionId: SessionId): boolean => {
      if (sessionId === scopedSessionId) return scopedWorking ?? false
      const session = sessions?.find((s) => s.sessionId === sessionId)
      return session ? isSessionWorking(session) : false
    },
    [scopedSessionId, scopedWorking, sessions],
  )

  // The description names what is LOST, not what is happening — "delete this
  // session" restates the button, whereas the transcript going is the fact the
  // operator needs in order to answer. The working clause is appended rather
  // than replacing it: mid-turn is additional bad news, not different news.
  const guardedDelete = useCallback(
    async (sessionId: SessionId) => {
      const working = isWorking(sessionId)
      const ok = await confirm({
        title: 'Delete this session?',
        description: working
          ? 'This agent is still working. Deleting ends its turn and permanently removes the session and its transcript — this cannot be undone.'
          : 'This permanently removes the session and its transcript — this cannot be undone. To stop the agent but keep its history, use End session instead.',
        confirmLabel: 'Delete',
      })
      if (!ok) return
      await killSession(sessionId)
    },
    [isWorking, confirm, killSession],
  )

  const guardedEnd = useCallback(
    async (sessionId: SessionId) => {
      if (isWorking(sessionId)) {
        const ok = await confirm({
          title: 'End this session?',
          description: 'This agent is still working — ending it now stops its turn.',
          confirmLabel: 'End anyway',
        })
        if (!ok) return
      }
      // An edit of what the session should be (POD-6399): queued and shown at
      // once. A refusal (an unsaved working tree) arrives on the session itself,
      // where its bar offers to end anyway, on every device and after a reload.
      await endSession(sessionId)
    },
    [isWorking, confirm, endSession],
  )

  const guardedArchive = useCallback(
    async (sessionId: SessionId, archived: boolean) => {
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

  return { guardedDelete, guardedEnd, guardedArchive }
}
