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
 * reading them per-frame is what lets the sink exist first. Both may answer
 * `undefined` during that window and the sink stays fail-open — a frame is never
 * held back because an observer is not up yet.
 */

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
  return (message: DaemonMessage): void => {
    /**
     * THE ONE TYPE THE DRIVER TAP MUST SKIP. The driver emits `runtimeEvent`
     * frames THROUGH this sink, so observing them here would feed the driver its
     * own output. `runtimeFineEvent` is the same stream at token granularity.
     */
    if (message.type !== 'runtimeEvent' && message.type !== 'runtimeFineEvent') {
      ports.runtime()?.observe(message)
    }
    /**
     * A NATIVE ATTACH THE SESSION REFUSED IS RE-ARMED FROM THE STATE FRAME IT
     * ALREADY EMITS. Every family's phase change becomes exactly this frame —
     * the three server drivers and the terminal observers all send it — so one
     * hook here is what three per-driver callbacks would have been. The phase
     * comes off the frame UNTRANSLATED: the decision about which phases can win
     * a take-over belongs to the reconcile, not to the sink.
     */
    if (message.type === 'agentState') {
      const ctx = ports.context()
      if (ctx) nativeClientStateObserved(ctx, message.sessionId, message.state)
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
    if (message.type === 'runtimeEvent' && message.event.t === 'interaction') {
      if (message.event.ev.ev === 'answered') {
        const ctx = ports.context()
        if (ctx) nativeClientInteractionAnswered(ctx, message.sessionId)
      }
    }
    ports.upstream(message)
  }
}
