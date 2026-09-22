// packages/harness/src/driver/families/session-slots.ts
//
// WHERE A FAMILY'S LIVE HANDLE LIVES (POD-4610, layers §1b/§2, spec §4.6).
//
// "One owner per session on the machine": the supervisor holds one entry per
// session, and that entry owns the session's driver handle. A family builds
// the handle and binds it into the entry's slot through this port; it keeps
// no handle index of its own, so `handleFor` on a family is a read of the
// supervisor's entry, not of a map the family could let drift from it.
//
// The daemon implements this over its SessionRegistry (one DaemonSession per
// session, `driver` slot). Several writers share that one slot — the
// terminal and headless drivers and each server family — so a slots port is
// a per-writer VIEW: it answers only for handles its own writer bound, and a
// release empties the slot only while it still holds the caller's handle.

import type { SessionId } from '@podium/model'
import type { AgentSessionHandle } from '../driver.js'

export interface SessionDriverSlots {
  /** This writer's live handle for the session; undefined when the slot is
   *  empty or holds another driver's handle. */
  get(sessionId: SessionId): AgentSessionHandle | undefined
  /** Bind the session's handle into its slot, creating the supervisor's entry
   *  for the session if it has none yet. */
  set(sessionId: SessionId, handle: AgentSessionHandle): void
  /** Empty the slot if it holds `handle` (or, with no handle, any handle this
   *  writer bound). A later bind under the same id is not the caller's to clear. */
  release(sessionId: SessionId, handle?: AgentSessionHandle): void
  /** Every handle this writer currently has bound. */
  handles(): readonly AgentSessionHandle[]
}
