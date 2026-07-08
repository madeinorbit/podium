import { AUTO_CONTINUE_BASE_DELAY_MS, AUTO_CONTINUE_MAX_DELAY_MS } from '@podium/runtime'
import type { AgentRuntimeState } from '@podium/protocol'

/** Everything the controller needs from the relay, injected so the loop is
 *  unit-testable with spies + fake timers and carries no relay knowledge. */
export interface AutoContinueDeps {
  /** The global master switch, read fresh on every decision. */
  isEnabled: () => boolean
  /** Type one `continue⏎` into the session (relay.continueSession, phase-gated). */
  sendContinue: (sessionId: string) => void
  /** Liveness + latest agent state, or undefined if the session is gone. */
  getSession: (
    sessionId: string,
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
    string,
    { attempt: number; timer: ReturnType<typeof setTimeout> | undefined }
  >()

  constructor(private readonly deps: AutoContinueDeps) {}

  /** Backoff for the Nth (0-based) wait after a submit, capped at 5 min. */
  private delayMs(attempt: number): number {
    return Math.min(AUTO_CONTINUE_BASE_DELAY_MS * 2 ** attempt, AUTO_CONTINUE_MAX_DELAY_MS)
  }

  /** Relay calls this on every agent-state transition. Arms on a retryable error,
   *  stops (resetting backoff) the instant the agent is no longer in one. */
  onStateChange(sessionId: string, next: AgentRuntimeState): void {
    if (this.deps.isEnabled() && isRetryableErrored(next)) this.arm(sessionId)
    else this.stop(sessionId)
  }

  /** Master switch flipped. On enable, arm any already-errored live sessions; on
   *  disable, cancel every running loop. */
  onSettingsChanged(enabled: boolean, retryableErroredLiveIds: string[]): void {
    if (!enabled) {
      this.stopAll()
      return
    }
    for (const id of retryableErroredLiveIds) this.arm(id)
  }

  /** Session hibernated/exited/killed — drop its loop promptly. */
  onSessionGone(sessionId: string): void {
    this.stop(sessionId)
  }

  /** True while a loop is active for the session (introspection/test helper). */
  isActive(sessionId: string): boolean {
    return this.loops.has(sessionId)
  }

  private arm(sessionId: string): void {
    if (this.loops.has(sessionId)) return // one loop per session
    this.loops.set(sessionId, { attempt: 0, timer: undefined })
    this.tick(sessionId)
  }

  /** Send one nudge if still warranted, then schedule the next with backoff. */
  private tick(sessionId: string): void {
    const loop = this.loops.get(sessionId)
    if (!loop) return
    const snap = this.deps.getSession(sessionId)
    if (!this.deps.isEnabled() || !snap || !snap.live || !isRetryableErrored(snap.state)) {
      this.stop(sessionId)
      return
    }
    this.deps.sendContinue(sessionId)
    const ms = this.delayMs(loop.attempt)
    loop.attempt += 1
    loop.timer = setTimeout(() => this.tick(sessionId), ms)
  }

  private stop(sessionId: string): void {
    const loop = this.loops.get(sessionId)
    if (!loop) return
    if (loop.timer) clearTimeout(loop.timer)
    this.loops.delete(sessionId)
  }

  private stopAll(): void {
    for (const id of [...this.loops.keys()]) this.stop(id)
  }
}
