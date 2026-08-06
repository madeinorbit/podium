import type { SessionMeta } from '@podium/model'
import * as Haptics from 'expo-haptics'
import { useEffect, useRef } from 'react'
import { useSessions } from '../client/hooks'

/** A stable identity for one errored-state arrival, or null outside that phase. */
export function agentErrorKey(session: SessionMeta): string | null {
  if (session.agentState?.phase !== 'errored') return null
  return `${session.agentState.since}:${session.agentState.error?.class ?? 'unknown'}`
}

/**
 * App-wide outcome feedback for agent failures. Keeping this above the router
 * means an error arriving in a background session still reports once, while a
 * rerender of the same errored state stays silent.
 */
export function AgentOutcomeHaptics() {
  const sessions = useSessions()
  const previous = useRef(new Map<string, string | null>())

  useEffect(() => {
    const next = new Map<string, string | null>()
    let errorArrived = false
    for (const session of sessions) {
      const key = agentErrorKey(session)
      next.set(session.sessionId, key)
      if (key !== null && previous.current.get(session.sessionId) !== key) errorArrived = true
    }
    previous.current = next
    if (errorArrived) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {})
    }
  }, [sessions])

  return null
}
