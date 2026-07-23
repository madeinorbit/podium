import { isAbsolute, join } from 'node:path'
import type {
  AgentKind,
  AgentQuotaWire,
  BrowseDirsResultMessage,
  ControlMessage,
  ConversationDiagnosticWire,
  ConversationSummaryWire,
  CredentialExportResultMessage,
  CredentialInstallResultMessage,
  DaemonMessage,
  DirectoryListingWire,
  DirListResultMessage,
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  HandoffChunkReadResultMessage,
  HandoffExportResultMessage,
  HandoffImportChunkResultMessage,
  HandoffImportResultMessage,
  MachineQuotaWire,
  PortableCredentialBundle,
  PortableCredentialKind,
  RepoOp,
  ResumeRef,
  TranscriptItem,
  UsageBucketWire,
  WorkspaceCleanResultMessage,
  WorkspaceExportResultMessage,
  WorkspaceImportResultMessage,
} from '@podium/protocol'
import { knownPathsFor } from '../../file-relay-policy'
import type { SessionStore } from '../../store'
import { perf } from '../perf/registry'

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
  cwd: string
  machineId: string
  agentKind: AgentKind
  resume?: ResumeRef
  transcriptItems(): TranscriptItem[]
}

interface DaemonRpcDeps {
  store: Pick<SessionStore['conversations'], 'conversationSegmentPath'>
  toMachine(machineId: string, msg: ControlMessage): void
  defaultMachine(): string
  resolveMachine(requested: string | undefined, cwd: string): string
  hasDaemon(machineId: string): boolean
  machineName(id: string): string
  onlineMachineIds(): string[]
  getSession(sessionId: string): RpcSessionView | undefined
  /** Lake-fallback transcript read (modules/conversations) — lazy: the
   *  conversations service is constructed after this one. */
  readTranscriptFromLake(
    session: { machineId: string; agentKind: AgentKind; resume?: { value: string } },
    input: { anchor?: string; direction: 'before' | 'after'; limit: number },
  ): Promise<TranscriptSlice | undefined>
}

/**
 * Request/response plumbing for daemon round-trips (modules/machines): mint a
 * prefixed requestId, register a resolver keyed by it, send the control
 * message, and resolve a fallback on timeout. Every `*Result` daemon message
 * looks its resolver up in the matching pending map. One place to get
 * unref/cleanup right instead of a dozen near-identical copies.
 *
 * The requestId counter is shared across every request family (and exposed via
 * nextRequestId for the headless module) so ids never collide across the
 * separate pending maps.
 */
