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

export interface SessionRegistryPorts {
  /** The durable label for a session nobody has labelled yet. */
  labelFor(sessionId: SessionId): string
}

export class SessionRegistry {
  private readonly sessions = new Map<SessionId, DaemonSession>()
  private readonly labelFor: (sessionId: SessionId) => string

  constructor(ports: SessionRegistryPorts) {
    this.labelFor = ports.labelFor
  }

  /** The session, creating and labelling it on first use. */
  ensure(sessionId: SessionId): DaemonSession {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = new DaemonSession({ sessionId, label: this.labelFor(sessionId) })
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
