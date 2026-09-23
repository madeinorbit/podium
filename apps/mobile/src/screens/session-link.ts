/**
 * ASK THE SERVER WHAT A SESSION ROUTE NAMES (POD-4637).
 *
 * The phone looks a session up by exact id. A short id (`/session/214a3887`)
 * or a birth ref can never match that way, so the screen used to say "not here
 * yet" about a live session. When the replica does not hold the id, this asks
 * `sessions.resolve` — the server's one rule, the same the CLI uses — rather
 * than matching prefixes on the phone.
 *
 * NOT ASKED while the row is present, or while an optimistic spawn is arriving
 * (the server has not confirmed that id yet, and "absent" would be a lie).
 * A failed request leaves the answer `idle`: offline, the replica's own copy
 * stands.
 */
import { useEffect, useState } from 'react'
import { useTrpc } from '../client/hooks'
import type { SessionLinkState } from './session-absence'

export function useSessionLink(
  identifier: string | undefined,
  opts: { present: boolean; spawnPending: boolean },
): SessionLinkState {
  const trpc = useTrpc()
  const ask = identifier !== undefined && !opts.present && !opts.spawnPending
  const [answer, setAnswer] = useState<{ identifier: string; state: SessionLinkState } | null>(null)
  useEffect(() => {
    if (!ask || identifier === undefined) return
    let live = true
    setAnswer({ identifier, state: { kind: 'resolving' } })
    trpc.sessions.resolve.query({ identifier }).then(
      (state) => {
        if (live) setAnswer({ identifier, state })
      },
      () => {
        if (live) setAnswer({ identifier, state: { kind: 'idle' } })
      },
    )
    return () => {
      live = false
    }
  }, [ask, identifier, trpc])
  if (!ask || !answer || answer.identifier !== identifier) {
    return ask ? { kind: 'resolving' } : { kind: 'idle' }
  }
  return answer.state
}
