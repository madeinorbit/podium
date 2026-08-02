/**
 * THE TRANSFER — every irreversible act, and the arbitration that decides who
 * owns the session when one of them fails.
 *
 * This phase is ONE function on purpose, and it is the reason the seam is drawn
 * where it is rather than three lines further in. From the kill onwards the
 * choreography is a single unwindable unit: `targetClaimed`, `sourceCommitted`
 * and `winnerAuthorized` are not bookkeeping, they are the rollback's inputs,
 * and the `catch` reads all three to decide whether the target keeps the session
 * or the source gets it back. Splitting the legs into separate functions would
 * distribute those three flags across the split — which is the coupling a
 * decomposition is supposed to remove, recreated by the decomposition itself.
 * The choreography is UNCHANGED and is meant to stay that way (POD-379's oracle
 * pins the order of the irreversible steps across both machines).
 *
 * ---------------------------------------------------------------------------
 * WHAT SURVIVES WHICH EXIT — the four outcomes, which differ only in that
 * ---------------------------------------------------------------------------
 *
 *   EXIT                     row's machine   source process   target claim
 *   ----------------------   -------------   --------------   -------------
 *   success                  target          gone             live, resumed
 *   target won, then threw   target          gone             kept, hibernated
 *     (`targetClaimed && winnerAuthorized`, e.g. a lost finalize ack)
 *   rolled back              source          resurrected      aborted
 *     (nothing claimed, or a claimant whose rights were revoked)
 *   pre-flight refused       source          untouched        never made
 *     (not this file — see {@link HandoffPreflight})
 *
 * The second row is the one a reader collapses into the third: once the import
 * returned AND the live apply-time checks passed, the target claim
 * DETERMINISTICALLY outranks the source. An RPC crash after that must not
 * resurrect the source, because two live owners of one conversation is the fork
 * this command exists to prevent. A claimant whose rights were REVOKED never
 * becomes an authorized winner, which is why the two flags are separate.
 *
 * OBLIGATION 2, SECOND CHECKPOINT (ADR 3 D8) is the `assertMachineUse` in front
 * of the import: the package has crossed the network by then, and the import is
 * the act that lands arbitrary code on the target's hardware, so the grant is
 * re-resolved LIVE there. Everything between the export and the import is pinned
 * by ordering alone today — the oracle's release clause covers the SOURCE
 * RELEASE specifically (POD-1409) — so a change in that region needs its own
 * assertion in the same commit that makes it.
 */

import { asMachineId } from '@podium/model'
import { transferHandoffPackage } from '../handoff-transfer'
import { recordHandoff } from './attribution'
import type { HandoffPlacement } from './placement'
import type {
  AssertMachineUse,
  HandoffCaller,
  HandoffInput,
  HandoffPorts,
  HandoffResult,
} from './ports'
import type { HandoffPreflightResult } from './preflight'

/** How long the source daemon is given to release the terminal after the kill.
 *  Unchanged value, named and injected so a test does not have to wait it out. */
const SOURCE_RELEASE_MS = 500

/** Everything the choreography does to the world. This is most of `HandoffPorts`
 *  because the transfer is where the moving happens; what it does NOT include is
 *  the resolution reads (`listRepos`, `listMachines`, `issueMeta`) — those were
 *  answered by the placement phase and are not re-asked mid-transfer. */
export type HandoffTransferPorts = Pick<
  HandoffPorts,
  | 'rpc'
  | 'listSessions'
  | 'persist'
  | 'broadcastSessions'
  | 'onSessionGone'
  | 'toMachine'
  | 'onWorktreesChanged'
  | 'rehomeIssue'
  | 'resurrectSession'
  | 'recordEvent'
  | 'sleep'
>

export class HandoffTransfer {
  constructor(private readonly ports: HandoffTransferPorts) {}

  /**
   * Stop the source, move the package, claim the target, and commit — or unwind
   * to whichever side the arbitration above says owns the session.
   */
  async apply(
    placement: HandoffPlacement,
    prepared: HandoffPreflightResult,
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
      issueWorktree,
    } = placement
    const { targetRepo, branch, baseShas } = prepared
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
