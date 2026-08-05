import { isAbsolute, join } from 'node:path'
import type {
  AgentKind,
  AgentQuotaWire,
  ConversationDiagnosticWire,
  ConversationSummaryWire,
  DirectoryListingWire,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  IssueId,
  MachineId,
  MachineQuotaWire,
  RepoId,
  ResumeRef,
  SessionId,
  TranscriptItem,
  UsageBucketWire,
} from '@podium/model'
import type {
  BrowseDirsResultMessage,
  ControlMessage,
  CredentialExportResultMessage,
  CredentialInstallResultMessage,
  DaemonMessage,
  DirListResultMessage,
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
  HandoffBindingExportInstruction,
  HandoffBindingFinalizeResultMessage,
  HandoffBindingImportInstruction,
  HandoffChunkReadResultMessage,
  HandoffExportResultMessage,
  HandoffImportChunkResultMessage,
  HandoffImportResultMessage,
  ModelChoiceWire,
  PortableCredentialBundle,
  PortableCredentialKind,
  RepoOp,
  WorkspaceCleanResultMessage,
  WorkspaceExportResultMessage,
  WorkspaceImportResultMessage,
} from '@podium/protocol'
import { knownPathsFor } from '../../file-relay-policy'
import type { RpcDaemonFrame, RpcDaemonFrameType } from '../../gateway/daemon-frame-routing'
import {
  DaemonRequestBroker,
  type DaemonRequestKind,
  type DaemonRequestPort,
  daemonRequestKind,
} from '../daemon-request'
import type { LakeReadSession, MemoryService } from '../memory/service'
import type { MemoryReader } from '../memory/types'
import { DEPLOYMENT, perf } from '../perf/registry'

const SCAN_TIMEOUT_MS = 10_000
const FILE_RPC_TIMEOUT_MS = 10_000
// A browse is one readdir, but it may hit a cold/spun-down disk on a remote
// machine — generous enough to ride that out, short enough that the picker's
// spinner doesn't outlive the user's patience.
const BROWSE_TIMEOUT_MS = 20_000

export interface ScanResult {
  conversations: ConversationSummaryWire[]
  diagnostics: ConversationDiagnosticWire[]
}

export interface ScanReposResult {
  repositories: GitRepositoryWire[]
  diagnostics: GitDiscoveryDiagnosticWire[]
}

/** Identity of the server-side reader requesting personal transcript content.
 * Authorization belongs at this boundary; the daemon and @podium/transcript run
 * as system-side readers and never receive or interpret this value. */
export type TranscriptReader = MemoryReader

/** One machine's directory listing, or why it couldn't be read (POD-814). */
export interface BrowseDirsResult {
  listing?: DirectoryListingWire
  error?: string
}

/** Outcome of a daemon-executed operation (git op / harness one-shot). */
export interface OpResult {
  ok: boolean
  output: string
}

/** A transcript window slice as served to the chat view. */
export interface TranscriptSlice {
  items: TranscriptItem[]
  head?: string
  tail?: string
  hasMore: boolean
}

/** The session fields the file/transcript RPCs resolve against. */
export interface RpcSessionView {
  id: SessionId
  cwd: string
  machineId: string
  agentKind: AgentKind
  resume?: ResumeRef
  transcriptItems(): TranscriptItem[]
}

interface DaemonRpcDeps {
  broker?: DaemonRequestPort
  memory: Pick<MemoryService, 'canReadSession' | 'transcriptPathHint' | 'readTranscriptFromLake'>
  toMachine(machineId: string, msg: ControlMessage): void
  defaultMachine(): MachineId
  resolveMachine(requested: string | undefined, cwd: string): string
  hasDaemon(machineId: string): boolean
  machineName(id: string): string
  onlineMachineIds(): MachineId[]
  getSession(sessionId: SessionId): RpcSessionView | undefined
}

/** A daemon reply's payload: the message minus its wire plumbing. */
type Payload<M extends { type: string; requestId: string }> = Omit<M, 'type' | 'requestId'>

/**
 * THE REQUEST FAMILIES, as one table.
 *
 * Each was a hand-declared `private readonly pendingX = new Map<...>()` field —
 * twenty-three of them, plus twenty-three `on*Result` methods to drain them.
 * What that hand-pairing actually expressed is exactly this: a prefix and a
 * result type. Stated once, it can be handed to a correlator that owns the
 * registration, the settlement and the timeout for all of them (POD-318).
 *
 * The prefixes are UNCHANGED — they appear in daemon logs and in test fixtures
 * that read a requestId back off the wire, and nothing about this refactor is a
 * reason to renumber the world.
 */
