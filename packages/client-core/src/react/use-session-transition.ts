import { useEffect, useState } from 'react'
import type { SessionView } from '../session-values'
import { sessionWaking } from '../values/session-status'
import { type SessionTransition, sessionTransition } from '../values/session-transition'

export const RESUME_WAIT_MS = 90_000

type SessionTransitionInput = Pick<
  SessionView,
  | 'sessionId'
  | 'status'
  | 'queuedMessageCount'
  | 'spawnFailure'
  | 'desired'
  | 'revision'
  | 'observedRevision'
  | 'lifecycleFailure'
>

/** Bound the UI's wait for a reply. The durable request may still run on reconnect. */
export function useSessionTransition(session: SessionTransitionInput | undefined): {
  transition: SessionTransition | undefined
  waking: boolean
} {
  const transition = sessionTransition(session)
  const waking = sessionWaking(session)
  const waiting =
    transition?.kind === 'starting' ||
    (transition === undefined &&
      (waking || (session?.status === 'starting' && session.desired === 'running')))
  const attempt = waiting ? `${session?.sessionId}:${session?.revision ?? 1}` : null
  const [expired, setExpired] = useState<string | null>(null)
  useEffect(() => {
    setExpired(null)
    if (attempt === null) return
    const timer = setTimeout(() => setExpired(attempt), RESUME_WAIT_MS)
    return () => clearTimeout(timer)
  }, [attempt])
  if (attempt !== null && expired === attempt) {
    return {
      transition: {
        kind: 'resume-timeout',
        retryable: session?.status === 'hibernated' || session?.status === 'exited',
      },
      waking: false,
    }
  }
  return { transition, waking }
}
