/**
 * THE HANDOFF HANDLER — POD-642 (3.2e), the command-plane owner of
 * `sessions.handoff`.
 *
 * The choreography itself is UNCHANGED and is meant to stay that way: POD-379's
 * oracle (`oracle-handoff.test.ts`) pins the order of the irreversible steps
 * across both machines, and the point of moving it here was to give the
 * command's obligations a place to live, not to redesign the transfer. Three
 * obligations are new, and all three are about WHEN a decision is taken
 * relative to an irreversible act:
 *
 *   1. `use` ON BOTH MACHINES, REFUSED BEFORE ANYTHING MOVES (readiness §3.1.4
 *      M5). Handoff is a `use` operation on the source (may I take this session
 *      OFF here?) and on the target (may I run it THERE?). Both are checked
 *      before the pre-flight, so a denial never stops a process or paints a
 *      handover overlay.
 *
 *   2. APPLY-TIME RE-AUTHORIZATION (ADR 3 D8/D16). A handoff takes real time —
 *      `ensureTargetRepo` may CLONE the repository, and the package transfer is
 *      chunked over the network. A dispatch-time check is therefore stale by the
 *      time each leg applies, so the target is re-checked immediately before the
 *      irreversible kill and again immediately before the import leg. A grant
 *      revoked mid-transfer is refused AT APPLY and rolls back to the source; it
 *      does not complete on the strength of a check made minutes earlier. This
 *      is the case D16 was written for: rights are the agent's scope intersected
 *      with its human's CURRENT rights, resolved live, never a snapshot.
 *
 *   3. IDEMPOTENCY ACROSS THE MULTI-LEG EXCHANGE. Before this, two concurrent
 *      dispatches ran two complete orchestrations: the package was exported
 *      twice, imported twice and SPAWNED TWICE on the target — two live owners
 *      of one conversation, which is the fork this command must not produce
 *      (POD-379 tagged that characterization `willChange(POD-642)` precisely so
 *      the change would be visible here). A single-flight registry keyed by
 *      session collapses a duplicate dispatch to the SAME target onto the
 *      in-flight transfer, and refuses a concurrent dispatch to a DIFFERENT
 *      target rather than racing two targets for one session.
 *
 * NOT OFFLINE-ENQUEUED, and it is not a judgement call: `use` on a machine makes
 * this an execution command (ADR 3 Amendment 1 D18.3), and a command that causes
 * execution on a live daemon must never be replayed out of a queue after the
 * world has moved. The contract declares `offline: 'online-only'`.
 *
 * ATTRIBUTION IS A PAIR (ADR 3 D17, ADR 9 D5 A3). The durable record names the
 * ACTOR (which agent or person initiated the move) and the ON-BEHALF-OF human,
 * both read off the transport capability, never off the payload. The bundle
 * manifest's own `format: 2` attribution is stamped here from that authenticated
 * principal and is never accepted from manifest payload identity.
 *
 * OWNERSHIP DOES NOT MOVE WITH THE SESSION. A session's owner is its
 * `onBehalfOf` human (ADR 9 D5 A4) and a machine change is not an ownership
 * change: the manifest records provenance, while the transferred binding carries
 * its existing delegation unchanged. Nothing mints a transfer-specific identity
 * or token.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR PHASES, AND WHAT SEPARATES THEM (POD-1399)
 * ---------------------------------------------------------------------------
 *
 * This file is the SEQUENCER. It holds no state, decides nothing, and its job is
 * to name the order in which the phases run and hand each one what the previous
 * one produced. Every seam below is the same kind of line — a change in what an
 * exit costs — because that is the property the choreography turns on:
 *
 *   {@link HandoffAdmission}   may this caller move this session, and is a move
 *                              already running. OWNS the single-flight registry;
 *                              nothing else can reach it. Refusing costs nothing.
 *   {@link resolveHandoffPlacement}
 *                              where it is, where it is going, and whether that
 *                              is possible. Reads only — its port type has no
 *                              write on it. Refusing costs nothing.
 *   {@link HandoffPreflight}   clone the repo, agree a common base, re-authorize.
 *                              Takes real time; refusing costs one overlay.
 *   {@link HandoffTransfer}    the kill, the package, the claim, the commit, the
 *                              receipt. Refusing costs an unwind, and past the
 *                              authorized target claim it is not refusable at
 *                              all — the target keeps the session.
 *
 * A phase can be read, and tested, without the ones after it. That was the thing
 * a single 401-line method made impossible: every property above was reachable
 * only by driving a complete two-machine transfer.
 */

import type { SessionId } from '@podium/model'
import { HandoffAdmission } from './admission'
import { resolveHandoffPlacement } from './placement'
import type {
  AssertMachineUse,
  HandoffCaller,
  HandoffInput,
  HandoffPorts,
  HandoffResult,
} from './ports'
import { HandoffPreflight } from './preflight'
import { HandoffTransfer } from './transfer'

export { HANDOFF_UNKNOWN_SESSION, type HandoffInput, type HandoffResult } from './ports'

export class HandoffCoordinator {
  /** ADMISSION owns the single-flight registry — see {@link HandoffAdmission}.
   *  The coordinator holds the phase, never the map: a registry reachable from
   *  the pieces that prepare and apply a transfer would be the duplicate-dispatch
   *  guard with three writers and no owner. */
  private readonly admission: HandoffAdmission
  private readonly preflight: HandoffPreflight
  private readonly transfer: HandoffTransfer

  constructor(private readonly ports: HandoffPorts) {
    this.admission = new HandoffAdmission(ports)
    this.preflight = new HandoffPreflight(ports)
    this.transfer = new HandoffTransfer(ports)
  }

  /**
   * Dispatch a handoff. Duplicate dispatch to the same target JOINS the transfer
   * already running; a concurrent dispatch to a different target is refused.
   * Both are decided in {@link HandoffAdmission}, which authorizes every dispatch
   * with its own gate BEFORE coalescing it.
   */
  handoff(
    input: HandoffInput,
    caller: HandoffCaller,
    assertMachineUse: AssertMachineUse,
  ): Promise<HandoffResult> {
    return this.admission.admit(input, caller, assertMachineUse, () =>
      this.run(input, caller, assertMachineUse),
    )
  }

  /** True while a transfer for this session is in flight (diagnostics/tests). */
  isTransferring(sessionId: SessionId): boolean {
    return this.admission.isTransferring(sessionId)
  }

  /**
   * THE SEQUENCE, and nothing else. Admission has already authorized this
   * dispatch (obligation 1) — including a caller that joined an in-flight
   * transfer — so what is left is three phases in the one order that keeps every
   * irreversible act behind a decision that was still cheap to reverse.
   *
   * `assertMachineUse` is threaded rather than resolved once: the pre-flight and
   * the transfer each call it again at their own apply points, which is what
   * makes the re-authorization live rather than a replay of one dispatch-time
   * answer (ADR 3 D8/D16).
   */
  private async run(
    input: HandoffInput,
    caller: HandoffCaller,
    assertMachineUse: AssertMachineUse,
  ): Promise<HandoffResult> {
    const placement = resolveHandoffPlacement(this.ports, input, caller)
    const prepared = await this.preflight.prepare(placement, input, assertMachineUse)
    return this.transfer.apply(placement, prepared, input, caller, assertMachineUse)
  }
}