const SCAN = daemonRequestKind<ScanResult>('r')
const SCAN_REPOS = daemonRequestKind<ScanReposResult>('rr')
const BROWSE_DIRS = daemonRequestKind<BrowseDirsResult>('bd')
const REPO_OP = daemonRequestKind<OpResult>('ro')
const HARNESS_EXEC = daemonRequestKind<OpResult>('hx')
const USAGE = daemonRequestKind<{ hostname: string; buckets: UsageBucketWire[] }>('us')
const AGENT_QUOTA = daemonRequestKind<{ hostname: string; agents: AgentQuotaWire[] }>('aq')
const MODEL_PROBE = daemonRequestKind<Record<string, ModelChoiceWire[]>>('mp')
const TRANSCRIPT_READ = daemonRequestKind<TranscriptSlice>('tr')
const IMAGE_UPLOAD = daemonRequestKind<{ path: string; error?: string }>('iu')
const FILE_READ = daemonRequestKind<Payload<FileReadResultMessage>>('fr')
const FILE_ASSET = daemonRequestKind<Payload<FileAssetResultMessage>>('fa')
const FILE_WRITE = daemonRequestKind<Payload<FileWriteResultMessage>>('fw')
const DIR_LIST = daemonRequestKind<Payload<DirListResultMessage>>('dl')
const HANDOFF_EXPORT = daemonRequestKind<Payload<HandoffExportResultMessage>>('he')
const HANDOFF_READ = daemonRequestKind<Payload<HandoffChunkReadResultMessage>>('hr')
const HANDOFF_WRITE = daemonRequestKind<Payload<HandoffImportChunkResultMessage>>('hw')
const HANDOFF_IMPORT = daemonRequestKind<Payload<HandoffImportResultMessage>>('hi')
const HANDOFF_BINDING_FINALIZE =
  daemonRequestKind<Payload<HandoffBindingFinalizeResultMessage>>('hf')
const WORKSPACE_EXPORT = daemonRequestKind<Payload<WorkspaceExportResultMessage>>('we')
const WORKSPACE_IMPORT = daemonRequestKind<Payload<WorkspaceImportResultMessage>>('wi')
const WORKSPACE_CLEAN = daemonRequestKind<Payload<WorkspaceCleanResultMessage>>('wc')
const CREDENTIAL_EXPORT = daemonRequestKind<Payload<CredentialExportResultMessage>>('ce')
const CREDENTIAL_INSTALL = daemonRequestKind<Payload<CredentialInstallResultMessage>>('ci')

/** How ONE reply frame settles: pick the family, project the payload, hand both
 *  to the correlator along with the machine that answered. */
type ReplySettler<K extends RpcDaemonFrameType> = (
  broker: DaemonRequestPort,
  machineId: string,
  msg: Extract<DaemonMessage, { type: K }>,
) => void

/** Drop the wire plumbing; what is left is what the caller awaited. */
const payloadOf = <M extends { type: string; requestId: string }>(msg: M): Payload<M> => {
  const { type: _type, requestId: _requestId, ...payload } = msg
  return payload
}

/**
 * THE FAN-IN, TOTAL over the frames the gateway routes to `rpc`.
 *
 * The key set is derived from `DAEMON_FRAME_PORTS`, so routing a new reply frame
 * to this port without saying which request family it answers is a compile
 * error here — the same protection the old one-method-per-frame surface gave,
 * minus the twenty-three methods. Every row is a projection and nothing else:
 * no map, no timer, no delete. Settling belongs to the broker.
 */
