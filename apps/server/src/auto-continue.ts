import { AUTO_CONTINUE_BASE_DELAY_MS, AUTO_CONTINUE_MAX_DELAY_MS } from '@podium/runtime'
import type { AgentRuntimeState, SessionId } from '@podium/model'

/** Everything the controller needs from the relay, injected so the loop is
 *  unit-testable with spies + fake timers and carries no relay knowledge. */
export interface AutoContinueDeps {
  /**
   * The switch for THIS SESSION, read fresh on every decision (PDM-295).
   *
   * It takes the session because `autoContinue.*` is a personal preference and
   * the session names the person: the answer is its owner's. It was a
   * no-argument "global master switch" that resolved the earliest admin, which
   * on a multi-human instance is one person's preference governing everybody's
   * agents. Implementations return FALSE when the owner cannot be named.
   */
  isEnabled: (sessionId: SessionId) => Promise<boolean>
  /** Type one `continue⏎` into the session (relay.continueSession, phase-gated). */
  sendContinue: (sessionId: SessionId) => void
  /** Liveness + latest agent state, or undefined if the session is gone. */
  getSession: (
    sessionId: SessionId,
  ) => { live: boolean; state: AgentRuntimeState | undefined } | undefined
}

/** A retryable-errored agent is one stopped on an error a blind retry might clear. */
function isRetryableErrored(s: AgentRuntimeState | undefined): boolean {
  return s?.phase === 'errored' && s.error?.retryable === true
}

/**
 * Backend auto-continue. When the master switch is on, every live session that
 * enters a retryable-errored state gets `continue` typed into it on an escalating
 * backoff (10s → 20s → … → 5 min cap) until it recovers. One loop per session;
 * the loop resets its backoff the moment the agent leaves the errored phase.
 */
export class AutoContinueController {
  /** sessionId → live loop. `attempt` drives backoff; `timer` is the pending tick. */
  private readonly loops = new Map<
    SessionId,
    { attempt: number; timer: ReturnType<typeof setTimeout> | undefined }
  >()

  constructor(private readonly deps: AutoContinueDeps) {}

  /** Backoff for the Nth (0-based) wait after a submit, capped at 5 min. */
  private delayMs(attempt: number): number {
    return Math.min(AUTO_CONTINUE_BASE_DELAY_MS * 2 ** attempt, AUTO_CONTINUE_MAX_DELAY_MS)
  }

  /** Relay calls this on every agent-state transition. Arms on a retryable error,
   *  stops (resetting backoff) the instant the agent is no longer in one. */
  async onStateChange(sessionId: SessionId, next: AgentRuntimeState): Promise<void> {
    if ((await this.deps.isEnabled(sessionId)) && isRetryableErrored(next)) await this.arm(sessionId)
    else this.stop(sessionId)
  }

  /** Restore a durable retryable-error loop without sending into a session that
   *  has not rebound its PTY yet. `onSessionLive` releases the first tick. */
  onSessionRestored(sessionId: SessionId, next: AgentRuntimeState): void {
    if (!isRetryableErrored(next) || this.loops.has(sessionId)) return
    this.loops.set(sessionId, { attempt: 0, timer: undefined })
  }

  /** First real bind after boot releases a restored loop exactly once. */
  async onSessionLive(sessionId: SessionId): Promise<void> {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.timer !== undefined) return
    await this.tick(sessionId)
  }

  /**
   * ONE PERSON'S SWITCH FLIPPED (PDM-295), so only THEIR sessions are affected.
   *
   * `retryableErroredLiveIds` is already narrowed by the caller to the sessions
   * that person owns. On enable, arm them; on disable, stop those same loops —
   * NOT `stopAll()`, which is what this did while the switch was the earliest
   * admin's and therefore everybody's. An instance where one member turning
   * auto-continue off silently cancelled every other member's recovery loops is
   * the same defect wearing a different hat.
   */
  async onSettingsChanged(enabled: boolean, retryableErroredLiveIds: SessionId[]): Promise<void> {
    if (!enabled) {
      for (const id of retryableErroredLiveIds) this.stop(id)
      return
    }
    for (const id of retryableErroredLiveIds) await this.arm(id)
  }

  /** Session hibernated/exited/killed — drop its loop promptly. */
  onSessionGone(sessionId: SessionId): void {
    this.stop(sessionId)
  }

  /** True while a loop is active for the session (introspection/test helper). */
  isActive(sessionId: SessionId): boolean {
    return this.loops.has(sessionId)
  }

  dispose(): void {
    this.stopAll()
  }

  private async arm(sessionId: SessionId): Promise<void> {
    if (this.loops.has(sessionId)) return // one loop per session
    this.loops.set(sessionId, { attempt: 0, timer: undefined })
    await this.tick(sessionId)
  }

  /** Send one nudge if still warranted, then schedule the next with backoff. */
  private async tick(sessionId: SessionId): Promise<void> {
    const loop = this.loops.get(sessionId)
    if (!loop) return
    const snap = this.deps.getSession(sessionId)
    if (
      !(await this.deps.isEnabled(sessionId)) ||
      !snap ||
      !snap.live ||
      !isRetryableErrored(snap.state)
    ) {
      this.stop(sessionId)
      return
    }
    this.deps.sendContinue(sessionId)
    const ms = this.delayMs(loop.attempt)
    loop.attempt += 1
    // NOT awaited: the backoff tick answers to no caller (rule 57).
    loop.timer = setTimeout(() => void this.tick(sessionId), ms)
  }

  private stop(sessionId: SessionId): void {
    const loop = this.loops.get(sessionId)
    if (!loop) return
    if (loop.timer) clearTimeout(loop.timer)
    this.loops.delete(sessionId)
  }

  private stopAll(): void {
    for (const id of [...this.loops.keys()]) this.stop(id)
  }
}
