/**
 * THE HANDOFF HANDLER'S PORTS — POD-642 (3.2e).
 *
 * `sessions.handoff` is the one session command that touches TWO machines and
 * moves a live agent between them. Its orchestration used to live inline in the
 * 250k-line `SessionLifecycle`, reachable only through that class; this module is
 * the port surface it now runs against, so the choreography can be driven — and
 * refused — without constructing a service.
 *
 * WHY PORTS AND NOT A SERVICE REFERENCE: the two properties this issue exists to
 * add are both about WHEN a decision is taken relative to an irreversible act
 * (nothing stopped before both machines authorized the move; the import leg
 * re-authorized at apply time, ADR 3 D8). A test can only pin that if it can
 * observe the acts in order and revoke a right between two of them, which means
 * the acts have to be injected. Ports are what make the revocation test
 * possible, not decoration.
 *
 * WHAT IS DELIBERATELY NOT HERE: a second daemon correlator. The request/reply
 * correlation lives in `modules/daemon-request.ts` — ONE registry for every
 * daemon round-trip in the server since POD-318, which folded the hand-paired
 * `onHandoffExportResult` / `onHandoffImportChunkResult` / `onHandoffImportResult`
 * handlers (and their per-kind pending maps) into it. The five legs below
 * inherit its answering-machine check for free: a handoff export answered by a
 * machine other than the one it was sent to is dropped (POD-1175), which matters
 * here more than anywhere, because these legs move a live agent — and its staged
 * worktree bytes — BETWEEN two machines. {@link HandoffRpcPort} is the SHAPE the
 * legs are consumed through — five request/result pairs, awaited — and nothing
 * more; it must not grow a correlation mechanism of its own.
 */

import type {
  AgentInventory,
  HandoffManifestV1,
  IssueRehomeTarget,
  MachineId,
  ResumeRef,
  SessionId,
  RepoId,
  IssueId,
} from '@podium/model'
import type { HandoffBindingExportInstruction, HandoffBindingImportInstruction, HandoffBindingTransfer, SessionBindingAdoptLaunchInstruction } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { CommandPrincipal } from '../../../command-principal'
import type { Capability } from '../../../issue-authz'
import type { HandoffStageToken } from '../handoff-transfer'
import type { Session, SessionDurableState } from '../session'

/**
 * The harnesses a bundle can carry, DERIVED from the manifest rather than
 * restated. POD-381 found the general case in its own contracts: a forked
 * `z.enum` with identical members parses, encodes and passes every golden case
 * identically, so a fork is invisible to everything except an identity check.
 * These are TYPES, not schemas — there is nothing to assert `toBe` on — so the
 * protection has to be the derivation itself: widen the manifest's list and this
 * follows, fork it and the two drift with nobody watching.
 */
export type ExportableAgentKind = HandoffManifestV1['agentKind']

/**
 * THE COMMAND'S OWN VOCABULARY — input, result, and the one pinned refusal
 * string — beside {@link HandoffCaller}, which is the same category of thing
 * (what the command is called WITH). They live here rather than on the
 * coordinator because every phase module speaks them and none of the phases
 * should have to import a sibling phase to name its own argument.
 */
export interface HandoffInput {
  sessionId: SessionId
  machineId: MachineId
}

export type HandoffResult = { ok: true; newCwd: string }

/** The pinned not-found shape for THIS command. Handoff is the odd one out among
 *  the session writes — POD-379's oracle pins its absent path as a throw with
 *  this exact message, where the rest answer `'session not found'` — so the
 *  shared `resolveSessionTarget`'s `absent` outcome maps onto it rather than
 *  replacing it. */
export const HANDOFF_UNKNOWN_SESSION = 'unknown session'

/** The five daemon legs, exactly as `DaemonRpcService` already exposes them. */
export interface HandoffRpcPort {
  repoOp(
    op: 'revParseVerify',
    repoPath: string,
    args: { ref: string },
    machineId: MachineId,
  ): Promise<{ ok: boolean; output: string }>
  handoffExport(
    input: {
      sessionId: SessionId
      cwd: string
      fallbackCwd?: string
      agentKind: ExportableAgentKind
      resume: ResumeRef
      branch: string
      baseShas: string[]
      repoId: RepoId
      title?: string
      issueId?: IssueId
      sourceMachineId: MachineId
      binding: HandoffBindingExportInstruction
    },
    machineId: MachineId,
  ): Promise<{
    ok: boolean
    error?: string
    stagePath?: string
    sizeBytes?: number
    manifest?: { worktreeName: string }
    binding?: HandoffBindingTransfer
  }>
  handoffReadChunk(
    stagePath: string,
    offset: number,
    length: number,
    machineId: MachineId,
  ): Promise<{ ok: boolean; data?: string; error?: string }>
  /** A STAGE TOKEN, not a session id (POD-1171) — this port is what `workspace.ts`
   *  hands to `transferHandoffPackage`, so it must admit the `ws-`/`ref-` tokens
   *  that path sends. Property syntax so a narrowing implementation is refused
   *  contravariantly rather than accepted bivariantly. */
  handoffWriteChunk: (
    stageToken: HandoffStageToken,
    offset: number,
    data: Buffer,
    machineId: MachineId,
  ) => Promise<{ ok: boolean; sizeBytes?: number; error?: string }>
  handoffImport(
    sessionId: SessionId,
    repoPath: string,
    worktreeName: string,
    machineId: MachineId,
    occupiedWorktreePaths?: string[],
    binding?: HandoffBindingImportInstruction,
  ): Promise<{
    ok: boolean
    error?: string
    newCwd?: string
    worktreeRoot?: string
    observationGeneration?: number
  }>
  handoffBindingFinalize(
    input: {
      sessionId: SessionId
      transitionId: string
      machineAccess: 'allowed' | 'denied' | 'unreachable'
      transferId: string
      role: 'source' | 'target'
      phase: 'commit' | 'abort'
      fromMachineId: MachineId
      toMachineId: MachineId
    },
    machineId: MachineId,
  ): Promise<{ ok: boolean; error?: string; observationGeneration?: number }>
}

