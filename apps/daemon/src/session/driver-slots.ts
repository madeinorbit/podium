/**
 * ONE DRIVER SLOT PER SESSION, SEVERAL WRITERS (POD-4610, layers §1b/§2).
 *
 * Every live session's driver handle lives on its DaemonSession entry
 * (`driver`). Five kinds of writer bind into that one slot — the terminal
 * driver, the headless driver and each server family — and none of them keeps
 * a handle index of its own.
 *
 * Each writer gets its OWN view from {@link driverSlotsOver}. A view answers
 * only for handles its writer bound: a terminal lookup must not return a
 * codex handle just because it shares the entry, and a terminal teardown must
 * not empty a slot a server family has since bound. What a view remembers is
 * authorship of handles (a WeakSet), not a session → handle map: the entry
 * stays the one place that says which handle a session has.
 */

import type { AgentSessionHandle, SessionDriverSlots } from '@podium/harness/driver/host'
import type { SessionRegistry } from './registry.js'

export function driverSlotsOver(registry: SessionRegistry): SessionDriverSlots {
  const bound = new WeakSet<AgentSessionHandle>()
  const mine = (handle: AgentSessionHandle | undefined): AgentSessionHandle | undefined =>
    handle && bound.has(handle) ? handle : undefined
  return {
    get: (sessionId) => mine(registry.get(sessionId)?.driver),
    set(sessionId, handle) {
      bound.add(handle)
      registry.ensure(sessionId).driver = handle
    },
    release(sessionId, handle) {
      const owned = registry.get(sessionId)
      const current = mine(owned?.driver)
      if (!owned || !current) return
      if (handle === undefined || current === handle) owned.driver = undefined
    },
    handles() {
      const out: AgentSessionHandle[] = []
      for (const [, owned] of registry.entries()) {
        const handle = mine(owned.driver)
        if (handle) out.push(handle)
      }
      return out
    },
  }
}