const RPC_REPLY_SETTLERS: { [K in RpcDaemonFrameType]: ReplySettler<K> } = {
  scanResult: (broker, machineId, msg) =>
    void broker.settle(SCAN, msg.requestId, machineId, {
      conversations: msg.conversations,
      diagnostics: msg.diagnostics,
    }),
  scanReposResult: (broker, machineId, msg) =>
    void broker.settle(SCAN_REPOS, msg.requestId, machineId, {
      repositories: msg.repositories,
      diagnostics: msg.diagnostics,
    }),
  browseDirsResult: (broker, machineId, msg) =>
    void broker.settle(BROWSE_DIRS, msg.requestId, machineId, {
      ...(msg.listing === undefined ? {} : { listing: msg.listing }),
      ...(msg.error === undefined ? {} : { error: msg.error }),
    }),
  repoOpResult: (broker, machineId, msg) =>
    void broker.settle(REPO_OP, msg.requestId, machineId, { ok: msg.ok, output: msg.output }),
  harnessExecResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_EXEC, msg.requestId, machineId, { ok: msg.ok, output: msg.output }),
  usageResult: (broker, machineId, msg) =>
    void broker.settle(USAGE, msg.requestId, machineId, {
      hostname: msg.hostname,
      buckets: msg.buckets,
    }),
  agentQuotaResult: (broker, machineId, msg) =>
    void broker.settle(AGENT_QUOTA, msg.requestId, machineId, {
      hostname: msg.hostname,
      agents: msg.agents,
    }),
  modelProbeResult: (broker, machineId, msg) =>
    void broker.settle(MODEL_PROBE, msg.requestId, machineId, msg.byAgent),
  imageUploadResult: (broker, machineId, msg) =>
    void broker.settle(IMAGE_UPLOAD, msg.requestId, machineId, {
      path: msg.path,
      ...(msg.error === undefined ? {} : { error: msg.error }),
    }),
  transcriptReadResult: (broker, machineId, msg) =>
    void broker.settle(TRANSCRIPT_READ, msg.requestId, machineId, {
      items: msg.items,
      ...(msg.head === undefined ? {} : { head: msg.head }),
      ...(msg.tail === undefined ? {} : { tail: msg.tail }),
      hasMore: msg.hasMore,
    }),
  fileReadResult: (broker, machineId, msg) =>
    void broker.settle(FILE_READ, msg.requestId, machineId, payloadOf(msg)),
  fileAssetResult: (broker, machineId, msg) =>
    void broker.settle(FILE_ASSET, msg.requestId, machineId, payloadOf(msg)),
  fileWriteResult: (broker, machineId, msg) =>
    void broker.settle(FILE_WRITE, msg.requestId, machineId, payloadOf(msg)),
  dirListResult: (broker, machineId, msg) =>
    void broker.settle(DIR_LIST, msg.requestId, machineId, payloadOf(msg)),
  handoffExportResult: (broker, machineId, msg) =>
    void broker.settle(HANDOFF_EXPORT, msg.requestId, machineId, payloadOf(msg)),
  handoffChunkReadResult: (broker, machineId, msg) =>
    void broker.settle(HANDOFF_READ, msg.requestId, machineId, payloadOf(msg)),
  handoffImportChunkResult: (broker, machineId, msg) =>
    void broker.settle(HANDOFF_WRITE, msg.requestId, machineId, payloadOf(msg)),
  handoffImportResult: (broker, machineId, msg) =>
    void broker.settle(HANDOFF_IMPORT, msg.requestId, machineId, payloadOf(msg)),
  handoffBindingFinalizeResult: (broker, machineId, msg) =>
    void broker.settle(HANDOFF_BINDING_FINALIZE, msg.requestId, machineId, payloadOf(msg)),
  workspaceExportResult: (broker, machineId, msg) =>
    void broker.settle(WORKSPACE_EXPORT, msg.requestId, machineId, payloadOf(msg)),
  workspaceImportResult: (broker, machineId, msg) =>
    void broker.settle(WORKSPACE_IMPORT, msg.requestId, machineId, payloadOf(msg)),
  workspaceCleanResult: (broker, machineId, msg) =>
    void broker.settle(WORKSPACE_CLEAN, msg.requestId, machineId, payloadOf(msg)),
  credentialExportResult: (broker, machineId, msg) =>
    void broker.settle(CREDENTIAL_EXPORT, msg.requestId, machineId, payloadOf(msg)),
  credentialInstallResult: (broker, machineId, msg) =>
    void broker.settle(CREDENTIAL_INSTALL, msg.requestId, machineId, payloadOf(msg)),
}

/**
 * THE DAEMON RPC SURFACE (modules/machines): every server→daemon round-trip the
 * feature modules can make, as ordinary awaited methods.
 *
 * IT OWNS NO CORRELATION STATE. It used to own twenty-three pending maps and a
 * static `settle` helper; those are now one registry inside
 * `modules/daemon-request.ts`, shared with the conversations and hosts modules.
 * What is left here is what actually belongs to this module: which control
 * message each call builds, which machine it targets, how long it waits, and
 * what a timeout means for that particular caller.
 *
 * The requestId counter lives in the broker and is shared across every family
 * (and exposed via nextRequestId for the headless module), so ids never collide.
 */
export class DaemonRpcService {
  private readonly broker: DaemonRequestPort

  constructor(private readonly deps: DaemonRpcDeps) {
    this.broker =
      deps.broker ??
      new DaemonRequestBroker({ toMachine: deps.toMachine, defaultMachine: deps.defaultMachine })
  }