/** One registered repository, as `store.repos.listRepos()` reports it. */
export interface HandoffRepo {
  machineId: MachineId
  path: string
  originUrl: string | null
  repoId: RepoId | null
  prefix: string | null
}

/** The slice of a machine row the handoff decision reads. */
export interface HandoffMachine {
  id: MachineId
  name?: string
  online: boolean
  inventory?: {
    agents: Pick<AgentInventory, 'kind' | 'installed' | 'probeError' | 'login'>[]
  }
}

/** The slice of an issue the handoff decision reads and re-homes. Every field is
 *  nullable because the issue row's are: a `null` worktree path and an absent one
 *  are the same fact here (this issue has no machine-local home), and flattening
 *  them to `?: string` would have made the port lie about its source. */
export interface HandoffIssue {
  machineId?: MachineId | null
  worktreePath?: string | null
  branch?: string | null
  parentBranch?: string | null
}

/**
 * THE `use` GATE — POD-381's `ctx.assertMachineUse`, taken as a port rather than
 * re-derived (readiness §3.1.4 M1/M5, ADR 3 Amendment 1 D18).
 *
 * It THROWS, and the throw is the whole contract: `checkMachineUse` answers
 * `'absent' | 'unauthorized' | undefined`, where `'absent'` deliberately covers
 * a machine that does not exist AND one the principal cannot `see`, with the SAME
 * message — so this path is not a fleet-enumeration oracle (§3.1.5's
 * consistent-error rule applied to machines). `'unauthorized'` is reachable only
 * INSIDE the see set, which is what keeps "denied" distinguishable from
 * "offline" for a machine the principal can see (M5).
 *
 * Handoff is a `use` operation on BOTH machines and calls this once per machine,
 * per POD-381's ruling that the signature stays single-machine: a denial has to
 * name WHICH machine, and the target check runs TWICE at different times (dispatch
 * and apply) — a list signature would make the second call read as a repeat of the
 * first rather than as apply-time re-authorization.
 */
export type AssertMachineUse = (machineId: MachineId) => void

/** Everything the handoff choreography does to the world, as one surface. */
export interface HandoffPorts {
  readonly rpc: HandoffRpcPort
  /** The live row, or undefined. Absence maps to this command's pinned throw. */
  getSession(sessionId: SessionId): Session | undefined
  /** Every session, for the target worktree-occupancy guard. */
  listSessions(): { sessionId: SessionId; machineId: MachineId; cwd: string; status: string }[]
  listRepos(): HandoffRepo[]
  listMachines(): HandoffMachine[]
  issueMeta(issueId: IssueId): HandoffIssue | undefined
  rehomeIssue(issueId: IssueId, where: IssueRehomeTarget): void
  ensureTargetRepo(sourceRepo: HandoffRepo, targetMachineId: MachineId): Promise<{ path: string }>
  /** Mutate the durable half as a DRAFT and persist it [POD-3330]. */
  write(session: Session, mutate: (draft: SessionDurableState) => void): void
  mutateSessionView(sessionId: SessionId, mutate: (session: Session) => void): void
  broadcastSessions(): void
  /** Cancel any armed auto-continue for a session that is about to stop. */
  onSessionGone(sessionId: SessionId): void
  toMachine(machineId: MachineId, message: ControlMessage): void
  onWorktreesChanged(repoPath: string, machineId: MachineId): void
  resumeSession(input: {
    agentKind: ExportableAgentKind
    cwd: string
    resume: ResumeRef
    /** UNBRANDED BY DECISION: the harness-native conversation id, not Podium's stable ConversationId. */
    conversationId: string
    title?: string
    machineId: MachineId
  }): Promise<{ sessionId: SessionId }>
  resurrectSession(input: {
    sessionId: SessionId
    adoptedBinding?: SessionBindingAdoptLaunchInstruction
  }): Promise<{ ok: boolean; reason?: string }>
  /** Durable attribution record (ADR 3 D17 / ADR 9 D5 A3) — see the coordinator. */
  recordEvent(event: { ts: string; kind: string; subject: string; payload: unknown }): void
  /** Injected so a transfer that takes real time is testable without one. */
  sleep(ms: number): Promise<void>
}

/**
 * WHO is asking — from the authenticated transport, never from the payload
 * (ADR 3 D7). It is a SEPARATE argument from the command input on purpose: an
 * identity field inside the input object is a payload identity channel, and the
 * whole point of D7 is that no such channel exists. `handoff.contract.test.ts`
 * asserts a forged `actor` / `onBehalfOf` inside the input is inert.
 */
export interface HandoffCaller {
  readonly capability: Capability
  /** Complete transport principal; never reconstructed from the manifest. */
  readonly principal: CommandPrincipal
}
