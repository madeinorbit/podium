/**
 * BRINGING A SESSION BACK (POD-1396, from POD-1385's god-object audit).
 *
 * One job: take an existing session — parked, on another machine, or identified
 * only by a resume ref — and make it live again. Six methods, one concern:
 *
 *   resumeSession      find-or-mint by resume ref (reuse / resurrect / fresh)
 *   findLiveByResume   the canonical row for a conversation
 *   resurrectSession   wake a hibernated/exited row under the same id
 *   finishResurrect    the synchronous half of that wake (fence + spawn frame)
 *   handoffSession     move a resumable worktree session to another machine
 *   handoffs           lazy factory for the single HandoffCoordinator
 *
 * They move together because resume calls resurrect, resurrect calls
 * finishResurrect, and handoffs wires resume/resurrect as ports into the
 * coordinator. Splitting them puts a call across a boundary for no gain.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 *
 * `machineUseGate` stays on SessionLifecycle — it is the assignable use-verb
 * seam (POD-381 / POD-1079), not a revival concern. It arrives here as a port.
 *
 * `spawn` is owned by SessionStart and arrives as a port. Resume reuses it for
 * the fresh-mint path; it does not re-implement spawn.
 *
 * Handoff coordinator internals (POD-1399) are not restructured here — only the
 * port assembly moves. POD-1409's missing sleep assertion still holds; do not
 * treat a green oracle-handoff suite as proof of the rollback contract.
 *
 * Dispose: none. The coordinator holds a single-flight map only; no timer.
 *
 * Ambient: resumeSession's `ownerUserId ?? FIRST_ADMIN_USER_ID` moved here from
 * lifecycle. USAGE DELTA on the census must be 0.
 */