  /** Globally-unique requestId mint — shared with the headless module so its
   *  turn/bind ids can never collide with an RPC id. */
  nextRequestId(prefix: string): string {
    return this.broker.nextRequestId(prefix)
  }

  /** One round-trip against a named family. A thin alias for the broker's own
   *  `request` — kept so every call below reads as one call, not two. */
  private request<T>(
    kind: DaemonRequestKind<T>,
    timeoutMs: number,
    onTimeout: () => T,
    build: (requestId: string) => ControlMessage,
    machineId?: string,
  ): Promise<T> {
    return this.broker.request({ kind, timeoutMs, onTimeout, build, machineId })
  }

  // ---- requests ----

  scan(): Promise<ScanResult> {
    return this.request(
      SCAN,
      SCAN_TIMEOUT_MS,
      () => ({
        conversations: [],
        diagnostics: [{ severity: 'error', message: 'discovery scan timed out' }],
      }),
      (requestId) => ({ type: 'scanRequest', requestId }),
    )
  }

  scanRepos(
    roots: string[],
    opts: { includeHome?: boolean; maxDepth?: number } = {},
    machineId?: string,
  ): Promise<ScanReposResult> {
    return this.request(
      SCAN_REPOS,
      SCAN_TIMEOUT_MS,
      () => ({
        repositories: [],
        diagnostics: [{ severity: 'error', path: '', message: 'repos scan timed out' }],
      }),
      (requestId) => ({
        type: 'scanReposRequest',
        requestId,
        roots,
        ...(opts.includeHome === undefined ? {} : { includeHome: opts.includeHome }),
        ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
      }),
      machineId,
    )
  }

  /** One directory's sub-directories on `machineId`'s disk (POD-814) [spec:SP-3701]
   *  — the repo picker's browser. `path` omitted browses that machine's $HOME.
   *  A daemon-reported failure comes back in `error`, not as a rejection. */
  browseDirs(
    path?: string,
    opts: { includeHidden?: boolean } = {},
    machineId?: string,
  ): Promise<BrowseDirsResult> {
    return this.request(
      BROWSE_DIRS,
      BROWSE_TIMEOUT_MS,
      () => ({ error: 'directory browse timed out' }),
      (requestId) => ({
        type: 'browseDirsRequest',
        requestId,
        ...(path === undefined ? {} : { path }),
        ...(opts.includeHidden === undefined ? {} : { includeHidden: opts.includeHidden }),
      }),
      machineId,
    )
  }

  /** Token-usage buckets from the daemon's transcript harvest (empty on timeout). */
  usage(sinceMs?: number): Promise<{ hostname: string; buckets: UsageBucketWire[] }> {
    return this.request(
      USAGE,
      20_000,
      () => ({ hostname: '', buckets: [] }),
      (requestId) => ({
        type: 'usageRequest',
        requestId,
        ...(sinceMs !== undefined ? { sinceMs } : {}),
      }),
    )
  }

  /** Per-agent plan-quota (5h/weekly windows), read live read-only on one daemon
   *  host. Empty agents on timeout. Distinct from `usage` (token-cost analytics).
   *  `machineId` targets a specific machine; omitted → the default online machine. */
  agentQuota(
    refresh?: boolean,
    machineId?: string,
  ): Promise<{ hostname: string; agents: AgentQuotaWire[] }> {
    return this.request(
      AGENT_QUOTA,
      20_000,
      () => ({ hostname: '', agents: [] }),
      (requestId) => ({
        type: 'agentQuotaRequest',
        requestId,
        ...(refresh !== undefined ? { refresh } : {}),
      }),
      machineId,
    )
  }

  /**
   * ENUMERATE ONE MACHINE'S MODELS ON THAT MACHINE (POD-1466).
   *
   * The probe shells out to the agent CLIs, so it only ever sees the host it runs
   * on: asking machine B's daemon is the ONLY way to learn machine B's models.
   * `{}` on timeout — the caller (ModelCatalog) keeps its last-good snapshot for
   * that machine rather than replacing it with an empty one, and the web falls
   * back to its static per-agent catalog.
   *
   * The timeout is generous for the reason the probe's own is: a cold
   * `cursor-agent models` plus the Anthropic model list can take several seconds,
   * and this read is stale-while-revalidate — no client is blocked on it.
   */
  modelProbe(machineId: string): Promise<Record<string, ModelChoiceWire[]>> {
    return this.request(
      MODEL_PROBE,
      20_000,
      () => ({}),
      (requestId) => ({ type: 'modelProbeRequest', requestId }),
      machineId,
    )
  }

