// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

// ---------------------------------------------------------------------------
// Attach and lease (spec §5)
// ---------------------------------------------------------------------------

/**
 * An interactive surface, produced on demand.
 *
 * NOT ATTACH: chat, status signals, mail and the steward. Those are `events()`
 * and `send()` on the handle. Attach is only for a real terminal.
 *
 * The two reserved variants below are DEFERRED, not forgotten — they are written
 * as types so that adding them later is an implementation, not a redesign of the
 * union. `handover` in particular is deliberately out of this epic.
 */
export type AttachEndpoint =
  /** Terminal family: today's frames path — the engine terminal IS the session. */
  | { kind: 'engine'; stream: TerminalStreamRef }
  /** Server family: a harness TUI client (`codex --remote`, `opencode attach`)
   *  under abduco in a scope SIBLING to the session's, streamed and warm-parked
   *  so its memory never counts against the agent's budget. */
  | {
      kind: 'client'
      placement: 'on-machine'
      stream: TerminalStreamRef
      warm: { ttlMs: number }
    }

/** RESERVED, DEFERRED (spec §5): a client terminal running on the USER's machine
 *  rather than the session's. Named so the union's growth is planned. */
export interface ReservedUserLocalAttach {
  kind: 'client'
  placement: 'user-local'
  connect: { url: string; token: string }
}

/** RESERVED, DEFERRED (spec §5): hand the session's own argv to a local terminal
 *  under a lease. Explicitly out of scope for POD-1761. */
export interface ReservedHandoverAttach {
  kind: 'handover'
  lease: SessionLease
  argv: readonly string[]
}

/** An opaque handle to the frame stream. The FRAMES THEMSELVES appear nowhere
 *  else in this surface — that containment is the point. */
export interface TerminalStreamRef {
  id: string
}

export interface AttachRequest {
  /** `takeover` claims the control lease; `peek` is an unlimited spectator. */
  mode: 'takeover' | 'peek'
  holder: string
}

/**
 * ONE CONTROL LEASE PER SESSION. Exactly one driver-controller (the runtime) or
 * one human-controller (an attach in take-over mode) holds it; spectators are
 * unlimited. This is what makes "the user attached and started typing" and "the
 * steward tried to nudge" impossible to interleave, and it generalizes
 * `exclusiveInteractiveResume` from a Claude quirk into the concurrency model.
 */
export interface SessionLease {
  holder: string
  kind: 'driver-controller' | 'human-controller'
  acquiredAt: string
  expiresAt?: string
}
