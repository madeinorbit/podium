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
 */

import { basename } from 'node:path'
import type { SessionId } from '@podium/model'
import { asMachineId } from '@podium/model'
import {
  transferHandoffPackage,
  verifiedBundleBases,
  verifiedCommonBundleBases,
} from '../handoff-transfer'
import { HandoffAdmission } from './admission'
import { recordHandoff } from './attribution'
import { resolveHandoffPlacement } from './placement'
import type {
  AssertMachineUse,
  HandoffCaller,
  HandoffInput,
  HandoffPorts,
  HandoffResult,
} from './ports'

export { HANDOFF_UNKNOWN_SESSION, type HandoffInput, type HandoffResult } from './ports'

/** How long the source daemon is given to release the terminal after the kill.
 *  Unchanged value, named and injected so a test does not have to wait it out. */
const SOURCE_RELEASE_MS = 500

export class HandoffCoordinator {
  /** ADMISSION owns the single-flight registry — see {@link HandoffAdmission}.
   *  The coordinator holds the phase, never the map: a registry reachable from
   *  the pieces that prepare and apply a transfer would be the duplicate-dispatch
   *  guard with three writers and no owner. */
  private readonly admission: HandoffAdmission

  constructor(private readonly ports: HandoffPorts) {
    this.admission = new HandoffAdmission(ports)
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

  private async run(
    input: HandoffInput,
    caller: HandoffCaller,
    assertMachineUse: AssertMachineUse,
  ): Promise<HandoffResult> {
    const {
      session,
      agentKind,
      exportIdentity,
      transferId,
      sourceMachineId,
      targetMachineId,
      sourceRepo,
      issue,
      issueWorktree,
      targetMachine,
    } = resolveHandoffPlacement(this.ports, input, caller)
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

    let targetRepo: { path: string }
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

    const source = { machineId: session.machineId, cwd: session.cwd, status: session.status }
    const wasRunning =
      session.status === 'live' ||
      session.status === 'starting' ||
      session.status === 'reconnecting'
    if (wasRunning) {
      session.status = 'hibernated'
      this.ports.onSessionGone(session.sessionId)
      this.ports.persist(session)
      this.ports.toMachine(source.machineId, { type: 'kill', sessionId: session.sessionId })
      this.ports.broadcastSessions()
      await this.ports.sleep(SOURCE_RELEASE_MS)
    }

    let targetClaimed = false
    let sourceCommitted = false
    let winnerAuthorized = false
    let importedLocation:
      | { newCwd: string; worktreeRoot?: string; observationGeneration: number }
      | undefined
    try {
      const exported = await this.ports.rpc.handoffExport(
        {
          sessionId: session.sessionId,
          cwd: source.cwd,
          ...(issueWorktree ? { fallbackCwd: issueWorktree } : {}),
          agentKind,
          resume: session.resume,
          branch,
          baseShas,
          repoId: sourceRepo.repoId,
          ...(session.name || session.title ? { title: session.name || session.title } : {}),
          ...(session.issueId ? { issueId: session.issueId } : {}),
          sourceMachineId: source.machineId,
          binding: {
            transitionId: `adopt:${transferId}:source-claim`,
            transferId,
            targetMachineId,
            machineAccess: 'allowed',
            ...exportIdentity,
            visibility: 'personal',
          },
        },
        source.machineId,
      )
      if (
        !exported.ok ||
        !exported.stagePath ||
        exported.sizeBytes === undefined ||
        !exported.manifest ||
        !exported.binding
      ) {
        throw new Error(exported.error ?? 'source failed to export session')
      }
      await transferHandoffPackage({
        rpc: this.ports.rpc,
        sessionId: session.sessionId,
        sourceMachineId: source.machineId,
        targetMachineId,
        sourceStagePath: exported.stagePath,
        sizeBytes: exported.sizeBytes,
      })
      // A retained target checkout may still belong to another resumable
      // session. The daemon resolves the actual registered worktree; these cwds
      // are the server-authoritative guard against resetting a shared workspace.
      const occupiedWorktreePaths = this.ports
        .listSessions()
        .filter(
          (other) =>
            other.sessionId !== session.sessionId &&
            other.machineId === input.machineId &&
            other.status !== 'exited',
        )
        .map((other) => other.cwd)
      // OBLIGATION 2, second checkpoint — THE APPLY-TIME ONE (ADR 3 D8). The
      // package has now crossed the network; the import is the act that lands
      // arbitrary code on the target's hardware, so the target's `use` grant is
      // re-resolved LIVE here. A revocation that arrived during the transfer
      // refuses the import and falls into the rollback below, which is the
      // difference between "re-authorized at apply" and "authorized at dispatch
      // and trusted afterwards".
      // MACHINE-OWNER BOUNDARY (§3.1.4 M2): `use` permits code execution on
      // hardware whose local SSH keys, git/gh identity, dotfiles and cloud CLI
      // sessions belong to that machine's owner, who may not own this session.
      // Those credentials do not travel with the binding. Attribution of
      // separately server-injected credentials or quota is intentionally not
      // decided here; it remains a per-feature policy decision.
      assertMachineUse(input.machineId)
      const imported = await this.ports.rpc.handoffImport(
        session.sessionId,
        targetRepo.path,
        exported.manifest.worktreeName,
        input.machineId,
        occupiedWorktreePaths,
        {
          transitionId: `adopt:${transferId}:target-claim`,
          machineAccess: 'allowed',
          transfer: exported.binding,
        },
      )
      if (!imported.ok || !imported.newCwd || imported.observationGeneration === undefined)
        throw new Error(imported.error ?? 'target failed to import session')
      targetClaimed = true
      importedLocation = {
        newCwd: imported.newCwd,
        ...(imported.worktreeRoot ? { worktreeRoot: imported.worktreeRoot } : {}),
        observationGeneration: imported.observationGeneration,
      }

      // Arbitration and authorization are deliberately separate. The target
      // claim wins this transfer only after native artifacts landed; both
      // machines are re-authorized LIVE before either claim becomes live or
      // terminal. A revoked winner is refused here, not blessed by ordering.
      assertMachineUse(source.machineId)
      assertMachineUse(input.machineId)
      winnerAuthorized = true
      const finalizedSource = await this.ports.rpc.handoffBindingFinalize(
        {
          sessionId: session.sessionId,
          transitionId: `adopt:${transferId}:source-commit`,
          machineAccess: 'allowed',
          transferId,
          role: 'source',
          phase: 'commit',
          fromMachineId: sourceMachineId,
          toMachineId: targetMachineId,
        },
        source.machineId,
      )
      if (!finalizedSource.ok) {
        throw new Error(finalizedSource.error ?? 'source binding finalize failed')
      }
      sourceCommitted = true
      const finalizedTarget = await this.ports.rpc.handoffBindingFinalize(
        {
          sessionId: session.sessionId,
          transitionId: `adopt:${transferId}:target-commit`,
          machineAccess: 'allowed',
          transferId,
          role: 'target',
          phase: 'commit',
          fromMachineId: sourceMachineId,
          toMachineId: targetMachineId,
        },
        input.machineId,
      )
      if (!finalizedTarget.ok) {
        throw new Error(finalizedTarget.error ?? 'target binding finalize failed')
      }

      session.handoffTarget = undefined
      session.machineId = asMachineId(input.machineId)
      session.cwd = imported.newCwd
      session.status = 'hibernated'
      this.ports.persist(session)
      // The import just ran `git worktree add` on the target, so `imported.newCwd`
      // names a worktree no client has ever scanned. Clients only re-fetch repos on
      // boot / a machine coming online / this invalidation, and the handoff gate
      // resolves a session's cwd against that list — so without this the moved
      // session has no known worktree and its own Handoff menu disappears until a
      // reload (POD-821). Both sides: the target gained a worktree, and the source
      // keeps its residue but is no longer where this session lives.
      this.ports.onWorktreesChanged(targetRepo.path, input.machineId)
      this.ports.onWorktreesChanged(sourceRepo.path, source.machineId)
      // [spec:SP-3f7a] The issue's home follows its session (POD-824): the target
      // worktree is where this work lives now, and the issue's home is what the
      // user sees — the file-browser root, the sidebar's worktree, and the cwd a
      // new agent on this issue spawns into. Keyed on the worktree ROOT the daemon
      // reports, never `newCwd` (which may be a `cwdSubpath` below it). An older
      // daemon sends no root; leave the issue alone rather than guess its layout.
      if (session.issueId && imported.worktreeRoot) {
        this.ports.rehomeIssue(session.issueId, {
          machineId: input.machineId,
          repoPath: targetRepo.path,
          worktreePath: imported.worktreeRoot,
        })
      }
      // The target binding already exists. Launching through ordinary SPAWN
      // would re-mint it from the importing human — a privilege-escalation path.
      // ADOPT launch resets only the host-local attempt.
      assertMachineUse(input.machineId)
      const resumed = await this.ports.resurrectSession({
        sessionId: session.sessionId,
        adoptedBinding: {
          transitionId: `adopt:${transferId}:target-launch`,
          machineAccess: 'allowed',
          transferId,
          role: 'target',
          fromMachineId: sourceMachineId,
          toMachineId: targetMachineId,
        },
      })
      if (!resumed.ok || (session.status as string) !== 'starting')
        throw new Error('target session failed to resume')
      recordHandoff(this.ports, session, sourceMachineId, targetMachineId, caller)
      return { ok: true, newCwd: imported.newCwd }
    } catch (error) {
      // Once import returned and the live apply-time checks passed, the target
      // claim deterministically outranks the source claim. An RPC crash or lost
      // finalize acknowledgement must not resurrect the losing source and fork
      // ownership. Leave the target hibernated for reconciliation. By contrast,
      // a claimant whose rights were revoked never becomes an authorized winner:
      // abort both claims and restore the source.
      const targetWins = targetClaimed && winnerAuthorized
      if (targetClaimed && !targetWins) {
        await this.ports.rpc.handoffBindingFinalize(
          {
            sessionId: session.sessionId,
            transitionId: `adopt:${transferId}:target-abort`,
            machineAccess: 'allowed',
            transferId,
            role: 'target',
            phase: 'abort',
            fromMachineId: sourceMachineId,
            toMachineId: targetMachineId,
          },
          input.machineId,
        )
      }
      if (!sourceCommitted && !targetWins) {
        await this.ports.rpc.handoffBindingFinalize(
          {
            sessionId: session.sessionId,
            transitionId: `adopt:${transferId}:source-abort`,
            machineAccess: 'allowed',
            transferId,
            role: 'source',
            phase: 'abort',
            fromMachineId: sourceMachineId,
            toMachineId: targetMachineId,
          },
          source.machineId,
        )
      }
      session.handoffTarget = undefined
      session.machineId =
        sourceCommitted || targetWins ? asMachineId(input.machineId) : source.machineId
      session.cwd =
        sourceCommitted || targetWins ? (importedLocation?.newCwd ?? session.cwd) : source.cwd
      session.status = 'hibernated'
      this.ports.persist(session)
      if (!sourceCommitted && !targetWins) {
        const rollback = await this.ports.resurrectSession({
          sessionId: session.sessionId,
          adoptedBinding: {
            transitionId: `adopt:${transferId}:source-rollback-launch`,
            machineAccess: 'allowed',
            transferId,
            role: 'source',
            fromMachineId: sourceMachineId,
            toMachineId: targetMachineId,
          },
        })
        if (!rollback.ok)
          console.warn(
            `[podium] handoff rollback failed for ${session.sessionId}: ${rollback.reason}`,
          )
      }
      throw error
    }
  }
}
