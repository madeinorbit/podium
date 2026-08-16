import { shallowEqual } from '@podium/client-core/store'
import { isSessionWorking } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model/browser'
import { useCallback } from 'react'
import { useStoreSelector } from '@/app/store'
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
export function useSessionGuard(scopedSessionId?: SessionId): {
  /** Delete (kill) a session — ALWAYS confirms; the row does not come back. */
  guardedDelete: (sessionId: SessionId) => Promise<void>
  /** Clean end [spec:SP-9904] — stops the process, frees the worktree, keeps the
   *  row. Prompts first only while the agent is working. Reports a server
   *  refusal (e.g. an unsaved working tree) and offers to force past it. */
  guardedEnd: (sessionId: SessionId) => Promise<void>
  /** Archive/unarchive a session, prompting first only when archiving a
   *  working session (unarchive is never destructive). */
  guardedArchive: (sessionId: SessionId, archived: boolean) => Promise<void>
} {
  const { scopedWorking, sessions, killSession, archiveSession, endSession } = useStoreSelector(
    (s) => ({
      scopedWorking:
        scopedSessionId === undefined
          ? undefined
          : (() => {
              const session = s.sessions.find(
                (candidate) => candidate.sessionId === scopedSessionId,
              )
              return session ? isSessionWorking(session) : false
            })(),
      sessions: scopedSessionId === undefined ? s.sessions : undefined,
      killSession: s.killSession,
      archiveSession: s.archiveSession,
      endSession: s.endSession,
    }),
    shallowEqual,
  )
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
      const result = await endSession(sessionId)
      // The server REFUSES rather than throws, and the refusal that matters is
      // an unsaved working tree — recoverable by forcing, so offer that instead
      // of leaving the operator with an error toast and no route forward.
      if (!result.ok) {
        const ok = await confirm({
          title: 'End anyway?',
          description: `${result.reason ?? 'The session could not be ended.'} Ending now frees the worktree regardless; the branch and any commits on it are kept.`,
          confirmLabel: 'End anyway',
        })
        if (!ok) return
        await endSession(sessionId, true)
      }
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