  /**
   * Fan out `agentQuota` to every online daemon and tag each reply with its
   * machineId + machineName — the overlay groups by machine because each machine
   * runs its agents under its own account. Empty when no daemon is online.
   *
   * Single-machine invariant: one online daemon → a single entry whose `agents`
   * equal today's `agentQuota().agents`, so the one-machine overlay is unchanged.
   */
  async agentQuotaAll(refresh?: boolean): Promise<MachineQuotaWire[]> {
    const machineIds = this.deps.onlineMachineIds()
    if (machineIds.length === 0) return []
    return Promise.all(
      machineIds.map(async (machineId) => {
        const { hostname, agents } = await this.agentQuota(refresh, machineId)
        return { machineId, machineName: this.deps.machineName(machineId), hostname, agents }
      }),
    )
  }

  /** Allowlisted git op on a dev machine (superagent tools). */
  repoOp(
    op: RepoOp,
    cwd: string,
    args?: Record<string, string>,
    machineId?: string,
  ): Promise<OpResult> {
    return this.request(
      REPO_OP,
      35_000,
      () => ({ ok: false, output: 'no daemon answered the git request in time' }),
      (requestId) => ({ type: 'repoOpRequest', requestId, op, cwd, ...(args ? { args } : {}) }),
      machineId ?? this.deps.resolveMachine(undefined, cwd),
    )
  }

  /** Read only allowlisted native auth files from one authenticated daemon. */
  credentialExport(
    kinds: PortableCredentialKind[],
    machineId: string,
  ): Promise<Omit<CredentialExportResultMessage, 'type' | 'requestId'>> {
    return this.request(
      CREDENTIAL_EXPORT,
      15_000,
      () => ({ bundles: [], unavailable: kinds }),
      (requestId) => ({ type: 'credentialExportRequest', requestId, kinds }),
      machineId,
    )
  }

  /** Atomically install allowlisted auth files on one authenticated daemon. */
  credentialInstall(
    bundles: PortableCredentialBundle[],
    machineId: string,
  ): Promise<Omit<CredentialInstallResultMessage, 'type' | 'requestId'>> {
    return this.request(
      CREDENTIAL_INSTALL,
      15_000,
      () => ({ installed: [], failed: bundles.map((bundle) => bundle.kind) }),
      (requestId) => ({ type: 'credentialInstallRequest', requestId, bundles }),
      machineId,
    )
  }

  handoffExport(
    input: {
      sessionId: SessionId
      cwd: string
      fallbackCwd?: string
      agentKind: 'claude-code' | 'codex'
      resume: { kind: string; value: string }
      branch: string
      baseShas: string[]
      repoId: RepoId
      title?: string
      issueId?: IssueId
      sourceMachineId: string
      binding: HandoffBindingExportInstruction
    },
    machineId: string,
  ): Promise<Omit<HandoffExportResultMessage, 'type' | 'requestId'>> {
    return this.request(
      HANDOFF_EXPORT,
      120_000,
      () => ({ ok: false, error: 'handoff export timed out' }),
      (requestId) => ({ type: 'handoffExportRequest', requestId, ...input }),
      machineId,
    )
  }

  handoffReadChunk(
    stagePath: string,
    offset: number,
    length: number,
    machineId: string,
  ): Promise<Omit<HandoffChunkReadResultMessage, 'type' | 'requestId'>> {
    return this.request(
      HANDOFF_READ,
      30_000,
      () => ({ ok: false, error: 'handoff read timed out' }),
      (requestId) => ({ type: 'handoffChunkReadRequest', requestId, stagePath, offset, length }),
      machineId,
    )
  }

  handoffWriteChunk(
    sessionId: SessionId,
    offset: number,
    data: Buffer,
    machineId: string,
  ): Promise<Omit<HandoffImportChunkResultMessage, 'type' | 'requestId'>> {
    return this.request(
      HANDOFF_WRITE,
      30_000,
      () => ({ ok: false, error: 'handoff write timed out' }),
      (requestId) => ({
        type: 'handoffImportChunk',
        requestId,
        sessionId,
        offset,
        data: data.toString('base64'),
      }),
      machineId,
    )
  }