export class DaemonRpcService {
  private nextRequestNum = 0
  private readonly pendingScans = new Map<string, (r: ScanResult) => void>()
  private readonly pendingRepoScans = new Map<string, (r: ScanReposResult) => void>()
  private readonly pendingBrowseDirs = new Map<string, (r: BrowseDirsResult) => void>()
  private readonly pendingRepoOps = new Map<string, (r: OpResult) => void>()
  private readonly pendingHandoffExports = new Map<
    string,
    (r: Omit<HandoffExportResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingHandoffReads = new Map<
    string,
    (r: Omit<HandoffChunkReadResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingHandoffWrites = new Map<
    string,
    (r: Omit<HandoffImportChunkResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingHandoffImports = new Map<
    string,
    (r: Omit<HandoffImportResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingWorkspaceExports = new Map<
    string,
    (r: Omit<WorkspaceExportResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingWorkspaceImports = new Map<
    string,
    (r: Omit<WorkspaceImportResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingWorkspaceCleans = new Map<
    string,
    (r: Omit<WorkspaceCleanResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingHarnessExecs = new Map<string, (r: OpResult) => void>()
  private readonly pendingUsage = new Map<
    string,
    (r: { hostname: string; buckets: UsageBucketWire[] }) => void
  >()
  private readonly pendingAgentQuota = new Map<
    string,
    (r: { hostname: string; agents: AgentQuotaWire[] }) => void
  >()
  private readonly pendingTranscriptReads = new Map<string, (r: TranscriptSlice) => void>()
  private readonly pendingUploads = new Map<string, (r: { path: string; error?: string }) => void>()
  private readonly pendingFileReads = new Map<
    string,
    (r: Omit<FileReadResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingFileAssets = new Map<
    string,
    (r: Omit<FileAssetResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingFileWrites = new Map<
    string,
    (r: Omit<FileWriteResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingDirLists = new Map<
    string,
    (r: Omit<DirListResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingCredentialExports = new Map<
    string,
    (r: Omit<CredentialExportResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingCredentialInstalls = new Map<
    string,
    (r: Omit<CredentialInstallResultMessage, 'type' | 'requestId'>) => void
  >()

  constructor(private readonly deps: DaemonRpcDeps) {}

  /** Globally-unique requestId mint — shared with the headless module so its
   *  turn/bind ids can never collide with an RPC id. */
  nextRequestId(prefix: string): string {
    return `${prefix}${this.nextRequestNum++}`
  }

  /** The generic round-trip primitive. Public: the hosts/conversations modules
   *  run their own pending maps through it (their result handlers live there). */
  request<T>(
    pending: Map<string, (r: T) => void>,
    prefix: string,
    timeoutMs: number,
    onTimeout: () => T,
    buildMsg: (requestId: string) => ControlMessage,
    machineId: string = this.deps.defaultMachine(),
  ): Promise<T> {
    const requestId = this.nextRequestId(prefix)
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve(onTimeout())
      }, timeoutMs)
      timer.unref?.()
      pending.set(requestId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.deps.toMachine(machineId, buildMsg(requestId))
    })
  }

  /** Resolve one pending request out of `map` (shared `*Result` handler shape). */
  private static settle<T>(map: Map<string, (r: T) => void>, requestId: string, value: T): void {
    const resolve = map.get(requestId)
    if (!resolve) return
    map.delete(requestId)
    resolve(value)
  }

  // ---- requests ----

  scan(): Promise<ScanResult> {
    return this.request(
      this.pendingScans,
      'r',
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
      this.pendingRepoScans,
      'rr',
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
      machineId ?? this.deps.defaultMachine(),
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
      this.pendingBrowseDirs,
      'bd',
      BROWSE_TIMEOUT_MS,
      () => ({ error: 'directory browse timed out' }),
      (requestId) => ({
        type: 'browseDirsRequest',
        requestId,
        ...(path === undefined ? {} : { path }),
        ...(opts.includeHidden === undefined ? {} : { includeHidden: opts.includeHidden }),
      }),
      machineId ?? this.deps.defaultMachine(),
    )
  }

  /** Token-usage buckets from the daemon's transcript harvest (empty on timeout). */
  usage(sinceMs?: number): Promise<{ hostname: string; buckets: UsageBucketWire[] }> {
    return this.request(
      this.pendingUsage,
      'us',
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
      this.pendingAgentQuota,
      'aq',
      20_000,
      () => ({ hostname: '', agents: [] }),
      (requestId) => ({
        type: 'agentQuotaRequest',
        requestId,
        ...(refresh !== undefined ? { refresh } : {}),
      }),
      machineId ?? this.deps.defaultMachine(),
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
      this.pendingRepoOps,
      'ro',
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
      this.pendingCredentialExports,
      'ce',
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
      this.pendingCredentialInstalls,
      'ci',
      15_000,
      () => ({ installed: [], failed: bundles.map((bundle) => bundle.kind) }),
      (requestId) => ({ type: 'credentialInstallRequest', requestId, bundles }),
      machineId,
    )
  }

  handoffExport(
    input: {
      sessionId: string
      cwd: string
      fallbackCwd?: string
      agentKind: 'claude-code' | 'codex'
      resume: { kind: string; value: string }
      branch: string
      baseShas: string[]
      repoId: string
      title?: string
      issueId?: string
      sourceMachineId: string
    },
    machineId: string,
  ): Promise<Omit<HandoffExportResultMessage, 'type' | 'requestId'>> {
    return this.request(
      this.pendingHandoffExports,
      'he',
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
      this.pendingHandoffReads,
      'hr',
      30_000,
      () => ({ ok: false, error: 'handoff read timed out' }),
      (requestId) => ({ type: 'handoffChunkReadRequest', requestId, stagePath, offset, length }),
      machineId,
    )
  }

  handoffWriteChunk(
    sessionId: string,
    offset: number,
    data: Buffer,
    machineId: string,
  ): Promise<Omit<HandoffImportChunkResultMessage, 'type' | 'requestId'>> {
    return this.request(
      this.pendingHandoffWrites,
      'hw',
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
    sessionId: string,
    repoPath: string,
    worktreeName: string,
    machineId: string,
    occupiedWorktreePaths: string[] = [],
  ): Promise<Omit<HandoffImportResultMessage, 'type' | 'requestId'>> {
    return this.request(
      this.pendingHandoffImports,
      'hi',
      120_000,
      () => ({ ok: false, error: 'handoff import timed out' }),
      (requestId) => ({
        type: 'handoffImportRequest',
        requestId,
        sessionId,
        repoPath,
        worktreeName,
        ...(occupiedWorktreePaths.length > 0 ? { occupiedWorktreePaths } : {}),
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
      repoId: string
      sourceMachineId: string
    },
    machineId: string,
  ): Promise<Omit<WorkspaceExportResultMessage, 'type' | 'requestId'>> {
    return this.request(
      this.pendingWorkspaceExports,
      'we',
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
      this.pendingWorkspaceImports,
      'wi',
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
      this.pendingWorkspaceCleans,
      'wc',
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
      this.pendingHarnessExecs,
      'hx',
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
    sessionId: string
    filename: string
    mimeType: string
    dataBase64: string
  }): Promise<{ path: string; error?: string }> {
    // The upload is written to (and read back by) the machine that runs the session,
    // so the returned path is valid in that session's prompt.
    const session = this.deps.getSession(input.sessionId)
    return this.request(
      this.pendingUploads,
      'iu',
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
  transcriptPathHint(session: {
    machineId: string
    resume?: { value: string }
  }): { pathHint: string } | undefined {
    const nativeId = session.resume?.value
    if (!nativeId) return undefined
    const path = this.deps.store.conversationSegmentPath(session.machineId, nativeId)
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
  async readTranscript(input: {
    sessionId: string
    anchor?: string
    direction: 'before' | 'after'
    limit: number
  }): Promise<TranscriptSlice> {
    const session = this.deps.getSession(input.sessionId)
    if (!session) return { items: [], hasMore: false }
    // Leg timing [POD-701]: transcriptRead.daemon / transcriptRead.lake record
    // the leg that actually served the response. Payload bytes aren't cheaply
    // available (summing item JSON lengths would cost a full pass), so a second
    // record carries the item count in the ms slot instead: transcriptRead.items.
    const t0 = performance.now()
    // Daemon-first (docs/spec/search-v1.md §2.2): the native file is fresher than
    // the mirror. But a machine with no live daemon socket can't answer at all —
    // skip straight to the lake rather than stalling the chat view for the full
    // request timeout to learn that.
    const fromDaemon = this.deps.hasDaemon(session.machineId)
      ? await this.request<TranscriptSlice>(
          this.pendingTranscriptReads,
          'tr',
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
            ...(this.transcriptPathHint(session) ?? {}),
            ...(input.anchor ? { anchor: input.anchor } : {}),
            direction: input.direction,
            limit: input.limit,
          }),
          session.machineId, // the transcript file lives on the session's machine
        )
      : undefined
    if (fromDaemon && fromDaemon.items.length > 0) {
      perf.record('phase', 'transcriptRead.daemon', performance.now() - t0)
      perf.record('phase', 'transcriptRead.items', fromDaemon.items.length)
      return fromDaemon
    }
    // Empty/timeout daemon answer (or no daemon): serve from the mirrored copy.
    const tLake0 = performance.now()
    const fromLake = await this.deps.readTranscriptFromLake(session, input)
    if (fromLake) {
      perf.record('phase', 'transcriptRead.lake', performance.now() - tLake0)
      perf.record('phase', 'transcriptRead.items', fromLake.items.length)
    }
    return fromLake ?? fromDaemon ?? { items: [], hasMore: false }
  }

  listDir(input: {
    machineId?: string
    root: string
    path?: string
  }): Promise<Omit<DirListResultMessage, 'type' | 'requestId'>> {
    const path = input.path ?? input.root
    return this.request(
      this.pendingDirLists,
      'dl',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path, entries: [], error: 'timeout' }),
      (requestId) => ({ type: 'dirListRequest', requestId, root: input.root, path }),
      input.machineId ?? this.deps.defaultMachine(),
    )
  }

  readFile(
    input: { sessionId: string; path: string } | { machineId?: string; root: string; path: string },
  ): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> {
    if ('sessionId' in input) {
      const session = this.deps.getSession(input.sessionId)
      if (!session) return Promise.resolve({ ok: false, path: input.path, error: 'no session' })
      const knownPath = knownPathsFor(session.transcriptItems()).has(input.path)
      return this.request(
        this.pendingFileReads,
        'fr',
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
      this.pendingFileReads,
      'fr',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path: input.path, error: 'timeout' }),
      (requestId) => ({
        type: 'fileReadRequest',
        requestId,
        cwd: input.root,
        path: input.path,
        knownPath: false,
      }),
      input.machineId ?? this.deps.defaultMachine(),
    )
  }

  readAsset(
    input:
      | { sessionId: string; path: string }
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
        this.pendingFileAssets,
        'fa',
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
      this.pendingFileAssets,
      'fa',
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
      input.machineId ?? this.deps.defaultMachine(),
    )
  }

  writeFile(
    input:
      | { sessionId: string; path: string; content: string; baseHash?: string }
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
        this.pendingFileWrites,
        'fw',
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, error: 'timeout' }),
        (requestId) => build(requestId, session.cwd),
        session.machineId,
      )
    }
    return this.request(
      this.pendingFileWrites,
      'fw',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, error: 'timeout' }),
      (requestId) => build(requestId, input.root),
      input.machineId ?? this.deps.defaultMachine(),
    )
  }

  // ---- daemon `*Result` fan-in ----

  onScanResult(msg: Extract<DaemonMessage, { type: 'scanResult' }>): void {
    DaemonRpcService.settle(this.pendingScans, msg.requestId, {
      conversations: msg.conversations,
      diagnostics: msg.diagnostics,
    })
  }

  onScanReposResult(msg: Extract<DaemonMessage, { type: 'scanReposResult' }>): void {
    DaemonRpcService.settle(this.pendingRepoScans, msg.requestId, {
      repositories: msg.repositories,
      diagnostics: msg.diagnostics,
    })
  }

  onBrowseDirsResult(msg: BrowseDirsResultMessage): void {
    DaemonRpcService.settle(this.pendingBrowseDirs, msg.requestId, {
      ...(msg.listing === undefined ? {} : { listing: msg.listing }),
      ...(msg.error === undefined ? {} : { error: msg.error }),
    })
  }

  onRepoOpResult(msg: Extract<DaemonMessage, { type: 'repoOpResult' }>): void {
    DaemonRpcService.settle(this.pendingRepoOps, msg.requestId, {
      ok: msg.ok,
      output: msg.output,
    })
  }

  onCredentialExportResult(msg: CredentialExportResultMessage): void {
    const { type: _type, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingCredentialExports, requestId, payload)
  }

  onCredentialInstallResult(msg: CredentialInstallResultMessage): void {
    const { type: _type, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingCredentialInstalls, requestId, payload)
  }

  onHandoffExportResult(msg: HandoffExportResultMessage): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingHandoffExports, requestId, payload)
  }
  onHandoffChunkReadResult(msg: HandoffChunkReadResultMessage): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingHandoffReads, requestId, payload)
  }
  onHandoffImportChunkResult(msg: HandoffImportChunkResultMessage): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingHandoffWrites, requestId, payload)
  }
  onHandoffImportResult(msg: HandoffImportResultMessage): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingHandoffImports, requestId, payload)
  }

  onWorkspaceExportResult(msg: WorkspaceExportResultMessage): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingWorkspaceExports, requestId, payload)
  }
  onWorkspaceImportResult(msg: WorkspaceImportResultMessage): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingWorkspaceImports, requestId, payload)
  }
  onWorkspaceCleanResult(msg: WorkspaceCleanResultMessage): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingWorkspaceCleans, requestId, payload)
  }

  onHarnessExecResult(msg: Extract<DaemonMessage, { type: 'harnessExecResult' }>): void {
    DaemonRpcService.settle(this.pendingHarnessExecs, msg.requestId, {
      ok: msg.ok,
      output: msg.output,
    })
  }

  onUsageResult(msg: Extract<DaemonMessage, { type: 'usageResult' }>): void {
    DaemonRpcService.settle(this.pendingUsage, msg.requestId, {
      hostname: msg.hostname,
      buckets: msg.buckets,
    })
  }

  onAgentQuotaResult(msg: Extract<DaemonMessage, { type: 'agentQuotaResult' }>): void {
    DaemonRpcService.settle(this.pendingAgentQuota, msg.requestId, {
      hostname: msg.hostname,
      agents: msg.agents,
    })
  }

  onTranscriptReadResult(msg: Extract<DaemonMessage, { type: 'transcriptReadResult' }>): void {
    DaemonRpcService.settle(this.pendingTranscriptReads, msg.requestId, {
      items: msg.items,
      ...(msg.head !== undefined ? { head: msg.head } : {}),
      ...(msg.tail !== undefined ? { tail: msg.tail } : {}),
      hasMore: msg.hasMore,
    })
  }

  onImageUploadResult(msg: Extract<DaemonMessage, { type: 'imageUploadResult' }>): void {
    DaemonRpcService.settle(this.pendingUploads, msg.requestId, {
      path: msg.path,
      ...(msg.error !== undefined ? { error: msg.error } : {}),
    })
  }

  onFileReadResult(msg: Extract<DaemonMessage, { type: 'fileReadResult' }>): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingFileReads, requestId, payload)
  }

  onFileWriteResult(msg: Extract<DaemonMessage, { type: 'fileWriteResult' }>): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingFileWrites, requestId, payload)
  }

  onFileAssetResult(msg: Extract<DaemonMessage, { type: 'fileAssetResult' }>): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingFileAssets, requestId, payload)
  }

  onDirListResult(msg: Extract<DaemonMessage, { type: 'dirListResult' }>): void {
    const { type: _t, requestId, ...payload } = msg
    DaemonRpcService.settle(this.pendingDirLists, requestId, payload)
  }
}
