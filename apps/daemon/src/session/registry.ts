/**
 * THE SESSION REGISTRY (POD-4434): SessionId → DaemonSession, replacing the
 * per-session maps on DaemonContext.
 *
 * The registry constructs a DaemonSession on first use through a caller-held
 * `labelFor` (the daemon's durable-label function): production wires the real
 * one, tests stub it. Nothing here names a frame, an observer or a driver —
 * it is a map with a label policy, and the lifecycle policy lives on the
 * sessions and their terminals.
 */

import type { SessionId } from '@podium/model'
import { DaemonSession } from './daemon-session.js'

export class SessionRegistry {
  private readonly sessions = new Map<SessionId, DaemonSession>()

  /**
   * The session, creating it on first use. Created UNLABELLED: the label is
   * the process identity and only spawn/reattach/steal know it. A held resize
   * or a viewer signal must never mint one — a stamped default would trip the
   * reattach identity guard for a session this daemon never owned.
   */
  ensure(sessionId: SessionId): DaemonSession {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = new DaemonSession({ sessionId })
      this.sessions.set(sessionId, session)
    }
    return session
  }

  get(sessionId: SessionId): DaemonSession | undefined {
    return this.sessions.get(sessionId)
  }

  has(sessionId: SessionId): boolean {
    return this.sessions.has(sessionId)
  }

  delete(sessionId: SessionId): void {
    this.sessions.delete(sessionId)
  }

  clear(): void {
    this.sessions.clear()
  }

  get size(): number {
    return this.sessions.size
  }

  entries(): IterableIterator<[SessionId, DaemonSession]> {
    return this.sessions.entries()
  }
}
