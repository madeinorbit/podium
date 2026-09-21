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
import type { SessionEngineScope } from './engines.js'

export class SessionRegistry {
  private readonly sessions = new Map<SessionId, DaemonSession>()
  /**
   * The session layer's engine hold (spec §4.8 steps 2–6), bound once by the
   * composition root over the daemon's engine durable. Sessions created after
   * the bind route their engine delegates through it; entries already held
   * pick it up on their next `ensure`.
   */
  private engineScope: SessionEngineScope | undefined = undefined
  /**
   * Viewer-signal memory, WITHOUT an entry. The "somebody opened this
   * session" frame usually arrives before its client terminal exists (and is
   * sent only on change), so the relay seeds from here at open/adopt time.
   * Only watched ids are stored; nothing here mints entries.
   */
  private readonly watchedSessions = new Set<SessionId>()

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
    if (this.engineScope) session.engines ??= this.engineScope
    return session
  }

  /**
   * Bind the session layer's engine hold. Called once by the composition root
   * with the scope over the daemon's engine durable; every session delegate
   * (`spawnEngine`, `killEngine`, `journalFor`, …) routes through it.
   */
  bindEngines(scope: SessionEngineScope): void {
    this.engineScope = scope
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

  /** Record the viewer signal for a session, whether or not it has an entry. */
  noteWatched(sessionId: SessionId, watched: boolean): void {
    if (watched) this.watchedSessions.add(sessionId)
    else this.watchedSessions.delete(sessionId)
  }

  /** Whether the viewer signal currently marks this session watched. */
  isWatched(sessionId: SessionId): boolean {
    return this.watchedSessions.has(sessionId)
  }

  entries(): IterableIterator<[SessionId, DaemonSession]> {
    return this.sessions.entries()
  }
}
