/**
 * A RUNNING CODEX SESSION ON A CHATGPT PLAN GETS A FRESH TOKEN BEFORE ITS OWN
 * RUNS OUT (credential management §11 "Codex"; epic Task 15).
 *
 * A Codex engine reads the plan's token from its environment once, at start,
 * and cannot take a new one while it runs. OpenAI's access tokens last an
 * hour. So Podium restarts the engine with resume at a turn boundary before
 * the token it holds runs low: credential health's restart re-resolves the
 * session, `attachAccess` issues a token with at least
 * {@link SESSION_TOKEN_MIN_LEFT_MS} left, and this schedule is set again from
 * that token's expiry.
 *
 * WHEN: {@link RESTART_WHEN_LEFT_MS} before the delivered token expires. A turn
 * running then is not cut: the restart waits for its end. A turn longer than
 * that margin outlives the token, fails readably (the driver's
 * `PLAN_TOKEN_EXPIRED_TEXT`), and the waiting restart runs at that boundary.
 *
 * WHAT A REFRESH MEANS: after a reconnect the server sends the session's access
 * again (`sessionAccessRefresh`), but the engine that survived keeps the token
 * it started with. So a refresh never moves the deadline later, and a refresh
 * for a session this server has no deadline for (it restarted, and the memory
 * went with it) restarts it at its next boundary, the only way to know what it
 * holds.
 *
 * Memory only. Nothing here holds a token.
 */

import type { SessionId } from '@podium/model'

/** A session is started with a token that has at least this long left. */
export const SESSION_TOKEN_MIN_LEFT_MS = 40 * 60_000
/** The session restarts at its next turn boundary once this little is left. */
export const RESTART_WHEN_LEFT_MS = 25 * 60_000

export interface PlanSessionRenewalDeps {
  now(): number
  /** Run `fn` at epoch ms `at` (now or soon when `at` has passed); returns a cancel. */
  setTimer(at: number, fn: () => void): () => void
  /** Credential health's restart with resume at the session's next turn boundary. */
  restartAtTurnBoundary(sessionId: SessionId): Promise<void>
  /** Where a failed restart request is reported. */
  onError?(err: unknown, sessionId: SessionId): void
}

export class PlanSessionRenewal {
  private readonly deadlines = new Map<SessionId, { at: number; cancel: () => void }>()

  constructor(private readonly deps: PlanSessionRenewalDeps) {}

  /**
   * A token that expires at `expiresAt` was just sent for the session:
   * `start` with a process start, `refresh` to a process already running.
   */
  delivered(sessionId: SessionId, expiresAt: number, kind: 'start' | 'refresh'): void {
    const at = expiresAt - RESTART_WHEN_LEFT_MS
    const known = this.deadlines.get(sessionId)
    if (kind === 'refresh') {
      if (!known) {
        this.schedule(sessionId, this.deps.now())
        return
      }
      if (known.at <= at) return
    }
    this.schedule(sessionId, at)
  }

  /** The deadline the session restarts at, if one is set (tests, diagnostics). */
  deadlineOf(sessionId: SessionId): number | undefined {
    return this.deadlines.get(sessionId)?.at
  }

  /** The session ended: nothing to renew. */
  forget(sessionId: SessionId): void {
    this.deadlines.get(sessionId)?.cancel()
    this.deadlines.delete(sessionId)
  }

  /** Stop every timer (server shutdown). */
  dispose(): void {
    for (const { cancel } of this.deadlines.values()) cancel()
    this.deadlines.clear()
  }

  private schedule(sessionId: SessionId, at: number): void {
    this.deadlines.get(sessionId)?.cancel()
    const cancel = this.deps.setTimer(at, () => {
      if (this.deadlines.get(sessionId)?.at !== at) return
      // Kept until the restart delivers a new token, so that a refresh
      // arriving in between does not read as "no deadline known".
      this.deps.restartAtTurnBoundary(sessionId).catch((err: unknown) => {
        this.deps.onError?.(err, sessionId)
      })
    })
    this.deadlines.set(sessionId, { at, cancel })
  }
}

/** `setTimer` on the real clock. Unref'd: a pending renewal never holds the process up. */
export function realTimer(now: () => number = Date.now) {
  return (at: number, fn: () => void): (() => void) => {
    const timer = setTimeout(fn, Math.max(0, at - now()))
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}
