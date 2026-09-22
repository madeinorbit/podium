/**
 * DRIVER SLOTS WITH NO SUPERVISOR BEHIND THEM (POD-4610).
 *
 * In the daemon a family's handles live on the SessionRegistry's entries.
 * A family runtime built on its own — a unit test, a conformance fixture, a
 * test-support child process — has no registry, so it gets this stand-in:
 * one slot per session id, the same compare-and-release rule as the daemon's.
 * Production never constructs one; the daemon's composition root passes its
 * registry-backed view.
 */

import type { SessionId } from '@podium/model'
import type { AgentSessionHandle } from '../driver.js'
import type { SessionDriverSlots } from '../families/session-slots.js'

export function createMemoryDriverSlots(): SessionDriverSlots {
  const slots = new Map<SessionId, AgentSessionHandle>()
  return {
    get: (sessionId) => slots.get(sessionId),
    set: (sessionId, handle) => void slots.set(sessionId, handle),
    release: (sessionId, handle) => {
      if (handle === undefined || slots.get(sessionId) === handle) slots.delete(sessionId)
    },
    handles: () => [...slots.values()],
  }
}
