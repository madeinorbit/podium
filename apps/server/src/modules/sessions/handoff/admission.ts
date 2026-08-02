/**
 * ADMISSION — who is allowed to start a handoff, and how many of them run.
 *
 * This is the first of the four phases `HandoffCoordinator` sequences, and it is
 * the only one that OWNS STATE. The single-flight registry lives here and is
 * private to this class: it is the thing that stops a duplicate dispatch from
 * exporting the package twice, importing it twice and SPAWNING IT TWICE on the
 * target — two live owners of one conversation (obligation 3 in the
 * coordinator's header). A registry passed by reference to the pieces that
 * decide, prepare and apply a transfer would be the same guard with three
 * writers and no owner, which is the shape a decomposition is supposed to
 * remove rather than create. Nothing outside this file can reach the map;
 * `isTransferring` is the only read of it anyone else gets.
 *
 * THE ELIGIBILITY AND `use` CHECKS RUN BEFORE THE JOIN, not after — the property
 * `handoff` used to hold inline and the reason admission is one phase rather
 * than two. A caller that joined an in-flight transfer without being authorized
 * would ride the INITIATOR's authorization: it would be told the move succeeded
 * without ever having been allowed to ask for it. So every dispatch is
 * authorized with its OWN gate first, and only then coalesced.
 *
 * WHAT ADMISSION DELIBERATELY DOES NOT DO: resolve anything. It answers "may
 * this caller move this session at all, and is a move already running" from the
 * session row and the two `use` checks, and hands the rest to
 * {@link resolveHandoffPlacement}. Every check here is synchronous and nothing
 * it touches can have moved by the time it answers, which is what lets the
 * refusals be reported as a rejected promise with nothing to unwind.
 */

import type { SessionId } from '@podium/model'
import { harnessSupportsHandoff } from '../../../harness-manifest'
import {
  type AssertMachineUse,
  HANDOFF_UNKNOWN_SESSION,
  type HandoffCaller,
  type HandoffInput,
  type HandoffPorts,
  type HandoffResult,
} from './ports'

interface InFlight {
  readonly machineId: string
  readonly promise: Promise<HandoffResult>
}

export class HandoffAdmission {
  /** One live transfer per session — see the header. Private, and it stays that
   *  way: this map is the guard, not a detail of it. */
  private readonly inFlight = new Map<string, InFlight>()

  constructor(private readonly ports: Pick<HandoffPorts, 'getSession'>) {}

  /**
   * Authorize a dispatch and either start it or coalesce it onto the transfer
   * already running. `start` is invoked at most once per admitted dispatch.
   *
   * Duplicate dispatch to the same target JOINS the running transfer; a
   * concurrent dispatch to a DIFFERENT target is refused rather than raced —
   * two targets for one session is the fork this command must not produce, and
   * it cannot be resolved by picking one, because the loser would already have
   * been told its move succeeded.
   */
  admit(
    input: HandoffInput,
    caller: HandoffCaller,
    assertMachineUse: AssertMachineUse,
    start: () => Promise<HandoffResult>,
  ): Promise<HandoffResult> {
    try {
      // FAIL CLOSED ON A MISSING PRINCIPAL. There is no ambient operator here: a
      // call site that forgets to thread the transport caller is refused, not
      // silently granted the rights the old inline path assumed (ADR 3 D7).
      if (!caller?.capability) throw new Error('handoff requires an authenticated caller')
      const session = this.ports.getSession(input.sessionId)
      if (!session) throw new Error(HANDOFF_UNKNOWN_SESSION)
      // ASKED OF THE CAPABILITY TABLE, not of the harness's name (POD-1105). The
      // pair of equality checks this replaces was the same answer with the
      // harness list copied into the command path, which is what the
      // harness-branching boundary rule exists to stop: an unknown harness is not
      // handoff-eligible, and that stays true without this file being edited.
      if (!harnessSupportsHandoff(session.agentKind)) {
        throw new Error('session harness does not support handoff')
      }
      if (!session.resume) throw new Error('session has no resume reference')
      // Handoff is a `use` operation on BOTH machines: may I take this session OFF
      // here, and may I run it THERE. Checked before the already-on-that-machine
      // refusal on purpose, so an unusable target answers the same way whatever
      // the session's current home happens to be.
      assertMachineUse(session.machineId)
      assertMachineUse(input.machineId)
    } catch (error) {
      return Promise.reject(error)
    }

    const existing = this.inFlight.get(input.sessionId)
    if (existing) {
      if (existing.machineId === input.machineId) return existing.promise
      // Two targets for one session is the fork this command must not produce,
      // and it cannot be resolved by picking one: the loser would already have
      // been told its move succeeded.
      return Promise.reject(new Error('session handoff already in progress'))
    }
    const promise = start().finally(() => {
      const current = this.inFlight.get(input.sessionId)
      if (current?.promise === promise) this.inFlight.delete(input.sessionId)
    })
    this.inFlight.set(input.sessionId, { machineId: input.machineId, promise })
    return promise
  }

  /** True while a transfer for this session is in flight (diagnostics/tests). */
  isTransferring(sessionId: SessionId): boolean {
    return this.inFlight.has(sessionId)
  }
}
