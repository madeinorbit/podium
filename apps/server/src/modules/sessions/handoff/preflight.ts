/**
 * PRE-FLIGHT — the last phase that can still be abandoned.
 *
 * Everything here takes real time and NOTHING here is irreversible, which is
 * exactly why it is one phase: `ensureTargetRepo` may CLONE the repository onto
 * the target and the base handshake is a round-trip to both daemons, but if any
 * of it fails the session is still live on its source machine and the only
 * cleanup owed is the overlay. The statement after this phase returns is the one
 * that stops a live process.
 *
 * ---------------------------------------------------------------------------
 * WHO CLEARS THE OVERLAY, AND WHY IT IS WRITTEN TWO DIFFERENT WAYS
 * ---------------------------------------------------------------------------
 *
 * `handoffTarget` is what every client renders a move with (the pane's handover
 * state, the sidebar row). It is painted HERE, at the top of the pre-flight, and
 * three different exits take it down — so a reader who finds only one of them
 * will conclude the other paths leak an overlay. They do not:
 *
 *   pre-flight throws  → cleared here, via `mutateSessionView` + broadcast,
 *                        because the row is otherwise untouched and there is no
 *                        persist to piggyback on.
 *   transfer succeeds  → cleared by the transfer, as one field of the same
 *                        `persist` that re-homes the row onto the target.
 *   transfer throws    → cleared by the transfer's rollback, likewise inside its
 *                        persist.
 *
 * The mechanism differs because what else is being written differs; the field is
 * the session row's, not this phase's, and no phase holds a copy of it.
 *
 * OBLIGATION 2, FIRST CHECKPOINT (ADR 3 D8/D16) is the last statement of this
 * phase and it belongs to this phase: both machines are re-authorized AFTER the
 * clone and the handshake, while the last act is still reversible. A gate
 * answered before a minutes-long clone is a rights snapshot; answered here, a
 * grant revoked during the clone still refuses with the process untouched.
 */

import { basename } from 'node:path'
import { verifiedBundleBases, verifiedCommonBundleBases } from '../handoff-transfer'
import type { HandoffPlacement } from './placement'
import type { AssertMachineUse, HandoffInput, HandoffPorts } from './ports'

/** What the pre-flight can reach. It writes exactly one thing — the overlay —
 *  and the absence of `persist`, `toMachine` and `onSessionGone` from this list
 *  is the guarantee that it cannot stop or move anything. */
export type HandoffPreflightPorts = Pick<
  HandoffPorts,
  'rpc' | 'ensureTargetRepo' | 'mutateSessionView' | 'broadcastSessions'
>

/** The repository row on the target, as `ensureTargetRepo` reports it — derived
 *  from the port rather than restated, so a widened result cannot drift from
 *  what this phase claims to return. */
type TargetRepo = Awaited<ReturnType<HandoffPorts['ensureTargetRepo']>>

/** What the transfer needs that only the pre-flight can know. */
export interface HandoffPreflightResult {
  readonly targetRepo: TargetRepo
  /** The branch the bundle carries: the issue's, or the worktree directory name. */
  readonly branch: string
  /** Bases BOTH machines verified — an empty set is refused before the kill. */
  readonly baseShas: string[]
}

export class HandoffPreflight {
  constructor(private readonly ports: HandoffPreflightPorts) {}

  /**
   * Paint the overlay, make the target ready, and agree a bundle base with it.
   * Throws with the overlay dropped and nothing else changed.
   */
  async prepare(
    placement: HandoffPlacement,
    input: HandoffInput,
    assertMachineUse: AssertMachineUse,
  ): Promise<HandoffPreflightResult> {
    const { session, sourceRepo, issue, targetMachine } = placement
    // Announce the move BEFORE the pre-flight (POD-337): everything from here on
    // can take real time — `ensureTargetRepo` may clone the repo on the target —
    // and `handoffTarget` is what every client renders the move with (the pane's
    // handover state, the sidebar row). Set after the synchronous eligibility
    // checks, so a refused move never flashes an overlay; cleared on every exit
    // that doesn't reach the target.
    this.ports.mutateSessionView(session.sessionId, (current) => {
      current.handoffTarget = targetMachine.name
    })
    this.ports.broadcastSessions()
    const clearHandoffOverlay = (): void => {
      this.ports.mutateSessionView(session.sessionId, (current) => {
        current.handoffTarget = undefined
      })
      this.ports.broadcastSessions()
    }

    let targetRepo: TargetRepo
    let baseShas: string[]
    let branch: string
    try {
      targetRepo = await this.ports.ensureTargetRepo(sourceRepo, input.machineId)
      branch = issue?.branch ?? basename(session.cwd)
      const candidates = [
        ...new Set(
          [issue?.parentBranch, 'main', 'origin/main', branch].filter((ref): ref is string =>
            Boolean(ref),
          ),
        ),
      ]
      const sourceVerified = await Promise.all(
        candidates.map((ref) =>
          this.ports.rpc.repoOp('revParseVerify', sourceRepo.path, { ref }, session.machineId),
        ),
      )
      const sourceBaseShas = verifiedBundleBases(sourceVerified)
      const targetVerified = await Promise.all(
        sourceBaseShas.map((ref) =>
          this.ports.rpc.repoOp('revParseVerify', targetRepo.path, { ref }, input.machineId),
        ),
      )
      baseShas = verifiedCommonBundleBases(sourceVerified, targetVerified)
      if (baseShas.length === 0)
        throw new Error('target repository has no verified common bundle base')
      // OBLIGATION 2, first checkpoint: the clone and the base handshake above
      // can take minutes. Re-authorize BOTH machines here, while the last act is
      // still reversible — the next statement stops a live process.
      assertMachineUse(session.machineId)
      assertMachineUse(input.machineId)
    } catch (error) {
      // Nothing has been stopped or moved yet — drop the overlay and report.
      clearHandoffOverlay()
      throw error
    }
    return { targetRepo, branch, baseShas }
  }
}
