/**
 * THE DAEMON'S OUTBOUND FRAME SINK (POD-2489).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A NAMED FUNCTION RATHER THAN A CLOSURE INSIDE THE BOOTSTRAP
 * ---------------------------------------------------------------------------
 *
 * Every frame this daemon sends passes two observation taps on its way out, and
 * both of them are load-bearing: the machine runtime's `observe` is how the
 * terminal driver sees the session it drives, and `nativeClientStateObserved` is
 * how a refused Native attach learns the session became attachable again. Both
 * used to live in an anonymous closure built inside `createDaemonHostRuntime`,
 * reachable only by booting the daemon — so POD-2489's adversarial review could
 * delete the second tap outright and watch every shipped gate stay green. A tap
 * whose absence nothing notices is not wired, it is coincidence.
 *
 * So the sink is a function with ports and a test of its own. The ports are
 * THUNKS, not values, because the bootstrap builds this before the two things it
 * reads: the runtime and the context both close their wiring cycle later, and
 * reading them PER FRAME is what lets the sink exist first. Hoisting either read
 * out of the returned function would leave it `undefined` for the process's whole
 * life and silently kill the tap — the exact failure this file was extracted to
 * make testable, so `frame-sink.test.ts` pins the per-frame read directly.
 *
 * Both ports may answer `undefined` during that window, and the sink stays open
 * across it: a frame is never held back because an observer is not up yet. That
 * is a statement about ABSENT observers, not about failing ones — a tap that
 * throws propagates, and the frame does not reach `upstream`. No tap on this path
 * can throw today, and pretending otherwise by swallowing would hide a real
 * defect rather than tolerate a missing one.
 */

import {
  compareProviderCursor,
  initialAgentState,
  reduceAgentState,
  type AgentStateEvent,
} from '@podium/harness'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { ProviderCursor } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { DaemonContext } from './control/context'
import { nativeClientInteractionAnswered, nativeClientStateObserved } from './control/session'

export interface FrameSinkPorts {
  /** The real transport. Every frame reaches it, tapped or not. */
  upstream(message: DaemonMessage): void
  /** The machine runtime's observation tap, once it is built. */
  runtime(): { observe(message: DaemonMessage): void } | undefined
  /** The daemon context, once the bootstrap has one. */
  context(): DaemonContext | undefined
}

export function createFrameSink(ports: FrameSinkPorts): (message: DaemonMessage) => void {
  const states = new Map<
    SessionId,
    { generation: number; cursor: ProviderCursor; state: AgentRuntimeState }
  >()
  const generations = new Map<SessionId, number>()
  return (message: DaemonMessage): void => {
    const currentGeneration = 'sessionId' in message ? generations.get(message.sessionId) : undefined
    const staleRuntimeEvent = message.type === 'runtimeEvent' &&
      currentGeneration !== undefined && message.event.observerGeneration < currentGeneration
    if (message.type === 'runtimeEvent' && Number.isSafeInteger(message.event.observerGeneration) && !staleRuntimeEvent) {
      generations.set(message.sessionId, message.event.observerGeneration)
    }
    /**
     * THE ONE TYPE THE DRIVER TAP MUST SKIP. The driver emits `runtimeEvent`
     * frames THROUGH this sink, so observing them here would feed the driver its
     * own output. `runtimeFineEvent` is the same stream at token granularity.
     */
    if (message.type !== 'runtimeEvent' && message.type !== 'runtimeFineEvent') {
      ports.runtime()?.observe(message)
    }
    // Fold the contract stream for native retry admission. Stale generations
    // and replayed cursors cannot re-arm an attachment refused by newer state.
    if (message.type === 'runtimeEvent' && message.event.t === 'state' && !staleRuntimeEvent) {
      const event = message.event
      const prior = states.get(message.sessionId)
      const fresh =
        !prior ||
        event.observerGeneration > prior.generation ||
        (event.observerGeneration === prior.generation &&
          compareProviderCursor(prior.cursor, event.cursor) === 'after')
      if (fresh) {
        const state = reduceAgentState(
          prior?.state ?? initialAgentState(event.at),
          event.change as AgentStateEvent,
          event.at,
        )
        states.set(message.sessionId, {
          generation: event.observerGeneration,
          cursor: event.cursor,
          state,
        })
        const ctx = ports.context()
        if (ctx) nativeClientStateObserved(ctx, message.sessionId, state)
      }
    }
    /**
     * AND THE OTHER HALF OF THAT RE-ARM: AN ASK THAT WAS JUST ANSWERED.
     *
     * Opening the native TUI to answer a prompt is refused with `needs_user`, and
     * no state frame ever announces the answer — codex folds the phase in
     * `closeAsk()` without emitting a state event, and its driver turns only the
     * `asked` interaction into a frame (POD-2494). The causal stream, though,
     * carries the `answered` event itself, and it comes through this same sink.
     * So the fact is here; it just is not in the frame the other tap reads.
     *
     * This is NOT the recursion the skip above guards against: that rule exists
     * because the driver's `observe` feeds the driver, and nothing under this tap
     * emits a frame.
     */
    if (message.type === 'runtimeEvent' && message.event.t === 'interaction' && !staleRuntimeEvent) {
      if (message.event.ev.ev === 'answered') {
        const ctx = ports.context()
        if (ctx) nativeClientInteractionAnswered(ctx, message.sessionId)
      }
    }
    ports.upstream(message)
  }
}