  handoffImport(
    sessionId: SessionId,
    repoPath: string,
    worktreeName: string,
    machineId: string,
    occupiedWorktreePaths: string[] = [],
    binding?: HandoffBindingImportInstruction,
  ): Promise<Omit<HandoffImportResultMessage, 'type' | 'requestId'>> {
    return this.request(
      HANDOFF_IMPORT,
      120_000,
      () => ({ ok: false, error: 'handoff import timed out' }),
      (requestId) => ({
        type: 'handoffImportRequest',
        requestId,
        sessionId,
        repoPath,
        worktreeName,
        ...(occupiedWorktreePaths.length > 0 ? { occupiedWorktreePaths } : {}),
        ...(binding ? { binding } : {}),
      }),
      machineId,
    )
  }

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
    machineId: string,
  ): Promise<Omit<HandoffBindingFinalizeResultMessage, 'type' | 'requestId'>> {
    return this.request(
      HANDOFF_BINDING_FINALIZE,
      30_000,
      () => ({ ok: false, error: 'handoff binding finalize timed out' }),
      (requestId) => ({
        type: 'handoffBindingFinalizeRequest',
        requestId,
        ...input,
      }),
      machineId,
    )
  }

  /** Lazy workspace snapshot export on the SOURCE daemon [POD-658]. */
  workspaceExport(
    input: {
      fetchId: string
      cwd: string
      baseShas: string[]
      repoId: RepoId
      sourceMachineId: string
    },
    machineId: string,
  ): Promise<Omit<WorkspaceExportResultMessage, 'type' | 'requestId'>> {
    return this.request(
      WORKSPACE_EXPORT,
      120_000,
      () => ({ ok: false, error: 'workspace export timed out' }),
      (requestId) => ({ type: 'workspaceExportRequest', requestId, ...input }),
      machineId,
    )
  }

  /** Materialize a transferred snapshot as a detached peek worktree [POD-658]. */
  workspaceImport(
    fetchId: string,
    repoPath: string,
    machineId: string,
  ): Promise<Omit<WorkspaceImportResultMessage, 'type' | 'requestId'>> {
    return this.request(
      WORKSPACE_IMPORT,
      120_000,
      () => ({ ok: false, error: 'workspace import timed out' }),
      (requestId) => ({ type: 'workspaceImportRequest', requestId, fetchId, repoPath }),
      machineId,
    )
  }

  /** Remove every peek worktree under a repo [POD-658]. */
  workspaceClean(
    repoPath: string,
    machineId: string,
  ): Promise<Omit<WorkspaceCleanResultMessage, 'type' | 'requestId'>> {
    return this.request(
      WORKSPACE_CLEAN,
      60_000,
      () => ({ ok: false, error: 'workspace clean timed out' }),
      (requestId) => ({ type: 'workspaceCleanRequest', requestId, repoPath }),
      machineId,
    )
  }

  /** One-shot `claude -p` / `codex exec` / `grok -p` on a dev machine. */
  harnessExec(input: {
    agent: 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor'
    model?: string
    prompt: string
    cwd?: string
    systemPrompt?: string
    mcpConfig?: string
    allowedTools?: string[]
    /** Kill budget for the CLI run, ms (daemon default 240s). The server-side
     *  wait adds 10s slack over it so the daemon's own timeout reports first. */
    timeoutMs?: number
  }): Promise<OpResult> {
    return this.request(
      HARNESS_EXEC,
      (input.timeoutMs ?? 240_000) + 10_000,
      () => ({ ok: false, output: 'harness run timed out' }),
      (requestId) => ({
        type: 'harnessExecRequest',
        requestId,
        agent: input.agent,
        prompt: input.prompt,
        ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      }),
    )
  }

  /**
   * Route an image upload to the owning daemon. The daemon writes the decoded
   * base64 bytes to ~/.podium/uploads/<sessionId>/<id>.<ext> and returns the
   * absolute path. Resolves with that path so the caller can insert it into a
   * prompt — Claude Code reads images by path.
   */
  uploadImage(input: {
    sessionId: SessionId
    filename: string
    mimeType: string
    dataBase64: string
  }): Promise<{ path: string; error?: string }> {
    // The upload is written to (and read back by) the machine that runs the session,
    // so the returned path is valid in that session's prompt.
    const session = this.deps.getSession(input.sessionId)
    return this.request(
      IMAGE_UPLOAD,
      30_000,
      () => ({ path: '' }),
      (requestId) => ({
        type: 'imageUploadRequest',
        requestId,
        sessionId: input.sessionId,
        filename: input.filename,
        mimeType: input.mimeType,
        dataBase64: input.dataBase64,
      }),
      session?.machineId,
    )
  }

  /** The recorded segment path for a session's conversation, shaped for message
   *  spreads (`{pathHint}` or undefined). Lookup only — never derives. */
  transcriptPathHint(
    reader: TranscriptReader,
    session: {
      id: SessionId
      machineId: string
      resume?: { value: string }
    },
  ): { pathHint: string } | undefined {
    const nativeId = session.resume?.value
    if (!nativeId) return undefined
    const path = this.deps.memory.transcriptPathHint(reader, session)?.pathHint
    return path ? { pathHint: path } : undefined
  }

  /**
   * Transcript for the chat view — a pure daemon round-trip; disk is the source of
   * truth. Reads the requested window of `limit` items relative to `anchor` (a
   * cursor) in `direction` ('before' = older, 'after' = newer; no anchor = the
   * latest window). The daemon resolves the on-disk transcript from the session's
   * agentKind/cwd/resume and serves the slice — so a LIVE session with an empty
   * recent-delta cache (e.g. right after a server restart) still loads its history
   * straight off disk, instead of the old short-circuit that returned an empty
   * buffer. Resolves an empty, hasMore:false page when the session is unknown or no
   * daemon answers.
   */
  async readTranscript(
    input: {
      sessionId: SessionId
      anchor?: string
      direction: 'before' | 'after'
      limit: number
    },
    reader: TranscriptReader,
  ): Promise<TranscriptSlice> {
    const startedAt = performance.now()
    const recordTotal = (): void => {
      perf.record('phase', 'transcriptRead.total', performance.now() - startedAt, DEPLOYMENT)
    }
    if (!this.deps.memory.canReadSession(reader, input.sessionId)) {
      recordTotal()
      return { items: [], hasMore: false }
    }
    const session = this.deps.getSession(input.sessionId)
    if (!session) {
      recordTotal()
      return { items: [], hasMore: false }
    }
    // Leg timing [POD-701]: transcriptRead.daemon / transcriptRead.lake record
    // the leg that actually served the response. Payload bytes aren't cheaply
    // available (summing item JSON lengths would cost a full pass), so a second
    // record carries the item count in the ms slot instead: transcriptRead.items.
    // The `.wait` phases also record an attempted leg when it returns an empty
    // page and the other source wins; otherwise a daemon timeout/empty answer
    // vanishes from attribution and the client gap cannot be closed.
    const hasDaemon = this.deps.hasDaemon(session.machineId)
    let fromDaemon: TranscriptSlice | undefined
    let daemonMs: number | undefined
    // Daemon-first (docs/spec/search-v1.md §2.2): the native file is fresher than
    // the mirror. But a machine with no live daemon socket can't answer at all —
    // skip straight to the lake rather than stalling the chat view for the full
    // request timeout to learn that.
    if (hasDaemon) {
      const tDaemon0 = performance.now()
      try {
        fromDaemon = await this.request<TranscriptSlice>(
          TRANSCRIPT_READ,
          SCAN_TIMEOUT_MS,
          () => ({ items: [], hasMore: false }),
          (requestId) => ({
            type: 'transcriptRead',
            requestId,
            sessionId: input.sessionId,
            agentKind: session.agentKind,
            cwd: session.cwd,
            ...(session.resume ? { resume: session.resume } : {}),
            // Segment evidence beats cwd derivation: the recorded absolute path (from
            // discovery scans) survives worktree moves; the daemon still falls back to
            // derivation + sweep when absent/stale (conversation registry §3.3).
            ...(this.transcriptPathHint(reader, session) ?? {}),
            ...(input.anchor ? { anchor: input.anchor } : {}),
            direction: input.direction,
            limit: input.limit,
          }),
          session.machineId, // the transcript file lives on the session's machine
        )
      } finally {
        daemonMs = performance.now() - tDaemon0
        perf.record('phase', 'transcriptRead.daemon.wait', daemonMs, DEPLOYMENT)
      }
    }
    if (fromDaemon && fromDaemon.items.length > 0) {
      perf.record('phase', 'transcriptRead.daemon', daemonMs ?? 0, DEPLOYMENT)
      perf.record('phase', 'transcriptRead.items', fromDaemon.items.length, DEPLOYMENT)
      recordTotal()
      return fromDaemon
    }
    // Empty/timeout daemon answer (or no daemon): serve from the mirrored copy.
    const tLake0 = performance.now()
    let fromLake: TranscriptSlice | undefined
    let lakeMs = 0
    try {
      fromLake = await this.deps.memory.readTranscriptFromLake(session, input)
    } finally {
      lakeMs = performance.now() - tLake0
      perf.record('phase', 'transcriptRead.lake.wait', lakeMs, DEPLOYMENT)
    }
    if (fromLake) {
      perf.record('phase', 'transcriptRead.lake', lakeMs, DEPLOYMENT)
      perf.record('phase', 'transcriptRead.items', fromLake.items.length, DEPLOYMENT)
    }
    recordTotal()
    return fromLake ?? fromDaemon ?? { items: [], hasMore: false }
  }

  listDir(input: {
    machineId?: string
    root: string
    path?: string
  }): Promise<Omit<DirListResultMessage, 'type' | 'requestId'>> {
    const path = input.path ?? input.root
    return this.request(
      DIR_LIST,
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path, entries: [], error: 'timeout' }),
      (requestId) => ({ type: 'dirListRequest', requestId, root: input.root, path }),
      input.machineId,
    )
  }

  readFile(
    input:
      | { sessionId: SessionId; path: string }
      | { machineId?: string; root: string; path: string },
  ): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> {
    if ('sessionId' in input) {
      const session = this.deps.getSession(input.sessionId)
      if (!session) return Promise.resolve({ ok: false, path: input.path, error: 'no session' })
      const knownPath = knownPathsFor(session.transcriptItems()).has(input.path)
      return this.request(
        FILE_READ,
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, path: input.path, error: 'timeout' }),
        (requestId) => ({
          type: 'fileReadRequest',
          requestId,
          cwd: session.cwd,
          path: input.path,
          knownPath,
        }),
        session.machineId,
      )
    }
    return this.request(
      FILE_READ,
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path: input.path, error: 'timeout' }),
      (requestId) => ({
        type: 'fileReadRequest',
        requestId,
        cwd: input.root,
        path: input.path,
        knownPath: false,
      }),
      input.machineId,
    )
  }

  readAsset(
    input:
      | { sessionId: SessionId; path: string }
      | {
          machineId?: string
          root: string
          path: string
          /** Ranged pull ([spec:SP-0fc9]) — artifact snapshotting reads large files in chunks. */
          offset?: number
          length?: number
        },
  ): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>> {
    if ('sessionId' in input) {
      const session = this.deps.getSession(input.sessionId)
      if (!session) return Promise.resolve({ ok: false, path: input.path, error: 'no session' })
      const knownPath = knownPathsFor(session.transcriptItems()).has(input.path)
      return this.request(
        FILE_ASSET,
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, path: input.path, error: 'timeout' }),
        (requestId) => ({
          type: 'fileAssetRequest',
          requestId,
          cwd: session.cwd,
          path: input.path,
          knownPath,
        }),
        session.machineId, // the asset lives in the session's cwd on its machine
      )
    }
    // Worktree-scoped variant (issue panel artifacts, worktree md images): same
    // daemon sandbox as fileReadRequest — cwd = the worktree root. Artifact paths
    // may be worktree-relative; the daemon realpaths them, so absolutize here.
    const absPath = isAbsolute(input.path) ? input.path : join(input.root, input.path)
    return this.request(
      FILE_ASSET,
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path: input.path, error: 'timeout' }),
      (requestId) => ({
        type: 'fileAssetRequest',
        requestId,
        cwd: input.root,
        path: absPath,
        knownPath: false,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.length !== undefined ? { length: input.length } : {}),
      }),
      input.machineId,
    )
  }

  writeFile(
    input:
      | { sessionId: SessionId; path: string; content: string; baseHash?: string }
      | { machineId?: string; root: string; path: string; content: string; baseHash?: string },
  ): Promise<Omit<FileWriteResultMessage, 'type' | 'requestId'>> {
    const build = (requestId: string, cwd: string) => ({
      type: 'fileWriteRequest' as const,
      requestId,
      cwd,
      path: input.path,
      content: input.content,
      ...(input.baseHash ? { baseHash: input.baseHash } : {}),
    })
    if ('sessionId' in input) {
      const session = this.deps.getSession(input.sessionId)
      if (!session) return Promise.resolve({ ok: false, error: 'no session' })
      return this.request(
        FILE_WRITE,
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, error: 'timeout' }),
        (requestId) => build(requestId, session.cwd),
        session.machineId,
      )
    }
    return this.request(
      FILE_WRITE,
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, error: 'timeout' }),
      (requestId) => build(requestId, input.root),
      input.machineId,
    )
  }

  /**
   * THE ONE FAN-IN — every request-correlated daemon reply this module owns.
   *
   * `machineId` is the machine that ANSWERED, from the authenticated transport.
   * It is not used here: it is handed straight to the broker, which refuses a
   * reply from any machine other than the one the request was sent to and leaves
   * that request pending (POD-1175). Putting the check anywhere else would mean
   * writing it twenty-three times, which is how it came to be missing.
   */
  settleDaemonReply(machineId: string, msg: RpcDaemonFrame): void {
    const settle = RPC_REPLY_SETTLERS[msg.type] as ReplySettler<RpcDaemonFrameType>
    settle(this.broker, machineId, msg)
  }
}
