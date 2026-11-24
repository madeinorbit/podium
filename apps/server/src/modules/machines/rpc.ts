import { createLogger } from '@podium/logger'
import type {
  AgentKind,
  AgentQuotaWire,
  BuiltinHarnessKind,
  ConversationDiagnosticWire,
  ConversationDiscoveryWire,
  DirectoryListingWire,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  HANDOFF_HARNESS_KINDS,
  HarnessAgent,
  IssueId,
  MachineId,
  MachineQuotaWire,
  RepoId,
  ResumeRef,
  SessionId,
  TranscriptItem,
  UsageBucketWire,
  UsageSourceWire,
} from '@podium/model'
import {
  asMachineId,
  machinePathSegments,
  machinePathSeparator,
  machinePathsEqual,
  resolveMachinePath,
} from '@podium/model'
import type {
  AccessField,
  BrowseDirsResultMessage,
  CodexCompleteResultMessage,
  CodexLlmMessageWire,
  CodexLlmToolWire,
  ConversationPrepareRequestMessage,
  ConversationPrepareResultMessage,
  CredentialExportResultMessage,
  CredentialInstallResultMessage,
  CredentialRemoveResultMessage,
  DevArtifactProbeResultMessage,
  DirListResultMessage,
  DirOp,
  FileAssetResultMessage,
  FileReadResultMessage,
  FileWriteResultMessage,
  GitHubCliResultMessage,
  HandoffBindingExportInstruction,
  HandoffBindingFinalizeResultMessage,
  HandoffBindingImportInstruction,
  HandoffChunkReadResultMessage,
  HandoffExportResultMessage,
  HandoffImportChunkResultMessage,
  HandoffImportResultMessage,
  HomeEnsureResultMessage,
  HomeHarness,
  HomeRemoveResultMessage,
  InteractionAnswerOutcome,
  MachineUninstallResultMessage,
  ModelChoiceWire,
  OauthLoopbackCallbackMessage,
  OauthLoopbackResultMessage,
  ObservationInputOrigin,
  PortableCredentialBundle,
  PortableCredentialKind,
  QuotaHistorySampleWire,
  RepoOp,
  ServerBindHost,
  ServerEndpointResultMessage,
  ServerTransferManifest,
  ServerTransferManifestEntry,
  ServerTransferResultMessage,
  SessionPosture,
  WorkspaceCleanResultMessage,
  WorkspaceExportResultMessage,
  WorkspaceImportResultMessage,
} from '@podium/protocol'
import {
  CAP_HARNESS_INSTALL_CANCEL,
  CAP_HARNESS_INSTALLS,
  CAP_REPO_ROOT_CHECK,
  CAP_TRANSCRIPT_PATHS,
  type HarnessActionResult,
  type HarnessInstallAction,
  SERVER_TRANSFER_MAX_CHUNK_BYTES,
} from '@podium/protocol'
import type {
  ContextReadResult,
  ControlMessage,
  DaemonMessage,
  RuntimeConfigureResultMessage,
  RuntimeContextReadResultMessage,
  RuntimeHistoryResultMessage,
  RuntimeLifecycleResultMessage,
  RuntimeSnapshotResultMessage,
  RuntimeStageAttachmentResultMessage,
  SessionContextReadInput,
  ShippingEvidenceResultMessage,
  ShippingJobRequestMessage,
  ShippingJobResult,
  ShippingRepairApplyResultMessage,
  StagedAttachmentRef,
  TurnDelivery,
  TurnReceipt,
} from '@podium/protocol/daemon'
import { contextReadFailure } from '@podium/protocol/daemon'
import { TRPCError } from '@trpc/server'
import { knownPathsFor } from '../../file-relay-policy'
import type { RpcDaemonFrame, RpcDaemonFrameType } from '../../gateway/daemon-frame-routing'
import { inferRepoFromRoots } from '../../repo-registry'
import { normalizeRepoPath } from '../../store/repos'
import {
  DaemonRequestBroker,
  type DaemonRequestKind,
  type DaemonRequestPort,
  daemonRequestKind,
} from '../daemon-request'
import type { LakeReadSession, MemoryService } from '../memory/service'
import type { MemoryReader } from '../memory/types'
import { DEPLOYMENT, perf } from '../perf/registry'
import type { PortableStateWriteFence } from '../server-transfer/portable-fence'
import { type HandoffStageToken, stageTokenAsFrozenWireField } from '../sessions/handoff-transfer'
import { sessionPostureFor } from '../sessions/session-posture'
import { mergeLatestTranscriptPage } from '../sessions/terminal'
import type { ServerPlacement } from '../updates/service'
import { isRefusedSend, REPO_ROOT_UNCHECKED } from './refused-send'

const SCAN_TIMEOUT_MS = 10_000
const FILE_RPC_TIMEOUT_MS = 10_000
/** The refusal for a root under no registered repository (the allowlist's words). */
const UNKNOWN_ROOT = 'root is not a known repository path'
// A browse is one readdir, but it may hit a cold/spun-down disk on a remote
// machine — generous enough to ride that out, short enough that the picker's
// spinner doesn't outlive the user's patience.
const BROWSE_TIMEOUT_MS = 20_000
// `createRepo` is four git invocations after the mkdir, and the first one on a
// cold machine pays for git's own start-up. Still well short of the clone budget.
const DIR_OP_INIT_TIMEOUT_MS = 60_000
/**
 * How long a `runtimeSendRequest` waits for its receipt.
 *
 * DERIVED FROM THE DRIVER'S OWN WINDOW, not chosen: the terminal driver waits
 * `VERIFICATION_WINDOW_MS` (4.8s) before answering `unverified`, so an RPC
 * deadline shorter than that would time out sends the driver was about to
 * report honestly — turning the one outcome that exists to avoid a guess back
 * into a guess. The margin covers the round trip.
 */
const RUNTIME_SEND_TIMEOUT_MS = 12_000
/** The other four verbs are local operations on the machine — a lease check, a
 *  keystroke, a state read — with no verification window to wait out. */
const RUNTIME_VERB_TIMEOUT_MS = 10_000

export interface ScanResult {
  conversations: ConversationDiscoveryWire[]
  diagnostics: ConversationDiagnosticWire[]
}

export interface ScanReposResult {
  repositories: GitRepositoryWire[]
  diagnostics: GitDiscoveryDiagnosticWire[]
}

/** Identity of the server-side reader requesting personal transcript content.
 * Authorization belongs at this boundary; the daemon and @podium/harness/store run
 * as system-side readers and never receive or interpret this value. */
export type TranscriptReader = MemoryReader

/** One machine's directory listing, or why it couldn't be read (POD-814). */
export interface BrowseDirsResult {
  listing?: DirectoryListingWire
  error?: string
}

/** Where the folder ended up, and/or why the op fell short (POD-1295). Both
 *  fields can be set: `createRepo` may create the folder and still fail to make
 *  it a repository. */
export interface DirOpResult {
  path?: string
  error?: string
}

/** Outcome of a daemon-executed operation (git op / harness one-shot). */
export interface OpResult {
  ok: boolean
  output: string
}

/** A transcript window slice as served to the chat view. */
export interface TranscriptSlice {
  /** The cursor source changed; replace the held window instead of appending. */
  reset?: boolean
  items: TranscriptItem[]
  head?: string
  tail?: string
  hasMore: boolean
  /** The session's machine has no live daemon socket, so this page is the best
   *  the server could do without it (POD-4808). Present whenever the machine is
   *  offline — even when the lake served mirrored history — so an empty page
   *  does not read as "done" and a live-looking session still names its machine.
   *  The name is resolved server-side from the machines table (the same presence
   *  source as requireOnlineSession), never matched from text. */
  offline?: { machineName: string }
}

/** The session fields the file/transcript RPCs resolve against. */
export interface RpcSessionView {
  id: SessionId
  cwd: string
  machineId: MachineId
  agentKind: AgentKind
  resume?: ResumeRef
  transcriptItems(): TranscriptItem[]
  runtimeTranscriptItems?(): TranscriptItem[]
  /** A bound live driver; parked rows and predecessor chains are archive reads. */
  driverId?: string
  status?: string
}

/** Prefix of the retired runtime-history cursor namespace (POD-4783). The
 *  encoder/decoder are gone; only this prefix check remains so a client
 *  holding an old cursor gets a clean first page instead of an error. */
const LEGACY_RUNTIME_HISTORY_PREFIX = 'runtime-history:'

function withRuntimeTranscriptItems(
  slice: TranscriptSlice,
  session: RpcSessionView,
  input: { anchor?: string; direction: 'before' | 'after'; limit: number },
): TranscriptSlice {
  // The cache is an overlay only on the unanchored latest page. Anchored paging
  // remains owned by the provider source and its cursor.
  if (input.anchor || input.direction !== 'before') return slice
  const runtimeItems = session.runtimeTranscriptItems?.() ?? []
  if (runtimeItems.length === 0) return slice
  const merged = mergeLatestTranscriptPage(slice.items, runtimeItems, input.limit)
  return {
    ...slice,
    items: merged.items,
    hasMore: slice.hasMore || merged.hasMore,
  }
}