import { randomUUID } from 'node:crypto'
import type { IssueId, ResumeRef, SessionId, SessionMeta, UserId } from '@podium/model'
import { type AgentKind, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import type {
  ControlMessage,
  SessionBindingAdoptLaunchInstruction,
} from '@podium/protocol'
import type { AutoContinueController } from '../../auto-continue'
import type { SessionStore } from '../../store'
import type { DurableIssueAccessIndex } from '../issues/access-index'
import type { DaemonRpcService } from '../machines/rpc'
import type { MachinesService, MachineUseResolver } from '../machines/service'
import { HandoffCoordinator } from './handoff/coordinator'
import type { AssertMachineUse, HandoffCaller, HandoffPorts } from './handoff/ports'
import type { PreparedSessionInstructions } from './instructions'
import type { SessionIssueWorkflowPort } from './issue-workflow-port'
import type { SessionLaunchConfig } from './launch-config'
import type { SessionRepository } from './repository'
import type { Session } from './session'
import type { SessionStart } from './session-start'
import type { SessionStateService } from './session-state/service'
import type { SessionTerminalProof } from './terminal-proof'
import type { SessionWorkspace } from './workspace'

export interface SessionRevivalPorts {
  store: SessionStore
  repository: SessionRepository
  state: SessionStateService
  terminalProof: SessionTerminalProof
  launchConfig: SessionLaunchConfig
  workspace: SessionWorkspace
  autoContinue: Pick<AutoContinueController, 'onSessionGone'>
  sessions: Map<SessionId, Session>
  machines: MachinesService
  rpc: DaemonRpcService
  listSessions(): SessionMeta[]
  broadcastSessions(): void
  toMachine(machineId: string, message: ControlMessage): void
  /** Fresh-mint path of resume — owned by SessionStart. */
  spawn: SessionStart['spawn']
  machineUseGate(caller: HandoffCaller): AssertMachineUse
  issueAccess: DurableIssueAccessIndex
  instructionsForStart(input: {
    sessionId: SessionId
    cwd: string
    agentKind: AgentKind
    issueId?: IssueId
    existingOnly?: boolean
  }): PreparedSessionInstructions
  onWorktreesChanged(repoPath: string, machineId?: string): void
}

export class SessionRevival {
  /** ONE coordinator for the life of this owner — its single-flight map is the
   *  guard. A per-call coordinator would start every dispatch with an empty map. */
  private handoffCoordinator: HandoffCoordinator | undefined

  constructor(private readonly ports: SessionRevivalPorts) {}

  async resumeSession(
    input: {
      ownerUserId?: UserId
      agentKind: AgentKind
      cwd: string
      resume: ResumeRef
      conversationId: string
      title?: string
      machineId?: string
      /** Provenance for the FRESH-SPAWN fallback only (issue #60). When the resume
       *  lands on an existing row (reuse/resurrect below), that row's original
       *  spawnedBy is kept — a resume never rewrites who created the session. */
      spawnedBy?: string
      /** The calling principal's `use` decision per machine — see createSession. */
      use?: MachineUseResolver
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{ sessionId: SessionId }> {
    // One row per conversation. A conversation is identified by its durable
    // resume ref (kind+value); resuming one that already has a row must REUSE
    // that row, never mint a parallel one. Each parallel row spawned its own
    // durable master and forked its own transcript, while the web only HID the
    // siblings (dedupeSessionsByResume) — so closing the visible row revealed a
    // masked duplicate with its own title/transcript/stage. Reuse kills that at
    // the source: a running row is focused as-is; a parked (hibernated/exited)
    // row is resurrected under its same id.
    const existing = this.findLiveByResume(input.resume)
    if (existing) {
      if (existing.status === 'hibernated' || existing.status === 'exited') {
        const woke = await this.resurrectSession({ sessionId: existing.sessionId }, issues)
        if (!woke.ok) throw new Error(woke.reason ?? 'failed to resume parked session')
      } else {
        // Reopening a still-live but long-idle session also resets its hibernation
        // timer — the user is back on it even with no new message. (resurrectSession
        // already stamps this for the parked case above.)
        this.ports.sessions.get(existing.sessionId)?.markResumed()
      }
      return { sessionId: existing.sessionId }
    }
    const issueId = this.ports.issueAccess.soleOwnerForCwd(input.cwd) ?? undefined
    // MINT SITE: a server-minted session id. The brand belongs where the id is
    // GENERATED — nothing upstream had it, so this is not an adapter cast.
    const sessionId = asSessionId(randomUUID())
    const preparedInstructions = this.ports.instructionsForStart({
      sessionId,
      cwd: input.cwd,
      agentKind: input.agentKind,
      ...(issueId ? { issueId } : {}),
    })
    const spawned = this.ports.spawn({
      agentKind: input.agentKind,
      ownerUserId: input.ownerUserId ?? FIRST_ADMIN_USER_ID,
      cwd: input.cwd,
      title: input.title,
      origin: { kind: 'resume', conversationId: input.conversationId },
      resume: input.resume,
      machineId: this.ports.machines.resolveMachineForAgent(
        input.machineId,
        input.cwd,
        input.agentKind,
        input.use,
      ),
      ...(preparedInstructions.instructions.length
        ? { instructions: preparedInstructions.instructions }
        : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(issueId ? { issueId } : {}),
      sessionId,
    })
    preparedInstructions.commit()
    return spawned
  }


  /**
   * The existing session for a resume ref, if any — the canonical row for that
   * conversation. Prefers a still-running row (live/starting/reconnecting) over a
   * parked one, breaking ties toward the most-recently-active so we land on the
   * row the user last touched.
   */
  findLiveByResume(resume: ResumeRef): Session | undefined {
    const running = (s: Session) =>
      s.status === 'live' || s.status === 'starting' || s.status === 'reconnecting'
    return (
      [...this.ports.sessions.values()]
        // A HEADLESS session shares its harness's resume ref but is not a PTY
        // reuse target — "open in terminal" resumes the same ref as a real PTY
        // session alongside it, so headless rows never satisfy this lookup.
        .filter(
          (s) => !s.headless && s.resume?.kind === resume.kind && s.resume?.value === resume.value,
        )
        .sort((a, b) => {
          if (running(a) !== running(b)) return running(a) ? -1 : 1
          return (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '')
        })
        .at(0)
    )
  }

  /**
   * Move one resumable worktree session to another machine ([spec:SP-3f7a]).
   *
   * THE COMPOSITION ROOT for the `sessions.handoff` command (POD-642). The
   * choreography, the `use`-verb gate on both machines, the apply-time
   * re-authorization and the single-flight idempotency live in
   * {@link HandoffCoordinator}; this method's whole job is to build that
   * coordinator's ports and hand it the transport caller.
   *
   * `machineUseGate` arrives as a port — it is not decided here.
   */
  handoffSession(
    input: { sessionId: SessionId; machineId: string },
    caller: HandoffCaller,
    issues: SessionIssueWorkflowPort,
  ): Promise<{ ok: true; newCwd: string }> {
    return this.handoffs(issues).handoff(input, caller, this.ports.machineUseGate(caller))
  }

  /**
   * ONE coordinator for the life of this owner, not one per call: its
   * single-flight map is the thing that stops a duplicate dispatch from forking
   * the session, and a per-call coordinator would start every dispatch with an
   * empty map — a guard that still looked implemented.
   */
  handoffs(issues: SessionIssueWorkflowPort): HandoffCoordinator {
    if (this.handoffCoordinator) return this.handoffCoordinator
    const ports: HandoffPorts = {
      rpc: this.ports.rpc,
      getSession: (sessionId) => this.ports.sessions.get(sessionId),
      listSessions: () =>
        this.ports.listSessions().map((meta) => ({
          sessionId: meta.sessionId,
          machineId: meta.machineId ?? '',
          cwd: meta.cwd,
          status: meta.status,
        })),
      listRepos: () => this.ports.store.repos.listRepos(),
      listMachines: () => this.ports.machines.listMachines(),
      issueMeta: (issueId) => this.ports.issueAccess.getMeta(issueId) ?? undefined,
      rehomeIssue: (issueId, where) => issues.rehome(issueId, where),
      ensureTargetRepo: (sourceRepo, targetMachineId) =>
        this.ports.workspace.ensureTargetRepo(sourceRepo, targetMachineId),
      persist: (session) => this.ports.repository.persist(session),
      mutateSessionView: (sessionId, mutate) => {
        this.ports.repository.mutateSessionView(sessionId, mutate)
      },
      broadcastSessions: () => this.ports.broadcastSessions(),
      onSessionGone: (sessionId) => this.ports.autoContinue.onSessionGone(sessionId),
      toMachine: (machineId, message) => this.ports.toMachine(machineId, message),
      onWorktreesChanged: (repoPath, machineId) =>
        this.ports.onWorktreesChanged(repoPath, machineId),
      resumeSession: (resumeInput) => this.resumeSession(resumeInput, issues),
      resurrectSession: (resurrectInput) => this.resurrectSession(resurrectInput, issues),
      recordEvent: (event) => {
        this.ports.store.events.appendEvent(event)
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }
    this.handoffCoordinator = new HandoffCoordinator(ports)
    return this.handoffCoordinator
  }


  /** Wake a hibernated session: respawn under the same id with its resume ref.
   *  If stop freed the worktree, recreates it from the preserved branch first
   *  [spec:SP-9904]. */
  resurrectSession(
    {
      sessionId,
      adoptedBinding,
    }: {
      sessionId: SessionId
      adoptedBinding?: SessionBindingAdoptLaunchInstruction
    },
    issues: SessionIssueWorkflowPort,
  ): Promise<{ ok: boolean; reason?: string }> {
    const session = this.ports.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, reason: 'unknown session' })
    // Hibernated (parked on purpose) and exited (process died or was killed
    // externally) are the same situation here: no process, but the row and the
    // resume ref are intact — both come back with one spawn.
    if (session.status !== 'hibernated' && session.status !== 'exited') {
      return Promise.resolve({ ok: false, reason: 'process still running' })
    }
    // A shell has no conversation to lose — a fresh spawn in the same cwd IS
    // full recovery, so it never needs a resume ref. Agents do: respawning one
    // without its ref would silently discard the conversation.
    if (session.agentKind !== 'shell' && !session.resume) {
      return Promise.resolve({ ok: false, reason: 'no resume ref' })
    }

    // Recreate a worktree freed by stop (or deleted out-of-band) before spawn
    // so the agent has a real cwd. Transcript inspection does not need this.
    // The common hibernate→wake path resolves synchronously, and the spawn
    // must too: queueText fire-and-forgets this call and its callers rely on
    // the spawn being on the wire before queueText returns [POD-197].
    const ensured = this.ports.workspace.ensureSessionWorktree(session, issues)
    if (ensured instanceof Promise) {
      return ensured.then((e) => this.finishResurrect(session, e, adoptedBinding))
    }
    return Promise.resolve(this.finishResurrect(session, ensured, adoptedBinding))
  }


  finishResurrect(
    session: Session,
    ensured: { ok: boolean; reason?: string; cwd?: string },
    adoptedBinding?: SessionBindingAdoptLaunchInstruction,
  ): { ok: boolean; reason?: string } {
    const sessionId = session.sessionId
    if (!ensured.ok) return { ok: false, reason: ensured.reason }
    if (ensured.cwd && ensured.cwd !== session.cwd) {
      session.cwd = ensured.cwd
    }

    const preparedInstructions = this.ports.instructionsForStart({
      sessionId,
      cwd: session.cwd,
      agentKind: session.agentKind,
      ...(session.issueId ? { issueId: session.issueId } : {}),
      existingOnly: true,
    })
    session.status = 'starting'
    session.exitCode = undefined
    // Waking a session resets its hibernation idle timer — otherwise a stale
    // lastActiveAt makes it immediately eligible to be parked again.
    session.markResumed()
    this.ports.repository.persist(session)
    const observationLease = this.ports.terminalProof.fence(session)
    this.ports.toMachine(session.machineId, {
      type: 'spawn',
      sessionId,
      durableLabel: session.durableLabel,
      agentKind: session.agentKind,
      cwd: session.cwd,
      ...(adoptedBinding ? { adoptedBinding } : {}),
      ...(observationLease
        ? {
            observationGeneration: observationLease.observationGeneration,
            observationBindingVersion: observationLease.bindingVersion,
            observationProviderSessionId: observationLease.providerSessionId,
            ...(observationLease.checkpoint
              ? { observationCheckpoint: observationLease.checkpoint }
              : {}),
          }
        : {}),
      ...(session.resume ? { resume: session.resume } : {}),
      ...(preparedInstructions.instructions.length
        ? { instructions: preparedInstructions.instructions }
        : {}),
      geometry: session.terminal.geometry,
      ...this.ports.launchConfig.modelDefaults(session.agentKind),
      ...this.ports.launchConfig.accountEnv(session.agentKind, session.accountId),
      ...(this.ports.state.draftSyncEnabled() ? { draftSync: true } : {}),
    })
    preparedInstructions.commit()
    this.ports.broadcastSessions()
    return { ok: true }
  }

}