interface DaemonRpcDeps {
  broker?: DaemonRequestPort
  memory: Pick<
    MemoryService,
    'canReadSession' | 'transcriptPathHint' | 'readTranscriptFromLake' | 'transcriptHasPredecessors'
  >
  toMachine(machineId: MachineId, msg: ControlMessage): void | Promise<void>
  /** Explicit deployment placement; absence refuses local-machine operations. */
  serverPlacement?: ServerPlacement
  defaultMachine(): MachineId | Promise<MachineId>
  resolveMachine(requested: string | undefined, cwd: string): string | Promise<string>
  daemonSupports?(machineId: MachineId, capability: string): boolean
  hasDaemon(machineId: MachineId): boolean
  daemonSupports?(machineId: MachineId, capability: string): boolean
  machineName(id: MachineId): string | Promise<string>
  /** {@link machineName} for many machines in one read; every asked id gets an entry. */
  machineNames(ids: readonly MachineId[]): Promise<ReadonlyMap<string, string>>
  onlineMachineIds(): MachineId[]
  getSession(sessionId: SessionId): Promise<RpcSessionView | undefined>
  portableStateFence?: PortableStateWriteFence
  /** The registered repository roots on a machine (POD-7501). A root-addressed file
   *  or repo-op request carries the one its root is under, for the daemon's
   *  realpath check; absent, every root-addressed request is refused. */
  repoPaths?(machineId: MachineId): Promise<string[]>
  /** The linked worktrees of the registered repositories on a machine, as its
   *  last scan found them (the `checkout` records, POD-6644). A repo op may name
   *  one that lives outside its repository, such as the sibling the assistant's
   *  `create_worktree` makes (POD-7505); the daemon then checks that git's data
   *  there is the repository's own. */
  worktreeCheckouts?(machineId: MachineId): Promise<ReadonlyArray<{ path: string; root: string }>>
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
const TRANSCRIPT_PATHS = daemonRequestKind<{ missingPaths: string[] }>('tp')
const BROWSE_DIRS = daemonRequestKind<BrowseDirsResult>('bd')
const DIR_OP = daemonRequestKind<DirOpResult>('dp')
const GITHUB_CLI = daemonRequestKind<Payload<GitHubCliResultMessage>>('gh')
const REPO_OP = daemonRequestKind<OpResult>('ro')
const HARNESS_EXEC = daemonRequestKind<OpResult>('hx')
const USAGE = daemonRequestKind<{
  hostname: string
  sampledAt?: string
  buckets: UsageBucketWire[]
  sources?: UsageSourceWire[]
}>('us')
const AGENT_QUOTA = daemonRequestKind<{ hostname: string; agents: AgentQuotaWire[] }>('aq')
const QUOTA_HISTORY = daemonRequestKind<{ samples: QuotaHistorySampleWire[] }>('qh')
const MODEL_PROBE = daemonRequestKind<Record<string, ModelChoiceWire[]>>('mp')
/**
 * Server-side LLM over a catalog Codex login (POD-4750). The daemon's own
 * HTTPS budget is 110 s; this broker deadline sits above it at 125 s, so a
 * slow model arrives as the daemon's clear timeout error — and a reply that
 * never comes (notably an older daemon that drops the unknown frame) lands on
 * the "no reply … may be older" message below, never on "offline".
 */
const CODEX_COMPLETE_TIMEOUT_MS = 125_000
const CODEX_COMPLETE = daemonRequestKind<Payload<CodexCompleteResultMessage>>('cc')
const DEV_ARTIFACT_PROBE = daemonRequestKind<Payload<DevArtifactProbeResultMessage>>('up')
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
/** Sign in with ChatGPT's loopback listener (credential management §11). */
const OAUTH_LOOPBACK = daemonRequestKind<Payload<OauthLoopbackResultMessage>>('ol')
const OAUTH_LOOPBACK_ACK_TIMEOUT_MS = 15_000
/** A callback is accepted this long past the listener's own time. */
const OAUTH_LOOPBACK_GRACE_MS = 30_000
// Harness homes (credential management §10) and the removal of a login file
// propagation copied (§8 cleanup), on a daemon that offered harness.homes.v1.
const HARNESS_INSTALL = daemonRequestKind<HarnessActionResult>('hi0')
const HARNESS_CHECK = daemonRequestKind<HarnessActionResult>('hi1')
const HARNESS_BACK = daemonRequestKind<HarnessActionResult>('hi2')
const HARNESS_PAUSE = daemonRequestKind<HarnessActionResult>('hi3')
const HARNESS_RESUME = daemonRequestKind<HarnessActionResult>('hi4')
const HARNESS_TAKESETTINGS = daemonRequestKind<HarnessActionResult>('hi5')
const HARNESS_REMOVECHANGES = daemonRequestKind<HarnessActionResult>('hi6')
const HARNESS_CHANGES = daemonRequestKind<HarnessActionResult>('hi7')
const HARNESS_REMOVE = daemonRequestKind<HarnessActionResult>('hi8')
const HARNESS_HOMEINFO = daemonRequestKind<HarnessActionResult>('hih')
const HARNESS_HOMEREMOVE = daemonRequestKind<HarnessActionResult>('hix')
const HARNESS_CANCELINSTALL = daemonRequestKind<HarnessActionResult>('hic')
const HOME_ENSURE = daemonRequestKind<Payload<HomeEnsureResultMessage>>('hn')
const HOME_REMOVE = daemonRequestKind<Payload<HomeRemoveResultMessage>>('hd')
const CREDENTIAL_REMOVE = daemonRequestKind<Payload<CredentialRemoveResultMessage>>('cx')
// A conversation placed for another credential's home (§9), on a daemon that
// offered conversation.prepare.v1.
const CONVERSATION_PREPARE = daemonRequestKind<Payload<ConversationPrepareResultMessage>>('cp')
// Uninstall Podium from a machine (managed installs §12 item 14), on a daemon
// that offered machine.uninstall.v1.
const MACHINE_UNINSTALL = daemonRequestKind<Payload<MachineUninstallResultMessage>>('mu')
const SERVER_TRANSFER = daemonRequestKind<Payload<ServerTransferResultMessage>>('st')
const SERVER_ENDPOINT = daemonRequestKind<Payload<ServerEndpointResultMessage>>('sm')
const SHIPPING_JOB = daemonRequestKind<ShippingJobResult>('sj')
const SHIPPING_EVIDENCE = daemonRequestKind<Payload<ShippingEvidenceResultMessage>>('se')
const SHIPPING_REPAIR_APPLY = daemonRequestKind<Payload<ShippingRepairApplyResultMessage>>('sr')
// AGENT RUNTIME CONTRACT (POD-1761 W3). Five correlated verbs against a flagged
// session's driver. They are ordinary RPC families because that is exactly what
// they are — nothing about the contract needed a new transport, which is the
// point of putting it in FRONT of the existing stack rather than beside it.
const RUNTIME_STAGE_ATTACHMENT =
  daemonRequestKind<Payload<RuntimeStageAttachmentResultMessage>>('rt')
const RUNTIME_SEND = daemonRequestKind<TurnReceipt>('rs')
const RUNTIME_LIFECYCLE = daemonRequestKind<Payload<RuntimeLifecycleResultMessage>>('rl')
const RUNTIME_ANSWER = daemonRequestKind<InteractionAnswerOutcome>('ra')
const log = createLogger('server:daemon-rpc')

/** The observation bootstrap (POD-2023). Its result is the union the frame
 *  carries — a snapshot, or the typed refusal for a session that is not behind
 *  the contract. The server no longer SENDS runtimeHistoryRequest (POD-4783:
 *  every family answers transcript.history from disk, so the live branch adds
 *  nothing); the kind and the runtimeHistoryResult settler below stay for one
 *  release so the fan-in remains total over the frames the gateway routes. */
const RUNTIME_HISTORY = daemonRequestKind<Payload<RuntimeHistoryResultMessage>>('rh')
const RUNTIME_SNAPSHOT = daemonRequestKind<Payload<RuntimeSnapshotResultMessage>>('rn')
const CONTEXT_READ = daemonRequestKind<Payload<RuntimeContextReadResultMessage>>('ctxr')
const RUNTIME_CONFIGURE = daemonRequestKind<Payload<RuntimeConfigureResultMessage>>('rc')

/** How ONE reply frame settles: pick the family, project the payload, hand both
 *  to the correlator along with the machine that answered. */
type ReplySettler<K extends SettledFrameType> = (
  broker: DaemonRequestPort,
  machineId: MachineId,
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
/** The loopback callback is not a reply: `settleDaemonReply` hands it to its listener. */
type SettledFrameType = Exclude<RpcDaemonFrameType, 'oauthLoopbackCallback'>

const RPC_REPLY_SETTLERS: { [K in SettledFrameType]: ReplySettler<K> } = {
  transcriptPathsResult: (broker, machineId, msg) =>
    void broker.settle(TRANSCRIPT_PATHS, msg.requestId, machineId, payloadOf(msg)),
  runtimeContextReadResult: (broker, machineId, msg) =>
    void broker.settle(CONTEXT_READ, msg.requestId, machineId, payloadOf(msg)),
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
  dirOpResult: (broker, machineId, msg) =>
    void broker.settle(DIR_OP, msg.requestId, machineId, {
      ...(msg.path === undefined ? {} : { path: msg.path }),
      ...(msg.error === undefined ? {} : { error: msg.error }),
    }),
  githubCliResult: (broker, machineId, msg) =>
    void broker.settle(GITHUB_CLI, msg.requestId, machineId, payloadOf(msg)),
  repoOpResult: (broker, machineId, msg) =>
    void broker.settle(REPO_OP, msg.requestId, machineId, { ok: msg.ok, output: msg.output }),
  harnessExecResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_EXEC, msg.requestId, machineId, { ok: msg.ok, output: msg.output }),
  usageResult: (broker, machineId, msg) =>
    void broker.settle(USAGE, msg.requestId, machineId, {
      hostname: msg.hostname,
      ...(msg.sampledAt === undefined ? {} : { sampledAt: msg.sampledAt }),
      buckets: msg.buckets,
      ...(msg.sources === undefined ? {} : { sources: msg.sources }),
    }),
  agentQuotaResult: (broker, machineId, msg) =>
    void broker.settle(AGENT_QUOTA, msg.requestId, machineId, {
      hostname: msg.hostname,
      agents: msg.agents,
    }),
  quotaHistoryResult: (broker, machineId, msg) =>
    void broker.settle(QUOTA_HISTORY, msg.requestId, machineId, { samples: msg.samples }),
  modelProbeResult: (broker, machineId, msg) =>
    void broker.settle(MODEL_PROBE, msg.requestId, machineId, msg.byAgent),
  codexCompleteResult: (broker, machineId, msg) =>
    void broker.settle(CODEX_COMPLETE, msg.requestId, machineId, payloadOf(msg)),
  devArtifactProbeResult: (broker, machineId, msg) =>
    void broker.settle(DEV_ARTIFACT_PROBE, msg.requestId, machineId, payloadOf(msg)),
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
  serverTransferResult: (broker, machineId, msg) =>
    void broker.settle(SERVER_TRANSFER, msg.requestId, machineId, payloadOf(msg)),
  serverEndpointResult: (broker, machineId, msg) =>
    void broker.settle(SERVER_ENDPOINT, msg.requestId, machineId, payloadOf(msg)),
  shippingJobResult: (broker, machineId, msg) =>
    void broker.settle(SHIPPING_JOB, msg.requestId, machineId, payloadOf(msg)),
  shippingEvidenceResult: (broker, machineId, msg) =>
    void broker.settle(SHIPPING_EVIDENCE, msg.requestId, machineId, payloadOf(msg)),
  shippingRepairApplyResult: (broker, machineId, msg) =>
    void broker.settle(SHIPPING_REPAIR_APPLY, msg.requestId, machineId, payloadOf(msg)),
  credentialInstallResult: (broker, machineId, msg) =>
    void broker.settle(CREDENTIAL_INSTALL, msg.requestId, machineId, payloadOf(msg)),
  oauthLoopbackResult: (broker, machineId, msg) =>
    void broker.settle(OAUTH_LOOPBACK, msg.requestId, machineId, payloadOf(msg)),
  harnessInstallResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_INSTALL, msg.requestId, machineId, payloadOf(msg)),
  harnessCheckResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_CHECK, msg.requestId, machineId, payloadOf(msg)),
  harnessBackResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_BACK, msg.requestId, machineId, payloadOf(msg)),
  harnessPauseResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_PAUSE, msg.requestId, machineId, payloadOf(msg)),
  harnessResumeResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_RESUME, msg.requestId, machineId, payloadOf(msg)),
  harnessTakeSettingsResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_TAKESETTINGS, msg.requestId, machineId, payloadOf(msg)),
  harnessRemoveChangesResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_REMOVECHANGES, msg.requestId, machineId, payloadOf(msg)),
  harnessChangesResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_CHANGES, msg.requestId, machineId, payloadOf(msg)),
  harnessRemoveResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_REMOVE, msg.requestId, machineId, payloadOf(msg)),
  harnessCancelInstallResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_CANCELINSTALL, msg.requestId, machineId, payloadOf(msg)),
  harnessHomeInfoResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_HOMEINFO, msg.requestId, machineId, payloadOf(msg)),
  harnessHomeRemoveResult: (broker, machineId, msg) =>
    void broker.settle(HARNESS_HOMEREMOVE, msg.requestId, machineId, payloadOf(msg)),
  homeEnsureResult: (broker, machineId, msg) =>
    void broker.settle(HOME_ENSURE, msg.requestId, machineId, payloadOf(msg)),
  homeRemoveResult: (broker, machineId, msg) =>
    void broker.settle(HOME_REMOVE, msg.requestId, machineId, payloadOf(msg)),
  credentialRemoveResult: (broker, machineId, msg) =>
    void broker.settle(CREDENTIAL_REMOVE, msg.requestId, machineId, payloadOf(msg)),
  conversationPrepareResult: (broker, machineId, msg) =>
    void broker.settle(CONVERSATION_PREPARE, msg.requestId, machineId, payloadOf(msg)),
  machineUninstallResult: (broker, machineId, msg) =>
    void broker.settle(MACHINE_UNINSTALL, msg.requestId, machineId, payloadOf(msg)),
  runtimeStageAttachmentResult: (broker, machineId, msg) =>
    void broker.settle(RUNTIME_STAGE_ATTACHMENT, msg.requestId, machineId, payloadOf(msg)),
  runtimeSendResult: (broker, machineId, msg) =>
    void broker.settle(RUNTIME_SEND, msg.requestId, machineId, msg.receipt),
  runtimeLifecycleResult: (broker, machineId, msg) =>
    void broker.settle(RUNTIME_LIFECYCLE, msg.requestId, machineId, payloadOf(msg)),
  runtimeAnswerResult: (broker, machineId, msg) =>
    void broker.settle(RUNTIME_ANSWER, msg.requestId, machineId, msg.outcome),
  runtimeHistoryResult: (broker, machineId, msg) =>
    void broker.settle(RUNTIME_HISTORY, msg.requestId, machineId, payloadOf(msg)),
  runtimeSnapshotResult: (broker, machineId, msg) =>
    void broker.settle(RUNTIME_SNAPSHOT, msg.requestId, machineId, payloadOf(msg)),
  runtimeConfigureResult: (broker, machineId, msg) =>
    void broker.settle(RUNTIME_CONFIGURE, msg.requestId, machineId, payloadOf(msg)),
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
  private readonly serverTransferDigests = new Map<string, string>()
  /** Open loopback listeners: who listens, and where its callback goes. Ten minutes at most. */
  private readonly loopbacks = new Map<
    string,
    { machineId: MachineId; onCallback: (callback: Payload<OauthLoopbackCallbackMessage>) => void }
  >()

  constructor(private readonly deps: DaemonRpcDeps) {
    this.broker =
      deps.broker ??
      new DaemonRequestBroker({ toMachine: deps.toMachine, defaultMachine: deps.defaultMachine })
  }

  /** Globally-unique requestId mint — shared with the headless module so its
   *  turn/bind ids can never collide with an RPC id. */
  /**
   * The machine an UNROUTED request lands on — the one `usage()` answered from.
   *
   * The cost fold needs it: a transcript path is only unique within a host, so
   * the segment lookup that turns a path into a session has to be scoped to the
   * daemon whose walk produced it (POD-1858).
   */
  async answeringMachineId(cwd?: string): Promise<MachineId> {
    // Repo operations historically select by checkout affinity. Resolve that
    // selection before authorization, then keep it through the eventual RPC.
    return cwd === undefined
      ? await this.deps.defaultMachine()
      : asMachineId(await this.deps.resolveMachine(undefined, cwd))
  }

  nextRequestId(prefix: string): string {
    return this.broker.nextRequestId(prefix)
  }

  /** One round-trip against a named family. A thin alias for the broker's own
   *  `request` — kept so every call below reads as one call, not two. */
  private async request<T>(
    kind: DaemonRequestKind<T>,
    timeoutMs: number,
    onTimeout: () => T,
    build: (requestId: string) => ControlMessage | Promise<ControlMessage>,
    machineId?: MachineId,
  ): Promise<T> {
    return await this.broker.request({ kind, timeoutMs, onTimeout, build, machineId })
  }

  // ---- requests ----

  canCheckTranscriptPaths(machineId: MachineId): boolean {
    return (
      this.deps.hasDaemon(machineId) &&
      this.deps.daemonSupports?.(machineId, CAP_TRANSCRIPT_PATHS) === true
    )
  }

  /** One metadata batch; uncertainty always credits a registry path as recorded. */
  async missingTranscriptPaths(machineId: MachineId, paths: string[]): Promise<string[]> {
    if (paths.length === 0 || !this.canCheckTranscriptPaths(machineId)) return []
    try {
      return (
        await this.request(
          TRANSCRIPT_PATHS,
          1_000,
          () => ({ missingPaths: [] }),
          (requestId) => ({ type: 'transcriptPathsRequest', requestId, paths }),
          machineId,
        )
      ).missingPaths
    } catch {
      // The daemon can disconnect between the online check and the send.
      return []
    }
  }

  /** The caller already authorized this exact session and negotiated read.v1. */
  async contextRead(
    input: SessionContextReadInput,
    machineId: MachineId,
    signal: AbortSignal,
  ): Promise<ContextReadResult> {
    const reply = await this.broker.request({
      kind: CONTEXT_READ,
      machineId,
      timeoutMs: input.read.timeoutMs,
      build: (requestId) => ({ type: 'runtimeContextReadRequest', requestId, ...input }),
      onTimeout: () => ({
        sessionId: input.sessionId,
        result: contextReadFailure(
          input.read,
          'unavailable',
          'timed-out',
          'Context read timed out',
        ),
      }),
      cancellation: {
        signal,
        onAbort: () => ({
          sessionId: input.sessionId,
          result: contextReadFailure(
            input.read,
            'cancelled',
            'cancelled',
            'Context read cancelled',
          ),
        }),
        cancel: (requestId) => {
          // Never queue a cancellation for a disconnected daemon.
          if (this.deps.hasDaemon(machineId))
            this.deps.toMachine(machineId, {
              type: 'runtimeContextReadCancel',
              requestId,
              sessionId: input.sessionId,
            })
        },
      },
    })
    return reply.sessionId === input.sessionId
      ? reply.result
      : contextReadFailure(
          input.read,
          'refused',
          'wrong-session',
          'Context answer names another session',
        )
  }

  async scan(): Promise<ScanResult> {
    return await this.request(
      SCAN,
      SCAN_TIMEOUT_MS,
      () => ({
        conversations: [],
        diagnostics: [{ severity: 'error', message: 'discovery scan timed out' }],
      }),
      (requestId) => ({ type: 'scanRequest', requestId }),
    )
  }

  async scanRepos(
    roots: string[],
    opts: { includeHome?: boolean; maxDepth?: number } = {},
    machineId?: MachineId,
  ): Promise<ScanReposResult> {
    return await this.request(
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

  /** One directory's sub-directories on `machineId`'s disk (POD-814)
   *  — the repo picker's browser. `path` omitted browses that machine's $HOME.
   *  A daemon-reported failure comes back in `error`, not as a rejection. */
  async browseDirs(
    path?: string,
    opts: { includeHidden?: boolean } = {},
    machineId?: MachineId,
  ): Promise<BrowseDirsResult> {
    return await this.request(
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

  /** Create / rename ONE folder on `machineId`'s disk (POD-1295) — the write
   *  counterpart to {@link browseDirs}. `name` is a single segment and the
   *  daemon does the joining; nothing here ever sends it a composed path.
   *  A refusal comes back in `error`, not as a rejection, exactly as a browse
   *  failure does. `createRepo` also runs `git init` and seeds a commit, which
   *  is why it gets the longer budget. */
  async dirOp(
    op: DirOp,
    machineId: MachineId,
    input: { parentPath: string; name: string; currentName?: string },
  ): Promise<DirOpResult> {
    return await this.request(
      DIR_OP,
      op === 'createRepo' ? DIR_OP_INIT_TIMEOUT_MS : BROWSE_TIMEOUT_MS,
      () => ({ error: 'directory operation timed out' }),
      (requestId) => ({
        type: 'dirOpRequest',
        requestId,
        op,
        parentPath: input.parentPath,
        name: input.name,
        ...(input.currentName === undefined ? {} : { currentName: input.currentName }),
      }),
      machineId,
    )
  }

  /** Live GitHub CLI readiness/list/clone on one machine. No credential is returned. */
  async githubCli(
    action: 'status' | 'list' | 'clone',
    machineId: MachineId,
    input: { repository?: string; destination?: string } = {},
  ): Promise<Payload<GitHubCliResultMessage>> {
    return await this.request(
      GITHUB_CLI,
      action === 'clone' ? 130_000 : 35_000,
      () => ({ status: { state: 'logged-out' }, error: 'GitHub CLI request timed out' }),
      (requestId) => ({
        type: 'githubCliRequest',
        requestId,
        action,
        ...(input.repository ? { repository: input.repository } : {}),
        ...(input.destination ? { destination: input.destination } : {}),
      }),
      machineId,
    )
  }

  /**
   * Token-usage buckets from the daemon's transcript harvest (empty on timeout).
   *
   * `withSources` also returns the per-FILE breakdown behind the buckets, which
   * is what per-task cost is folded from (POD-1858). Opt-in because it is an
   * order of magnitude larger than the buckets and has exactly one reader: the
   * cost fold on `usage.summary`, which strips it before the payload reaches a
   * client. The status chip's 90-second poll asks without it.
   */
  async usage(
    sinceMs?: number,
    withSources?: boolean,
    machineId?: MachineId,
  ): Promise<{
    hostname: string
    sampledAt?: string
    buckets: UsageBucketWire[]
    sources?: UsageSourceWire[]
    /** The window the `sources` folds cover — the daemon's memo, not `sinceMs`. */
    sourcesSinceMs?: number
  }> {
    return await this.request(
      USAGE,
      20_000,
      () => ({ hostname: '', buckets: [] }),
      (requestId) => ({
        type: 'usageRequest',
        requestId,
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        ...(withSources ? { withSources } : {}),
      }),
      machineId,
    )
  }

  /** Per-agent plan-quota (5h/weekly windows), read live read-only on one daemon
   *  host. Empty agents on timeout. Distinct from `usage` (token-cost analytics).
   *  `machineId` targets a specific machine; omitted → the default online machine. */
  async agentQuota(
    refresh?: boolean,
    machineId?: MachineId,
  ): Promise<{ hostname: string; agents: AgentQuotaWire[] }> {
    return await this.request(
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
   * Recover past quota windows from harness files on every online host (POD-1571).
   *
   * A generous timeout, and deliberately: this walks every Codex session rollout
   * on the machine — over a thousand files on a working box — where `agentQuota`
   * beside it makes three HTTP calls. Nothing waits on it; it seeds the ledger in
   * the background at boot, once.
   */
  async quotaHistoryAll(sinceMs: number): Promise<QuotaHistorySampleWire[]> {
    const machineIds = this.deps.onlineMachineIds()
    if (machineIds.length === 0) return []
    const perMachine = await Promise.all(
      machineIds.map(
        async (machineId) =>
          await this.request(
            QUOTA_HISTORY,
            120_000,
            () => ({ samples: [] }),
            (requestId) => ({ type: 'quotaHistoryRequest', requestId, sinceMs }),
            machineId,
          ),
      ),
    )
    return perMachine.flatMap((r) => r.samples)
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
  async modelProbe(machineId: MachineId): Promise<Record<string, ModelChoiceWire[]>> {
    return await this.request(
      MODEL_PROBE,
      20_000,
      () => ({}),
      (requestId) => ({ type: 'modelProbeRequest', requestId }),
      machineId,
    )
  }

  /**
   * ONE SERVER-SIDE LLM TURN ON A NAMED MACHINE'S CODEX LOGIN (POD-4750).
   *
   * The daemon performs the Responses call with its CLI-maintained token and
   * returns only the model's reply — the token never crosses this boundary.
   * A timeout is NOT "offline": the machine was picked because it IS online,
   * so a missing reply means its daemon never answered — most likely a daemon
   * older than this frame — and the message says exactly that.
   */
  async codexComplete(
    machineId: MachineId,
    input: {
      model: string
      messages: CodexLlmMessageWire[]
      tools: CodexLlmToolWire[]
      effort: 'low' | 'medium' | 'high'
    },
  ): Promise<Payload<CodexCompleteResultMessage>> {
    const name = await this.deps.machineName(machineId)
    return await this.request(
      CODEX_COMPLETE,
      CODEX_COMPLETE_TIMEOUT_MS,
      () => ({
        ok: false as const,
        error: `no reply from ${name}; its daemon may be older than this server — update Podium there, then retry.`,
      }),
      (requestId) => ({
        type: 'codexCompleteRequest',
        requestId,
        model: input.model,
        messages: input.messages,
        tools: input.tools,
        effort: input.effort,
      }),
      machineId,
    )
  }

  /**
   * Prove the exact authenticated development artifact route from one managed
   * machine. A timeout is a failed proof, never permission to publish.
   */
  async probeDevArtifact(
    url: string,
    machineId: MachineId,
  ): Promise<Payload<DevArtifactProbeResultMessage>> {
    return await this.request(
      DEV_ARTIFACT_PROBE,
      20_000,
      () => ({
        ok: false,
        detail: 'the machine did not answer the artifact reachability probe',
      }),
      (requestId) => ({
        type: 'devArtifactProbeRequest',
        requestId,
        url,
      }),
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
    const names = await this.deps.machineNames(machineIds)
    return await Promise.all(
      machineIds.map(async (machineId) => {
        const { hostname, agents } = await this.agentQuota(refresh, machineId)
        return { machineId, machineName: names.get(machineId) ?? machineId, hostname, agents }
      }),
    )
  }

  /**
   * {@link repoOp} IN A FOLDER A CALLER NAMED (POD-7503): the git panel, file
   * search and the superagent's tools. The folder must sit under a registered
   * repository, and the daemon resolves both and refuses a folder outside it, so
   * a symlink inside a repository cannot point git at another checkout. Server
   * records (issue worktrees, registered repositories, session folders) keep
   * {@link repoOp}: a worktree may live outside every registered repository.
   *
   * A folder under no registered repository may still be one of a repository's
   * linked worktrees on record (POD-7505): the request then names both, and the
   * daemon refuses unless the folder is in that worktree and git's data there is
   * the repository's.
   */
  async rootRepoOp(
    op: RepoOp,
    root: string,
    args?: Record<string, string>,
    machineId?: MachineId,
  ): Promise<OpResult> {
    return await this.rootRequest(
      {
        kind: REPO_OP,
        timeoutMs: 35_000,
        onTimeout: () => ({ ok: false, output: 'no daemon answered the git request in time' }),
        refuse: (error) => ({ ok: false, output: error }),
        root,
        machineId: asMachineId(machineId ?? (await this.deps.resolveMachine(undefined, root))),
        worktrees: true,
      },
      (requestId, repoRoot, worktreeRoot) => ({
        type: 'repoOpRequest',
        requestId,
        op,
        cwd: root,
        ...(args ? { args } : {}),
        repoRoot,
        ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
      }),
    )
  }

  /** Allowlisted git op on a dev machine, in a folder the server holds on record. */
  async repoOp(
    op: RepoOp,
    cwd: string,
    args?: Record<string, string>,
    machineId?: MachineId,
  ): Promise<OpResult> {
    return await this.request(
      REPO_OP,
      35_000,
      () => ({ ok: false, output: 'no daemon answered the git request in time' }),
      (requestId) => ({ type: 'repoOpRequest', requestId, op, cwd, ...(args ? { args } : {}) }),
      asMachineId(machineId ?? (await this.deps.resolveMachine(undefined, cwd))),
    )
  }

  /** Purpose-built shipping effect RPC. Its input is a fixed operation schema;
   * callers cannot smuggle argv or shell text through this boundary. */
  async shippingJob(
    input: Omit<ShippingJobRequestMessage, 'type' | 'requestId'>,
    machineId: MachineId,
  ): Promise<ShippingJobResult> {
    return await this.request(
      SHIPPING_JOB,
      40_000,
      () => ({
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        orderId: input.orderId,
        attemptId: input.attemptId,
        machineId,
        generation: input.generation,
        operation: input.operation,
        state: 'running',
        classification: 'observed',
        summary: 'shipping daemon did not answer before the RPC deadline',
        logs: [],
        artifactRefs: [],
        heartbeatedAt: new Date().toISOString(),
      }),
      (requestId) => ({ type: 'shippingJobRequest', requestId, ...input }),
      machineId,
    )
  }

  async shippingEvidence(
    authority: ShippingJobRequestMessage,
    artifactRef: string,
    maxBytes: number,
    machineId: MachineId,
  ): Promise<Payload<ShippingEvidenceResultMessage>> {
    return await this.request(
      SHIPPING_EVIDENCE,
      15_000,
      () => ({ artifactRef, ok: false, error: 'shipping evidence daemon did not answer' }),
      (requestId) => ({
        type: 'shippingEvidenceRequest',
        requestId,
        authority,
        artifactRef,
        maxBytes,
      }),
      machineId,
    )
  }

  async shippingRepairApply(
    input: {
      authority: ShippingJobRequestMessage
      contextDigest: string
      repairBaseSha: string
      repairRef: string
      patch: string
      touchedPaths: string[]
    },
    machineId: MachineId,
  ): Promise<Payload<ShippingRepairApplyResultMessage>> {
    return await this.request(
      SHIPPING_REPAIR_APPLY,
      40_000,
      () => ({
        ok: false,
        summary: 'shipping repair daemon did not answer',
        artifactRefs: [],
      }),
      (requestId) => ({ type: 'shippingRepairApplyRequest', requestId, ...input }),
      machineId,
    )
  }

  // ---- the Agent Runtime contract (POD-1761 W3) ----
  //
  // FOUR VERBS, NO POLICY. Everything these methods know is which frame to build
  // and how long to wait; whether a session is behind the contract at all is the
  // DAEMON's answer, and it comes back as a typed refusal rather than as a
  // question this side has to ask first. A caller that guessed would be a second
  // place the flag lived.

  /**
   * Deliver one turn through the contract and answer with its receipt.
   *
   * NOTE WHAT A TIMEOUT PRODUCES: `unverified`, not `refused`. The frame really
   * did go to a machine, so "the keystrokes may well have landed and nobody
   * proved it" is the true statement — which is precisely what that outcome
   * means. Reporting `refused` would tell a caller the session declined the
   * write, and a caller that believed it would send the same text twice.
   */
  async runtimeSend(
    input: {
      sessionId: SessionId
      rowId?: string
      deliveryRecovery?: boolean
      /** On a recovery: the program holds the row durably (POD-4886). */
      held?: 'durable'
      initialPrompt?: boolean
      turnId?: string
      text: string
      origin: ObservationInputOrigin
      delivery: TurnDelivery
      attachments?: readonly StagedAttachmentRef[]
      /** The turn's launch terms in Podium's words (POD-6858). */
      posture?: SessionPosture
      // LEGACY(remove-after: 2027-02): pre-posture daemons read this; removing it drops them
      allowedTools?: string[]
      // LEGACY(remove-after: 2027-02): pre-posture daemons read this; removing it drops them
      permissionMode?: string
      toolPolicy?: 'none'
      mcpConfig?: string
      resumeValue?: string
      sessionUuid?: string
      accountId?: string
      requestDigest?: string
      contextPrompt?: string
      systemPrompt?: string
      timeoutMs?: number
      model?: string
      effort?: string
      /** A headless turn's credential (POD-6733, credential management §8); never logged. */
      access?: AccessField
    },
    machineId: MachineId,
  ): Promise<TurnReceipt> {
    return await this.request(
      RUNTIME_SEND,
      RUNTIME_SEND_TIMEOUT_MS,
      () => ({
        outcome: 'unverified' as const,
        deliveredAs: input.delivery,
        verificationWindowMs: RUNTIME_SEND_TIMEOUT_MS,
        at: new Date().toISOString(),
      }),
      (requestId) => ({
        ...(input.rowId
          ? {
              type: 'runtimeDurableSendRequest' as const,
              rowId: input.rowId,
              deliveryRecovery: input.deliveryRecovery === true,
              initialPrompt: input.initialPrompt === true,
            }
          : { type: 'runtimeSendRequest' as const }),
        requestId,
        turnId: input.turnId ?? requestId,
        sessionId: input.sessionId,
        text: input.text,
        origin: input.origin,
        delivery: input.delivery,
        attachments: input.attachments ? [...input.attachments] : undefined,
        // LEGACY(remove-after: 2027-02): pre-posture daemons read these; removing it drops them
        ...(input.allowedTools ? { allowedTools: [...input.allowedTools] } : {}),
        // LEGACY(remove-after: 2027-02): pre-posture daemons read this; removing it drops them
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
        ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
        ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
        ...(input.sessionUuid ? { sessionUuid: input.sessionUuid } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.requestDigest ? { requestDigest: input.requestDigest } : {}),
        ...(input.contextPrompt ? { contextPrompt: input.contextPrompt } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.rowId && input.deliveryRecovery && input.held === 'durable'
          ? { held: 'durable' as const }
          : {}),
        ...(input.access ? { access: input.access } : {}),
        // Appended at the END, as the frame declares it (POD-6858).
        ...(input.posture ? { posture: input.posture } : {}),
      }),
      machineId,
    )
  }

  async runtimeStageAttachment(
    input: {
      sessionId: SessionId
      source: { bytes: Uint8Array; filename: string; mediaType: string; id?: string }
    },
    machineId: MachineId,
  ): Promise<Payload<RuntimeStageAttachmentResultMessage>> {
    return await this.request(
      RUNTIME_STAGE_ATTACHMENT,
      RUNTIME_VERB_TIMEOUT_MS,
      () => ({ sessionId: input.sessionId, result: { reason: 'not_running' as const } }),
      (requestId) => ({
        type: 'runtimeStageAttachmentRequest',
        requestId,
        sessionId: input.sessionId,
        source: {
          dataBase64: Buffer.from(input.source.bytes).toString('base64'),
          filename: input.source.filename,
          mediaType: input.source.mediaType,
          ...(input.source.id ? { id: input.source.id } : {}),
        },
      }),
      machineId,
    )
  }

  /** REQUEST a fence. The fence itself, if the provider confirms one, arrives on
   *  the causal stream as a terminal turn event — never as this reply. */
  async runtimeInterrupt(
    sessionId: SessionId,
    machineId: MachineId,
    cancelRowId?: string,
    /** The turn the stop is for (POD-6397); the daemon answers `turn_ended`. */
    turn?: string,
  ): Promise<Payload<RuntimeLifecycleResultMessage>> {
    return await this.request(
      RUNTIME_LIFECYCLE,
      RUNTIME_VERB_TIMEOUT_MS,
      () => ({ sessionId, result: { reason: 'not_running' as const } }),
      (requestId) => ({
        type: 'runtimeInterruptRequest',
        requestId,
        sessionId,
        cancelRowId,
        ...(turn !== undefined ? { turn } : {}),
      }),
      machineId,
    )
  }

  /**
   * THE OBSERVATION BOOTSTRAP, ACROSS THE WIRE (POD-2023).
   *
   * Coarse `runtimeEvent` frames are `control.entity`: the daemon fsync-retains
   * them until the server commits and returns a terminal receipt. This snapshot
   * RPC is an explicit current-state read for control-plane callers, not the
   * recovery mechanism for the durable event stream or its board projector.
   *
   * A TIMEOUT IS `not_running`, and that is the honest default rather than a
   * convenient one: what a caller learns is "I could not obtain a bootstrap",
   * and the only safe reading of that is that this machine is not driving the
   * session. Manufacturing an empty snapshot would hand a consumer a cursor that
   * silently discards everything before it.
   */
  async runtimeSnapshot(
    sessionId: SessionId,
    machineId: MachineId,
  ): Promise<Payload<RuntimeSnapshotResultMessage>> {
    return await this.request(
      RUNTIME_SNAPSHOT,
      RUNTIME_VERB_TIMEOUT_MS,
      () => ({ sessionId, result: { reason: 'not_running' as const } }),
      (requestId) => ({ type: 'runtimeSnapshotRequest', requestId, sessionId }),
      machineId,
    )
  }

  async runtimeAnswer(
    input: {
      sessionId: SessionId
      interactionId: string
      principal?: { kind: 'user' | 'agent' | 'system'; ref: string }
      answer: Record<string, unknown>
    },
    machineId: MachineId,
  ): Promise<InteractionAnswerOutcome> {
    return await this.request(
      RUNTIME_ANSWER,
      RUNTIME_VERB_TIMEOUT_MS,
      // A timeout is not "already answered" and not "expired": the ask may still
      // be open and unanswered, which is exactly `unknown-interaction` from this
      // side's point of view — we do not know that it is there.
      () => ({ ok: false as const, reason: 'unknown-interaction' as const }),
      (requestId) => ({
        type: 'runtimeAnswerRequest',
        requestId,
        sessionId: input.sessionId,
        interactionId: input.interactionId,
        principal: input.principal,
        answer: input.answer,
      }),
      machineId,
    )
  }

  /**
   * CHANGE A RUNNING SESSION'S STICKY MODEL / EFFORT (POD-3081).
   *
   * A TIMEOUT IS `not_running`, matching every runtime verb above it, and here
   * the choice carries a little more weight than usual: this reply is what the
   * server writes the session's REQUESTED model from. Defaulting a lost reply to
   * anything optimistic would record a change the machine may never have made,
   * and the requested-vs-observed split would then be showing a requested value
   * that was never requested of anything.
   */
  async runtimeConfigure(
    input: { sessionId: SessionId; model?: string; effort?: string; permissionMode?: string },
    machineId: MachineId,
  ): Promise<Payload<RuntimeConfigureResultMessage>> {
    return await this.request(
      RUNTIME_CONFIGURE,
      RUNTIME_VERB_TIMEOUT_MS,
      () => ({ sessionId: input.sessionId, result: { reason: 'not_running' as const } }),
      (requestId) => ({
        type: 'runtimeConfigureRequest',
        requestId,
        sessionId: input.sessionId,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      }),
      machineId,
    )
  }

  async runtimeLifecycle(
    input: { sessionId: SessionId; verb: 'stop' | 'hibernate' | 'kill' },
    machineId: MachineId,
  ): Promise<Payload<RuntimeLifecycleResultMessage>> {
    return await this.request(
      RUNTIME_LIFECYCLE,
      RUNTIME_VERB_TIMEOUT_MS,
      () => ({ sessionId: input.sessionId, result: { reason: 'not_running' as const } }),
      (requestId) => ({
        type: 'runtimeLifecycleRequest',
        requestId,
        sessionId: input.sessionId,
        verb: input.verb,
      }),
      machineId,
    )
  }

  /** Read only allowlisted native auth files from one authenticated daemon. */
  async credentialExport(
    kinds: PortableCredentialKind[],
    machineId: MachineId,
    options?: { propagation?: boolean; expectedFingerprint?: string },
  ): Promise<Omit<CredentialExportResultMessage, 'type' | 'requestId'>> {
    return await this.request(
      CREDENTIAL_EXPORT,
      15_000,
      () => ({ bundles: [], unavailable: kinds }),
      (requestId) => ({
        type: 'credentialExportRequest',
        requestId,
        kinds,
        ...(options?.propagation ? { propagation: true } : {}),
        ...(options?.expectedFingerprint
          ? { expectedFingerprint: options.expectedFingerprint }
          : {}),
      }),
      machineId,
    )
  }

  /**
   * Ask one daemon to listen on `127.0.0.1:<port>` for a ChatGPT sign-in's
   * callback (credential management §11). Answers whether it listens; the
   * callback, if the browser returns there, goes to `onCallback` once, and only
   * when the machine that listens sends it.
   */
  async oauthLoopbackListen(
    machineId: MachineId,
    i: { port: number; state: string; ttlMs: number },
    onCallback: (callback: Payload<OauthLoopbackCallbackMessage>) => void,
  ): Promise<{ listening: boolean; error?: string; listenerId?: string }> {
    let requestId: string | undefined
    const answer = await this.request(
      OAUTH_LOOPBACK,
      OAUTH_LOOPBACK_ACK_TIMEOUT_MS,
      () => ({
        listening: false,
        error: 'This machine did not answer. Its Podium may be too old to listen for a sign-in.',
      }),
      (id) => {
        requestId = id
        this.loopbacks.set(id, { machineId, onCallback })
        setTimeout(() => this.loopbacks.delete(id), i.ttlMs + OAUTH_LOOPBACK_GRACE_MS).unref?.()
        return {
          type: 'oauthLoopbackRequest',
          requestId: id,
          port: i.port,
          path: '/auth/callback',
          state: i.state,
          ttlMs: i.ttlMs,
        }
      },
      machineId,
    )
    if (!answer.listening && requestId) this.loopbacks.delete(requestId)
    return answer.listening && requestId ? { ...answer, listenerId: requestId } : answer
  }

  /** Close a listener the server no longer needs; a no-op once it has closed. */
  oauthLoopbackCancel(machineId: MachineId, listenerId: string): void {
    if (!this.loopbacks.delete(listenerId)) return
    try {
      this.deps.toMachine(machineId, { type: 'oauthLoopbackCancel', requestId: listenerId })
    } catch (err) {
      log.warn('could not cancel a sign-in listener', { err, machineId })
    }
  }

  private onLoopbackCallback(machineId: MachineId, msg: OauthLoopbackCallbackMessage): void {
    const listener = this.loopbacks.get(msg.requestId)
    if (!listener || listener.machineId !== machineId) {
      log.warn('dropped a sign-in callback no listener of this machine expects', {
        requestId: msg.requestId,
        machineId,
      })
      return
    }
    this.loopbacks.delete(msg.requestId)
    listener.onCallback(payloadOf(msg))
  }

  /** Atomically install allowlisted auth files on one authenticated daemon. */
  async credentialInstall(
    bundles: PortableCredentialBundle[],
    machineId: MachineId,
    options?: { propagation?: boolean; expectedFingerprint?: string },
  ): Promise<Omit<CredentialInstallResultMessage, 'type' | 'requestId'>> {
    return await this.request(
      CREDENTIAL_INSTALL,
      15_000,
      () => ({ installed: [], failed: bundles.map((bundle) => bundle.kind) }),
      (requestId) => ({
        type: 'credentialInstallRequest',
        requestId,
        bundles,
        ...(options?.propagation ? { propagation: true } : {}),
        ...(options?.expectedFingerprint
          ? { expectedFingerprint: options.expectedFingerprint }
          : {}),
      }),
      machineId,
    )
  }

  /** Capability-gated machine action. The daemon owns every install/version decision. */
  async harnessAction(
    action: HarnessInstallAction,
    harness: BuiltinHarnessKind,
    machineId: MachineId,
    confirmedConversations?: string[],
  ): Promise<HarnessActionResult> {
    if (!this.deps.daemonSupports?.(machineId, CAP_HARNESS_INSTALLS))
      return { ok: false, error: 'Update Podium on this machine to manage harness installs.' }
    switch (action) {
      case 'home-info':
        return await this.request(
          HARNESS_HOMEINFO,
          120000,
          () => ({ ok: false, error: 'The machine did not answer.' }),
          (requestId) => ({ type: 'harnessHomeInfoRequest', requestId, harness }),
          machineId,
        )
      case 'remove-home':
        if (!confirmedConversations)
          return {
            ok: false,
            error: 'Inspect the home and confirm its conversations before deleting it.',
          }
        return await this.request(
          HARNESS_HOMEREMOVE,
          120000,
          () => ({ ok: false, error: 'The machine did not answer.' }),
          (requestId) => ({
            type: 'harnessHomeRemoveRequest',
            requestId,
            harness,
            confirmedConversations,
          }),
          machineId,
        )

      case 'install':
        return await this.request(
          HARNESS_INSTALL,
          1800000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessInstallRequest', requestId, harness }),
          machineId,
        )
      case 'check':
        return await this.request(
          HARNESS_CHECK,
          1800000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessCheckRequest', requestId, harness }),
          machineId,
        )
      case 'back':
        return await this.request(
          HARNESS_BACK,
          120000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessBackRequest', requestId, harness }),
          machineId,
        )
      case 'pause':
        return await this.request(
          HARNESS_PAUSE,
          120000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessPauseRequest', requestId, harness }),
          machineId,
        )
      case 'resume':
        return await this.request(
          HARNESS_RESUME,
          120000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessResumeRequest', requestId, harness }),
          machineId,
        )
      case 'take-settings':
        return await this.request(
          HARNESS_TAKESETTINGS,
          120000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessTakeSettingsRequest', requestId, harness }),
          machineId,
        )
      case 'remove-changes':
        return await this.request(
          HARNESS_REMOVECHANGES,
          120000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessRemoveChangesRequest', requestId, harness }),
          machineId,
        )
      case 'changes':
        return await this.request(
          HARNESS_CHANGES,
          120000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessChangesRequest', requestId, harness }),
          machineId,
        )
      case 'remove':
        return await this.request(
          HARNESS_REMOVE,
          120000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessRemoveRequest', requestId, harness }),
          machineId,
        )
      case 'cancel-install':
        if (!this.deps.daemonSupports?.(machineId, CAP_HARNESS_INSTALL_CANCEL))
          return {
            ok: false,
            error: 'Update Podium on this machine to cancel a harness install.',
          }
        // The daemon answers once the install has stopped and cleaned up.
        return await this.request(
          HARNESS_CANCELINSTALL,
          120000,
          () => ({
            ok: false,
            error: 'The machine did not answer in time. Check its harness state before retrying.',
          }),
          (requestId) => ({ type: 'harnessCancelInstallRequest', requestId, harness }),
          machineId,
        )
    }
  }

  /** Make sure the home for a credential and harness exists on one daemon. */
  async homeEnsure(
    credentialId: string,
    harness: HomeHarness,
    machineId: MachineId,
  ): Promise<Payload<HomeEnsureResultMessage>> {
    return await this.request(
      HOME_ENSURE,
      15_000,
      () => ({ ok: false, error: 'The machine did not answer in time.' }),
      (requestId) => ({ type: 'homeEnsureRequest', requestId, credentialId, harness }),
      machineId,
    )
  }

  /**
   * Remove a home on one daemon. Generous: the daemon first stops the
   * sessions in it and Codex's own daemon there, and the directory can hold
   * Codex's 400 MB installed copy.
   */
  async homeRemove(
    homeId: string,
    machineId: MachineId,
    options: { signOut?: boolean } = {},
  ): Promise<Payload<HomeRemoveResultMessage>> {
    return await this.request(
      HOME_REMOVE,
      120_000,
      () => ({ ok: false, error: 'The machine did not answer in time.' }),
      (requestId) => ({
        type: 'homeRemoveRequest',
        requestId,
        homeId,
        ...(options.signOut ? { signOut: true } : {}),
      }),
      machineId,
    )
  }

  /** Remove the login file propagation copied, while its fingerprint matches. */
  async credentialRemove(
    harness: HomeHarness,
    fingerprint: string,
    machineId: MachineId,
  ): Promise<Payload<CredentialRemoveResultMessage>> {
    return await this.request(
      CREDENTIAL_REMOVE,
      15_000,
      () => ({ outcome: 'failed', error: 'The machine did not answer in time.' }),
      (requestId) => ({ type: 'credentialRemoveRequest', requestId, harness, fingerprint }),
      machineId,
    )
  }

  /**
   * Put a session's conversation where a resume in `toHomeId` finds it
   * (credential management §9). Generous: a Codex rollout can be large.
   */
  async conversationPrepare(
    input: Omit<ConversationPrepareRequestMessage, 'type' | 'requestId'>,
    machineId: MachineId,
  ): Promise<Payload<ConversationPrepareResultMessage>> {
    return await this.request(
      CONVERSATION_PREPARE,
      60_000,
      () => ({ ok: false, error: 'The machine did not answer in time.' }),
      (requestId) => ({ type: 'conversationPrepareRequest', requestId, ...input }),
      machineId,
    )
  }

  /**
   * Ask a daemon to uninstall Podium from its machine. Generous: the daemon
   * undoes every recorded home edit before it answers.
   */
  async machineUninstall(
    machineId: MachineId,
    options: { force?: boolean } = {},
  ): Promise<Payload<MachineUninstallResultMessage>> {
    return await this.request(
      MACHINE_UNINSTALL,
      60_000,
      () => ({ ok: false, error: 'The machine did not answer in time.' }),
      (requestId) => ({
        type: 'machineUninstallRequest',
        requestId,
        ...(options.force ? { force: true } : {}),
      }),
      machineId,
    )
  }

  async handoffExport(
    input: {
      sessionId: SessionId
      cwd: string
      fallbackCwd?: string
      agentKind: (typeof HANDOFF_HARNESS_KINDS)[number]
      resume: { kind: string; value: string }
      branch: string
      baseShas: string[]
      repoId: RepoId
      title?: string
      issueId?: IssueId
      sourceMachineId: MachineId
      binding: HandoffBindingExportInstruction
    },
    machineId: MachineId,
  ): Promise<Omit<HandoffExportResultMessage, 'type' | 'requestId'>> {
    return await this.request(
      HANDOFF_EXPORT,
      120_000,
      () => ({ ok: false, error: 'handoff export timed out' }),
      (requestId) => ({ type: 'handoffExportRequest', requestId, ...input }),
      machineId,
    )
  }

  async handoffReadChunk(
    stagePath: string,
    offset: number,
    length: number,
    machineId: MachineId,
  ): Promise<Omit<HandoffChunkReadResultMessage, 'type' | 'requestId'>> {
    return await this.request(
      HANDOFF_READ,
      30_000,
      () => ({ ok: false, error: 'handoff read timed out' }),
      (requestId) => ({ type: 'handoffChunkReadRequest', requestId, stagePath, offset, length }),
      machineId,
    )
  }

  /**
   * A STAGE TOKEN, and the boundary where saying otherwise used to be free
   * (POD-1171). This leg names the target daemon's stage `.tgz`; on two of the
   * three transfer paths the value has never been a session id. Declaring it
   * `SessionId` here still satisfied `HandoffTransferRpc` because method
   * parameters are bivariant, so nothing caught the mismatch — the union is now
   * stated where the value actually enters the wire.
   *
   * The wire field STAYS `sessionId`: the bytes are a compatibility surface with
   * every deployed daemon, and this issue renames in-repo only.
   */
  async handoffWriteChunk(
    stageToken: HandoffStageToken,
    offset: number,
    data: Buffer,
    machineId: MachineId,
  ): Promise<Omit<HandoffImportChunkResultMessage, 'type' | 'requestId'>> {
    return await this.request(
      HANDOFF_WRITE,
      30_000,
      () => ({ ok: false, error: 'handoff write timed out' }),
      (requestId) => ({
        type: 'handoffImportChunk',
        requestId,
        sessionId: stageTokenAsFrozenWireField(stageToken),
        offset,
        data: data.toString('base64'),
      }),
      machineId,
    )
  }

  async handoffImport(
    sessionId: SessionId,
    repoPath: string,
    worktreeName: string,
    machineId: MachineId,
    occupiedWorktreePaths: string[] = [],
    binding?: HandoffBindingImportInstruction,
  ): Promise<Omit<HandoffImportResultMessage, 'type' | 'requestId'>> {
    return await this.request(
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

  async handoffBindingFinalize(
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
  ): Promise<Omit<HandoffBindingFinalizeResultMessage, 'type' | 'requestId'>> {
    return await this.request(
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
  async workspaceExport(
    input: {
      fetchId: string
      cwd: string
      baseShas: string[]
      repoId: RepoId
      sourceMachineId: MachineId
    },
    machineId: MachineId,
  ): Promise<Omit<WorkspaceExportResultMessage, 'type' | 'requestId'>> {
    return await this.request(
      WORKSPACE_EXPORT,
      120_000,
      () => ({ ok: false, error: 'workspace export timed out' }),
      (requestId) => ({ type: 'workspaceExportRequest', requestId, ...input }),
      machineId,
    )
  }

  /** Materialize a transferred snapshot as a detached peek worktree [POD-658]. */
  async workspaceImport(
    fetchId: string,
    repoPath: string,
    machineId: MachineId,
  ): Promise<Omit<WorkspaceImportResultMessage, 'type' | 'requestId'>> {
    return await this.request(
      WORKSPACE_IMPORT,
      120_000,
      () => ({ ok: false, error: 'workspace import timed out' }),
      (requestId) => ({ type: 'workspaceImportRequest', requestId, fetchId, repoPath }),
      machineId,
    )
  }

  /** Remove every peek worktree under a repo [POD-658]. */
  async workspaceClean(
    repoPath: string,
    machineId: MachineId,
  ): Promise<Omit<WorkspaceCleanResultMessage, 'type' | 'requestId'>> {
    return await this.request(
      WORKSPACE_CLEAN,
      60_000,
      () => ({ ok: false, error: 'workspace clean timed out' }),
      (requestId) => ({ type: 'workspaceCleanRequest', requestId, repoPath }),
      machineId,
    )
  }

  /** One-shot `claude -p` / `codex exec` / `grok -p` on a dev machine. */
  async harnessExec(input: {
    agent: HarnessAgent
    model?: string
    effort?: string
    prompt: string
    cwd?: string
    systemPrompt?: string
    mcpConfig?: string
    /** The run's launch terms (POD-6858). Absent: the default posture. */
    posture?: SessionPosture
    /** The old Claude-worded allow list, for a daemon that predates posture. */
    // LEGACY(remove-after: 2027-02): pre-posture daemons read this; removing it drops them
    allowedTools?: string[]
    /** Kill budget for the CLI run, ms (daemon default 240s). The server-side
     *  wait adds 10s slack over it so the daemon's own timeout reports first. */
    timeoutMs?: number
  }): Promise<OpResult> {
    return await this.request(
      HARNESS_EXEC,
      (input.timeoutMs ?? 240_000) + 10_000,
      () => ({ ok: false, output: 'harness run timed out' }),
      (requestId) => ({
        type: 'harnessExecRequest',
        requestId,
        agent: input.agent,
        prompt: input.prompt,
        ...(input.model && input.model !== 'auto' ? { model: input.model } : {}),
        ...(input.effort && input.effort !== 'auto' ? { effort: input.effort } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
        // LEGACY(remove-after: 2027-02): pre-posture daemons read this; removing it drops them
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        posture: input.posture ?? sessionPostureFor({}),
      }),
    )
  }

  /**
   * Route an image upload to the owning daemon. The daemon writes the decoded
   * base64 bytes to ~/.podium/uploads/<sessionId>/<id>.<ext> and returns the
   * absolute path. Resolves with that path so the caller can insert it into a
   * prompt — Claude Code reads images by path.
   */
  async uploadImage(input: {
    sessionId: SessionId
    filename: string
    mimeType: string
    dataBase64: string
    /** Fallback target for a session that does not exist yet (POD-1203) — the
     *  home composer attaches before its session is spawned. Ignored whenever
     *  the session names a machine of its own. */
    machineId?: MachineId
  }): Promise<{ path: string; error?: string }> {
    // The upload is written to (and read back by) the machine that runs the session,
    // so the returned path is valid in that session's prompt.
    const session = await this.deps.getSession(input.sessionId)
    const write = async () =>
      await this.request(
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
        session?.machineId ?? input.machineId,
      )
    return this.deps.portableStateFence
      ? await this.deps.portableStateFence.runWriter(write)
      : await write()
  }

  /** The recorded segment path for a session's conversation, shaped for message
   *  spreads (`{pathHint}` or undefined). Lookup only — never derives. */
  async transcriptPathHint(
    reader: TranscriptReader,
    session: {
      id: SessionId
      machineId: MachineId
      resume?: { value: string }
    },
  ): Promise<{ pathHint: string } | undefined> {
    const nativeId = session.resume?.value
    if (!nativeId) return undefined
    const path = (await this.deps.memory.transcriptPathHint(reader, session))?.pathHint
    return path ? { pathHint: path } : undefined
  }

  /** Shared authorized read for chat, toolkit, answers and recaps. One Store
   *  read path (POD-4783): the daemon's transcriptRead when connected and the
   *  session has no predecessor chain, the memory lake otherwise. */
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
    if (!(await this.deps.memory.canReadSession(reader, input.sessionId))) {
      recordTotal()
      return { items: [], hasMore: false }
    }
    const session = await this.deps.getSession(input.sessionId)
    if (!session) {
      recordTotal()
      return { items: [], hasMore: false }
    }
    const hasPredecessors = await this.deps.memory.transcriptHasPredecessors(session)
    // Presence is the offline signal (POD-4808): the same daemon-socket state
    // requireOnlineSession refuses on. Resolved here so every return below can
    // say whether this page is the best an offline machine could do, rather
    // than letting an empty page read as "done".
    const hasDaemon = this.deps.hasDaemon(session.machineId)
    const offlineName = hasDaemon ? undefined : await this.deps.machineName(session.machineId)
    const withOffline = (slice: TranscriptSlice): TranscriptSlice =>
      offlineName ? { ...slice, offline: { machineName: offlineName } } : slice
    // Retired runtime-history cursors have no Store interpretation. A client
    // holding one gets a clean first page (latest window + reset) rather than
    // an error or a silently appended foreign source.
    let sourceReset = false
    if (input.anchor?.startsWith(LEGACY_RUNTIME_HISTORY_PREFIX)) {
      input = { sessionId: input.sessionId, direction: 'before', limit: input.limit }
      sourceReset = true
    }
    const archivePage = (page: TranscriptSlice): TranscriptSlice => {
      const projected = withRuntimeTranscriptItems(page, session, input)
      return sourceReset ? { ...projected, reset: true } : projected
    }
    // Leg timing [POD-701]: transcriptRead.daemon / transcriptRead.lake record
    // the leg that actually served the response. Payload bytes aren't cheaply
    // available (summing item JSON lengths would cost a full pass), so a second
    // record carries the item count in the ms slot instead: transcriptRead.items.
    // The `.wait` phases also record an attempted leg when it returns an empty
    // page and the other source wins; otherwise a daemon timeout/empty answer
    // vanishes from attribution and the client gap cannot be closed.
    let fromLake: TranscriptSlice | undefined
    let lakeMs = 0
    let lakeAttempted = false
    const readLake = async (): Promise<TranscriptSlice | undefined> => {
      lakeAttempted = true
      const tLake0 = performance.now()
      try {
        return await this.deps.memory.readTranscriptFromLake(session, input)
      } finally {
        lakeMs = performance.now() - tLake0
        perf.record('phase', 'transcriptRead.lake.wait', lakeMs, DEPLOYMENT)
      }
    }
    // A daemon can resolve only the provider's CURRENT file. Once the lake has
    // an immutable predecessor, it is the only source that can answer an opaque
    // cursor across the complete chain, so consult it first even while the
    // machine is online. Fall back to the daemon if preserved files are missing.
    if (hasPredecessors) {
      fromLake = await readLake()
      if (fromLake) {
        perf.record('phase', 'transcriptRead.lake', lakeMs, DEPLOYMENT)
        perf.record('phase', 'transcriptRead.items', fromLake.items.length, DEPLOYMENT)
        recordTotal()
        return withOffline(archivePage(fromLake))
      }
    }
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
          async (requestId) => ({
            type: 'transcriptRead',
            requestId,
            sessionId: input.sessionId,
            agentKind: session.agentKind,
            cwd: session.cwd,
            ...(session.resume ? { resume: session.resume } : {}),
            // Segment evidence beats cwd derivation: the recorded absolute path (from
            // discovery scans) survives worktree moves; the daemon still falls back to
            // derivation + sweep when absent/stale (conversation registry §3.3).
            ...((await this.transcriptPathHint(reader, session)) ?? {}),
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
      return archivePage(fromDaemon)
    }
    // Empty/timeout daemon answer (or no daemon): serve from the mirrored copy.
    if (!lakeAttempted) fromLake = await readLake()
    if (fromLake) {
      perf.record('phase', 'transcriptRead.lake', lakeMs, DEPLOYMENT)
      perf.record('phase', 'transcriptRead.items', fromLake.items.length, DEPLOYMENT)
    }
    recordTotal()
    const fallback = fromLake ?? fromDaemon ?? { items: [], hasMore: false }
    const projected = withOffline(archivePage(fallback))
    if (projected !== fallback) {
      perf.record('phase', 'transcriptRead.items', projected.items.length, DEPLOYMENT)
    }
    return projected
  }

  /**
   * A REQUEST ADDRESSED BY A CALLER'S ROOT (POD-7501, POD-7503): a file read,
   * write or listing, or a repo op whose folder came from a caller. The callers'
   * allowlists match the root as text; the daemon is the one that can see a
   * symlinked root, so the frame names the registered repository the root
   * matched and the daemon checks both realpaths.
   *
   * Refused here, as `refuse(reason)`, before any daemon is asked: a root under
   * no registered repository, and a connected daemon that predates the check
   * (it would drop `repoRoot` unseen and follow the link). The machines service
   * judges the frame again at the send, so a daemon that changed in between, or
   * none at all, refuses it there rather than parking it.
   */
  private async rootRequest<T>(
    spec: {
      kind: DaemonRequestKind<T>
      timeoutMs: number
      onTimeout: () => T
      refuse: (error: string) => T
      root: string
      machineId: MachineId
      /** Also match the repositories' linked worktrees on record. Repo ops only:
       *  only the daemon's git check can tell a worktree's data is the repo's. */
      worktrees?: boolean
    },
    build: (requestId: string, repoRoot: string, worktreeRoot?: string) => ControlMessage,
  ): Promise<T> {
    const { machineId } = spec
    const roots = (await this.deps.repoPaths?.(machineId)) ?? []
    let repoRoot = inferRepoFromRoots(roots, spec.root)
    let worktreeRoot: string | undefined
    if (repoRoot === undefined && spec.worktrees) {
      const worktree = await this.worktreeOnRecord(machineId, roots, spec.root)
      repoRoot = worktree?.root
      worktreeRoot = worktree?.path
    }
    if (repoRoot === undefined) return spec.refuse(UNKNOWN_ROOT)
    if (
      this.deps.hasDaemon(machineId) &&
      this.deps.daemonSupports?.(machineId, CAP_REPO_ROOT_CHECK) !== true
    )
      return spec.refuse(REPO_ROOT_UNCHECKED)
    try {
      return await this.request(
        spec.kind,
        spec.timeoutMs,
        spec.onTimeout,
        (requestId) => build(requestId, repoRoot, worktreeRoot),
        machineId,
      )
    } catch (error) {
      if (isRefusedSend(error)) return spec.refuse(error.message)
      throw error
    }
  }

  /** The innermost linked worktree on record that holds `root`, with the
   *  registered repository it belongs to; undefined when that repository is no
   *  longer registered on the machine. */
  private async worktreeOnRecord(
    machineId: MachineId,
    registered: readonly string[],
    root: string,
  ): Promise<{ path: string; root: string } | undefined> {
    const worktrees = (await this.deps.worktreeCheckouts?.(machineId)) ?? []
    const path = inferRepoFromRoots(
      worktrees.map((w) => w.path),
      root,
    )
    if (path === undefined) return undefined
    const worktree = worktrees.find((w) => machinePathsEqual(normalizeRepoPath(w.path), path))
    const repo =
      worktree &&
      registered.find((r) =>
        machinePathsEqual(normalizeRepoPath(r), normalizeRepoPath(worktree.root)),
      )
    return repo !== undefined && worktree ? { path, root: repo } : undefined
  }

  /** The machine a root-addressed file request goes to, named or the default. */
  private async fileMachine(machineId: MachineId | undefined): Promise<MachineId> {
    return machineId ?? asMachineId(await this.deps.defaultMachine())
  }

  async listDir(input: {
    machineId?: MachineId
    root: string
    path?: string
  }): Promise<Omit<DirListResultMessage, 'type' | 'requestId'>> {
    const path = input.path ?? input.root
    return await this.rootRequest(
      {
        kind: DIR_LIST,
        timeoutMs: FILE_RPC_TIMEOUT_MS,
        onTimeout: () => ({ ok: false, path, entries: [], error: 'timeout' }),
        refuse: (error) => ({ ok: false, path, entries: [], error }),
        root: input.root,
        machineId: await this.fileMachine(input.machineId),
      },
      (requestId, repoRoot) => ({
        type: 'dirListRequest',
        requestId,
        root: input.root,
        path,
        repoRoot,
      }),
    )
  }

  async readFile(
    input:
      | { sessionId: SessionId; path: string }
      | { machineId?: MachineId; root: string; path: string },
  ): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> {
    if ('sessionId' in input) {
      const session = await this.deps.getSession(input.sessionId)
      if (!session)
        return await Promise.resolve({ ok: false, path: input.path, error: 'no session' })
      const knownPath = knownPathsFor(session.transcriptItems()).has(input.path)
      return await this.request(
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
    return await this.rootRequest(
      {
        kind: FILE_READ,
        timeoutMs: FILE_RPC_TIMEOUT_MS,
        onTimeout: () => ({ ok: false, path: input.path, error: 'timeout' }),
        refuse: (error) => ({ ok: false, path: input.path, error }),
        root: input.root,
        machineId: await this.fileMachine(input.machineId),
      },
      (requestId, repoRoot) => ({
        type: 'fileReadRequest',
        requestId,
        cwd: input.root,
        path: input.path,
        knownPath: false,
        repoRoot,
      }),
    )
  }

  async readAsset(
    input:
      | { sessionId: SessionId; path: string; offset?: number; length?: number }
      | {
          machineId?: MachineId
          root: string
          path: string
          /** Ranged pull — artifact snapshotting reads large files in chunks. */
          offset?: number
          length?: number
        },
  ): Promise<Omit<FileAssetResultMessage, 'type' | 'requestId'>> {
    if ('sessionId' in input) {
      const session = await this.deps.getSession(input.sessionId)
      if (!session)
        return await Promise.resolve({ ok: false, path: input.path, error: 'no session' })
      const knownPath = knownPathsFor(session.transcriptItems()).has(input.path)
      return await this.request(
        FILE_ASSET,
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, path: input.path, error: 'timeout' }),
        (requestId) => ({
          type: 'fileAssetRequest',
          requestId,
          cwd: session.cwd,
          path: input.path,
          knownPath,
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
          ...(input.length !== undefined ? { length: input.length } : {}),
        }),
        session.machineId, // the asset lives in the session's cwd on its machine
      )
    }
    // Worktree-scoped variant (issue panel artifacts, worktree md images): same
    // daemon sandbox as fileReadRequest — cwd = the worktree root. Artifact paths
    // may be worktree-relative; the daemon realpaths them, so absolutize here.
    const absPath = resolveMachinePath(input.root, input.path)
    return await this.rootRequest(
      {
        kind: FILE_ASSET,
        timeoutMs: FILE_RPC_TIMEOUT_MS,
        onTimeout: () => ({ ok: false, path: input.path, error: 'timeout' }),
        refuse: (error) => ({ ok: false, path: input.path, error }),
        root: input.root,
        machineId: await this.fileMachine(input.machineId),
      },
      (requestId, repoRoot) => ({
        type: 'fileAssetRequest',
        requestId,
        cwd: input.root,
        path: absPath,
        knownPath: false,
        repoRoot,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.length !== undefined ? { length: input.length } : {}),
      }),
    )
  }

  async writeFile(
    input:
      | { sessionId: SessionId; path: string; content: string; baseHash?: string }
      | { machineId?: MachineId; root: string; path: string; content: string; baseHash?: string },
  ): Promise<Omit<FileWriteResultMessage, 'type' | 'requestId'>> {
    const build = (requestId: string, cwd: string, repoRoot?: string) => ({
      type: 'fileWriteRequest' as const,
      requestId,
      cwd,
      path: input.path,
      content: input.content,
      ...(input.baseHash ? { baseHash: input.baseHash } : {}),
      ...(repoRoot !== undefined ? { repoRoot } : {}),
    })
    if ('sessionId' in input) {
      const session = await this.deps.getSession(input.sessionId)
      if (!session) return await Promise.resolve({ ok: false, error: 'no session' })
      return await this.request(
        FILE_WRITE,
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, error: 'timeout' }),
        (requestId) => build(requestId, session.cwd),
        session.machineId,
      )
    }
    if (writesIntoGitDir(input.root, input.path)) return { ok: false, error: GIT_DIR_WRITE }
    return await this.rootRequest(
      {
        kind: FILE_WRITE,
        timeoutMs: FILE_RPC_TIMEOUT_MS,
        onTimeout: () => ({ ok: false, error: 'timeout' }),
        refuse: (error) => ({ ok: false, error }),
        root: input.root,
        machineId: await this.fileMachine(input.machineId),
      },
      (requestId, repoRoot) => build(requestId, input.root, repoRoot),
    )
  }

  serverEndpointProbe(
    input: {
      transferId: string
      manifestDigest: string
      publicUrl: string
      reachabilityToken: string
      targetMachineId: MachineId
    },
    machineId: MachineId,
  ): Promise<Payload<ServerEndpointResultMessage>> {
    return this.request(
      SERVER_ENDPOINT,
      20_000,
      () => ({
        transferId: input.transferId,
        operation: 'probe',
        ok: false,
        error: 'target endpoint probe timed out',
      }),
      (requestId) => ({ type: 'serverEndpointProbeRequest', requestId, ...input }),
      machineId,
    )
  }

  serverEndpointCommit(
    input: { transferId: string; publicUrl: string; targetMachineId: MachineId },
    machineId: MachineId,
  ): Promise<Payload<ServerEndpointResultMessage>> {
    return this.request(
      SERVER_ENDPOINT,
      20_000,
      () => ({
        transferId: input.transferId,
        operation: 'commit',
        ok: false,
        error: 'endpoint commit timed out',
      }),
      (requestId) => ({ type: 'serverEndpointCommitRequest', requestId, ...input }),
      machineId,
    )
  }

  serverEndpointResume(
    transferId: string,
    machineId: MachineId,
  ): Promise<Payload<ServerEndpointResultMessage>> {
    return this.request(
      SERVER_ENDPOINT,
      10_000,
      () => ({ transferId, operation: 'resume', ok: false, error: 'endpoint resume timed out' }),
      (requestId) => ({ type: 'serverEndpointResumeRequest', requestId, transferId }),
      machineId,
    )
  }

  /** Stage a portable server snapshot on a named target daemon. */
  async serverTransferPrepare(
    input:
      | {
          transferId: string
          manifest: ServerTransferManifest
          manifestDigest: string
          publicUrl: string
          bindHost: ServerBindHost
          port: number
          reachabilityToken: string
        }
      | {
          transferId: string
          sourceMachineId?: MachineId
          manifest: ServerTransferManifestEntry[]
          manifestDigest: string
          totalBytes: number
        },
    machineId: MachineId,
  ): Promise<Payload<ServerTransferResultMessage>> {
    if (!('publicUrl' in input) || Array.isArray(input.manifest))
      return await Promise.resolve({
        transferId: input.transferId,
        operation: 'prepare',
        ok: false,
        state: 'aborted',
        error: 'full identity-bound transfer manifest is required',
        errorCode: 'invalid-request',
      })
    const manifest = input.manifest as ServerTransferManifest
    const placement = this.deps.serverPlacement
    if (placement?.kind !== 'fleet')
      return {
        transferId: input.transferId,
        operation: 'prepare',
        ok: false,
        state: 'aborted',
        error: 'server is external or its placement is unavailable; no source machine for transfer',
        errorCode: 'identity-mismatch',
      }
    const sourceMachineId = placement.machineId
    if (
      manifest.transferId !== input.transferId ||
      manifest.sourceMachineId !== sourceMachineId ||
      manifest.targetMachineId !== machineId ||
      manifest.sourceMachineId === manifest.targetMachineId
    )
      return await Promise.resolve({
        transferId: input.transferId,
        operation: 'prepare',
        ok: false,
        state: 'aborted',
        error: 'transfer/source/target manifest binding does not match RPC routing',
        errorCode: 'identity-mismatch',
      })
    this.serverTransferDigests.set(machineId + ':' + input.transferId, input.manifestDigest)
    return await this.request(
      SERVER_TRANSFER,
      120_000,
      () => ({
        transferId: input.transferId,
        operation: 'prepare',
        ok: false,
        state: 'aborted',
        error: 'target prepare timed out',
        errorCode: 'timeout',
      }),
      (requestId) => ({
        type: 'serverTransferPrepareRequest',
        requestId,
        transferId: input.transferId,
        manifest,
        manifestDigest: input.manifestDigest,
        publicUrl: input.publicUrl,
        bindHost: input.bindHost,
        port: input.port,
        reachabilityToken: input.reachabilityToken,
      }),
      machineId,
    )
  }

  /** Split source reads into bounded, contiguous, retry-safe wire chunks. */
  async serverTransferChunk(
    input: {
      transferId: string
      path: string
      offset: number
      data: Buffer
      manifestDigest?: string
    },
    machineId: MachineId,
  ): Promise<Payload<ServerTransferResultMessage>> {
    const manifestDigest =
      input.manifestDigest ?? this.serverTransferDigests.get(machineId + ':' + input.transferId)
    if (!manifestDigest)
      return {
        transferId: input.transferId,
        operation: 'chunk',
        ok: false,
        state: 'staging',
        error: 'transfer manifest digest is unavailable',
        errorCode: 'invalid-request',
      }
    let response: Payload<ServerTransferResultMessage> | undefined
    for (let start = 0; start < input.data.length; start += SERVER_TRANSFER_MAX_CHUNK_BYTES) {
      const data = input.data.subarray(start, start + SERVER_TRANSFER_MAX_CHUNK_BYTES)
      response = await this.request(
        SERVER_TRANSFER,
        30_000,
        () => ({
          transferId: input.transferId,
          operation: 'chunk',
          ok: false,
          state: 'staging',
          error: 'target chunk timed out',
          errorCode: 'timeout',
        }),
        (requestId) => ({
          type: 'serverTransferChunkRequest',
          requestId,
          transferId: input.transferId,
          manifestDigest,
          path: input.path,
          offset: input.offset + start,
          data: data.toString('base64'),
          expectedLength: data.length,
        }),
        machineId,
      )
      if (!response.ok) return response
    }
    return (
      response ?? {
        transferId: input.transferId,
        operation: 'chunk',
        ok: false,
        state: 'staging',
        error: 'empty transfer chunk',
        errorCode: 'invalid-request',
      }
    )
  }

  /** Ask the target to hash every staged file before the source is fenced. */
  async serverTransferValidate(
    transferId: string,
    manifestDigest: string,
    machineId: MachineId,
  ): Promise<Payload<ServerTransferResultMessage>> {
    this.serverTransferDigests.set(machineId + ':' + transferId, manifestDigest)
    return await this.request(
      SERVER_TRANSFER,
      120_000,
      () => ({
        transferId,
        operation: 'validate',
        ok: false,
        state: 'staging',
        error: 'target validation timed out',
        errorCode: 'timeout',
      }),
      (requestId) => ({
        type: 'serverTransferValidateRequest',
        requestId,
        transferId,
        manifestDigest,
      }),
      machineId,
    )
  }

  /** Promote a validated target and switch its persisted mode to server. */
  async serverTransferPromote(
    transferId: string,
    manifestDigest: string,
    publicUrl: string,
    bindHost: ServerBindHost,
    machineId: MachineId,
    port: number,
    // SECRET when it holds a key: the request is built here and sent, never logged or kept.
    vault: { vaultDataKey?: string | null; vaultCheck?: string } = {},
  ): Promise<Payload<ServerTransferResultMessage>> {
    this.serverTransferDigests.set(machineId + ':' + transferId, manifestDigest)
    return await this.request(
      SERVER_TRANSFER,
      120_000,
      () => ({
        transferId,
        operation: 'promote',
        ok: false,
        state: 'uncertain',
        error: 'target promotion timed out; inspect the target before retrying',
        errorCode: 'uncertain-commit',
      }),
      (requestId) => ({
        type: 'serverTransferPromoteRequest',
        requestId,
        transferId,
        manifestDigest,
        publicUrl,
        bindHost,
        port,
        targetMode: 'server',
        idempotencyKey: transferId,
        ...vault,
      }),
      machineId,
    )
  }

  /** Remove a target stage. A promoted transfer is deliberately not abortable. */
  async serverTransferAbort(
    transferId: string,
    reason: string | undefined,
    machineId: MachineId,
  ): Promise<Payload<ServerTransferResultMessage>> {
    const manifestDigest = this.serverTransferDigests.get(machineId + ':' + transferId)
    if (!manifestDigest)
      return await Promise.resolve({
        transferId,
        operation: 'abort',
        ok: false,
        state: 'aborted',
        error: 'transfer manifest digest is unavailable',
        errorCode: 'invalid-request',
      })

    return await this.request(
      SERVER_TRANSFER,
      30_000,
      () => ({
        transferId,
        operation: 'abort',
        ok: false,
        state: 'aborted',
        error: 'target abort timed out',
        errorCode: 'timeout',
      }),
      (requestId) => ({
        type: 'serverTransferAbortRequest',
        requestId,
        transferId,
        ...(reason ? { reason } : {}),
        manifestDigest,
      }),
      machineId,
    )
  }

  /** Acknowledge durable promoted proof so the retained target daemon may retire. */
  async serverTransferAcknowledge(
    transferId: string,
    manifestDigest: string,
    machineId: MachineId,
  ): Promise<Payload<ServerTransferResultMessage>> {
    this.serverTransferDigests.set(machineId + ':' + transferId, manifestDigest)
    return await this.request(
      SERVER_TRANSFER,
      10_000,
      () => ({
        transferId,
        operation: 'acknowledge',
        manifestDigest,
        ok: false,
        state: 'promoted',
        errorCode: 'timeout',
        error: 'target acknowledgement timed out after serving proof was durable',
      }),
      (requestId) => ({
        type: 'serverTransferAcknowledgeRequest',
        requestId,
        transferId,
        manifestDigest,
      }),
      machineId,
    )
  }

  /** Read target-side recovery state through the same authenticated machine broker. */
  async inspectServerTransfer(
    transferId: string | undefined,
    machineId: MachineId,
    manifestDigest?: string,
  ): Promise<Payload<ServerTransferResultMessage>> {
    return await this.request(
      SERVER_TRANSFER,
      10_000,
      () => ({
        ...(transferId ? { transferId } : {}),
        operation: 'status',
        ...(manifestDigest ? { manifestDigest } : {}),
        ok: false,
        state: 'idle',
        errorCode: 'timeout',
        error: 'target status timed out',
      }),
      (requestId) => ({
        type: 'serverTransferInspectRequest',
        requestId,
        ...(transferId ? { transferId } : {}),
        ...(manifestDigest ? { manifestDigest } : {}),
      }),
      machineId,
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
  settleDaemonReply(machineId: MachineId, msg: RpcDaemonFrame): void {
    if (msg.type === 'oauthLoopbackCallback') {
      this.onLoopbackCallback(machineId, msg)
      return
    }
    const settle = RPC_REPLY_SETTLERS[msg.type] as ReplySettler<SettledFrameType>
    settle(this.broker, machineId, msg)
  }
}

/** What a root-addressed save into a `.git` folder answers, here and on the daemon. */
const GIT_DIR_WRITE = 'refusing to write inside .git'

/**
 * A ROOT-ADDRESSED SAVE INTO A `.git` FOLDER (POD-7505), judged on the text.
 *
 * Git takes instructions from there: `.git/config` (`core.fsmonitor` runs a
 * program on the next `git status`, `core.worktree` moves the working tree),
 * `.git/hooks`, and a `.git` file in a subfolder points git at another
 * repository. A save from the app has no business there. The daemon judges the
 * resolved path again (a symlink can hide the segment from this text); this
 * refusal only keeps the request from leaving. Compared as Windows compares
 * names: case-insensitively, cut at an NTFS stream suffix, without trailing
 * dots and spaces, and with the 8.3 short name `GIT~1` on a Windows root.
 */
export function writesIntoGitDir(root: string, path: string): boolean {
  // Every segment, the root's too: a root may itself name `<repo>/.git`. No
  // repository is registered under a folder named `.git`.
  const windows = machinePathSeparator(root) === '\\'
  return machinePathSegments(resolveMachinePath(root, path), root).some((segment) => {
    // A Windows name ends at its first `:` (an NTFS stream: `.git::$DATA` is
    // `.git`, as git's `is_ntfs_dotgit` reads it).
    const cut = windows ? (segment.split(':')[0] ?? '') : segment
    const name = cut.toLowerCase().replace(/[. ]+$/u, '')
    return name === '.git' || (windows && /^git~\d+$/u.test(name))
  })
}
