import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BlobStore } from '@podium/blob-store'
import { LocalBlobStorage } from '@podium/blob-store/local'
import { type HumanCeiling, workflowAssignInput } from '@podium/commands'
import { ISSUE_SYSTEM_POINTER } from '@podium/harness/metadata'
import type { OneTimeCodeOperations } from '@podium/identity'
import type {
  AgentKind,
  Attribution,
  EffectTarget,
  IssueId,
  IssuePanelArtifactWire,
  MachineId,
  MessageHeld,
  NotInConversationCause,
  SessionId,
  SessionMeta,
  UpdateChannel,
  UserId,
} from '@podium/model'
import {
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asIssueId,
  asMachineId,
  asMutationId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
  formatAgentError,
  machinePathsEqual,
  mintDeviceId,
  spawnedByParentSessionId,
} from '@podium/model'
import type {
  LocalPortableStateControl,
  ServerMessage,
  UpdateKeyRotation,
  VisibilityResolver,
  WriteReceipt,
} from '@podium/protocol'
import {
  CAP_CHECKOUT_CHANGED_V1,
  CAP_MACHINE_PROCESSES_V1,
  CAP_TOPICS_V1,
  formatIssueRef,
  type HostMemoryBreakdown,
  parseCheckoutTopicId,
  platformTargetFor,
  SERVER_MOVE_CAPABILITY,
  SERVER_MOVE_VAULT_KEY_CAPABILITY,
  SubscriptionRegistry,
  wireSchemaDigest,
} from '@podium/protocol'
import type {
  MessageFailedCause,
  QueueDrainAbandonedReason,
  RuntimeAttachmentRef,
} from '@podium/protocol/daemon'
import { resolveSpawnDefaults } from '@podium/runtime'
import { durableSessionLabel } from '@podium/runtime/instance'
import { stateDir } from '@podium/runtime/local-machine'
import { prepareSourceDaemonCutover } from '@podium/runtime/transfer-lifecycle'
import {
  CHANGE_LOG_OBSERVER,
  FeedIdentityRegistry,
  GrantEdgeVisibilityPolicy,
  kernelVisibilityResolver,
  Ledger,
  type LedgerWriter,
  MutationLedger,
  NoDelegationsGranted,
  type WriteScope,
} from '@podium/sync'
import { FEED_RESCOPE_THRESHOLD } from '@podium/sync/bootstrap-worker'
import { IssueAttachOrchestrator } from './application/issue-attach-orchestrator'
import { bootStage } from './boot-timing'
import { serverBuildVersion } from './build-version'
import { capabilityPrincipalResolver } from './capability-principal'
import { clientRelocations } from './client-relocation'
import { codexAuthorizerFor } from './codex-machine'
import {
  attributionOf,
  type CommandPrincipal,
  onBehalfOfUser,
  resolvePrincipalAsync,
  systemPrincipal,
  userCommandPrincipal,
} from './command-principal'
import { LifecyclePort } from './composition/lifecycle-port'
import { composeReactions, REACTIONS, type ReactionDefinition } from './composition/reactions'
import { getFeatureStates, isFeatureEnabled, serverFeatureFacts } from './features'
import { makeFeedVisibility } from './feed-visibility'
import { ClientMux } from './gateway/client-mux'
import { ClientRegistry } from './gateway/client-registry'
import { DaemonLinks } from './gateway/daemon-link-kind'
import { DaemonMux } from './gateway/daemon-mux'
import { FeedServing } from './gateway/feed-serving'
import { MobileClientVersions } from './gateway/mobile-client-versions'
import { PresenceRouting } from './gateway/presence-routing'
import { createDaemonTopicIngress } from './gateway/topic-ingress'
import { daemonTopicProducer, type TopicProducers, TopicRouting } from './gateway/topic-routing'
import { driverFamilyForId } from './harness-manifest'
import type { MemberCredentials } from './identity/member-credentials'
import { checkIssueAccess, mayReachPrivate } from './issue-authz'
import {
  checkMachineUse,
  checkMachineVerb,
  machineCustodian,
  ownershipSnapshotFromMachines,
} from './machine-access'
import type { ModelProbe } from './model-catalog'
import { resolveLaunchSelection } from './model-validation'
import { AgentProfileService } from './modules/agent-profiles/service'
import { ApprovalService } from './modules/approvals/service'
import { automationPromptSender } from './modules/automations/prompt'
import { AutomationScheduler } from './modules/automations/scheduler'
import { AutomationsService } from './modules/automations/service'
import { EventBus, type EventMap } from './modules/bus'
import { CheckoutsService } from './modules/checkouts/service'
import { CONCERTMASTER_RULES } from './modules/concertmaster/briefing'
import { DeliveredMessageWatch } from './modules/concertmaster/delivered'
import { makeConcertmasterFeedCapture } from './modules/concertmaster/records'
import { ConcertmasterService } from './modules/concertmaster/service'
import { CostService } from './modules/cost/service'
import type { AttachAccessDeps } from './modules/credentials/attach-access'
import {
  type ChatgptPlanService,
  composeChatgptPlan,
} from './modules/credentials/chatgpt-plan/service'
import {
  PlanSessionRenewal,
  realTimer,
  SESSION_TOKEN_MIN_LEFT_MS,
} from './modules/credentials/chatgpt-plan/session-renewal'
import { recordFoundLogins } from './modules/credentials/found-logins'
import {
  CREDENTIAL_EXPIRY_SWEEP_MS,
  CREDENTIAL_TURN_BOUNDARY,
  type FetchLike as CredentialFetch,
  CredentialHealth,
  classifyCredentialFailure,
} from './modules/credentials/health'
import { placementRemovers } from './modules/credentials/home-removers'
import { NativeLoginService } from './modules/credentials/native-login'
import { Placements } from './modules/credentials/placements'
import { HomeSignInService } from './modules/credentials/sign-in'
import { DaemonRequestBroker } from './modules/daemon-request'
import { awaitEffectSettled } from './modules/effects/await'
import { makeEffectFeedCapture } from './modules/effects/feed'
import { EffectExecutorRegistry } from './modules/effects/registry'
import { EffectsRunner } from './modules/effects/runner'
import { registerEffectCommands } from './modules/effects/sync-write'
import { EventLogRetention } from './modules/events/retention'
import { type FileStorageJobName, fileStorageJobs } from './modules/files/file-jobs'
import { ORPHAN_AUDIT_EVERY_MS, OrphanAudit } from './modules/files/orphan-audit'
import { registerFileWriteEffect } from './modules/files/write-effect'
import { registerDiscoveryEffects } from './modules/fleet/discovery-effects'
import { registerFolderEffects } from './modules/fleet/folder-effects'
import { registerServerMoveEffect } from './modules/fleet/server-move-effect'
import { registerMachineUninstallEffect } from './modules/fleet/uninstall-effect'
import { registerMachineUpdateEffect } from './modules/fleet/update-effect'
import { WriteFunnel } from './modules/funnel'
import { HIBERNATION_HOLDER, HibernationMetricsDemand } from './modules/hosts/metrics-demand'
import { MachineProcessesTopic } from './modules/hosts/processes-topic'
import { HOST_COMMANDS_TRPC, type HostState, memoryBreakdownRoots } from './modules/hosts/registry'
import { HostsService, type MemoryBreakdown } from './modules/hosts/service'
import { complete, type OnMachineTransport } from './modules/inference/complete'
import { registerSessionAnswerEffect } from './modules/interactions/answer-effect'
import { InteractionFeedPublisher } from './modules/interactions/feed'
import { deliverToNativeMenu } from './modules/interactions/native-menu-delivery'
import { InteractionService } from './modules/interactions/service'
import { interactionFingerprint } from './modules/interactions/synthesis'
import { IssueSessionLifecycle } from './modules/issue-session-lifecycle'
import { DurableIssueAccessIndex } from './modules/issues/access-index'
import {
  issueArtifactEffectPort,
  registerIssueArtifactEffects,
} from './modules/issues/artifact-effects'
import { IssueArtifactStore } from './modules/issues/artifact-store'
import { IssueAuthorityArbitration } from './modules/issues/authority-arbitration'
import { IssueAutoArchive } from './modules/issues/auto-archive'
import { IssueCommandDispatcher } from './modules/issues/dispatcher'
import { issueGitEffectPort, registerIssueGitEffects } from './modules/issues/git-effects'
import { IssueGitWatch } from './modules/issues/git-watch'
import { readIssue, readIssues } from './modules/issues/issue-reader'
import { PENDING_UPLOAD_SWEEP_MS, PendingUploadStore } from './modules/issues/pending-uploads'
import { type ReassignmentFacts, reassignmentNotices } from './modules/issues/reassign-notice'
import { makeAgentRelayDispatch } from './modules/issues/relay-dispatch'
import { AgentRelayGate } from './modules/issues/relay-gate'
import { IssueService } from './modules/issues/service'
import { seatText } from './modules/issues/service/seat'
import { registerIssueStartEffect } from './modules/issues/start-effect'
import {
  finishSelfStop,
  issueWorkEffectPort,
  registerIssueWorkEffects,
} from './modules/issues/work-effects'
import { LayoutService } from './modules/layout/service'
import { LockCommandDispatcher } from './modules/lock/registry'
import { LockService } from './modules/lock/service'
import { FleetLogLevelDirector } from './modules/logs/fleet-director'
import { FleetLogStore } from './modules/logs/fleet-store'
import { ClientLogLevelDirector } from './modules/logs/level-director'
import { LogIngestService } from './modules/logs/service'
import { MachineConditionTopic } from './modules/machines/condition-topic'
import { routeMachineDiagnostic } from './modules/machines/diagnostics'
import { LoginPropagationService } from './modules/machines/login-propagation'
import { type MachineRecordsDeps, makeMachineRecordCompare } from './modules/machines/records'
import { DaemonRpcService } from './modules/machines/rpc'
import { MachinesService, type PairingCodes } from './modules/machines/service'
import type { TranscriptLakeStorage } from './modules/memory/lake'
import { MemoryService } from './modules/memory/service'
import { MessageFeedPublisher } from './modules/message-feed/feed'
import { readMessageRecords } from './modules/message-feed/records'
import { MessageGate } from './modules/messages/gate'
import { principalMailPolicy } from './modules/messages/handlers/context'
import { QueuedMessageApply } from './modules/messages/queued-apply'
import { DELIVERY_RETRY_BACKSTOP_MS } from './modules/messages/scheduler'
import { MessageDeliveryService } from './modules/messages/service'
import { makeSpawnOnWake } from './modules/messages/spawn'
import type { MessageWriter } from './modules/messages/writer'
import {
  bindNoticeService,
  emitNotice,
  NoticeService,
  resolveNotices,
} from './modules/notices/emit'
import { CommentMentions } from './modules/notices/mentions'
import { makeNoticeFeedCapture } from './modules/notices/records'
import {
  DEFAULT_NOTIFICATION_PUSHERS,
  type NotificationPushers,
  NotifyService,
  type SessionNoticeInfo,
} from './modules/notify/service'
import { createOperations, type OperationsModule } from './modules/operations'
import { LIFECYCLE_EXCLUSION_GROUP } from './modules/operations/lifecycle'
import { DEPLOYMENT, type PerfRegistry, perf } from './modules/perf/registry'
import { QuotaBackfill } from './modules/quota-history/backfill'
import { AccountQuotaTopic, AccountUsageTopic } from './modules/quota-history/quota-topic'
import { QuotaSampler } from './modules/quota-history/service'
import { ReadPositionService } from './modules/read-position/service'
import { registerRecordCommands } from './modules/records/register'
import {
  restartSourceAfterRecovery,
  retireSourceAfterTransfer,
} from './modules/server-transfer/lifecycle'
import { serverMoveOperationKind } from './modules/server-transfer/operation'
import { PortableStateFence } from './modules/server-transfer/portable-fence'
import { serverTransferRpcAdapter } from './modules/server-transfer/rpc-adapter'
import type { ServerTransferTargetState } from './modules/server-transfer/service'
import { ServerTransferService } from './modules/server-transfer/service'
import { sourceTransferFence } from './modules/server-transfer/source-fence'
import { readPromotedTargetMetadata } from './modules/server-transfer/target-status'
import { QUEUED_INPUT_SWEEP_MS, SYSTEM_INBOX_PRINCIPAL } from './modules/sessions/inbox'
import { SessionInstructionRegistry } from './modules/sessions/instructions'
import { SessionLifecycle } from './modules/sessions/lifecycle'
import { SessionLifecycleController } from './modules/sessions/lifecycle-controller'
import type { SessionLiveKind, SessionLiveTopics } from './modules/sessions/live-topics'
import { SessionReadToolkit } from './modules/sessions/read-toolkit'
import { readSessionRefs } from './modules/sessions/refs'
import type { Session } from './modules/sessions/session'
import { registerSessionConfigureEffect } from './modules/sessions/session-configure-effect'
import { registerSessionHandoffEffect } from './modules/sessions/session-handoff-effect'
import {
  registerSessionInterruptEffect,
  type SessionInterruptsHandle,
} from './modules/sessions/session-interrupt-effect'
import {
  createSpawnLaunchInUnit,
  refuseUnplaceable,
  registerSessionLaunchEffect,
  SESSION_LAUNCH_KIND,
  settledSpawnLaunch,
} from './modules/sessions/session-launch-effect'
import { CredentialSwitcher, type SwitchSession } from './modules/sessions/switch-credential'
import { makeInstancePreferencesFeedCapture } from './modules/settings/instance-record'
import {
  bridgeConfigChanged,
  SettingsService,
  type TelegramSetupClient,
} from './modules/settings/service'
import { SuperagentDefaultSeeder } from './modules/settings/superagent-default'
import { DockShellService, resolveSampledShellOwners } from './modules/shells/service'
import {
  CompatibilityShippingPolicyResolver,
  ShippingService,
  shippingResourceHolderId,
} from './modules/shipping'
import {
  ShippingEvidenceRegistry,
  ShipwrightService,
  shipwrightApplyPatchThroughRelay,
} from './modules/shipping/shipwright'
import { deliverAnswerToSession } from './modules/superagent/answer-delivery'
import type { HeadlessService } from './modules/superagent/headless'
import type { SuperagentService } from './modules/superagent/service'
import { makeThreadFeedCapture } from './modules/superagent/thread-records'
import { SyncWriteEntry } from './modules/sync-write/entry'
import { registerFamilyCommands } from './modules/sync-write/family-commands'
import { legacyMutationFallback } from './modules/sync-write/legacy-receipt'
import { registerOutboxCommands } from './modules/sync-write/outbox-commands'
import { SyncWriteRegistry } from './modules/sync-write/registry'
import { GRANT_EVENT_KIND } from './modules/updates/grant-cause'
import {
  createUpdateFleetBridge,
  exclusiveUpdateVersion,
  updateOperationKind,
} from './modules/updates/operation'
import { updateOperationObserver } from './modules/updates/operation-observer'
import { UpdateReconciler } from './modules/updates/reconciler'
import { type ChannelFeed, resolveReleaseTarget } from './modules/updates/release-target'
import type { ServerPlacement } from './modules/updates/service'
import { UpdatesService } from './modules/updates/service'
import { registerUpdateEffect, type UpdateEffects } from './modules/updates/update-effect'
import { readUsageSummary } from './modules/usage-summary'
import { WorkflowService } from './modules/workflows/service'
import { asSystemWrite, syncedWriteProvenance } from './plain-command-scope'
import { privateResourceAccess } from './private-resources'
import { MachineRepoDiscovery } from './repo-discovery'
import { inferRepoFromRoots, RepoRegistry } from './repo-registry'
import { SELF_HOSTED_CAPABILITIES, type ServerCapabilities } from './server-mode'
import { soleMemberFor } from './sole-member'
import { JANITOR_STEWARD_EVENT_LIMIT, StewardService, stewardNoticeSender } from './steward'
import { SessionStore } from './store'
import { changeLogCommit } from './store/change-log-commit'
import type { EffectRow, EffectsRepository } from './store/effects'
import { afterCommit, applyAfterCommit, spanOpen } from './store/executor/executor'
import { currentReadScope, readScopeSlot } from './store/executor/read-scope'
import { readKindTokens } from './sync/kind-tokens'
import { databaseRecords } from './sync/record-source'
import type { SyncDeltaPorts } from './sync/route-support'
import { installSessionSourceWrites } from './sync/session-source-writes'
import { autoContinueSender, systemIssueNotice } from './system-notices'
import { WriteContexts } from './write-contexts'

// Re-exported so repo-registry/superagent/tests keep importing the daemon-RPC
// result shapes from './relay'.
export type {
  OpResult,
  ScanReposResult,
  ScanResult,
} from './modules/machines/rpc'

import { createLogger } from '@podium/logger'

const log = createLogger('server:relay')
const repoDiscoveryLog = createLogger('server:repo-discovery')

export type { MemoryBreakdown }

/**
 * The durable state the composition itself needs, read by
 * {@link SessionRegistry.create} before the graph exists (POD-3256).
 *
 * It holds only what cannot wait for {@link SessionRegistry.hydrate}: the
 * feature gate closes over the settings VALUE, so the value has to be in hand
 * when the closure is made.
 */
interface SessionRegistryBoot {
  readonly legacyReceiptCutoff: number
  readonly legacyReceiptOwner: UserId | null
  readonly settings: Awaited<ReturnType<SessionStore['settings']['getSettings']>>
  readonly updateRecovery: Awaited<ReturnType<SessionStore['updateRecovery']['read']>>
}

interface SessionRegistryOptions {
  serverPlacement?: ServerPlacement
  /** What this server's mode allows (server-mode.ts). Absent: a self-hosted install. */
  capabilities?: ServerCapabilities
  /** Boot-resolved deployment identity; every composition root names it explicitly. */
  instanceId: string
  /**
   * The server target app label for derived machine version state. The real
   * composition root supplies the baked app version; fixtures may omit it.
   */
  targetVersion?: () => string | undefined
  /** Public half of this server's update-signing key, sent on every successful machine hello. */
  updatePubkey?: () => string
  /** Signed transition path to the current update key. */
  updateKeyRotations?: () => readonly UpdateKeyRotation[]
  /**
   * Is this server's own binary the deployment's to replace rather than the
   * updater's? (PDM-26, `updateScope: 'fleet-only'`.) Stated by the composition
   * root, which is the only place that reads the deployment's environment.
   * Absent means `all` — every self-hosted install.
   */
  coordinatorExcluded?: () => boolean
  /**
   * This installation's own `dev` feed — address, origin fence, trust root and
   * machine credential. Read PER RESOLVE, because a Settings write to Public URL
   * or a remote machine joining the fleet both change the answer.
   *
   * Absent (an installed server, or a source server that cannot name an address
   * its fleet could reach) means there is no dev feed to pull.
   */
  devChannelFeed?: () => ChannelFeed | undefined
  telegramSetup?: TelegramSetupClient
  generateTelegramSetupCode?: () => string
  now?: () => number
  /**
   * The mail gate's BOUNDED-WAIT seam (`MessageGateDeps.awaitPollMs`/`sleep`),
   * which `awaitAgent` and `ask` accept but nothing above them could reach.
   * Absent — every production boot and nearly every test — means real timers
   * and the shipped poll interval. A send never waits on it [POD-4661].
   */
  mailAwait?: { pollMs?: number; sleep?(ms: number): Promise<void> }
  /** Where the transcript lake keeps its parts (POD-6963 design 2.3): the workspace's
   *  `files` handle and its id. Opt-in: when unset (the default — every existing
   *  test), NO mirror traffic is produced. */
  transcriptLake?: TranscriptLakeStorage
  /**
   * This workspace's user files (POD-6963 design 2.1): the handle the
   * composition root built with `forWorkspace`, on the state directory or on a
   * bucket: the artifact, composer-upload and lake owners' files (POD-7052,
   * POD-7054, POD-7055). Absent in tests: the artifact and composer-upload
   * stores then keep their files under the state directory, as a self-hosted
   * server does.
   */
  files?: BlobStore
  portableStateFence?: PortableStateFence
  /** Live model-list probe (grok/cursor/opencode `models`). Injected in tests so the
   *  catalog never shells out; defaults to the real CLI probe. */
  modelProbe?: ModelProbe
  /** Inbound daemon pairing codes — a HUB-role capability injected from server
   *  assembly (core never imports hub/pairing; see roles.ts). Absent = pairing
   *  disabled: mint throws, `pair` handshakes are rejected, `hello` unaffected. */
  installationId?: string
  pairing?: PairingCodes
  /**
   * A member's password and address, through their account of the identity
   * package (POD-6746). Absent, which is a registry assembled without an
   * identity core (most tests): every password write refuses.
   */
  memberCredentials?: MemberCredentials
  /**
   * Device claims are included in the last portable snapshot of a server move.
   * Read when a move uses them: the server opens its identity after the
   * registry (POD-6939).
   */
  clientRelocationCodes?: () => OneTimeCodeOperations
  /** Opt-in server-move test evidence, injected by the composition root. */
  afterServerMoveJournalCommitted?: () => void
  /** Reaction contracts to publish on the module seam. Defaults to the registry;
   *  injected only so the runtime refusal of an invalid principal is observable
   *  (POD-1470). Whatever is passed goes through the same totality check the
   *  registry does — a widened system writeScope fails construction. */
  reactions?: readonly unknown[]
  /** Compose read/recovery surfaces without running ordinary boot writers. */
  recoveryOnly?: boolean
  /** Run durable hydration on a fenced rehearsal copy without background dispatch. */
  rehearseBoot?: boolean
  /** Which parked sessions stay in memory (POD-6160 D2f); absent keeps them all. */
  sessionResidency?: { evictParked?: boolean; sweepIntervalMs?: number }
  /** Whether this server runs the hub role (`roles.ts`). Absent = hub, as a tRPC
   *  context with no role is: the fleet's hub-only writes on `sync.submit` are
   *  refused when it is false, as their routes 404 (POD-6417). */
  servesHub?: boolean
  /** The provider calls that verify a pasted credential (credential management
   *  §7). Tests pass a fake provider; absent, the global `fetch`. */
  credentialProviderFetch?: CredentialFetch
}

/** The composed module set (issue #13 Phase 2): the typed seam every caller —
 *  router procs (ctx.modules), server assembly, superagent, tests — reaches
 *  services through. */
/** One-shot effects as data (ADR 12 D5 E2, POD-6357): where a kind registers
 *  its executor, and how an old route waits for a record to settle. */
export interface EffectsModule {
  readonly executors: EffectExecutorRegistry
  readonly runner: EffectsRunner
  /** One record as the Authority holds it now, tombstones included. */
  get(id: string): Promise<EffectRow | undefined>
  awaitSettled(id: string, timeoutMs: number): ReturnType<typeof awaitEffectSettled>
  /** One kind's newest record on a target that is still running, or that succeeded. */
  newestOnTarget: EffectsRepository['newestOnTarget']
  /**
   * A record the server itself asks for (the janitor's connect scan, POD-6396):
   * no caller, so no `sync.submit`; the kind's schema and deadline still apply,
   * and the trigger runs it after the commit like any other.
   */
  createAsSystem(effect: {
    readonly id: string
    readonly kind: string
    readonly target: EffectTarget
    readonly input: unknown
    readonly job: string
  }): Promise<EffectRow>
  /**
   * A record a write creates in its OWN unit of work, attributed to whoever the
   * write names (an approval's `approval.execute`, POD-6415). Only inside a
   * unit: the record commits or rolls back with the write.
   */
  createInUnit(writer: Pick<LedgerWriter, 'commit'>, effect: NewEffectInUnit): Promise<EffectRow>
}

interface NewEffectInUnit {
  readonly id: string
  readonly kind: string
  readonly target: EffectTarget
  readonly input: unknown
  readonly createdBy: UserId | null
  readonly actor: string
}

export interface RegistryModules {
  /** The superagent's own session writes (`superagent.tools`, POD-6601). */
  superagentToolsWriter: Pick<LedgerWriter, 'commit'>
  /** The superagent's turn runner, after a send commits (`superagent.turns`, POD-6606). */
  superagentTurnsWriter: Pick<LedgerWriter, 'commit'>
  /** The messaging bridge's superagent sends, with no command (`superagent.bridge`, POD-6606). */
  superagentBridgeWriter: Pick<LedgerWriter, 'commit'>
  bus: EventBus
  funnel: WriteFunnel
  sessions: SessionLifecycle
  machines: MachinesService
  /** Each machine's checkouts as synced records (POD-6644). */
  checkouts: CheckoutsService
  updates: UpdatesService
  /**
   * Durable long-running operations (POD-2097) — the generic engine plus its
   * kind registry. The registry is named here, not hidden behind the engine, so
   * that a feature registering a new kind does it in a diff a reviewer sees.
   */
  operations: OperationsModule
  /**
   * One-shot effects (POD-6357). OPTIONAL for the reason `updatesReconciler`
   * gives: a module set assembled by hand without it serves no effect kinds.
   */
  effects?: EffectsModule
  /**
   * Background convergence for machines that were asleep when an update ran
   * (POD-2105, spec §3.6). OPTIONAL because it is pure choreography: a registry
   * assembled without it (every fixture that builds a module set by hand) is a
   * server that simply does not converge stragglers, not a broken one.
   */
  updatesReconciler?: UpdateReconciler
  /**
   * TELLING A RUNNING OPERATION THAT THE FLEET MOVED (POD-2741).
   *
   * The daemon path already does this: `onUpdateStatus` in this file calls the
   * service and then this, because "the same frame is the running operation's
   * progress event". The COORDINATOR's own participant reports through
   * `startLocalUpdateParticipant`, which is handed a bare `updates` service and
   * therefore updated the service and told the operation nothing — so the
   * coordinator could refuse a target in 264 ms while its place in the wave sat
   * at `granted` until the step spent its whole silence budget. Exposed so the
   * composition root can give the local participant the same seam.
   *
   * OPTIONAL for the same reason as the reconciler above: a hand-built module
   * set without it is a server whose operations do not learn from local status,
   * not a broken one.
   */
  updateFleetBridge?: { onFleetChanged(): Promise<void> }
  rpc: DaemonRpcService
  costs: CostService
  /** Credential verification, attention, expiry, renewal and removal (§7, §8; Task 13). */
  credentialHealth: CredentialHealth
  /** `sessions.switchCredential` (§9; Task 11). */
  credentialSwitch: CredentialSwitcher
  /** Sign in with ChatGPT, and the keeper of those sign-ins (§11; Task 14). */
  chatgptPlan: ChatgptPlanService
  serverTransfer: ServerTransferService
  loginPropagation: LoginPropagationService
  nativeLogin: NativeLoginService
  /** Signing in to a subscription in a home on a machine (§6 way 2; Task 9). */
  homeSignIn: HomeSignInService
  memory: MemoryService
  hosts: HostsService
  settings: SettingsService
  /** Per-user sidebar/tab layout (POD-1350) — store + feed publish behind one service. */
  layout: LayoutService
  /**
   * THE SYNC WRITE ENTRY POINT (ADR 12 D2, POD-6273): every write to synced data
   * from a transport goes through `syncWrite.submit`. Families register their
   * commands on `syncWrite.registry`.
   */
  syncWrite: SyncWriteEntry
  /** Server-owned dock-shell mapping (POD-4436) — per user, per worktree → shell session. */
  dockShells: DockShellService
  /** Per-user event-stream read positions (POD-1380) — same shape, monotonic merge. */
  readPosition: ReadPositionService
  issueSessionLifecycle: IssueSessionLifecycle
  /** Makes each session's desired state true (ADR 12 D5 E1, POD-6356). */
  sessionLifecycleController: SessionLifecycleController
  /** The `session.launch` effect kind's handle (POD-6398); absent in hand-built sets. */
  sessionLaunches?: { errorOf(effectId: string): unknown }
  /** The `session.interrupt` effect kind's handle (POD-6397); absent in hand-built sets. */
  sessionInterrupts?: SessionInterruptsHandle
  /** Software update as an effect record, and the ports it runs with (POD-6358). */
  updateEffects?: UpdateEffects
  headless: HeadlessService
  /**
   * The superagent, LATE-BOUND (POD-6419): it is built after this registry
   * (`server.ts`) over these modules, and {@link SuperagentService.create} sets
   * it. Its writes on the sync write entry point read it per call; absent until
   * then.
   */
  superagent?: SuperagentService
  notify: NotifyService
  /** Each person's notice inbox (POD-6881, credential management spec §13). */
  notices: NoticeService
  /**
   * Concertmaster sessions' curated conversations and the mark (POD-7211).
   * OPTIONAL for the reason `effects` gives: a module set assembled by hand
   * without it is a server with no Concertmasters, not a broken one.
   */
  concertmaster?: ConcertmasterService
  issues: IssueService
  /** Named agent setups (POD-6107): the library and the launch resolver. */
  agentProfiles: AgentProfileService
  /** Durable Shipping control plane; command registration is owned by POD-889. */
  shipping: ShippingService
  issueCommands: IssueCommandDispatcher
  approvals: ApprovalService
  /** The PendingInteraction aggregate (POD-2020) — every blocking ask, durable
   *  and answerable from any surface. */
  interactions: InteractionService
  workflows: WorkflowService
  /** Advisory named lease locks. */
  locks: LockService
  lockCommands: LockCommandDispatcher
  /** Scheduled automations (#470) — the Automations tab's cron half. */
  automations: AutomationsService
  /** Unified agent messaging (#237). */
  messages: MessageDeliveryService
  /** `podium mail` command surface over the substrate (#237). */
  messageGate: MessageGate
  /** Read toolkit tiers 1–2 — session status/read (#237). */
  readToolkit: SessionReadToolkit
  /** Permanent artifact snapshot store (#441). */
  issueArtifacts: IssueArtifactStore
  /** Composer uploads awaiting the send that claims them (POD-2148). */
  pendingUploads: PendingUploadStore
  /** Total operational contract for every semantically asynchronous reaction. */
  reactions: readonly ReactionDefinition[]
  /** Switch-latency perf registry [POD-701] — the process-level singleton,
   *  exposed here so router procs reach it through the module seam. */
  perf: PerfRegistry
  /** Client log + crash ingestion (chunk 3 of the logging strategy) — the
   *  service behind `logs.forward` / `logs.crash`. */
  logs: LogIngestService
  /** The operator's runtime log-level control over connected clients — the
   *  service behind `logs.setLevel` (POD-1920). Holds no state: it selects
   *  connections and pushes a frame. */
  clientLogLevels: ClientLogLevelDirector
  /** Where a raised REMOTE DAEMON's records land (POD-3156). A separate store
   *  from `logs` above, deliberately — see `modules/logs/fleet-store.ts`. */
  fleetLogs: FleetLogStore
  /** The operator's runtime log-level control over connected DAEMONS — the
   *  service behind `logs.setDaemonLevel` (POD-3156). Stateless, like its client
   *  sibling: it selects live machines and pushes a control frame. */
  fleetLogLevels: FleetLogLevelDirector
  /** Framework idempotency (POD-382) — the ONE mutationId dedup, exposed on the
   *  module seam so a transport wires the framework's implementation rather than
   *  reaching into a service for it. */
  mutations: MutationLedger
}

/** Projection of a Session to the fields an attention notice needs. */
function noticeInfo(
  session: Pick<Session, 'sessionId' | 'status' | 'name' | 'title' | 'cwd' | 'agentKind'>,
): SessionNoticeInfo {
  return {
    sessionId: session.sessionId,
    status: session.status,
    ...(session.name ? { name: session.name } : {}),
    ...(session.title ? { title: session.title } : {}),
    cwd: session.cwd,
    agentKind: session.agentKind,
  }
}

/**
 * The server's composition root (issue #13 Phase 2 → #191). The constructor IS
 * the composition: it builds the module graph in dependency order
 * (bus → machines/rpc → settings/notify/hosts → issue wire plumbing → sessions →
 * conversations → issues → commands), wires the cross-module bus subscriptions,
 * runs the module boot hooks, and exposes the graph as the typed `modules` set.
 * There is NO delegating facade here any more: callers hold `modules.<svc>`
 * (or the store's aggregate repositories) directly.
 */
export class SessionRegistry {
  private mobileVersions?: MobileClientVersions
  /** Topics on the stream plane (ADR 7 Amendment 2), over the gateway's one registry. */
  topics!: TopicRouting
  /** Each connected daemon's link and its kind (credential management §8). */
  readonly daemonLinks: DaemonLinks

  readonly recoveryOnly: boolean
  /** Installation capabilities derived once by the server composition root. */
  readonly capabilities: ServerCapabilities
  /** See {@link SessionRegistryOptions.memberCredentials}. */
  readonly memberCredentials: MemberCredentials | undefined
  /** Typed in-process event bus — modules subscribe here (issue #13 Phase 2). */
  readonly bus = new EventBus()
  /** Typed accessor to the composed services — the one seam callers use. */
  readonly modules: RegistryModules
  /**
   * Tiered per-machine repo discovery (POD-787). Built here, not
   * at the server's composition, because the `machine.scan` effect runs it and
   * the effect kinds must be registered before the boot sweep (POD-6396).
   */
  readonly repoDiscovery: MachineRepoDiscovery
  /**
   * THE GATEWAY's daemon socket mux (POD-389). `attachDaemon`, `detachDaemon` and
   * `routeDaemonFrame` live here, not on the sessions service: a daemon
   * connection is a MACHINE principal whose frames belong to many features, and
   * the sessions service is one of them.
   */
  readonly gateway: DaemonMux
  /**
   * THE GATEWAY's client socket mux (POD-390). `attachClient`, `detachClient`
   * and `routeClientFrame` live here, not on the sessions service: a client
   * connection is a transport-authenticated principal whose frames and whose
   * fan-out belong to the gateway plane, and the sessions service is one of the
   * features that delivers through it. Named separately from {@link gateway}
   * (the daemon mux) rather than renaming POD-389's field across the tree;
   * POD-391 owns whether the two become one object.
   */
  readonly clientGateway: ClientMux
  /** The issue tracker, aliased for ergonomics (≡ modules.issues). */
  readonly issues: IssueService
  /** Restart-safe order control plane (≡ modules.shipping). */
  readonly shipping: ShippingService
  /** In-process issue command surface (≡ modules.issueCommands) — the registry
   *  dispatcher serving the daemon relay + MCP with router-equal authz. */
  readonly issueCommands: IssueCommandDispatcher

  /** Steward trigger queue over the event log; polls only while settings-enabled. */
  private readonly steward: StewardService
  /** Event-log retention timers (issue #61) — modules/events. */
  private readonly eventRetention: EventLogRetention
  /**
   * The quota window ledger's writer (POD-1571). STARTED, unlike the two retired
   * timers near it, and it has to be: quota is a live pull-through read that
   * nothing polls on a schedule, so without this timer a window that elapses
   * while no client is open leaves no record at all — and unlike a cache, that
   * history cannot be recomputed later from anything on disk.
   */
  private readonly quotaSampler: QuotaSampler
  /** The `account.quota` and `account.usage` producers (POD-5798). */
  private readonly accountQuota: AccountQuotaTopic
  private readonly accountUsage: AccountUsageTopic
  /** One-shot boot import of the quota history the harnesses wrote themselves
   *  (POD-1571) — Codex rollouts and Grok's billing log. Claude keeps none. */
  private readonly quotaBackfill: QuotaBackfill
  /** Durable change-log owner, retained so shutdown cancels maintenance slices. */
  readonly syncDelta: SyncDeltaPorts
  private readonly ledger: Ledger
  /** The write contexts over {@link ledger} (ADR 12 D9): the only source of a
   *  write scope in the process. */
  private readonly writes: WriteContexts
  /** What the machine records are written from (POD-6644). */
  private machineRecordsDeps!: () => MachineRecordsDeps & {
    reach: NonNullable<MachineRecordsDeps['reach']>
  }
  /** Each machine's checkouts as synced records (POD-6644). */
  private checkouts!: CheckoutsService
  /** Curated issue-event window, resolved during async registry hydration. */
  /** Open interaction set, resolved during async registry hydration. */
  /** People's chat messages on the feed, resolved during async registry hydration. */
  /** Boot and inventory-triggered personal backend seeding. */
  private readonly superagentDefaults: SuperagentDefaultSeeder
  /** Message delivery slow sweep (#237). */
  private readonly messageSweep: ReturnType<typeof setInterval>
  /** Adds a person's delivered message to a Concertmaster's conversation (POD-7211). */
  private readonly concertmasterDelivered: DeliveredMessageWatch
  /** The credential expiry sweep (credential management §7). */
  private readonly credentialExpirySweep: ReturnType<typeof setInterval>
  /** Queued-INPUT sweep (POD-1703) — the PTY queue's own backstop. The sweep
   *  above walks the message LEDGER; this one re-arms the drains that actually
   *  move bytes, which had no timer at all. */
  private readonly queuedInputSweep: ReturnType<typeof setInterval>
  /** Unclaimed composer uploads past their day (POD-2148). */
  private readonly pendingUploadSweep: ReturnType<typeof setInterval>
  /** Read-gated auto-archive timers (issue #127) — modules/issues. */
  private readonly issueAutoArchive: IssueAutoArchive
  /** Parent-branch movement watch (POD-384) — modules/issues. */
  private readonly issueGitWatch: IssueGitWatch
  private readonly effectsRunner: EffectsRunner
  /** Cron tick for scheduled automations (#470) — modules/automations. */
  private readonly automationScheduler: AutomationScheduler
  private readonly store: SessionStore
  private readonly now: () => number
  private localDaemonPortableState: LocalPortableStateControl | undefined
  /** The superagent service, once assembly has built it — see
   *  {@link adoptSuperagent}. */
  private adoptedSuperagent: SuperagentService | undefined
  private unsubscribeAccessChanges: (() => void) | undefined
  /** Disposer for the runtime's config-write seam bridged onto the bus (POD-3840). */
  private readonly configChangedBridge: () => void

  private stopping = false
  private readonly backgroundTasks = new Set<Promise<void>>()

  /** Owned work starts after hydration and drains before its services close. */
  private startBackground(failure: string, work: () => Promise<unknown>): void {
    if (this.stopping) return
    const task = Promise.resolve()
      .then(async () => {
        if (!this.stopping) await work()
      })
      .catch((err: unknown) => log.warn(failure, { err }))
      .finally(() => this.backgroundTasks.delete(task))
    this.backgroundTasks.add(task)
  }

  /**
   * THE BOOT STEPS, in the order the constructor ran them.
   *
   * Each line used to sit inside a constructor — this one's, or one of the
   * services it builds — and each is a store call, so none of them may stay
   * there (POD-3256). They run after the graph exists and before the server
   * listens, which is where they always effectively ran: the durable seeds
   * below only have to beat the first client asking for a cursor.
   *
   * Correctness seeds are awaited here. Recoverable history passes start as
   * owned background work after hydration and drain before disposal.
   */
  private async hydrate(rehearseBoot = false): Promise<void> {
    let stageStarted = performance.now()
    // Session rows must be restored before issue and message recovery
    // can inspect their targets. Recovery-only serves operations, history, action
    // and health, so it neither needs nor may run session restoration's writers.
    if (!this.recoveryOnly || rehearseBoot) await this.modules.sessions.loadFromStore()
    bootStage('sessions recovery', stageStarted)
    stageStarted = performance.now()
    // Bootstrap streams model tables. Migrations invalidate the kinds they
    // rewrite with sync_kind generations. Only the session passes still rebuild
    // log records; their source-write replacement belongs to POD-6789.
    await this.modules.machines.storeRecordChannel()
    await this.superagentDefaults.seed()
    // Only interrupted preparations need recovery; this uses the running
    // index and captures changed thread rows in their own transaction.
    await this.store.superagent.syncTurnRunningWithPendingTurns()
    // Historical evidence and copied approvals are repaired by the
    // sync-without-boot-reconcile migration, which bumps their kind generations.
    bootStage('feeds memory automations', stageStarted)
    stageStarted = performance.now()
    if (!this.recoveryOnly || rehearseBoot) {
      await this.modules.issues.recoverLegacyMembership()
      if (!this.recoveryOnly && !rehearseBoot)
        this.modules.issueSessionLifecycle.startClosedIssueSweep()
    }
    bootStage('issues catch-up', stageStarted)
    stageStarted = performance.now()
    // One durable queued-row pass repairs events missed while the server was down
    // and restores one-shot wake-cooldown deadlines.
    if (!this.recoveryOnly) {
      try {
        await this.modules.messages.reconcileQueued()
      } catch (error) {
        log.warn('queued message startup recovery failed — the retry backstop remains active', {
          err: error,
        })
      }
    }
    bootStage('queued messages recovery', stageStarted)
    // A fresh install can hold model rows before its first append; a load at
    // head 0 cannot carry them (seq 0 is the cold-start cursor, ADR 2 D12).
    if (!this.recoveryOnly && !rehearseBoot) await this.store.sync.raiseEmptyHead()
    // The effect trigger and its recovery sweep (POD-6357): the boot sweep
    // expires, re-dispatches and recovers what a stop left behind.
    if (!this.recoveryOnly && !rehearseBoot) {
      this.effectsRunner.start()
      // These recoverable passes have periodic/durable retry sources. They
      // must neither race construction nor hold first boot behind history.
      this.startBackground('runtime board startup replay paused before cursor advance', () =>
        this.modules.sessions.runtimeGateway.replayBoardProjection(),
      )
      this.startBackground('shipping startup recovery deferred', () => this.shipping.reconcile())
      this.startBackground('credential expiry sweep failed', () =>
        this.modules.credentialHealth.checkExpiry(),
      )
    }
  }

  /**
   * BUILD THE SERVER — the entry point, because composing the graph is not the
   * whole of booting it (POD-3256).
   *
   * The settings snapshot must exist before the graph is built. Recovery uses
   * the constructed services, so {@link hydrate} runs afterward. The store
   * establishes machine identity before either set of readers (POD-318).
   */
  static async create(
    store: SessionStore | undefined,
    notificationPushers: NotificationPushers | undefined,
    options: SessionRegistryOptions,
  ): Promise<SessionRegistry> {
    const resolvedStore = store ?? (await SessionStore.open(':memory:'))
    // The registry's Ledger reads the store's change capture (POD-6920).
    await resolvedStore.attachChangeLog()
    const registry = new SessionRegistry(resolvedStore, notificationPushers, options, {
      settings: await resolvedStore.settings.getSettings(),
      updateRecovery: await resolvedStore.updateRecovery.read(),
      legacyReceiptOwner: await resolvedStore.settings.retiredSoloMemberId(),
      legacyReceiptCutoff: await resolvedStore.settings.legacyMutationReceiptCutoff(
        (options.now ?? Date.now)(),
      ),
    })
    await registry.hydrate(options.rehearseBoot)
    return registry
  }

  /**
   * Composition only — no store call reaches this body. {@link SessionRegistry.create}
   * is the entry point.
   */
  private constructor(
    store: SessionStore,
    notificationPushers: NotificationPushers | undefined,
    options: SessionRegistryOptions,
    boot: SessionRegistryBoot,
  ) {
    // Validated BEFORE anything is constructed: an invalid reaction principal — a
    // system reaction widening its writeScope — must refuse the assembly outright
    // rather than surface after services and timers exist (POD-1470).
    const reactions = composeReactions(options.reactions ?? REACTIONS)
    this.store = store
    notificationPushers ??= DEFAULT_NOTIFICATION_PUSHERS
    const { instanceId } = options
    const recoveryOnly = options.recoveryOnly === true
    const backgroundDisabled = recoveryOnly || options.rehearseBoot === true
    this.recoveryOnly = recoveryOnly
    this.capabilities = options.capabilities ?? SELF_HOSTED_CAPABILITIES
    this.memberCredentials = options.memberCredentials
    this.now = options.now ?? Date.now
    const portableStateFence = options.portableStateFence ?? new PortableStateFence()
    // Resolve feature state once, then keep it atomic with settings changes. This also
    // avoids reading persistence during instruction preparation after async recovery.
    // The read itself is the factory's (POD-3256): the gate below closes over the
    // value, and closing over a promise is not the same object.
    let currentSettings = boot.settings
    // THE PROCESS'S SNAPSHOT IS THE INSTANCE TIER (POD-6291). A member's
    // change carries that member's resolved view, personal leaves included.
    // Its instance leaves are the instance's, so it is taken at once (the
    // feature gate reads only those), then replaced by the instance blob so
    // no member's personal values stay in a process-wide value. A generation
    // keeps a late blob read from overwriting a newer change.
    let settingsGeneration = 0
    this.bus.on('settings.changed', ({ next, member }) => {
      const generation = ++settingsGeneration
      currentSettings = next
      if (member === undefined) return
      void this.store.settings
        .getSettings()
        .then((instance) => {
          if (generation === settingsGeneration) currentSettings = instance
        })
        .catch(() => undefined)
    })
    const featureEnabled = (id: Parameters<typeof isFeatureEnabled>[0]) =>
      isFeatureEnabled(id, currentSettings)
    // Delegation is resolved from durable session ownership on every apply. This
    // lookup is available before feature construction and never snapshots rights.
    const principalForCapability = capabilityPrincipalResolver(this.store.sessions)
    const workflowCallerForCapability = async (
      capability: import('@podium/model').Capability,
      overrideScope?: boolean,
    ): Promise<import('./modules/workflows/service').WorkflowCaller> => {
      const principal = await principalForCapability(capability)
      const human = onBehalfOfUser(principal)
      const role = human === null ? undefined : await this.store.users.roleOf(human)
      return {
        actor: capability.actorSessionId
          ? { kind: 'session', id: capability.actorSessionId }
          : { kind: 'operator', id: null },
        capability,
        principal,
        onBehalfOf: human,
        ...(role === 'admin' ? { protectedWrite: true } : {}),
        ...(overrideScope ? { overrideScope: true } : {}),
      }
    }
    /**
     * FRAMEWORK IDEMPOTENCY, ONE INSTANCE (POD-382). Every command envelope that
     * honours a `mutationId` — the session session-state class, the session command
     * plane and the issue registry — dedupes through THIS object. It replaces
     * `SessionLifecycle.withMutation`, whose per-proc wrapper form was a per-proc
     * chance to forget (POD-379's idempotency oracle exists because of it) and
     * which made the issue family reach the session service for a property that
     * belongs to neither.
     *
     * Built here, at the composition root, ahead of every consumer: an envelope
     * that constructed its own would be a second dedup cache, and two caches over
     * one durable table is how a replay applies twice.
     */
    const mutations = new MutationLedger(this.store.sync, this.now)
    // Client log + crash ingestion (chunk 3 of the logging strategy). Built at
    // the composition root like every other service; its file sinks open lazily
    // on the first forwarded batch, so a server nobody forwards to opens none.
    const logs = new LogIngestService({
      onCrash: (event) => this.bus.emit('client.crashed', event),
    })
    const sessionInstructions = new SessionInstructionRegistry()
    const liveSessions = new Map<SessionId, Session>()
    // THE CLIENT CONNECTION SET, built before the sessions service that reads it:
    // the gateway owns it (POD-390), and the mux below is what mutates it.
    const clientRegistry = new ClientRegistry()
    // Plaintext claims live only until this source tells its already-authenticated
    // browser sockets to leave. Their hashes enter the final portable snapshot.
    const relocations = clientRelocations({
      codes: options.clientRelocationCodes,
      clients: () => clientRegistry.values(),
      // The socket was admitted by memberOfRequest; the current row could
      // have been disabled since then.
      accountFor: async (memberId) => (await this.store.users.get(memberId))?.accountId,
    })
    // The operator's log-level valve over that same connection set (POD-1920).
    // Stateless: it selects connections and delivers a frame, so a client that
    // reconnects is back at its own default with nothing to clean up.
    const clientLogLevels = new ClientLogLevelDirector(clientRegistry)
    // FLEET DAEMON LOG CAPTURE (POD-3156, POD-3184). The store's file sinks open
    // lazily on the first batch, and a daemon now forwards `warn`+ without being
    // asked — so a server with a healthy remote fleet opens a file per machine
    // and writes very little to it, and one whose only daemon is its own process
    // still opens nothing (that daemon does not forward outside a raise).
    const fleetLogs = new FleetLogStore()

    const issueAccess = new DurableIssueAccessIndex(
      this.store.issues,
      this.store.grants,
      this.store.repos,
    )
    let updates: UpdatesService | undefined
    /**
     * `Promise<void>`, not `void` — the same tightening `UpdatesDeps.onTargetChanged`
     * just had (rule 52b). The bridge handler assigned to this slot has been
     * async for as long as the slot has been declared `void`, and a `void` slot
     * accepts a promise-returning function silently, so widening the port alone
     * would have left the promise dropped one level further out and the awaits
     * at the service's call sites awaiting nothing.
     */
    let targetChanged: ((channel: UpdateChannel) => Promise<void>) | undefined
    let seedSuperagentDefaults: (() => Promise<void>) | undefined
    // The condition topic is composed below the machines service (POD-6644).
    let machineConditionChanged: ((machineId: MachineId) => void) | undefined
    // WHAT KIND OF CONNECTION EACH DAEMON IS ON (credential management §8).
    // Judged from the facts recorded at accept and the trusted networks the
    // instance holds NOW, so an admin's change applies without a reconnect.
    this.daemonLinks = new DaemonLinks({
      trustedNetworks: () => currentSettings.daemonLink.trustedNetworks,
      kindChanged: (machineId) => machineConditionChanged?.(machineId),
    })
    // Registered after the snapshot's own listener above, so it reads the new value.
    this.bus.on('settings.changed', () => this.daemonLinks.settingsChanged())
    // Forward-declared for the same reason `updates` is: the update SERVICE has
    // to be able to ask whether a durable operation holds the lifecycle group
    // (single-flight's other half, P6), and the operations module is composed
    // further down, after everything it announces changes to.
    let operations: OperationsModule | undefined
    const machines = new MachinesService({
      compareMachineRecords: async (write, writer) =>
        await this.store.grants.machineRecordWrites.compare(write, writer),
      daemonLinkKind: (machineId) => this.daemonLinks.daemonLinkKind(machineId),
      conditionChanged: (machineId) => machineConditionChanged?.(machineId),
      instanceId,
      ...(options.updatePubkey ? { updatePubkey: options.updatePubkey } : {}),
      ...(options.updateKeyRotations ? { updateKeyRotations: options.updateKeyRotations } : {}),
      store: this.store,
      recoveryOnly,
      // BY CHANNEL (POD-3858). `listMachines` resolves each machine's channel in
      // order to report it; asking the authority per machine made it resolve the
      // same channel again, twice, and each resolution read the config file.
      channelTarget: (channel) => {
        if (!updates) {
          const version = options.targetVersion?.()
          return version === undefined ? {} : { version }
        }
        const version = updates.targetVersionForChannel(channel)
        const unavailableReason = updates.targetUnavailableReasonForChannel(channel)
        return {
          ...(version === undefined ? {} : { version }),
          ...(unavailableReason === undefined ? {} : { unavailableReason }),
        }
      },
      // POD-1882: read per call, not captured — Settings → Updates writes the fleet
      // default into the settings store, and an unpinned machine must follow the CURRENT
      // value rather than whatever it was when this server booted.
      fleetUpdateChannel: () => this.store.settings.resolve('updateChannel').value,
      // ONE READER of `<stateDir>/machine.id`: the composition root passes the id to
      // the store, and every consumer takes the store's copy. A second `readOrCreate*`
      // call anywhere in the process would be a second opinion about who this host is.
      hostMachine: this.store.hostMachine,
      bus: this.bus,
      ...(options.pairing ? { pairing: options.pairing } : {}),
      ...(options.installationId ? { installationId: options.installationId } : {}),
      ...(options.memberCredentials ? { memberCredentials: options.memberCredentials } : {}),
      // Custody transitions require an existing recipient in the member directory.
      userExists: async (userId) => (await this.store.users.get(userId)) !== undefined,
      // A daemon coming back gets nothing queued on behalf of an owner who can
      // no longer act, or whose authority changed after it was queued (POD-6293).
      fenceQueuedDelivery: async (sessionId, queuedAtMs) => {
        const owner = (await this.store.sessions.getSession(sessionId))?.ownerUserId
        if (!owner) return false
        return (
          !(await this.store.users.get(owner)) ||
          (await this.store.users.queuedBeforeAuthorityChange(owner, queuedAtMs))
        )
      },
      onInventoryRecorded: async () => await seedSuperagentDefaults?.(),
      // Managed-install notices (managed installs §8) go through the inbox the
      // server binds at boot (POD-6881); a notice is the server's own write.
      installNotices: {
        machine: async (machineId) => {
          const record = await this.store.machines.getMachine(machineId)
          if (!record) return undefined
          return { name: record.name, custodian: await this.store.machines.custodian(machineId) }
        },
        emit: async (notice) => await asSystemWrite(async () => await emitNotice(notice)),
        resolve: async (key) => await asSystemWrite(async () => await resolveNotices(key)),
        now: () => this.now(),
      },
    })
    this.machineRecordsDeps = (): MachineRecordsDeps & {
      reach: NonNullable<MachineRecordsDeps['reach']>
    } => ({
      facts: async (ids) => await machines.recordFacts(ids),
      // The grant edges themselves, in one read through the operation's loader.
      grants: async (ids) => await this.store.grants.loadForResources('machine', ids),
      members: async () => await this.store.users.recordMembers(),
      // Each member's checkout reach, recorded with their access row in one
      // transaction: the feed evicts exactly what a member lost (POD-6644).
      reach: {
        of: async (ids) => await this.store.checkouts.reachOfMachines(ids),
        lost: async (ids) => await this.store.checkouts.lostOfMachines(ids),
        paths: async (ids) => await this.store.checkouts.pathsOfMachines(ids),
        apply: async (change, at) => await this.store.checkouts.applyReach(change, at),
        now: () => new Date(this.now()).toISOString(),
      },
    })
    // AGENT PROFILES (POD-6107). Composed right after machines because the launch
    // resolver asks the machine service which candidate harness can run where.
    const agentProfiles = new AgentProfileService({
      store: this.store.agentProfiles,
      now: () => new Date(this.now()).toISOString(),
      listMachines: async () => await machines.listMachines(),
      requireRunnable: async ({ machineId, cwd, agentKind }) => {
        await machines.resolveMachineForAgent(machineId ?? undefined, cwd, agentKind as AgentKind)
      },
      roleOf: async (userId) => await this.store.users.roleOf(userId),
    })
    // Hosts is composed below the transfer service. The callback is rebound once
    // it exists; transfer actions cannot run until this constructor completes.
    let resumeHostPressureAfterTransferFence = async (): Promise<void> => {}
    // Machine rows come from explicit setup or pairing. A server without its
    // own install has no host row to provision.
    // The fleet's log-level valve (POD-3156), built after the machine registry
    // it selects over. It reaches the registry through a PORT (online set, name,
    // one send) rather than holding the service: which machines a raise is for
    // is the logs feature's decision, and touching a daemon socket stays the
    // machines module's.
    const fleetLogLevels = new FleetLogLevelDirector(
      {
        onlineMachineIds: () => machines.onlineMachineIds(),
        machineName: async (id) => await machines.machineName(id),
        toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      },
      fleetLogs,
    )
    const updatesService = new UpdatesService({
      recovery: {
        read: () => boot.updateRecovery,
        write: async (snapshot) => await this.store.updateRecovery.write(snapshot),
      },
      recoveryOnly,
      machines: async () =>
        (await machines.listMachines())
          .filter((machine) => !machine.revokedAt)
          .map((machine) => ({
            id: machine.id,
            name: machine.name,
            // Already the RESOLVED channel (pin, else fleet default) — see
            // MachinesService.listMachines. No fallback literal here: the service
            // resolves an absent channel through the SAME helper (POD-2100), and a
            // second literal is exactly how the two paths disagreed.
            channel: machine.updateChannel,
            version: machine.appVersion ?? 'unreported',
            state: 'current',
            online: machine.online,
            busy: false,
            // THIS SERVER'S OWN HOST (POD-3170), so the planner can grant it last
            // rather than restarting itself out from under a fleet mid-delivery.
            // The host machine is the right answer in every topology: when a
            // local participant owns it the parent hands over, and when the
            // machine's own daemon owns it the process being replaced is this
            // all-in-one. Both take this server with them.
            ...(machine.id === machines.hostMachine?.id ? { coordinator: true } : {}),
            // Explicit source checkouts are visible machines, but they are not
            // package rollout targets. Unknown stays absent and therefore fails
            // toward visibility for older daemons.
            ...(machine.installKind ? { installKind: machine.installKind } : {}),
            // How this machine can take delivery, as its daemon reported. Without
            // it the wave grants updates a machine has already said it cannot
            // use, and the fleet learns by failing (POD-2004).
            ...(machine.deliveryCaps ? { deliveryCaps: machine.deliveryCaps } : {}),
            ...(machine.presenceSource ? { presenceSource: machine.presenceSource } : {}),
            ...(machine.services?.crashOwner === 'desktop'
              ? { deliveryUnavailableReason: 'managed by Desktop updater' }
              : {}),
            // WHICH BYTES IT COULD RUN (POD-2783), in the release manifest's own
            // vocabulary, through the SAME function the mint keys the manifest by
            // — so "the platforms this release contains" and "this machine's
            // platform" cannot be two spellings of one fact. Absent until the
            // daemon reports an inventory, and absent means eligible; a fleet
            // that fell back to the publishing host's platform here would answer
            // the join-late question with a guess about the very machine it is
            // about.
            ...(machine.inventory
              ? { platform: platformTargetFor(machine.inventory.os, machine.inventory.arch) }
              : {}),
          })),
      channelFor: async (machineId) => await machines.updateChannel(machineId),
      send: (machineId, message) => machines.toMachine(machineId, message),
      now: this.now,
      ...(options.coordinatorExcluded ? { coordinatorExcluded: options.coordinatorExcluded } : {}),
      ...(options.updatePubkey ? { updatePubkey: options.updatePubkey } : {}),
      nextGrantId: () => randomUUID(),
      // EVERY channel through one resolver (spec §1). `dev` needs this
      // installation's own feed descriptor, which only the composition root can
      // state; without one the resolver refuses `dev` by name rather than
      // resolving something else.
      feedPollingEnabled: () => this.store.settings.resolve('updateFeedPolling').value,
      resolveTarget: async (channel, previous) =>
        await resolveReleaseTarget(channel, {
          ...(previous ? { previous } : {}),
          ...(channel === 'dev' ? { feed: options.devChannelFeed?.() } : {}),
        }),
      // `dev` on a source host is the one channel this server both PUBLISHES
      // into and PULLS from, so a refresh must not walk its own newer identity
      // back to the last release. Asked per call, because a server becomes a
      // publisher (or stops being one) only across a restart but the fleet's
      // registration does not.
      locallyPublished: (channel) => channel === 'dev' && options.devChannelFeed?.() !== undefined,
      concurrency: 3,
      // Read per call for the same reason `MachinesService` reads it per call:
      // Settings → Updates writes the fleet default into the settings store, and an
      // unpinned machine must follow the CURRENT value (POD-1882).
      fleetChannel: () => this.store.settings.resolve('updateChannel').value,
      // Read per call: a version published while an update is running is queued
      // as `nextTarget` instead of mutating the running wave (POD-2098, §3.2).
      exclusiveOperationActive: async () =>
        (await operations?.engine.active(LIFECYCLE_EXCLUSION_GROUP)) !== undefined,
      // …and WHICH version that operation is delivering, so an operation adopted
      // across a restart can still be handed the package it resumed waiting for
      // (POD-2228). This process has no memory of having published it.
      approvedTarget: async (channel) => await this.store.operations.approvedTarget(channel),
      exclusiveOperationVersion: async (channel) =>
        exclusiveUpdateVersion(await operations?.engine.active(LIFECYCLE_EXCLUSION_GROUP), channel),
      onTargetChanged: async (channel) => await targetChanged?.(channel),
      /**
       * WHY EVERY GRANT WENT OUT, WHERE IT SURVIVES THE PROCESS (POD-2907).
       *
       * The durable event log, not the process log: a grant to this host's own
       * machine ends this process, and the answer to "what authorized that"
       * must not depend on the log level somebody was running. `announce:
       * false` keeps it out of the live activity feed — this is a forensic
       * row, not an event anybody subscribed to.
       */
      recordGrant: async (record) => {
        await this.store.events.appendEvent(
          {
            ts: new Date(record.at).toISOString(),
            kind: GRANT_EVENT_KIND,
            subject: record.machineId,
            payload: record,
          },
          { announce: false },
        )
      },
    })
    updates = updatesService
    const requestBroker = new DaemonRequestBroker({
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      defaultMachine: async () => await machines.defaultMachine(),
    })
    // config.json writes made by THIS process, published beside settings.changed.
    // Held so shutdown detaches it: the seam is a MODULE-level subscriber list in
    // @podium/runtime, so a relay that came and went without unsubscribing would
    // leave a listener holding a dead bus — visible in tests, which build several.
    this.configChangedBridge = bridgeConfigChanged(this.bus)
    // Issue wire plumbing (modules/issues). Constructed BEFORE loadFromStore: the
    // deps are lazy closures (allWire guards the not-yet-assigned IssueService),
    // and broadcasts triggered during load must find the publisher in place.
    // The write-seam change log (#255/#256/#257): issue, session
    // AND conversation writes append their change rows ATOMICALLY with the
    // entity write (one transact span on the shared connection). One changes
    // table + one seq sequence — changesSince consumers see one unified feed.
    // The effect kinds this server serves. Made here because the effect
    // record's builder reads it; the kinds register on it further down.
    const effectExecutors = new EffectExecutorRegistry()
    // EVERY RECORD, BUILT FROM THE MODEL TABLES (design POD-6253 §1). The
    // Authority drains the database's change capture through it and builds
    // the records a write reached (POD-6920), and the start-up load and the
    // sharing rules read current values from it (POD-6770).
    const records = databaseRecords({ store: this.store, effectExecutors, now: this.now })
    const feedVisibility = makeFeedVisibility({
      store: this.store,
      audiencesFor: (kind, ids) => this.store.grants.visibilityAudiencesFor(kind, ids),
      authorizationRevision: () => this.store.grants.visibilityRevision(),
      currentRecords: records.build,
    })
    const visibility = new GrantEdgeVisibilityPolicy(
      feedVisibility.state,
      new NoDelegationsGranted(),
    )
    const ledger = new Ledger({
      visibility,
      anchors: feedVisibility.anchors,
      rescopeThreshold: FEED_RESCOPE_THRESHOLD,
      listenerPrincipal: CHANGE_LOG_OBSERVER,
      repo: this.store.sync,
      now: () => this.now(),
      transact: async (fn) => await this.store.transact(fn),
      // Subscriber delivery waits for the OUTERMOST commit, not for the nested
      // savepoint this commit may be [POD-3260, spec §3.3 mechanism 3]. With no
      // span open — the common case, a top-level ledger.commit — it runs at
      // once, as a tracked effect rather than a floating promise: its
      // visibility pass reads sessions, and a delivery still reading when the
      // store began to close had that read refused, unhandled [POD-6226].
      postCommit: (step, label) => this.store.effect(step, label),
      // The BASELINE FOLD is mechanism 1 on the same commit, and it is a
      // separate port because it is a separate contract: an outer rollback must
      // take the fold with it, or process memory keeps claiming rows the
      // database never kept [POD-3328, spec §3.3 mechanism 1].
      applyCommit: { spanOpen, onCommit: applyAfterCommit },
      // WHICH COMMAND IS APPENDING (ADR 2 D8, POD-6273): the sync write entry
      // point opens a provenance scope around each command's unit of work, and
      // the Authority stamps every row it appends there with the command's
      // mutationId and causationId. Outside a scope it stamps nothing. Inside a
      // plain command (ADR 12 D8, POD-6360) it refuses: a plain handler has no
      // access to the Authority, so it cannot write synced data by accident.
      provenance: syncedWriteProvenance,
      // DERIVED CHANGE CAPTURE (POD-6920, design POD-6253 §3): a commit
      // names nothing; the Authority drains what the write changed.
      records,
    })
    this.ledger = ledger
    // WHO MAY WRITE (ADR 12 D9, POD-6592): the Ledger's scope mint, taken once,
    // here. The sync write entry point mints each command's scope from it; every
    // other writer is a declared origin (`write-contexts.ts`).
    const writes = new WriteContexts(ledger, ledger.takeScopeMint())
    this.writes = writes
    const settings = new SettingsService(this.store.settings, this.store.secrets, this.bus, {
      telegramBindings: this.store.telegramBindings,
      // The chat routing value is observed from Telegram, not supplied by the
      // caller. Its server-owned projection also follows an online disconnect.
      // Read per call: the write contexts are built after this service.
      preferenceWriter: {
        commit: async (op) =>
          await asSystemWrite(async () => await writes.system('settings.preferences').commit(op)),
      },
      // The append-only settings trail (POD-421). Injected here so the transport
      // never reaches into the store for it.
      audit: {
        repo: this.store.settingsAudit,
        now: () => new Date(this.now()).toISOString(),
      },
      ...(options.telegramSetup ? { telegramSetup: options.telegramSetup } : {}),
      ...(options.generateTelegramSetupCode
        ? { generateTelegramSetupCode: options.generateTelegramSetupCode }
        : {}),
      ...(options.modelProbe ? { modelProbe: options.modelProbe } : {}),
      now: this.now,
    })
    /**
     * THE SUPERAGENT'S BACKEND, PICKED FOR SOMEONE WHO HAS NOT PICKED (POD-1313).
     *
     * Wired here because it is the first point where both halves exist: the
     * machines that report what is installed, and the settings service that owns
     * the per-user write. It reads `listMachines()` with NO `use` resolver — the
     * single-operator reading this build already takes everywhere else — so the
     * seed sees exactly the machines the spawn path would consider.
     */
    const superagentDefaults = new SuperagentDefaultSeeder({
      // An install that has never created an account row still has a person: this
      // build authenticates one shared password as firstAdminMemberId(), and that
      // is the very install this seed exists for. Falling back to it here rather
      // than inside the seeder keeps the "who is this for" question at the
      // composition root, where POD-315 will replace it with real principals.
      users: async () => {
        const rows = (await this.store.users.list()).map((row) => asUserId(row.id))
        return rows.length > 0 ? rows : [await firstAdminMemberId(this.store)]
      },
      settingsFor: async (userId) => await settings.getSettingsFor(userId),
      machines: async () => await machines.listMachines(),
      updatePreferences: async (userId, values) => {
        await settings.updatePreferences(userId, values)
      },
    })
    // An inventory report is the ONLY moment new availability becomes known, and
    // a daemon that connects minutes after boot is the ordinary case. The hook
    // is awaited by recordInventory before it announces the metadata change, so
    // every observer sees the seeded state and rename-only changes never re-run it.
    seedSuperagentDefaults = async () => await superagentDefaults.seed()
    this.superagentDefaults = superagentDefaults
    const compareMachineRecords = makeMachineRecordCompare(
      this.store,
      writes.system('machines.records'),
      this.machineRecordsDeps().reach,
    )
    this.store.grants.machineRecordWrites.compare = async (write, writer) =>
      await asSystemWrite(async () => await compareMachineRecords(write, writer))
    installSessionSourceWrites(this.store, writes.system('sessions.live'))
    this.store.sessions.setSnoozeLapseCommit(changeLogCommit(writes.system('sessions.snoozeLapse')))
    // ONE HOOK ON THE ONE APPEND (POD-1772): every orchestrator event write in
    // the server goes through `store.events.appendEvent`, and every retention
    // batch through `pruneEventBatch`. Each runs this commit in its own
    // transaction, which drains the change capture, so the issue-event window
    // and a session's transcript flag reach the feed from the write path
    // (POD-6920).
    const eventLog = writes.system('feed.issueEvents')
    this.store.events.setLogCommit(changeLogCommit(eventLog))
    // ONE HOOK ON THE ONE WRITE FUNNEL (POD-4764): every write to the messages
    // table hands its rows to the chat message feed inside its own
    // transaction, so a person's messages and their delivery status reach every
    // device from the write path, whichever module moved them.
    const messageFeed = new MessageFeedPublisher({ ledger: writes.system('feed.messages') })
    this.store.messages.setFeedCapture(messageFeed.capture)
    this.store.sessions.setMessageWindowWrite(messageFeed.writeSessions)
    // ONE HOOK ON THE THREAD WRITE FUNNEL (POD-6675): every write to
    // `superagent_threads` publishes the thread's record to its owner's devices
    // inside its own transaction, whoever made it.
    this.store.superagent.setThreadFeedCapture(
      makeThreadFeedCapture(writes.system('feed.superagentThreads')),
    )
    this.store.users.setMemberCreated(
      async (userId) =>
        await asSystemWrite(async () => await this.store.superagent.seedMemberGlobalThread(userId)),
    )
    // ONE HOOK ON THE NOTICE WRITE FUNNEL (POD-6881): every write to `notices`
    // publishes the open notice (or its removal) to its recipient's devices
    // inside its own transaction.
    this.store.notices.setFeedCapture(makeNoticeFeedCapture(writes.system('feed.notices')))
    // ONE HOOK ON THE CONCERTMASTER CONVERSATION'S WRITE FUNNEL (POD-7211):
    // every write to `concertmaster_entries` publishes the entry to the devices
    // that show its session's conversation, inside its own transaction.
    this.store.concertmaster.setFeedCapture(
      makeConcertmasterFeedCapture(writes.system('feed.concertmaster')),
    )
    // ONE HOOK ON THE SETTINGS BLOB WRITE (POD-6677): every write of
    // `meta['settings']` publishes the instance settings record to every member
    // inside its own transaction, whoever made it.
    const captureInstancePreferences = makeInstancePreferencesFeedCapture(
      writes.system('feed.instancePreferences'),
    )
    // Configuration above the database is resolved at boot. A settings write
    // supplies its own stored channel inside the transaction.
    const channelAboveSettings = this.store.settings.resolve('updateChannel', undefined, {})
    const fixedFleetChannel =
      channelAboveSettings.source === 'default' ? undefined : channelAboveSettings.value
    this.store.settings.setInstanceFeedCapture(async (write, next) => {
      // A preference write with no blob of its own (personal rows): its blob
      // write, if any, comes back through here with `next`.
      if (next === undefined) return await captureInstancePreferences(write)
      await this.store.machines.recordContext.writeFleetChannel(
        fixedFleetChannel ?? next.deployment.updateChannel ?? 'stable',
        async () => await captureInstancePreferences(write, next),
      )
    })
    const issueArbitration = new IssueAuthorityArbitration(writes.system('issues.server'))
    // THE write funnel (modules/funnel): authorize → repo write → change append →
    // broadcast. Bridges ledger appends onto the bus and runs THE ordered
    // metadataDelta pipe (#256) — sendDelta is the one seam deltas reach
    // clients through.
    // THE SERVING EDGE (POD-1203). One feed, framed per connection by the kernel's
    // publisher, translated per negotiated wire version at the boundary. Feed
    // identity is PERSISTED (`readFeedIdentity`/`writeFeedIdentity`), because ADR
    // 2 D1 makes a re-minted epoch across a restart indistinguishable from a
    // restored backup to every replica holding a cursor.
    const conversationDiagnostics: {
      current: readonly import('@podium/model').ConversationDiagnosticWire[]
    } = { current: [] }
    const subscriptions = new SubscriptionRegistry()
    // THE KERNEL'S OWN SEAM (POD-1196), not a hand-written bridge.
    //
    // This used to translate a protocol Principal into a second principal type
    // and open with `if (principal.kind !== 'user') return false` — refusing
    // EVERY agent, because the kernel's principal had nowhere to put a delegated
    // scope. One principal type and a delegation port remove both the
    // translation and the refusal.
    //
    // The entity-kind narrowing stays: it is a fact about what rooms address,
    // not a refusal of a principal.
    const prepareRoomVisibility = async (
      rooms: readonly import('@podium/protocol').RoomRef[],
    ): Promise<VisibilityResolver> => {
      const prepared = await visibility.forBatch(
        rooms.map((room) => ({
          entity: room.kind === 'issue' ? ('issueProjection' as const) : room.kind,
          entityId: room.id,
        })),
      )
      const resolver = kernelVisibilityResolver(prepared)
      return {
        canSee: (principal, ref) =>
          (ref.kind === 'session' || ref.kind === 'issue') && resolver.canSee(principal, ref),
      }
    }
    const presence = new PresenceRouting({
      subscriptions,
      clients: clientRegistry,
      prepareVisibility: prepareRoomVisibility,
      now: this.now,
    })
    // TOPICS (ADR 7 Amendment 2, POD-5800): the SAME registry, a second router.
    // The metrics producer's snapshot reads the hosts service, which is built
    // further down; the box is filled before any socket can subscribe.
    const topicLate: {
      hosts?: HostsService
      quota?: AccountQuotaTopic
      usage?: AccountUsageTopic
      sessionLive?: SessionLiveTopics
    } = {}
    // POD-6764: a session's live readings. The producers live in the sessions
    // module, which is built further down.
    const sessionLiveProducer = (kind: SessionLiveKind) => ({
      start: (id: string) => topicLate.sessionLive?.start(kind, asSessionId(id)),
      stop: (id: string) => topicLate.sessionLive?.stop(kind, asSessionId(id)),
      snapshot: (id: string) => topicLate.sessionLive?.snapshot(kind, asSessionId(id)),
    })
    const machineConditions = new MachineConditionTopic({
      condition: (machineId) => {
        const linkKind = this.daemonLinks.daemonLinkKind(machineId)
        return { ...machines.condition(machineId), ...(linkKind ? { linkKind } : {}) }
      },
      now: () => this.now(),
      publish: (machineId, value) =>
        this.bus.emit('machine.conditionChanged', { machineId, value }),
    })
    machineConditionChanged = (machineId) => machineConditions.changed(machineId)
    const processTopic = new MachineProcessesTopic({
      supports: (id) => machines.daemonSupports(id, CAP_MACHINE_PROCESSES_V1),
      send: (id, frame) => machines.toMachine(id, frame),
      publish: (id, value) => this.bus.emit('machine.processesChanged', { id, value }),
      onError: (err) => log.warn('process topic failed', { err }),
    })
    const topicProducers: TopicProducers = {
      'machine.condition': { snapshot: (id) => machineConditions.snapshot(asMachineId(id)) },
      'machine.metrics': daemonTopicProducer({
        kind: 'machine.metrics',
        machineOf: (id) => asMachineId(id),
        supportsTopics: (machineId) => machines.daemonSupports(machineId, CAP_TOPICS_V1),
        send: (machineId, frame) => machines.toMachine(machineId, frame),
        snapshot: (id) => topicLate.hosts?.latestFor(asMachineId(id)),
      }),
      'checkout.changed': daemonTopicProducer({
        kind: 'checkout.changed',
        machineOf: (id) => parseCheckoutTopicId(id)?.machineId,
        supportsTopics: (id) => machines.daemonSupports(id, CAP_CHECKOUT_CHANGED_V1),
        send: (id, frame) => machines.toMachine(id, frame),
        snapshot: () => null,
      }),
      'machine.processes': processTopic,
      // POD-5798: the sampler is built further down; its holders start the live passes.
      'account.quota': {
        start: (id) => topicLate.quota?.start(asUserId(id)),
        stop: (id) => topicLate.quota?.stop(asUserId(id)),
        snapshot: (id) => topicLate.quota?.snapshot(asUserId(id)),
      },
      'account.usage': {
        start: (id) => topicLate.usage?.start(asUserId(id)),
        stop: (id) => topicLate.usage?.stop(asUserId(id)),
        snapshot: (id) => topicLate.usage?.snapshot(asUserId(id)),
      },
      'session.terminalState': sessionLiveProducer('session.terminalState'),
      'session.condition': sessionLiveProducer('session.condition'),
      'account.events': {},
    }
    const topics: TopicRouting = new TopicRouting({
      subscriptions,
      clients: clientRegistry,
      prepareVisibility: async (entities) =>
        kernelVisibilityResolver(
          await visibility.forBatch(
            entities.map((entity) => ({
              entity: entity.kind as 'machine' | 'session',
              entityId: entity.id,
            })),
          ),
        ),
      prepareMachineUse: async () => {
        const ownership = await ownershipSnapshotFromMachines(machines)
        return {
          canSee: (principal, ref) =>
            principal.kind === 'user' &&
            'role' in principal &&
            checkMachineUse(
              userCommandPrincipal(
                asUserId(principal.user),
                principal.role as import('@podium/model').UserRole,
              ),
              asMachineId(ref.id),
              ownership,
            ) === undefined,
        }
      },
      producers: topicProducers,
      now: this.now,
    })
    this.bus.on('machine.conditionChanged', ({ machineId, value }) =>
      topics.publish('machine.condition', machineId, value),
    )
    this.bus.on('machine.processesChanged', ({ id, value }) =>
      topics.publish('machine.processes', id, value),
    )
    this.topics = topics
    // Every account notice a connection holds the topic for goes on it (D26).
    clientRegistry.routeAccountEvents((conn, msg) => {
      const reached = topics.emit(
        'account.events',
        conn.principal.user,
        msg,
        (subscriberId) => String(subscriberId) === conn.id,
      )
      return reached.size > 0
    })
    this.bus.on('machine.connected', ({ machineId }) => {
      machineConditions.changed(machineId)
      // The generic resetWatchLevel: the new daemon process gets every key of
      // its machine that is still held (D21).
      topics.machineAttached(machineId)
    })
    this.bus.on('machine.disconnected', ({ machineId }) => {
      machineConditions.changed(machineId)
      processTopic.unavailable(machineId)
    })
    const feedServing = new FeedServing({
      onPublicationIdle: (listener) => this.store.onPublicationIdle(listener),
      workspaceId: this.store.workspaceId,
      authority: ledger.authority,
      identity: new FeedIdentityRegistry(
        {
          readIdentity: async () => await this.store.sync.readFeedIdentity(),
          writeIdentity: async (identity) =>
            await this.store.sync.writeFeedIdentity(identity, this.now()),
        },
        // Opaque, never a counter: D1 forbids a counter outright (restoring one
        // backup twice re-mints the same value and hands a different timeline an
        // epoch clients have already accepted) and `assertOpaqueEpoch` refuses a
        // decimal integer at this boundary.
        () => randomUUID(),
      ),
      retention: { minAvailableSeq: async () => await this.store.sync.minChangeSeq() },
      subscriptions,
      // Rooms and topics are re-checked on the same trigger as the feed (D24).
      onVisibilityChanged: async (subscriberIds) => {
        await presence.revalidateSubscribers(subscriberIds)
        await topics.revalidateSubscribers(subscriberIds)
      },
      diagnostics: () => [...conversationDiagnostics.current],
    })
    this.syncDelta = { authority: ledger.authority, serving: feedServing }

    const funnel = new WriteFunnel({
      onPublicationIdle: (listener) => this.store.onPublicationIdle(listener),
      workspaceId: this.store.workspaceId,
      bus: this.bus,
      // THE SAME Authority the Ledger facade wraps, not a second one (POD-305):
      // two over one store would each keep their own ordered broadcast queue.
      authority: ledger.authority,
      serving: feedServing,
      onPublished: (seq) => this.bus.emit('feed.published', { seq }),
    })
    const installedIssueProjection = async (issueId: string) =>
      (await ledger.authority.installedValues('issueProjection', [issueId])).get(issueId) as
        | { id: string; parentId?: string | null }
        | undefined
    // Advisory named lease locks. Worktree invalidation is an
    // event callback into the already-constructed gateway registry, not a
    // deferred service dependency.
    // A worktree the server created or removed (an issue start, a handoff
    // import, POD-821) is a change of that machine's checkouts: it is scanned,
    // and what moved reaches every device as `checkout` records (POD-6644).
    // The service is composed below the daemon RPC it scans through.
    let checkouts: CheckoutsService | undefined
    const broadcastWorktreesChanged = (_repoPath: string, machineId?: MachineId): void => {
      void (async () => {
        const id = machineId ? asMachineId(machineId) : await machines.defaultMachine()
        checkouts?.rescanSoon(id)
      })().catch((err: unknown) => log.warn('checkout rescan failed', { err }))
    }
    const memory = new MemoryService(
      {
        store: this.store,
        now: () => this.now(),
        // Conversation writes commit through the write-seam ledger (#257):
        // discovery/meta commits name their records at the write; the feed
        // serves them (POD-1203 deleted the snapshot tail).
        ledger: writes.system('conversations.discovery'),
        // Scan diagnostics are not feed content and the v1 wire carried them
        // inside `conversationsChanged`; the edge re-serves them to the wire
        // versions that still need them (POD-1203).
        onDiagnosticsChanged: (diagnostics) => {
          conversationDiagnostics.current = diagnostics
        },
        // ONE correlator, handed over as itself (POD-318). It was constructed
        // above precisely so every consumer can take it directly instead of
        // wrapping a not-yet-built service in a closure.
        daemonRequest: requestBroker,
      },
      {
        ...(options.transcriptLake ? { transcriptLake: options.transcriptLake } : {}),
      },
    )
    const rpcLate: { rpc?: DaemonRpcService } = {}
    const checkoutWrites = new LifecyclePort<
      Pick<IssueService['reports']['store'], 'commitRepoWrite'>
    >('checkout repo writes')
    checkouts = new CheckoutsService({
      store: this.store,
      scan: async (machineId, roots) => {
        if (!rpcLate.rpc) return { repositories: [], diagnostics: [] }
        return await rpcLate.rpc.scanRepos(roots, { includeHome: false, maxDepth: 0 }, machineId)
      },
      online: (machineId) => machines.hasDaemon(machineId),
      writer: () => ({
        commit: async (op) =>
          await asSystemWrite(async () => await this.writes.system('checkouts.scan').commit(op)),
      }),
      // Scan-reported origins are the server's own write (POD-6417).
      commitRepoWrite: async (write) => {
        try {
          await asSystemWrite(
            async () =>
              await checkoutWrites
                .read()
                .commitRepoWrite(this.writes.system('checkouts.scan'), write),
          )
        } catch (err) {
          log.warn('scanned repo origins were not recorded', { err })
        }
      },
      now: () => new Date(this.now()).toISOString(),
    })
    this.checkouts = checkouts
    // A daemon that connects may have created or removed worktrees while away.
    this.bus.on('machine.connected', ({ machineId }) => checkouts?.rescanSoon(machineId))
    const rpcSessions = new LifecyclePort<Pick<SessionLifecycle, 'residency' | 'repository'>>(
      'RPC session readers',
    )
    const rpc = new DaemonRpcService({
      broker: requestBroker,
      memory,
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      serverPlacement: options.serverPlacement,
      defaultMachine: async () => await machines.defaultMachine(),
      resolveMachine: async (requested, cwd) => await machines.resolveMachine(requested, cwd),
      hasDaemon: (machineId) => machines.hasDaemon(machineId),
      daemonSupports: (machineId, capability) => machines.daemonSupports(machineId, capability),
      machineName: async (id) => await machines.machineName(id),
      machineNames: async (ids) => await machines.machineNames(ids),
      onlineMachineIds: () => machines.onlineMachineIds(),
      portableStateFence,
      // A parked session is restored from its row for the read (POD-6160 D2f);
      // the view closes over the object, which stays readable if it is evicted.
      getSession: async (sessionId) => {
        const session =
          liveSessions.get(sessionId) ??
          (await rpcSessions.read().residency.ensure(sessionId, 'rpc'))
        session?.freshenDurable()
        // A restored parked session's transcript is replayed for its reader (POD-6160).
        if (session) await rpcSessions.read().repository.ensureTranscript(session)
        return session
          ? {
              id: session.sessionId,
              cwd: session.cwd,
              machineId: session.machineId,
              agentKind: session.agentKind,
              resume: session.resume,
              transcriptItems: () => session.terminal.transcriptItems(),
              runtimeTranscriptItems: () => session.terminal.runtimeTranscriptItems(),
              driverId: session.driverId,
              status: session.status,
            }
          : undefined
      },
    })
    rpcLate.rpc = rpc
    // ONE machines read, then a pure per-machine answer (POD-3257). The
    // single-machine dep below is this one applied to one id, so the eligibility
    // rules cannot drift between the fleet path and the point lookup — and a
    // caller looping over the fleet no longer re-reads the whole table per
    // machine.
    const targetStateResolver = async (): Promise<
      (machineId: MachineId) => ServerTransferTargetState
    > => {
      const byId = new Map((await machines.listMachines()).map((m) => [m.id, m] as const))
      const digest = wireSchemaDigest()
      return (machineId) => {
        const machine = byId.get(machineId)
        return {
          exists: machine !== undefined && !machine.revokedAt,
          online: machines.hasDaemon(machineId),
          capable:
            machine?.wireSchemaDigest === digest &&
            machine.serverMoveEligibility?.eligible === true,
          // POD-2700. `undefined` components mean NOT RECORDED, which must not
          // refuse — same reading as everywhere else — so only an evaluated row
          // that lacks the component answers `false`.
          hasDaemon:
            machine?.serviceAssignment?.agentExecution === true &&
            machine.availability?.daemon === true,
          vaultKeyHandover:
            machine?.deliveryCaps?.includes(SERVER_MOVE_VAULT_KEY_CAPABILITY) === true,
        }
      }
    }
    // The order the source's writers stop in for a transfer snapshot, and
    // restart in after it: the mirror pauses before the portable fence goes up
    // (modules/server-transfer/source-fence.ts).
    const sourceFence = sourceTransferFence({
      daemon: () => this.localDaemonPortableState,
      mirror: {
        pause: async () => await memory.pauseMirroringForTransfer(),
        resume: async () => await memory.resumeMirroringAfterTransfer(),
      },
      portable: portableStateFence,
      store: {
        begin: async () => await this.store.beginTransferFence(),
        end: async () => await this.store.endTransferFence(),
      },
    })
    const serverTransfer = new ServerTransferService({
      stateRoot: stateDir(),
      sourceInstanceId: options.instanceId,
      hostMachine: this.store.hostMachine,
      sourceFeedIdentity: async () => {
        const identity = await feedServing.identity()
        return { feedId: identity.feedId, feedEpoch: identity.epoch }
      },
      sourceApplicationVersion: options.targetVersion?.() ?? 'dev',
      sourceSchemaVersion: () => this.store.schemaVersionForTransfer(),
      sourceWireSchemaDigest: wireSchemaDigest(),
      sourceCapable: async () => {
        if (!this.store.hostMachine) return false
        const source = (await machines.listMachines()).find(
          (machine) => machine.id === this.store.hostMachine?.id,
        )
        return (
          source?.online === true &&
          source.wireSchemaDigest === wireSchemaDigest() &&
          source.deliveryCaps?.includes(SERVER_MOVE_CAPABILITY) === true
        )
      },
      rpc: serverTransferRpcAdapter(rpc),
      // Credential management design §7: the data key moves in promotion, only to a
      // target the server itself judged not `plain`.
      // Read through at each use: the store opens its vault at boot, after which
      // this always answers; a registry built over a bare store still constructs.
      vault: {
        state: () => this.store.vault.state(),
        status: () => this.store.vault.status(),
        exportDataKey: () => this.store.vault.exportDataKey(),
      },
      targetLinkKind: (machineId) => this.daemonLinks.daemonLinkKind(machineId),
      localPromotedTransfer: () => readPromotedTargetMetadata(stateDir()),
      // ONE machines read for the whole fleet (POD-3257). The per-machine form
      // delegates to it: asking `targetState` inside a loop is what re-read the
      // whole table per machine, which is quadratic and a round trip each on a
      // networked backend.
      targetStateResolver,
      targetState: async (machineId) => (await targetStateResolver())(machineId),
      endpointHandoff: {
        registeredMachineIds: async () =>
          (await machines.listMachines())
            .filter(
              (machine) =>
                !machine.revokedAt &&
                machine.serviceAssignment?.agentExecution === true &&
                machine.availability?.daemon === true,
            )
            .map((machine) => machine.id),
        onlineMachineIds: () => machines.onlineMachineIds(),
        probeCandidate: async (input) => {
          const endpoint = new URL(
            `/server-transfer/candidate/${input.transferId}`,
            input.publicUrl,
          )
          const response = await fetch(endpoint, {
            headers: { authorization: `Bearer ${input.reachabilityToken}` },
            signal: AbortSignal.timeout(10_000),
          })
          if (!response.ok) throw new Error(`target candidate returned HTTP ${response.status}`)
          const proof = (await response.json()) as Record<string, unknown>
          if (
            proof.transferId !== input.transferId ||
            proof.manifestDigest !== input.manifestDigest ||
            proof.targetMachineId !== input.targetMachineId
          ) {
            throw new Error('target candidate reachability proof does not match the move')
          }
        },
        probeMachine: async (input, machineId) => {
          const result = await rpc.serverEndpointProbe(input, machineId)
          return result.ok && result.operation === 'probe' && result.transferId === input.transferId
            ? { ok: true }
            : { ok: false, error: result.error ?? 'endpoint probe was refused' }
        },
        commitMachine: async (input, machineId) => {
          const result = await rpc.serverEndpointCommit(input, machineId)
          return result.ok &&
            result.operation === 'commit' &&
            result.transferId === input.transferId
            ? { ok: true }
            : { ok: false, error: result.error ?? 'endpoint commit was refused' }
        },
        resumeMachine: async (transferId, machineId) => {
          const result = await rpc.serverEndpointResume(transferId, machineId)
          return result.ok && result.operation === 'resume' && result.transferId === transferId
            ? { ok: true }
            : { ok: false, error: result.error ?? 'endpoint resume was refused' }
        },
        prepareClientRelocations: relocations.prepare,
        cancelClientRelocations: relocations.cancel,
        relocateClients: (input) => {
          const claimFor = relocations.take(input.operationId)
          for (const client of clientRegistry.values()) {
            const claimToken = claimFor(client.id)
            clientRegistry.deliverAccountEvent(client, {
              type: 'serverRelocation',
              transferId: input.transferId,
              publicUrl: input.publicUrl,
              ...(claimToken ? { claimToken } : {}),
            })
          }
        },
      },
      sourceHealthy: () => this.store.checkpointForTransfer(),
      checkpoint: () => this.store.checkpointForTransfer(),
      fence: async () => await sourceFence.fence(),
      releaseFence: async () => {
        await sourceFence.releaseFence()
        await machines.resumeAfterTransferFence()
        await resumeHostPressureAfterTransferFence()
      },
      demoteSource: ({ transferId, publicUrl }) => {
        prepareSourceDaemonCutover({ transferId, serverUrl: publicUrl })
      },
      // The service fsyncs committed before this callback. Desktop continuity
      // therefore sees matching daemon config + committed journal before exit.
      afterJournalCommitted: options.afterServerMoveJournalCommitted,
      afterCommitted: ({ serverUrl }) => retireSourceAfterTransfer(serverUrl),
      afterRecoveredAbort: () => restartSourceAfterRecovery(),
    })
    const loginPropagation = new LoginPropagationService({
      store: this.store,
      machines,
      rpc,
      now: () => this.now(),
    })
    // A mail sender's capability and a session ref's owner, from who the session
    // acts for (POD-6160: the resident session, else its row, read once per
    // operation). `sessionsSvc` is built below; these run only once it exists.
    const mailSessions = new LifecyclePort<
      Pick<SessionLifecycle, 'capabilityForSession' | 'records'>
    >('mail session authorization')
    const capabilityForLiveSession = async (sessionId: SessionId) =>
      await mailSessions.read().capabilityForSession(sessionId)
    // Sessions are private (POD-6283): the owner, and no grant.
    const liveSessionOwner = async (sessionId: SessionId) =>
      (await mailSessions.read().records.ownershipOf(sessionId, 'mailSessionRef'))?.ownerUserId
    // What a mail principal may address. Its own function so a check that
    // needs only this (the apply-time re-authorization of each queued row)
    // does not read the fleet's machine ownership as well (POD-6229).
    const mailCeiling = (principal: CommandPrincipal): HumanCeiling => {
      const userId = onBehalfOfUser(principal)
      return {
        canSee: async (ref) => {
          if (principal.kind === 'system') return true
          if (userId === null) return false
          if (ref.kind === 'issue') return feedVisibility.mayReadIssue(userId, asIssueId(ref.id))
          if (ref.kind === 'session') {
            return mayReachPrivate(userId, {
              id: ref.id,
              owner: await liveSessionOwner(asSessionId(ref.id)),
            })
          }
          return false
        },
      }
    }
    const mail = principalMailPolicy({
      principalForCapability,
      principalForMessage: async (message) => {
        if (message.fromKind === 'system') return systemPrincipal(message.fromName ?? 'message')
        if (message.fromSession) {
          try {
            return await principalForCapability(await capabilityForLiveSession(message.fromSession))
          } catch {
            return undefined
          }
        }
        if (!message.attribution?.onBehalfOf) return undefined
        const userId = asUserId(message.attribution?.onBehalfOf)
        const role = await this.store.users.roleOf(userId)
        return role ? userCommandPrincipal(userId, role) : undefined
      },
      ceilingFor: (principal) => mailCeiling(principal),
      policyFor: async (principal) => {
        const ownership = await ownershipSnapshotFromMachines(machines)
        return {
          ceiling: mailCeiling(principal),
          machines: {
            // Rule 46: every grant-dependent machine check in this command or
            // delivery apply reads through the pass's lease snapshot. The next
            // apply opens a new scope and therefore re-reads revoked grants.
            mayUse: (machineId) =>
              principal.kind === 'system' ||
              checkMachineUse(principal, machineId, ownership) === undefined,
            isReachable: (machineId) => machines.hasDaemon(machineId),
          },
        }
      },
    })
    // The sessions module (core lifecycle + data planes). Its issue-shaped deps
    // are lazy closures — issues/conversations are assigned below, and are only
    // ever invoked after construction completes.
    const queuedApplyHooks: {
      handingOn?: (
        writer: MessageWriter,
        messageId: string,
        sessionId: SessionId,
      ) => Promise<boolean>
      spawnPrompt?: (
        writer: MessageWriter,
        input: {
          parentSessionId: SessionId
          sessionId: SessionId
          text: string
          attachments?: readonly RuntimeAttachmentRef[]
        },
      ) => Promise<string>
      ownerPrompt?: (
        writer: MessageWriter,
        input: {
          sessionId: SessionId
          text: string
          attribution: Attribution
          attachments?: readonly RuntimeAttachmentRef[]
        },
      ) => Promise<string>
      continueSession?: (
        writer: MessageWriter,
        input: {
          sessionId: SessionId
          erroredTurn: string
        },
      ) => Promise<{ ok: boolean; reason?: string }>
      applied?: (messageId: string, sessionId: SessionId) => Promise<void>
      provenLate?: (messageId: string, sessionId: SessionId) => Promise<void>
      idMatched?: (
        messageId: string,
        sessionId: SessionId,
        proof: {
          transcriptItem: import('@podium/model').TranscriptItemRef
          harnessRef: import('@podium/model').HarnessRef
        },
      ) => Promise<void>
      disprovenLate?: (
        messageId: string,
        sessionId: SessionId,
        reason: string,
        cause: NotInConversationCause,
      ) => Promise<void>
      accepted?: (messageId: string, sessionId: SessionId, held: MessageHeld) => Promise<void>
      injected?: (messageId: string, sessionId: SessionId) => Promise<void>
      unconfirmed?: (messageId: string, sessionId: SessionId, reason: string) => Promise<void>
      rejected?: (messageId: string, reason: string, cause?: MessageFailedCause) => Promise<void>
      abandoned?: (input: {
        sessionId: SessionId
        turnIds: readonly string[]
        reason: QueueDrainAbandonedReason
      }) => Promise<void>
      interrupted?: (messageId: string) => Promise<void>
      typing?: (messageId: string, sessionId: SessionId) => Promise<void>
      interruptedPending?: (sessionId: SessionId, messageId?: string) => Promise<void>
      sessionsRemoved?: (
        scope: WriteScope,
        sessionIds: readonly SessionId[],
        opts?: { endedIssueId?: IssueId },
      ) => Promise<void>
    } = {}
    const queuedMessageApply = new QueuedMessageApply({
      messages: this.store.messages,
      writer: writes.system('messages.daemon'),
      authorize: mail.authorizeAtApply,
      applied: async (messageId, sessionId) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.applied?.(
          messageId,
          sessionId,
        )
        await completion
      },
      injected: async (messageId, sessionId) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.injected?.(
          messageId,
          sessionId,
        )
        await completion
      },
      unconfirmed: async (messageId, sessionId, reason) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.unconfirmed?.(
          messageId,
          sessionId,
          reason,
        )
        await completion
      },
      rejected: async (messageId, reason, cause) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.rejected?.(
          messageId,
          reason,
          cause,
        )
        await completion
      },
    })
    // A ChatGPT plan's session token (epic Task 15). Late-bound: the keeper and
    // credential health are composed further down.
    let issueSessionToken: AttachAccessDeps['issueToken'] | undefined
    const issueUploads = new LifecyclePort<
      Pick<IssueService['crud'], 'chatUploadBytes' | 'chatUploadOwner'>
    >('session issue uploads')
    const sessionIssues = new LifecyclePort<
      Pick<
        IssueSessionLifecycle,
        'draftForStart' | 'discardUnlaunchedDraft' | 'recordParticipation'
      >
    >('session issue workflows')
    const sessionsSvc = new SessionLifecycle({
      startActivityFlush: !backgroundDisabled,
      issueToken: async (credentialId, to) => {
        if (!issueSessionToken) throw new Error('the ChatGPT plan keeper is not wired yet')
        return await issueSessionToken(credentialId, to)
      },
      durableLabelFor: (sessionId) => durableSessionLabel(sessionId, instanceId),
      ...(options.sessionResidency ? { residency: options.sessionResidency } : {}),
      store: this.store,
      now: () => this.now(),
      bus: this.bus,
      daemonLinkKind: (machineId) => this.daemonLinks.daemonLinkKind(machineId),
      authorizeQueuedMessage: (messageId) => queuedMessageApply.authorize(messageId),
      handOffQueuedMessage: async (writer, messageId, sessionId) =>
        (await queuedApplyHooks.handingOn?.(writer, messageId, sessionId)) ?? true,
      recordSpawnPrompt: async (writer, input) => {
        if (!queuedApplyHooks.spawnPrompt) throw new Error('the message ledger is not wired yet')
        return await queuedApplyHooks.spawnPrompt(writer, input)
      },
      recordOwnerPrompt: async (writer, input) => {
        if (!queuedApplyHooks.ownerPrompt) throw new Error('the message ledger is not wired yet')
        return await queuedApplyHooks.ownerPrompt(writer, input)
      },
      // Claimed chat uploads, staged at delivery (POD-2148). Lazy: `issues` is
      // composed below and only read once a row is forwarded.
      chatUploads: {
        bytes: async (issueId, uploadId) =>
          await issueUploads.read().chatUploadBytes(issueId, uploadId),
        owner: async (issueId, uploadId) =>
          await issueUploads.read().chatUploadOwner(issueId, uploadId),
      },
      // Auto-continue is a message (POD-4846).
      sendContinue: async (writer, input) => {
        if (!queuedApplyHooks.continueSession)
          throw new Error('the message ledger is not wired yet')
        return await queuedApplyHooks.continueSession(writer, input)
      },
      // Refuses rather than stranding: a removal that cannot end its messages
      // must not commit (POD-4816).
      failMessagesToRemovedSessions: async (scope, sessionIds, opts) => {
        if (!queuedApplyHooks.sessionsRemoved)
          throw new Error('the message ledger is not wired yet')
        await queuedApplyHooks.sessionsRemoved(scope, sessionIds, opts)
      },
      rejectQueuedMessage: async (messageId, reason, cause) =>
        await queuedMessageApply.reject(messageId, reason, cause),
      confirmQueuedMessageApplied: (messageId, sessionId) =>
        queuedMessageApply.applied(messageId, sessionId),
      confirmQueuedMessageLate: async (messageId, sessionId) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.provenLate?.(
          messageId,
          sessionId,
        )
        await completion
      },
      failQueuedMessageLate: async (messageId, sessionId, reason, cause) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.disprovenLate?.(
          messageId,
          sessionId,
          reason,
          cause,
        )
        await completion
      },
      noteQueuedMessageAccepted: async (messageId, sessionId, held) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.accepted?.(
          messageId,
          sessionId,
          held,
        )
        await completion
      },
      queuedMessageHeld: (messageId) => queuedMessageApply.held(messageId),
      nameQueuedMessageEntry: (messageId, sessionId, transcriptItem) =>
        queuedMessageApply.named(messageId, sessionId, transcriptItem),
      reportQueuedMessageIdMatch: async (messageId, sessionId, proof) =>
        await queuedApplyHooks.idMatched?.(messageId, sessionId, proof),
      keepQueuedMessageHarnessIds: (messageId, sessionId, harnessRef) =>
        queuedMessageApply.harnessIds(messageId, sessionId, harnessRef),
      noteQueuedMessageInjected: (messageId, sessionId) =>
        queuedMessageApply.injected(messageId, sessionId),
      noteQueuedMessageUnconfirmed: (messageId, sessionId, reason) =>
        queuedMessageApply.unconfirmed(messageId, sessionId, reason),
      queueDrainAbandoned: async (input) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.abandoned?.(input)
        await completion
      },
      interruptQueuedMessage: async (messageId) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.interrupted?.(messageId)
        await completion
      },
      noteQueuedMessageTyping: async (messageId, sessionId) => {
        const completion: Promise<void> | undefined = queuedApplyHooks.typing?.(
          messageId,
          sessionId,
        )
        await completion
      },
      interruptPendingMessage: async (sessionId, messageId) => {
        const retraction: Promise<void> | undefined = queuedApplyHooks.interruptedPending?.(
          sessionId,
          messageId,
        )
        await retraction
      },
      sessions: liveSessions,
      funnel,
      clients: clientRegistry,
      subscriptions,
      // Session writes commit through the writer of whoever asked (ADR 12 D9,
      // POD-6601): a command's own, or one of these named origins. The boot
      // writer also reads the installed snapshot (its prior personal rows).
      writers: {
        daemon: writes.system('sessions.daemon'),
        lifecycle: writes.system('sessions.lifecycle'),
        live: writes.system('sessions.live'),
        boot: writes.system('boot.reconcile'),
      },
      machines,
      rpc,
      onSpawnTargetLogin: async ({ machineId, agentKind, ownerUserId }) =>
        await loginPropagation.trigger({
          targetMachineId: machineId,
          agentKind,
          principalUserId: ownerUserId,
        }),
      memory,
      issueAccess,
      installedIssueProjection,
      onWorktreesChanged: broadcastWorktreesChanged,
      commitRepoWrite: async (write) => await this.commitServerRepoWrite(write),
      instructionsForStart: (input) => sessionInstructions.prepare(input),
      agentLaunch: async (input) => await agentProfiles.launch(input),
      // Installed at the existing issue/session workflow boundary before hydration.
      draftForStart: async (_writer, input) =>
        (await this.store.repos.machineHasRootContaining(input.cwd, input.machineId))
          ? await sessionIssues.read().draftForStart(writes.system('sessions.lifecycle'), input)
          : undefined,
      discardUnlaunchedDraft: async (_writer, issueId) =>
        await sessionIssues.read().discardUnlaunchedDraft(issueId),
      recordIssueParticipation: async (writer, issueId, userId, via) =>
        await sessionIssues.read().recordParticipation(writer, issueId, userId, via),
      // POD-1081: attach owns frame delivery; presence rooms own who-is-watching
      // (a client counts the room's members, POD-6764: no client count on the
      // record). PTY attach auto-joins the room so the two stay one mechanism.
      publishSessionLive: (kind, sessionId, value) => topics.publish(kind, sessionId, value),
      sessionRoomJoin: (client, sessionId) =>
        presence.ensureJoined(client, { kind: 'session', id: sessionId }),
      sessionRoomLeave: (client, sessionId) =>
        presence.ensureLeft(client, { kind: 'session', id: sessionId }),
    })
    topicLate.sessionLive = sessionsSvc.liveTopics
    rpcSessions.install(sessionsSvc)
    mailSessions.install(sessionsSvc)
    const nativeLogin = new NativeLoginService({
      machines,
      sessions: sessionsSvc,
      bus: this.bus,
      // The USER read is hoisted once per candidate scan (rule 18). The
      // returned machine checks read grants through NativeLoginService's
      // per-start lease, so one login answer uses one snapshot and the next
      // start re-reads (rule 46). The rule itself is stated once in
      // `codex-machine.ts` so login starts and Codex server-AI use cannot
      // drift into two answers about who may use which machine.
      authorizerFor: async (ownerUserId) =>
        await codexAuthorizerFor({ users: this.store.users, machines }, ownerUserId, 'start login'),
      cwdForMachine: async (machineId) =>
        (await this.store.repos.listRepoPaths(machineId))[0] ?? '/',
      custodianOf: async (machineId) => await this.store.machines.custodian(machineId),
    })
    // ADDING A SUBSCRIPTION ON A MACHINE (credential management §6 way 2;
    // Task 9): a home on the machine and the vendor's sign-in in a terminal
    // there. The terminal is the server's own write, as the login pane above.
    const homeSignIn = new HomeSignInService({
      store: this.store,
      daemon: {
        isOnline: (machineId) => machines.hasDaemon(machineId),
        supports: (machineId, cap) => machines.daemonSupports(machineId, cap),
      },
      rpc: {
        homeEnsure: async (credentialId, harness, machineId) =>
          await rpc.homeEnsure(credentialId, harness, machineId),
        homeRemove: async (homeId, machineId) => await rpc.homeRemove(homeId, machineId),
      },
      terminals: {
        open: async (i) => {
          const cwd = (await this.store.repos.listRepoPaths(i.machineId))[0] ?? '/'
          const spawned = await asSystemWrite(
            async () =>
              await sessionsSvc.createSession({
                agentKind: 'shell',
                loginHarness: i.harness,
                loginHome: { credentialId: i.credentialId, homeId: i.homeId },
                cwd,
                title: `${i.harness} sign-in`,
                name: `${i.harness} sign-in`,
                machineId: i.machineId,
                ownerUserId: i.ownerUserId,
              }),
          )
          return spawned.sessionId
        },
        close: async (sessionId) =>
          await asSystemWrite(
            async () => await sessionsSvc.killSession(sessionsSvc.serverWriter, { sessionId }),
          ),
      },
      requestInventory: (machineId) => machines.toMachine(machineId, { type: 'inventoryRequest' }),
      now: () => this.now(),
    })
    this.bus.on('session.exited', async ({ sessionId, code }) => {
      await homeSignIn.onExit(sessionId, code)
    })
    this.bus.on('machine.metadataChanged', async ({ machineId, inventory }) => {
      if (!inventory) return
      const machine = await this.store.machines.getMachine(machineId)
      await homeSignIn.onInventory(machineId, machine?.inventory)
      // Logins the person made on the machine become credentials (§6 way 3).
      await recordFoundLogins(
        {
          store: this.store,
          serial: homeSignIn.serial,
          now: () => this.now(),
          isWaitingFor: (homeId) => homeSignIn.isWaitingFor(homeId),
        },
        machineId,
        machine?.inventory,
      )
    })

    // The closed-issue memo behind the `sessions()` projection below, held for
    // the lifetime of a READ SCOPE [POD-3261]. It used to be invalidated by
    // `queueMicrotask`, which is sound only while nothing in the pass yields —
    // the first `await` anywhere drops it and the full scans come back. The
    // slot is a read-through memo with no invalidation of its own: whether an
    // issue is CLOSED cannot change inside one scope. It holds an answer only
    // for the issues the sample asked about, read by id (POD-6155): never the
    // whole table.
    const closedIssueIdsSlot = readScopeSlot<Map<string, boolean>>(() => new Map())
    const closedIssueIdsInScope = async (ids: Iterable<string>): Promise<ReadonlySet<string>> => {
      const known = currentReadScope().slot(closedIssueIdsSlot)
      const missing = [...new Set(ids)].filter((id) => !known.has(id))
      if (missing.length > 0) {
        const closed = await this.store.issues.closedIssueIdsAmong(missing)
        for (const id of missing) known.set(id, closed.has(id))
      }
      return new Set([...known].flatMap(([id, closed]) => (closed ? [id] : [])))
    }
    // The folder owners behind the same projection, memoized the same way: one
    // indexed read per sample for the folders not yet asked (POD-6155), however
    // many times the sample rebuilds its session list. Which issue owns a
    // folder does not change inside one host sample's scope.
    const folderOwnersSlot = readScopeSlot<Map<string, IssueId | null>>(() => new Map())
    const folderOwnersInScope = async (
      cwds: Iterable<string>,
    ): Promise<Map<string, IssueId | null>> => {
      const known = currentReadScope().slot(folderOwnersSlot)
      const missing = [...new Set(cwds)].filter((cwd) => !known.has(cwd))
      if (missing.length > 0) {
        for (const [cwd, owner] of await issueAccess.issuesForCwds(missing)) known.set(cwd, owner)
      }
      return known
    }
    // The two automation reads behind `hasScheduledWakeup`, once per READ SCOPE
    // [POD-6149]. The backstop asks once per quiet live session, and the answer
    // reads the same two tables each time; one host sample (its own read scope)
    // now reads them once. Nothing in a sample writes automations.
    const scheduledWakeupsSlot = readScopeSlot<{
      held:
        | Promise<{
            lastSpawned: Awaited<ReturnType<SessionStore['automations']['lastSpawnedSessions']>>
            automations: Awaited<ReturnType<SessionStore['automations']['list']>>
          }>
        | undefined
    }>(() => ({ held: undefined }))
    const scheduledWakeupsInScope = () => {
      const slot = currentReadScope().slot(scheduledWakeupsSlot)
      slot.held ??= (async () => ({
        lastSpawned: await this.store.automations.lastSpawnedSessions(),
        automations: await this.store.automations.list(),
      }))()
      // A failed read must not be remembered for the rest of the scope.
      slot.held.catch(() => {
        slot.held = undefined
      })
      return slot.held
    }
    const hosts = new HostsService(
      {
        getSettings: async () => await this.store.settings.getSettings(),
        transferFenceActive: () => this.store.transferFenceActive,
        clients: () => clientRegistry.values(),
        publishMetrics: (machineId, sample) => topics.publish('machine.metrics', machineId, sample),
        machineName: async (id) => await machines.machineName(id),
        sessions: async () => {
          // ONE statement per projection, not one per session (POD-568): the
          // sweep asks for this on every host sample, and the whole point of the
          // narrow query is that a five-second path never materializes issue rows.
          //
          // ONE statement per SCOPE, not one per projection [POD-1931]. A single
          // `sample()` asks for this projection four to six times PER MACHINE —
          // idle-live counting, shell-idle, backstop, the unobserved report, and
          // once more per hibernate attempt — and each ask was scanning the whole
          // `issues` table. Measured live: 280 full scans / 4 minutes, 2.6s of
          // blocked event loop.
          //
          // LIVE ONLY (POD-4657): the map holds every retained row — hibernated
          // and exited included — and every sweep consumer filters
          // `status === 'live'` first. Building a view (driver-family manifest
          // scan plus four viewer-state lookups) for a dormant row is pure
          // waste, paid five times per 5 s host sample; measured locally at
          // ~30 ms of the tick on a 4.8k-row database (41.6 ms to 11.0 ms
          // per sample). The list stays live-read per call, which is what
          // the re-read after a hibernate attempt depends on.
          const samples = [...liveSessions.values()].filter((session) => session.status === 'live')
          // Every shell resolves its owning issue through the one resolver
          // (POD-4526, mapping-first), so the reaper binds a dock shell to
          // its worktree's top-level issue even when its bound issue differs —
          // the same answer the tab-release and stop triggers read. Bound
          // shells pay for a lookup too now: skipping them (bound-first) is
          // what let one shell read as owner-open here and owner-closed
          // there. Non-shells never enter the map and keep their bound issue.
          // One mapping read per call, live shells only (POD-4627): the map
          // above holds no dormant session, and every reaper pass filters
          // `status === 'live'` before it reads an owner, so a dormant
          // shell's owner was never an input to a decision; skipping it
          // changes no verdict.
          const ownerIssueIds = await resolveSampledShellOwners(
            {
              worktreesForSessions: (ids) => this.store.dockShells.worktreesForSessions(ids),
              issuesForCwds: (cwds) => folderOwnersInScope(cwds),
            },
            samples,
          )
          // Only the CLOSED answers are memoized for the host sample's explicit
          // read scope, including across awaits. The session list itself stays
          // live on every call, which is what the re-read after a hibernate
          // attempt depends on.
          const closed = await closedIssueIdsInScope(
            samples.flatMap((session) => {
              const owner =
                session.agentKind === 'shell'
                  ? ownerIssueIds.get(session.sessionId)
                  : session.issueId
              return owner != null ? [owner] : []
            }),
          )
          return samples.map((session) => {
            // The bound driver's FAMILY, so the park gate can tell a terminal
            // it may read quiet off from a contract it must not (this issue).
            // Same lookup as the client wire (session.ts toMeta): bound wins
            // over selected, absent means unknown and the gate keeps PTY rules.
            const driverFamily = driverFamilyForId(
              session.driverId ?? session.selectedDriverId ?? '',
            )
            // The owning issue is the one resolver's answer above (POD-4526):
            // live shells read the map (mapping-first, bound fallback inside),
            // non-shells keep their bound issue. A dormant shell carries no
            // `issueClosed`; every reaper pass drops it on `status` first.
            const ownerIssueId =
              session.agentKind === 'shell' ? ownerIssueIds.get(session.sessionId) : session.issueId
            return {
              sessionId: session.sessionId,
              machineId: session.machineId,
              status: session.status,
              agentKind: session.agentKind,
              // THE SHELL POLICY'S INPUTS (POD-4435): held/watched read from
              // the same viewer state the priority fan-out reads, so the
              // reaper and the tab-release trigger cannot disagree.
              hasInput: session.terminal.lastInputAtMs > 0,
              heldByTab: sessionsSvc.state.isHeld(session.sessionId),
              watched: sessionsSvc.state.isWatched(session.sessionId),
              // POD-4524: the attach-TUI row's production producer. A bound
              // server-family session renders its native surface through a
              // daemon-side client terminal, so it goes through the table as
              // 'attach-tui'; login still wins, and everything else stays a
              // shell. `driverFamily` is unknown until the daemon binds, and
              // unknown reads as shell — a session with no client terminal has
              // nothing the warm-park row could close.
              purpose:
                session.loginHarness !== undefined
                  ? 'login'
                  : driverFamily === 'server'
                    ? 'attach-tui'
                    : 'shell',
              lastHeldAtMs: sessionsSvc.state.lastHeldAtMs(session.sessionId),
              // POD-4524: when native view last went away; the reaper measures
              // unwatchedMs from here. Absent disables the warm-park row.
              lastUnwatchedAtMs: sessionsSvc.state.lastUnwatchedAtMs(session.sessionId),
              resume: session.resume,
              agentState: session.agentState,
              lastActiveAt: session.lastActiveAt,
              lastResumedAtMs: session.terminal.lastResumedAtMs,
              lastInputAtMs: session.terminal.lastInputAtMs,
              lastOutputAtMs: session.terminal.lastOutputAtMs,
              ...(driverFamily ? { driverFamily } : {}),
              // Bound issue only — except dock shells, whose owner the server
              // mapping answers exactly (see above). A session whose cwd merely
              // sits INSIDE some issue's worktree still resolves through
              // `issueForCwd`, which is a per-session durable read; it would
              // land in the no-issue tier, which is already above open work
              // and below closed work.
              ...(ownerIssueId != null ? { issueClosed: closed.has(ownerIssueId) } : {}),
            }
          })
        },
        hibernateSession: async (input) => await sessionsSvc.hibernateSession(input),
        parkShellSession: (input) => sessionsSvc.parkShellSession(input),
        // The host's pressure reaper: the server's own act (`sessions.lifecycle`).
        killShellSession: (input) => sessionsSvc.killSession(sessionsSvc.serverWriter, input),
        hasScheduledWakeup: async (sessionId, now) => {
          const { lastSpawned, automations: scheduledAutomations } = await scheduledWakeupsInScope()
          return scheduledAutomations.some((automation) => {
            if (!automation.enabled || automation.nextRunAt === null) return false
            const target = automation.targetSessionId ?? lastSpawned.get(automation.id)
            return target === sessionId && Date.parse(automation.nextRunAt) > now
          })
        },
        terminalProofs: async (sessionIds) =>
          new Map(
            [...(await sessionsSvc.terminalProofStatuses(sessionIds))].map(([id, status]) => [
              id,
              { ok: status.reason === 'ok', missing: status.missing },
            ]),
          ),
        daemonRequest: requestBroker,
        toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      },
      this.bus,
    )
    resumeHostPressureAfterTransferFence = () => hosts.resumeAfterTransferFence()
    topicLate.hosts = hosts
    // THE PRESSURE SWEEP IS A VIEWER: it holds machine.metrics:<id> for every
    // connected machine while hibernation is on, so a topics.v1 daemon keeps
    // sampling for it and stops when nobody, sweep included, is watching.
    const metricsDemand = new HibernationMetricsDemand({
      hold: (machineId) => topics.hold(HIBERNATION_HOLDER, 'machine.metrics', machineId),
      release: (machineId) => topics.release(HIBERNATION_HOLDER, 'machine.metrics', machineId),
      enabled: async () => (await this.store.settings.getSettings()).hibernation.enabled,
      onlineMachineIds: () => machines.onlineMachineIds(),
    })
    this.bus.on('machine.connected', ({ machineId }) => {
      void metricsDemand.connected(machineId).catch((err: unknown) => {
        log.warn('could not decide host-metrics demand for a machine', { machineId, err })
      })
    })
    this.bus.on('machine.disconnected', ({ machineId }) => metricsDemand.disconnected(machineId))
    this.bus.on('settings.changed', ({ previous, next }) => {
      if (previous.hibernation.enabled === next.hibernation.enabled) return
      void metricsDemand.reevaluate().catch((err: unknown) => {
        log.warn('could not re-decide host-metrics demand', { err })
      })
    })
    const headless = sessionsSvc.headless
    this.bus.on('session.openUrl', (request) => sessionsSvc.onOpenUrl(request))
    // Session-bound lock auto-release: a finished/exited session
    const notify = new NotifyService(
      {
        // RESOLVED FOR ONE PERSON (POD-1213). These reads include personal
        // preferences, which no longer live on the instance blob — an unresolved
        // read would see the model's defaults instead of the operator's choices.
        // `firstAdminMemberId()` is spelled out rather than defaulted, the shape
        // `IssueService.broadcastViewer` uses: this build's transport cannot name
        // a person (one shared password), so the sole account is the only true
        // answer, and POD-315/POD-1077 replace the argument rather than finding a
        // hidden read.
        getSettings: async (ownerUserId?: import('@podium/model').UserId) =>
          await this.store.settings.getSettingsFor(
            ownerUserId ?? (await firstAdminMemberId(this.store)),
          ),
        // POD-419: out of the server-only keyed store, read at the moment of use.
        telegramBotToken: async () =>
          await this.store.secrets.getOrEmpty('notifications.telegramBotToken'),
        telegramRouteAvailable: async (ownerUserId) =>
          (await this.store.telegramBindings.listForUser(ownerUserId)).length === 1,
        // The bus is the hand-over point, and `emit` already defers its
        // listeners past the emitter's commit and runs them at the root
        // (POD-3806), so the promise this returns means "announced", which is
        // all a request can promise. It is `async` so the dep's honest
        // `Promise<void>` (POD-3820) has something real to hold: a future
        // rewiring straight to the delivery service is now awaited by the
        // caller instead of dropped.
        requestTelegram: async (request) => {
          this.bus.emit('notification.telegramRequested', request)
        },
        // Grouped with the other phase listeners' appends of the same state
        // change: one commit, not one per row (POD-6233).
        appendEvent: async (e) => {
          await this.store.events.appendEventGrouped(e)
        },
        now: () => this.now(),
        // Attention is an account notice: on the account.events topic when the
        // connection holds it, else the pre-topics frame (ADR 7 Amendment 2 D26).
        clients: (ownerUserId) =>
          [...clientRegistry.values()]
            .filter((client) => ownerUserId === undefined || client.principal.user === ownerUserId)
            .map((client) => ({
              send: (msg: ServerMessage) => {
                if (msg.type === 'attentionEvent') clientRegistry.deliverAccountEvent(client, msg)
                else clientRegistry.deliver(client, msg)
              },
              get visible() {
                return client.visible
              },
            })),
        // A prompt-failed notice can name an exited session (POD-6160): its
        // facts are read from the database when it is not resident.
        sessionInfo: async (sessionId) => {
          const s =
            sessionsSvc.sessions.get(sessionId) ??
            (await sessionsSvc.readSessionFactsById(sessionId))
          return s ? noticeInfo(s) : undefined
        },
        // The not-exited sessions, running or hibernated (POD-6160): a stopped
        // session's last state is not replayed, as the live path above already
        // suppresses notices for stopped sessions.
        sessionStates: async () =>
          (await sessionsSvc.readSessionFactsWithStatuses(['starting', 'live', 'hibernated'])).map(
            (s) => ({
              info: noticeInfo(s),
              state: s.agentState,
              ownerUserId: s.ownerUserId,
            }),
          ),
      },
      notificationPushers,
      this.bus,
    )
    // THE NOTICE INBOX (POD-6881, spec §13): the one way into a person's inbox,
    // pushed through that person's own channels for the kinds they switched on.
    const notices = new NoticeService({
      notices: this.store.notices,
      pushPreferences: async (user) =>
        (await this.store.settings.getSettingsFor(user)).notifications.notices,
      push: async (user, message) => await notify.notifyExternal(message, user),
      now: () => new Date(this.now()).toISOString(),
    })
    bindNoticeService(notices)
    // releases its held locks and leaves every wait queue (the queue advances
    // with a grant-notification mail). Best-effort — the lazy expiry sweep is
    // the backstop if this listener ever misses a death.
    // Boot session hydration runs in `hydrate`, not here: it is async now and a
    // constructor cannot await it. Its recovery-only guard moved with it.
    // Constructed AFTER loadFromStore (same slot the inline mirror construction held).
    // Permanent artifact snapshots (#441): the server pulls bytes
    // from the owning daemon at artifact-add time into <state-dir>/artifacts and
    // serves them locally via /files/artifact (registered in server.ts).
    // On the workspace's blob store since POD-7054: keys under `artifacts/`,
    // today's paths on a self-hosted disk; CLI upload state in `artifact_uploads`.
    const workspaceFiles =
      options.files ??
      new LocalBlobStorage({ stateDir: stateDir(), fence: portableStateFence }).forWorkspace(
        store.workspaceId,
      )
    const issueArtifacts = new IssueArtifactStore({
      files: workspaceFiles,
      uploads: store.artifactUploads,
      rpc: {
        readAsset: async (i) => await rpc.readAsset(i),
        listDir: async (i) => await rpc.listDir(i),
      },
    })
    // Files picked in a composer, held until a send or create claims them into
    // an issue (POD-2148). On the same blob store since POD-7055: bytes under
    // `pending-uploads/`, records in `pending_uploads`; a claim copies the file
    // into the artifact store.
    const pendingUploads = new PendingUploadStore({
      files: workspaceFiles,
      records: store.pendingUploads,
    })
    // Late-bound because the lifecycle object below needs services this one
    // composes. `Promise<void>`, not `void` [POD-3820]: the assignment at the
    // bottom is `async`, and under a `void` declaration TypeScript accepted it
    // while the close silently dropped the promise.
    let stopClosedIssue:
      | ((input: { issueId: IssueId; closedBy: UserId }) => Promise<void>)
      | undefined
    // Late-bound for the same reason: the messages service is composed below.
    let noticeReassignment: ((facts: ReassignmentFacts) => Promise<void>) | undefined

    // Sign in with ChatGPT and its keeper (§11). DEFERRED READ: health is built below.
    const planHealth = new LifecyclePort<Pick<CredentialHealth, 'noteFailure' | 'afterRenew'>>(
      'credential plan health',
    )
    const chatgptPlan = composeChatgptPlan({
      store: this.store,
      now: () => this.now(),
      fetch: options.credentialProviderFetch,
      health: {
        noteFailure: async (failure) => await planHealth.read().noteFailure(failure),
        afterRenew: async (record, verdict) => await planHealth.read().afterRenew(record, verdict),
      },
      machines,
      rpc,
    })

    // Podium's own model calls (credential management §9). A ChatGPT login's
    // calls run on the machine whose Codex home holds it (POD-4750): that
    // machine's daemon performs the Responses call, so the login never leaves
    // it and never crosses this interface.
    const onMachine: OnMachineTransport = {
      listMachines: async () => await machines.listMachines(),
      isOnline: (id) => machines.hasDaemon(id),
      defaultMachineId: () => machines.defaultMachine().catch(() => undefined),
      codexComplete: async (machineId, input) => await rpc.codexComplete(machineId, input),
    }

    const issues = IssueService.compose({
      store: this.store,
      // MENTIONS IN COMMENTS (POD-6881): matched against the active members.
      // Every member reads every task (design §2.2), so each active member
      // mentioned may read it; a disabled account is no member.
      commentMentions: new CommentMentions({
        activeMembers: async () =>
          (await this.store.users.list()).map((user) => ({
            id: asUserId(user.id),
            displayName: user.displayName,
          })),
        readersOf: async (_issueId, users) => [...users],
        emitNotice: async (i) => await notices.emitNotice(i),
        resolveNotices: async (key) => await notices.resolveNotices(key),
      }),
      artifacts: issueArtifacts,
      pendingUploads,
      // The issue service's session reads since POD-6160: running sessions from
      // memory, everything else from the database.
      runningSessionFacts: () => sessionsSvc.runningSessionFacts(),
      readSessionFacts: async () => await sessionsSvc.readSessionFacts(),
      readSessionSeatFacts: async (query) => await sessionsSvc.readSessionSeatFacts(query),
      readSessionFactsById: async (sessionId) => await sessionsSvc.readSessionFactsById(sessionId),
      readSessionFactsByIssue: async (worktreePath, issueId) =>
        await sessionsSvc.readSessionFactsByIssue(worktreePath, issueId),
      readSessionFactsByIssues: async (issues) =>
        await sessionsSvc.readSessionFactsByIssues(issues),
      // The by-id read [POD-1646]: one session, not the full pass.
      sessionById: async (sessionId) => await sessionsSvc.sessionById(sessionId),
      // The narrow read [POD-1639]: an issue mutation asks for ITS sessions, not
      // for all of them. Same set, same fields — see SessionView.listForIssue.
      // A read handed to a person carries only the sessions THEY may read
      // (POD-6285); a read without one is the issue service's own lookup.
      listSessionsForIssue: async (worktreePath, issueId, forUser) =>
        await sessionsSvc.listSessionsForIssue(
          worktreePath,
          issueId,
          forUser ? await sessionsSvc.view.principalForTrustedUser(forUser) : undefined,
        ),
      // A known set, wired [POD-2322] — the issue tree's members.
      sessionsById: async (sessionIds, forUser) =>
        await sessionsSvc.sessionsById(
          sessionIds,
          forUser ? await sessionsSvc.view.principalForTrustedUser(forUser) : undefined,
        ),
      machineName: async (machineId) => await machines.machineName(machineId),
      machineOnline: (machineId) => machines.hasDaemon(machineId),
      // Shell lifetime verbs for the worktree-free trigger (POD-4525): live
      // reads off the registry map, viewer state for held/watched, and the
      // teardown/kill verbs the policy maps onto.
      shellPolicy: {
        liveSession: (sessionId) => sessionsSvc.sessions.get(sessionId),
        isHeld: (sessionId) => sessionsSvc.state.isHeld(sessionId),
        isWatched: (sessionId) => sessionsSvc.state.isWatched(sessionId),
        park: async (sessionId) => await sessionsSvc.parkShellSession({ sessionId }),
        // A freed worktree's dock shell, in the issue's cleanup (`sessions.lifecycle`).
        kill: async (sessionId) =>
          await sessionsSvc.killSession(sessionsSvc.serverWriter, { sessionId }),
      },
      // A spawn names the person it runs for, so `roles.coding` is theirs
      // (POD-6285). With no user named, the read is for instance-tier policy
      // (git workflow, worktree GC), the same for every member: SYSTEM, read
      // through the first admin's row only because a settings read needs one.
      getSettings: async (forUser) =>
        await this.store.settings.getSettingsFor(forUser ?? (await firstAdminMemberId(this.store))),
      complete: async (input) =>
        await complete(
          {
            store: this.store,
            onMachine,
            chatgptPlan: chatgptPlan.keeper,
            // A provider that rejects the credential, or reports a limit (§7).
            // DEFERRED READ: the health service is built below.
            onCredentialFailure: async (failure) => await planHealth.read().noteFailure(failure),
          },
          input,
        ),
      spawnSession: async (o) =>
        await sessionsSvc.createSession({
          requestTerminalDriver: true,
          ...(o.sessionId ? { sessionId: o.sessionId } : {}),
          cwd: o.cwd,
          agentKind: o.agentKind as AgentKind,
          ...(o.issueId ? { issueId: o.issueId } : {}),
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.effort !== undefined ? { effort: o.effort } : {}),
          // Issue workflow already resolved both fields, including deliberate auto.
          ...(o.model !== undefined && o.effort !== undefined
            ? {
                launchSelection: {
                  model: o.model,
                  effort: o.effort,
                  forced: o.forceUnknownModel === true,
                },
              }
            : {}),
          ...(o.forceUnknownModel ? { forceUnknownModel: true } : {}),
          ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
          ...(o.spawnedBy ? { spawnedBy: o.spawnedBy } : {}),
          ...(o.machineId ? { machineId: o.machineId } : {}),
          ...(o.ownerUserId ? { ownerUserId: o.ownerUserId } : {}),
          ...(o.agentProfileId ? { agentProfileId: o.agentProfileId } : {}),
          ...(o.credentialId !== undefined ? { credentialId: o.credentialId } : {}),
        }),
      agentProfiles,
      repoOp: async (op, cwd, args, machineId) => await rpc.repoOp(op, cwd, args, machineId),
      readRepo: async (op, cwd, args, machineId) => await rpc.repoOp(op, cwd, args, machineId),
      resolveMachine: async (requested, cwd) => {
        try {
          return await machines.resolveMachine(requested, cwd)
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'PRECONDITION_FAILED')
            return undefined
          throw error
        }
      },
      requireMachineForRepo: async (machineId, repoPath) =>
        await machines.requireMachineForRepo(machineId, repoPath),
      requireIssueHomeMachine: async (machineId) =>
        await machines.requireRepoHostStructure(machineId),
      // Machine-pinned start (POD-1386/POD-1405/POD-1424): resolve the repository on the
      // target by IDENTITY — the repoId-keyed resolver handoff already uses, so a pin
      // finds the repo instead of demanding the source's path — then materialise the
      // start point there, because our integration branches are on no shared remote and
      // a fetch cannot help the target reach them.
      prepareMachineStart: async ({ repoPath, machineId, startPoint }) => {
        const targetRepoPath = await sessionsSvc.workspace.resolveRepoOnMachine(repoPath, machineId)
        if (!startPoint) return { repoPath: targetRepoPath }
        // The start point that comes BACK may be a commit id rather than the branch name
        // that went in: a bundled branch arrives as objects, not as a ref, so the name
        // does not resolve on the target even though the commit does.
        const ensured = await sessionsSvc.workspace.ensureRefOnMachine({
          sourceRepoPath: repoPath,
          targetMachineId: machineId,
          targetRepoPath,
          ref: startPoint,
        })
        return { repoPath: targetRepoPath, startPoint: ensured.startPoint }
      },
      // The lookup-only half (POD-1571): add-session and worktree recreate need the
      // repository the target ALREADY has, and must keep the refusal when it has none.
      findRepoOnMachine: async (repoPath, machineId) =>
        await sessionsSvc.workspace.findRepoOnMachine(repoPath, machineId),
      recoverIssueBranch: async ({ branch, ...placement }) => {
        const ensured = await sessionsSvc.workspace.ensureRefOnMachine({
          ...placement,
          ref: `refs/heads/${branch}`,
        })
        return ensured.startPoint
      },
      readSessionIssueId: async (sessionId) => await sessionsSvc.readSessionIssueId(sessionId),
      // The issue write that asked passes its own writer (ADR 12 D9, POD-6601).
      setSessionIssueId: (writer, sessionId, issueId) =>
        sessionsSvc.setSessionIssueId(writer, sessionId, issueId),
      setSessionCwd: (writer, sessionId, cwd) => sessionsSvc.setSessionCwd(writer, sessionId, cwd),
      setSessionArchived: (writer, sessionId, archived) =>
        sessionsSvc.setArchived(writer, { sessionId, archived }),
      // Closing an issue retires standing session offers (POD-290) so finished
      // work cannot keep demanding a decision after the close flip.
      clearSessionOffer: (writer, sessionId) => sessionsSvc.clearOffer(writer, sessionId),
      onWorktreesChanged: broadcastWorktreesChanged,
      // Every issue mutation commits through the write-seam ledger (#255) —
      // change rows land in the same transaction as the row write — and fans
      // by the publisher (which unions in hub-mirrored issues), so durable-
      // before-fan-out holds by construction — there is NO raw-WS path out of
      // the issue tracker anymore, and since POD-1203 no snapshot path either:
      // the appended rows ARE what a client is served.
      funnel,
      ledger: issueArbitration.ledger,
      // A command's own writer gets the same revision arbitration (POD-6594).
      arbitrate: (writer) => issueArbitration.wrap(writer),
      onIssueCreated: (event) => this.bus.emit('issue.created', event),
      onIssueWorktreeMoved: (event) => this.bus.emit('issue.worktreeMoved', event),
      onIssueClosed: async (input) => await stopClosedIssue?.(input),
      // AFTER THE COMMIT: a notice for a reassignment the span rolls back would
      // tell two people something that did not happen (POD-6287).
      onIssueReassigned: async (facts) => {
        afterCommit(() => {
          void noticeReassignment?.(facts).catch((err) => {
            log.warn('reassignment notices failed', { err, issueId: facts.issueId })
          })
        }, 'issue-reassign-notice')
      },
    })
    const applySessionDerived = async (event: EventMap['issue.sessionDerived']): Promise<void> => {
      switch (event.kind) {
        case 'gitActivity':
          await issues.gitWorkflow.recordSessionGitActivity(event.sessionId, {
            ...(event.commits ? { commits: event.commits } : {}),
            ...(event.touched ? { touched: event.touched } : {}),
          })
          break
        case 'activity':
          await issues.gitWorkflow.onSessionActivity(event.sessionId)
          break
        case 'attention':
          await issues.gitWorkflow.onSessionAttention(event.sessionId)
          break
        case 'turnEnd':
          await issues.gitWorkflow.onSessionTurnEnd(event.sessionId)
          break
        case 'removedOrArchived':
          await issues.gitWorkflow.onSessionRemovedOrArchived(event.sessionId)
          break
        case 'adoptWorktree': {
          const issue = await issueAccess.getMeta(event.issueId)
          const message = event.message
          if (
            !issue ||
            issue.archived ||
            issue.worktreePath !== null ||
            message.kind !== 'worktree'
          )
            break
          if (
            message.repoRoot !== undefined &&
            !machinePathsEqual(message.repoRoot, issue.repoPath)
          )
            break
          if (await issueAccess.isIssueWorktree(message.cwd)) break
          // A daemon's worktree report: the server's own issue write.
          await issues.crud.update(writes.system('issues.server'), issue.id, {
            worktreePath: message.cwd,
            machineId: event.machineId,
            ...(message.branch ? { branch: message.branch } : {}),
          })
          break
        }
      }
    }
    const applyRuntimeDerived = async (event: EventMap['issue.runtimeDerived']): Promise<void> => {
      switch (event.kind) {
        case 'gitActivity':
          await issues.gitWorkflow.projectSessionGitActivity(event.sessionId, {
            ...(event.commits ? { commits: event.commits } : {}),
            ...(event.touched ? { touched: event.touched } : {}),
          })
          break
        case 'attention':
          await issues.gitWorkflow.onSessionAttention(event.sessionId)
          break
        case 'turnEnd':
          await issues.gitWorkflow.projectSessionTurnEnd(event.sessionId)
          break
      }
    }
    this.bus.on('issue.sessionDerived', applySessionDerived)
    this.bus.on('issue.runtimeDerived', applyRuntimeDerived)
    checkoutWrites.install(issues.reports.store)
    issueUploads.install(issues.crud)
    const issueSessionLifecycle = new IssueSessionLifecycle({
      issues,
      sessions: sessionsSvc,
      ledger: issueArbitration.ledger,
      arbitrate: (writer) => issueArbitration.wrap(writer),
    })
    sessionIssues.install(issueSessionLifecycle)
    stopClosedIssue = async (input) =>
      await issueSessionLifecycle.stopClosedIssue({ ...input, reason: 'close' })

    // CREDENTIAL HEALTH (credential management §7, §8; Task 13). What a
    // rejected, expiring, renewed or removed credential does to its sessions,
    // its notices and the machines that hold a copy. The interaction aggregate
    // that flags a session is built later: a DEFERRED READ, on the terms of the
    // interaction sinks below.
    let interactionsRef: InteractionService | undefined
    const credentialPlacements = new Placements({
      store: this.store,
      // Both kinds go by the daemon's home requests (Task 8); a daemon without
      // harness homes is not asked, and its placements stay `removal-pending`,
      // visibly. The vendor's sign-out before a home goes is Task 9's.
      transport: {
        isOnline: (machineId) => machines.hasDaemon(machineId),
        removers: placementRemovers({
          daemonSupports: (machineId, cap) => machines.daemonSupports(machineId, cap),
          rpc,
        }),
      },
    })
    const credentialRestarts = new LifecyclePort<Pick<CredentialSwitcher, 'restartWithResume'>>(
      'credential restart workflow',
    )
    const credentialHealth = new CredentialHealth({
      store: this.store,
      placements: credentialPlacements,
      // The inbox (POD-6881). A notice is a synced record and renew, remove and
      // share are plain commands: the notice is the server's own write.
      notices: {
        emit: async (notice) => await asSystemWrite(async () => await notices.emitNotice(notice)),
        resolve: async (key) => await asSystemWrite(async () => await notices.resolveNotices(key)),
      },
      now: () => this.now(),
      ...(options.credentialProviderFetch ? { fetch: options.credentialProviderFetch } : {}),
      sessions: {
        liveSessionIds: async (credentialId) =>
          await this.store.sessions.liveSessionIdsOnCredential(credentialId),
        standing: async (sessionId) => {
          const session = await sessionsSvc.sessionById(sessionId)
          if (!session || session.status === 'hibernated' || session.status === 'exited') {
            return 'not-running'
          }
          if (session.status === 'starting') return 'in-turn'
          const phase = session.agentState?.phase
          if (phase === 'ended') return 'not-running'
          return phase === 'working' || phase === 'compacting' ? 'in-turn' : 'between-turns'
        },
        // Stop the harness between turns and start it again under the same
        // session with its conversation resumed; the revival resolves the
        // credential afresh and so delivers the renewed secret. These are the
        // server's own session writes, which a renew or remove (plain commands)
        // set off: `asSystemWrite` is the sanctioned way out of that scope.
        // ONE restart path, the switch's (§9, epic Task 11): park, then revive;
        // for a switch the conversation is placed for its new home first. Each
        // session write inside is the server's (`asSystemWrite`, below).
        restartWithResume: async (sessionId) =>
          await credentialRestarts.read().restartWithResume(sessionId),
        stop: async (sessionId) => {
          await asSystemWrite(async () => await issueSessionLifecycle.stopSession({ sessionId }))
        },
        flagRemoved: async (sessionId, credential) => {
          const spec = {
            kind: 'recovery' as const,
            payload: {
              v: 1 as const,
              reason: 'unknown' as const,
              prompt: `The credential "${credential.label}" this session runs on was removed, so the session stops at the end of its current turn. Choose another credential to continue.`,
              offered: ['abandon' as const],
            },
          }
          await asSystemWrite(
            async () =>
              await interactionsRef?.ask({
                interaction: {
                  ...spec,
                  sessionId,
                  source: 'protocol',
                  answerable: 'keystroke-emulated',
                  askedAt: new Date(this.now()).toISOString(),
                  fingerprint: interactionFingerprint(sessionId, spec),
                },
              }),
          )
        },
      },
    })
    planHealth.install(credentialHealth)
    this.bus.on('superagent.turnEnded', async (event) => {
      if (event.ok || event.harnessErrorKind !== 'provider-auth' || !event.harness) return
      const session = await sessionsSvc.sessionById(asSessionId(event.podiumSessionId))
      // A superagent turn on a credential the provider rejected (§7).
      if (session?.credentialId) {
        await credentialHealth.noteFailure({
          credentialId: session.credentialId,
          failure: 'rejected',
          reason: event.error ?? 'The provider rejected this credential.',
          ...(event.ownerUserId ? { actorUserId: event.ownerUserId } : {}),
          sessionId: session.sessionId,
        })
      }
      if (!session?.machineId) return
      nativeLogin.markRequired(session.machineId, event.harness)
      await loginPropagation.trigger({
        targetMachineId: session.machineId,
        agentKind: event.harness,
        force: true,
        refresh: true,
        ...(event.ownerUserId ? { principalUserId: event.ownerUserId } : {}),
      })
    })
    // SWITCHING A SESSION TO ANOTHER CREDENTIAL (§9, epic Task 11). The
    // switch's own session writes run inside the `sessions.switchCredential`
    // plain command, so each is the server's write (`asSystemWrite`), as the
    // credential health restarts above are.
    const switchView = (session: Session): SwitchSession => {
      const driverId = session.lifecycleDriverRequest()
      return {
        sessionId: session.sessionId,
        agentKind: session.agentKind,
        machineId: session.machineId,
        ownerUserId: session.ownerUserId,
        credentialId: session.credentialId ?? null,
        cwd: session.cwd,
        status: session.status,
        ...(session.resume ? { resume: session.resume } : {}),
        ...(driverId ? { driverId } : {}),
        ...(session.issueId ? { issueId: session.issueId } : {}),
        ...(session.title ? { title: session.title } : {}),
      }
    }
    const credentialSwitch = new CredentialSwitcher({
      store: this.store,
      restarts: credentialHealth,
      placement: {
        daemonSupports: (machineId, cap) => machines.daemonSupports(machineId, cap),
        conversationPrepare: async (request, machineId) =>
          await rpc.conversationPrepare(request, machineId),
      },
      sessions: {
        read: async (sessionId) =>
          await sessionsSvc.residency.withSession(sessionId, 'sessions.switchCredential', (s) =>
            s ? switchView(s) : undefined,
          ),
        standing: async (sessionId) => await credentialHealth.sessions.standing(sessionId),
        record: async (sessionId, credentialId) =>
          await asSystemWrite(
            async () =>
              await sessionsSvc.residency.withSession(
                sessionId,
                'sessions.switchCredential',
                async (session) => {
                  if (!session) return
                  await sessionsSvc.repository.write(
                    writes.system('sessions.lifecycle'),
                    session,
                    (draft) => {
                      draft.credentialId = credentialId ?? undefined
                    },
                  )
                },
              ),
          ),
        hibernate: async (sessionId) =>
          await asSystemWrite(async () => await sessionsSvc.hibernateSession({ sessionId })),
        resurrect: async (sessionId) =>
          await asSystemWrite(async () => {
            const revived = await issueSessionLifecycle.resurrectSession({ sessionId })
            return revived.ok ? { ok: true } : { ok: false, reason: revived.reason }
          }),
        interrupt: async (sessionId) =>
          await asSystemWrite(async () => await sessionsSvc.interruptTurn({ sessionId })),
        stop: async (sessionId) => {
          await asSystemWrite(async () => await issueSessionLifecycle.stopSession({ sessionId }))
        },
        transcriptTail: async (sessionId, limit) =>
          (
            await rpc.readTranscript(
              { sessionId, direction: 'before', limit },
              { kind: 'system', id: 'credential-switch' },
            )
          ).items.flatMap((item) =>
            (item.role === 'user' || item.role === 'assistant') && item.text
              ? [{ role: item.role, text: item.text }]
              : [],
          ),
        startHandoff: async ({ from, credentialId, prompt }) =>
          await asSystemWrite(
            async () =>
              (
                await sessionsSvc.createSession({
                  ownerUserId: from.ownerUserId,
                  agentKind: from.agentKind,
                  cwd: from.cwd,
                  machineId: from.machineId,
                  ...(from.issueId ? { issueId: from.issueId } : {}),
                  ...(from.title ? { title: from.title } : {}),
                  initialPrompt: prompt,
                  credentialId,
                })
              ).sessionId,
          ),
      },
    })
    this.bus.on('machine.connected', ({ machineId }) =>
      credentialPlacements.retryPendingOn(machineId).catch((err) => {
        log.warn('credential placement removal on reconnect failed', { machineId, err })
      }),
    )
    // CODEX ON A CHATGPT PLAN (§11 "Codex"; epic Task 15). A session gets a token
    // with at least SESSION_TOKEN_MIN_LEFT_MS left, and restarts with resume at a
    // turn boundary before the one its engine holds runs low.
    credentialRestarts.install(credentialSwitch)
    const planRenewal = new PlanSessionRenewal({
      now: () => this.now(),
      setTimer: realTimer(() => this.now()),
      restartAtTurnBoundary: async (sessionId) =>
        await credentialHealth.restartAtTurnBoundary(sessionId),
      onError: (err, sessionId) =>
        log.warn('could not restart a ChatGPT plan session for a fresh token', { err, sessionId }),
    })
    issueSessionToken = async (credentialId, to) => {
      const issued = await chatgptPlan.keeper.issue(credentialId, {
        minLeftMs: SESSION_TOKEN_MIN_LEFT_MS,
      })
      if (to.sessionId) {
        planRenewal.delivered(to.sessionId, issued.expiresAt, to.refresh ? 'refresh' : 'start')
      }
      return { secret: issued.token, expiresAt: issued.expiresAt }
    }
    // No forget on exit: a restart is a hibernate then a revival, and an exit
    // event arriving after the revival's delivery would erase the deadline that
    // delivery set. A deadline for a session that is not running does nothing.

    // THE SESSION LIFECYCLE CONTROLLER (ADR 12 D5 E1, POD-6356): makes a
    // session's desired state true through the daemon channel, after each edit
    // commits and again whenever that session's machine reconnects.
    const sessionLifecycleController = new SessionLifecycleController({
      read: async (sessionId) => await sessionsSvc.desiredStateOf(sessionId),
      pending: async (machineId) => await this.store.sessions.lifecyclePending(machineId),
      connected: (machineId) => machines.hasDaemon(machineId),
      stop: async (sessionId, force, principal, selfStop) =>
        await issueSessionLifecycle.stopSession({
          sessionId,
          ...(force ? { force: true } : {}),
          ...(principal ? { principal } : {}),
          // An agent stopping itself (POD-6422): park and free now; its process
          // ends after the reply (the hook below, or `finishSelfStop`).
          ...(selfStop ? { selfStop: true } : {}),
        }),
      hibernate: async (sessionId) => await sessionsSvc.hibernateSession({ sessionId }),
      resurrect: async (sessionId) => await issueSessionLifecycle.resurrectSession({ sessionId }),
      acknowledge: async (sessionId, revision, failure) =>
        await sessionsSvc.acknowledgeDesiredState(
          writes.system('sessions.lifecycle'),
          sessionId,
          revision,
          failure,
        ),
      // A start is re-authorized when it is acted on, as a queued mail's apply
      // is: the writer's human, with today's role and grants, must still hold
      // `use`, narrowed by the writing agent's delegation when an agent wrote it.
      mayStart: async ({ machineId, lifecycle }) => {
        if (lifecycle.byUser === null) return false
        const writer = await this.store.users.get(lifecycle.byUser)
        if (!writer || writer.disabledAt) return false
        const ownership = await ownershipSnapshotFromMachines(machines)
        if (
          checkMachineUse(userCommandPrincipal(lifecycle.byUser, writer.role), machineId, ownership)
        ) {
          return false
        }
        const delegated = lifecycle.byAgent
          ? ownership.delegatedMachines?.(lifecycle.byAgent)
          : undefined
        return delegated === undefined || delegated.has(machineId)
      },
    })
    this.bus.on('machine.connected', ({ machineId }) =>
      sessionLifecycleController.reconcileMachine(machineId).catch((err) => {
        log.warn('session lifecycle reconcile on reconnect failed', { machineId, err })
      }),
    )

    this.bus.on('session.wakeRequested', async ({ sessionId, principal }) => {
      if (process.env.PODIUM_REHEARSAL === '1') return
      const authorization: Promise<import('./modules/sessions/inbox').InboxAuthorizationDecision> =
        sessionsSvc.authorizeQueuedInputAtApply({
          sessionId,
          principal,
          sourceMessageId: null,
        })
      const authorized = await authorization
      // REFUSING THE WAKE IS CORRECT — revocation is supposed to stop a parked
      // session being woken by input it may no longer accept, and the queued row
      // stays pending for an explicit later resume. Doing it SILENTLY was not:
      // the sender is told its message was queued, the session never comes back,
      // and nothing anywhere records why. A refused wake looked identical to a
      // broken one for as long as it took to read this line (POD-1650).
      // A LOG IS NOT A SIGNAL (POD-1703). The line below records why; it does not
      // tell the person who sent the message, who is still looking at a bubble
      // that says pending. `onWakeUnavailable` raises the same needs-attention
      // the spawn-budget path raises, on every row addressed to this session.
      if (!authorized.ok) {
        const reason = authorized.reason ?? 'not authorized'
        log.warn('wake refused — input stays queued for an explicit resume', { sessionId, reason })
        await messagesSvc.onWakeUnavailable(sessionId, `refused: ${reason}`)
        return
      }
      void issueSessionLifecycle
        .resurrectSession({ sessionId })
        .then(async (result) => {
          if (!result.ok) {
            log.warn('wake-on-queue failed', {
              sessionId,
              reason: result.reason,
            })
            await messagesSvc.onWakeUnavailable(sessionId, result.reason ?? 'wake failed')
            return
          }
          // THE WAKE IS AN ELIGIBILITY EDGE (POD-1703). A bind normally re-arms
          // the drain, but a resume that comes back without one — an already-live
          // session, a race with the daemon's own bind — left the row waiting for
          // the next reconnect. Re-arming here costs a no-op when the bind path
          // already ran.
          await sessionsSvc.inbox.drain(sessionId)
        })
        .catch(async (err) => {
          log.warn('wake-on-queue failed', { sessionId, err })
          await messagesSvc.onWakeUnavailable(sessionId, 'wake threw')
        })
    })
    // The `session.listChanged` republish tail is GONE (POD-1574). It re-derived
    // every issue's payload whenever the session list moved, gated by a dirty
    // check that no writer ever advanced. Neither `IssueProjection` (POD-797 removed
    // `sessions`/`sessionSummary`/`unread`) nor `IssueProjection` (never had one)
    // carries a session-derived field, so the tail had nothing to reconcile — and
    // the one time the gate did open, boot reconciliation had already published
    // the same rows (modules/issues/service/index.ts).
    // A LockSessionKey may be a documented non-session identity. System
    // identities are handled before these callbacks; a lookup miss here is how
    // the unknown-relay sentinel gets pruned from a queue (see LockSessionKey's
    // note). So the map is probed as a plain key.
    // A lock holder's session, running or parked (POD-6160): the resident
    // session, else its row read once per operation. `sessionsSvc` is built
    // above; a sentinel holder id names no session and reads as absent.
    const lockSessionRow = async (sessionId: string) =>
      await sessionsSvc.records.ownershipOf(asSessionId(sessionId), 'lock')
    const sessionWorkspace = async (sessionId: SessionId): Promise<string | null> => {
      // LockSessionKey may be a sentinel; miss → null (no co-location key).
      const s = await lockSessionRow(sessionId)
      if (!s || s.status === 'exited' || !s.cwd) return null
      return s.cwd
    }
    // Unified messaging (#237): the one send path. Sender is
    // stamped by each surface from its authenticated caller; issue-addressed
    // sends dual-write the legacy issue_messages mirror so inbox/claim/pending
    // keep working until those readers migrate.
    // Principal-resolved at accept and apply time; queued rows retain attribution.
    // producer: the delivery service gets its apply-time port and the gate gets
    // its resolution-time ceiling, and MessageGate refuses at boot if they are
    // not the same object. Today's ceiling is the single-user maximum, so this
    // wiring changes no behaviour — what it changes is that the queued-send
    // rejection path (ADR 3 D8 / Amendment 1 D16) is now LIVE end to end rather
    // than only unit-tested against the handler, so POD-1075's real ceiling
    // arrives at a composition root that already carries it.
    const messagesSvc = new MessageDeliveryService({
      soleActiveMember: async () => {
        const sole = await this.store.users.soleActiveMember()
        return sole ? asUserId(sole.id) : undefined
      },
      // RECOVERY: rows stored before per-message attribution were the first admin's.
      legacyRowOwner: () => firstAdminMemberId(this.store),
      authorizeAtApply: mail.authorizeAtApply,
      // POD-1193: wake resumes/spawns on the target session's machine — enforce
      // `use` at delivery. Same principalMailPolicy object as the ceiling port.
      placementAtWake: mail.placementAtWake,
      messages: this.store.messages,
      notificationFacts: this.store.notificationFacts,
      events: this.store.events,
      issues,
      sessions: sessionsSvc,
      isAgentDriven: (sessionId) => sessionsSvc.receiptSender.onContract(sessionId),
      mirrorIssueMail: async (row) =>
        await funnel.run({ write: async () => await this.store.issues.addIssueMessage(row) }),
      // The READING session's owner marks it read (POD-6291), never the first
      // admin; a delivery to nobody moves only the shared delivery state.
      mirrorMarkIssueMailRead: async (issueId, ids, reader) =>
        await funnel.run({
          write: async () =>
            await this.store.issues.markIssueMessagesRead(
              reader ? ((await this.store.sessions.getSession(reader))?.ownerUserId ?? null) : null,
              issueId,
              ids,
              new Date().toISOString(),
            ),
        }),
      // The service's own accounts (POD-6602); every other messages write
      // takes the writer of whoever asked.
      writers: {
        daemon: writes.system('messages.daemon'),
        delivery: writes.system('messages.delivery'),
      },
      // Spawn-on-wake (#237): an unresumable wake
      // spawns a fresh agent on the target issue through the SAME machinery
      // issue_start rides (createSession); the service then queues the message
      // as the child's first prompt. Authz (gate.send write check) → spawn
      // budget → cooldown all bite before this seam is reached.
      spawnOnWake: makeSpawnOnWake({
        issues,
        createSession: async (o) =>
          await sessionsSvc.createSession({ ...o, requestTerminalDriver: true }),
      }),
      // Cross-machine provenance [POD-658]: name the sender's machine in the
      // envelope note so the receiver knows to `podium workspace fetch`.
      machineName: async (id) =>
        (await machines.listMachines()).find((m) => m.id === id)?.name ?? id,
      programVersion: async (sessionId, program) => {
        const session = await sessionsSvc.readSessionFactsById(sessionId)
        if (!session) return undefined
        const machine = await this.store.machines.getMachine(session.machineId)
        return machine?.harnessVersions?.find((report) => report.harness === program)?.version
      },
      now: () => new Date(this.now()).toISOString(),
    })
    const locks = new LockService({
      locks: this.store.locks,
      transact: async (fn) => await this.store.transact(fn),
      // NOT THROUGH THE AUTHORITY (POD-6419). A lease is server-local: a lock
      // write publishes no change (the funnel was handed ``),
      // and a lock write from a person or an agent is a plain command, whose
      // scope gives it no Authority (ADR 12 D8). Its own `transact` is the unit.
      funnel: {
        run: async (op) => {
          await op.authorize?.()
          return await op.write()
        },
      },
      now: () => this.now(),
      resolveRepoId: async (repoPath) => await this.store.repos.resolveRepoIdForPath(repoPath),
      // HOLDER liveness: does the row still exist? A hibernated holder is
      // parked, not dead, and keeps its lease (session-exit.test.ts).
      sessionAlive: async (sessionId) => {
        const s = await lockSessionRow(sessionId)
        return !!s && s.status !== 'exited'
      },
      // WAITER liveness: can it take a grant? A hibernated session polls
      // nothing, so it is pruned like an exited one (POD-3807) and re-queues
      // itself when it wakes. Only a running session can, and a running
      // session is resident, so memory answers.
      sessionRunning: (sessionId) => {
        const s = liveSessions.get(asSessionId(sessionId))
        return !!s && s.status !== 'exited' && s.status !== 'hibernated'
      },
      sessionWorkspace,
      // Grant/steal notices are messages to the holder's issue (POD-4846);
      // best-effort by contract (the waiter also discovers the grant by polling).
      // The SERVER's own write (POD-6419): a lock write is a plain command,
      // whose scope refuses synced writes; the notice it triggers is not one.
      sendMail: async (issueId, from, body) => {
        try {
          await asSystemWrite(
            async () =>
              await systemIssueNotice(
                messagesSvc,
                writes.system('messages.server'),
                from,
              )(issueId, body),
          )
        } catch {}
      },
      appendEvent: async (e) => {
        await this.store.events.appendEvent(e)
      },
    })
    const lockCommands = new LockCommandDispatcher({
      locks,
      issues,
      sessionWorkspace,
      operatorLocks: this.capabilities.operatorLocks,
    })
    this.bus.on('session.exited', ({ sessionId }) => locks.releaseForSession(sessionId))
    // THE CONCERTMASTER (POD-7211): the mark on a session, and the curated
    // conversation its person reads instead of the transcript. Behind the
    // `concertmaster` feature, read on every call.
    const concertmaster = new ConcertmasterService({
      entries: this.store.concertmaster,
      enabled: () => featureEnabled('concertmaster'),
      now: () => this.now(),
      mint: () => randomUUID().slice(0, 8),
      session: async (sessionId) => {
        const row = await this.store.sessions.getSession(sessionId)
        return row === undefined
          ? undefined
          : {
              concertmaster: row.concertmaster === true,
              agentKind: row.agentKind,
              headless: row.headless === true,
              deleted: Boolean(row.deletedAt),
            }
      },
      setMark: async (writer, sessionId, on) =>
        await sessionsSvc.setConcertmaster(writer, { sessionId, concertmaster: on }),
      send: async (writer, from, input) => await messagesSvc.send(writer, from, input),
      message: async (id) => await messagesSvc.message(id),
    })
    // A person's message joins that conversation once its delivery is
    // confirmed, after the delivery's commit and never inside it.
    this.concertmasterDelivered = new DeliveredMessageWatch({
      enabled: () => featureEnabled('concertmaster'),
      subscribe: (listener) => this.store.messages.committed.subscribe(listener),
      record: async (sessionId, messageId) =>
        await asSystemWrite(async () => await concertmaster.recordDelivered(sessionId, messageId)),
    })
    // Both people hear about a reassignment in their own inbox (POD-6287).
    // Best effort: the reassignment has committed, and a lost notice must not
    // turn it into an error the caller would retry.
    noticeReassignment = async (facts) => {
      const names = new Map<UserId, string>()
      for (const id of [facts.from, facts.to, facts.by]) {
        names.set(id, (await this.store.users.get(id))?.displayName ?? id)
      }
      for (const notice of reassignmentNotices(facts, (id) => names.get(id) ?? id)) {
        try {
          await messagesSvc.send(writes.system('messages.server'), notice.sender, notice.input)
        } catch (err) {
          log.warn('reassignment notice not delivered', {
            err,
            issueId: facts.issueId,
            recipient: notice.recipient,
          })
        }
      }
    }
    queuedApplyHooks.spawnPrompt = async (writer, input) =>
      await messagesSvc.recordSpawnPrompt(writer, input)
    queuedApplyHooks.continueSession = autoContinueSender(messagesSvc)
    queuedApplyHooks.ownerPrompt = async (writer, input) =>
      await messagesSvc.recordOwnerPrompt(writer, input)
    queuedApplyHooks.sessionsRemoved = async (scope, sessionIds, opts) =>
      await messagesSvc.failMessagesToRemovedSessions(scope, sessionIds, opts)
    queuedApplyHooks.handingOn = async (writer, messageId, sessionId) =>
      await messagesSvc.onQueuedInputHandingOn(writer, messageId, sessionId)
    queuedApplyHooks.applied = async (messageId, sessionId) =>
      await messagesSvc.onQueuedInputApplied(messageId, sessionId)
    queuedApplyHooks.provenLate = async (messageId, sessionId) =>
      await messagesSvc.onQueuedInputProvenLate(messageId, sessionId)
    queuedApplyHooks.idMatched = async (messageId, sessionId, proof) =>
      await messagesSvc.onQueuedInputIdMatched(messageId, sessionId, proof)
    queuedApplyHooks.disprovenLate = async (messageId, sessionId, reason, cause) =>
      await messagesSvc.onQueuedInputDisprovenLate(messageId, sessionId, reason, cause)
    queuedApplyHooks.accepted = async (messageId, sessionId, held) =>
      await messagesSvc.onQueuedInputAccepted(messageId, sessionId, held)
    queuedApplyHooks.injected = async (messageId, sessionId) =>
      await messagesSvc.onQueuedInputInjected(messageId, sessionId)
    queuedApplyHooks.unconfirmed = async (messageId, sessionId, reason) =>
      await messagesSvc.onQueuedInputUnknown(messageId, sessionId, reason)
    queuedApplyHooks.rejected = async (messageId, reason, cause) =>
      await messagesSvc.rejectQueuedInput(messageId, reason, cause)
    queuedApplyHooks.abandoned = async ({ sessionId, turnIds, reason }) =>
      await messagesSvc.onQueueDrainAbandoned(sessionId, turnIds, reason)
    // A live busy send can be in the message ledger without a SessionInbox row.
    // The exit event is the real boundary that hands that row to the durable FIFO.
    // The session inbox withdrew the row on the daemon's word (or no daemon
    // ever had it): the one way a queued message becomes cancelled (POD-4776).
    queuedApplyHooks.interrupted = async (messageId) =>
      await messagesSvc.onQueuedInputWithdrawn(messageId)
    queuedApplyHooks.typing = async (messageId, sessionId) =>
      await messagesSvc.onQueuedInputTyping(messageId, sessionId)
    queuedApplyHooks.interruptedPending = async (sessionId, messageId) => {
      try {
        await messagesSvc.cancelPendingOperatorMessage(
          writes.system('messages.delivery'),
          sessionId,
          messageId,
        )
      } catch (error) {
        // A concurrent boundary delivery or retraction can win the guarded
        // cancellation. Storage and notification failures must reach the caller.
        if (!(error instanceof Error) || error.message !== 'message is no longer queued') {
          throw error
        }
      }
    }
    // Event-complete delivery eligibility: every durable session
    // or issue metadata transition lands here after commit. Session upserts cover
    // bind/live, resume-ref, attachment/CWD and draft changes; issue upserts cover
    // worktree/archive/target-resolution changes. The service coalesces by target.
    this.bus.on('oplog.appended', async ({ changes }) => {
      // ISSUE CHANGES GO IN ONE BATCH (POD-1597). Per change, the recompute walks
      // every session and resolves each against every issue; the boot catch-up
      // arrives here as ONE batch of every issue there is, so per-change cost
      // squared the world and cost 573s of a 668s boot on the live database.
      // The issue half of a mixed batch is therefore recomputed AFTER the session
      // half rather than interleaved with it; both only queue targets into the
      // scheduler's coalescing map, which is flushed once, after this handler.
      const changedIssueIds: string[] = []
      for (const change of changes) {
        if (change.entity === 'session') {
          await messagesSvc.onSessionEligibilityChanged(
            // `EntityChangeSpec.id` is polymorphic by `entity` (an issue id for
            // 'issue', a session id here), so the brand is recovered inside the
            // discriminated branch — the same rule as MessageRow's `toId`.
            asSessionId(change.id),
            change.op === 'upsert' ? (change.value as SessionMeta) : undefined,
          )
        } else if (change.entity === 'issueProjection') {
          // Own issue facts contain every change mail eligibility reads:
          // worktree, archive, close and machine placement.
          changedIssueIds.push(change.id)
        }
      }
      await messagesSvc.onIssuesEligibilityChanged(changedIssueIds)
    })
    // The routing before-state arrives with the change (POD-6160): what a
    // moved session resolved to before, and the worktree a moved issue left.
    this.bus.on('session.routingChanged', async ({ previous }) => {
      await messagesSvc.onSessionRoutingChanged(previous)
    })
    this.bus.on('issue.worktreeMoved', async ({ issueId, previousWorktreePath }) => {
      await messagesSvc.onIssuesEligibilityChanged(
        [issueId],
        new Map([[issueId, previousWorktreePath]]),
      )
    })
    const workflows = new WorkflowService(
      {
        store: this.store.workflows,
        now: () => new Date(this.now()).toISOString(),
        // The caller's own session: a calling agent runs, so it is resident.
        session: (sessionId) => {
          const s = liveSessions.get(sessionId)
          return s
            ? {
                sessionId: s.sessionId,
                cwd: s.cwd,
                ...(s.issueId ? { issueId: s.issueId } : {}),
                agentKind: s.agentKind,
                machineId: s.machineId,
              }
            : undefined
        },
        // Any session, running or parked (POD-6160).
        readSession: async (sessionId) => {
          const s = await sessionsSvc.records.ownershipOf(sessionId, 'workflows')
          return s
            ? {
                sessionId: s.sessionId,
                cwd: s.cwd,
                ...(s.issueId ? { issueId: s.issueId } : {}),
                agentKind: s.agentKind,
                machineId: s.machineId,
              }
            : undefined
        },
        issue: async (issueId) => {
          const issue = await issues.reports?.getMeta(issueId)
          // Only `worktreePath` is read (workflows' step-placement check); the id /
          // repoId / repoPath this used to also carry had no reader (POD-367).
          return issue ? { worktreePath: issue.worktreePath } : undefined
        },
        repoIdForPath: async (path) => await this.store.repos.resolveRepoIdForPath(path),
        agentProfile: async (ref) => await agentProfiles.find(ref),
        // A run a spawn starts commits on the feed's mirror origin, inside
        // whichever operation spawned the session; a workflow command commits
        // on the command's own writer (POD-6676).
        changes: writes.system('feed.workflows'),
        notifyCoordinator: async (sessionId, text) => {
          await messagesSvc.send(
            writes.system('messages.server'),
            { kind: 'system', name: 'workflow' },
            {
              to: { kind: 'session', id: sessionId },
              body: text,
              kind: 'notification',
              // #471: fyi is the only urgency that currently waits for a turn boundary.
              urgency: 'fyi',
              lifecycle: 'wait',
            },
          )
        },
      },
      {
        /**
         * THE RUN-SCOPED IDEMPOTENCY LEDGER (POD-731), backed by the product's
         * existing `applied_mutations` table rather than by a second mechanism —
         * the same store the outbox write path already treats as "a replay of an
         * already-applied mutation returns its recorded result instead of
         * re-running". The workflow key namespaces it by command and run, so a
         * mutation id replayed against another run is a different delivery.
         */
        /**
         * RESOLVED IN FRONT OF THE DECISION, NOT INSIDE IT (POD-3221 ruling on
         * rule 51 case 2). `ownerOf` and `hasGrant` are durable reads now, and
         * widening WorkflowOwnershipPort is the one conversion that must not
         * happen: `workflowDecision` asks both in boolean positions, where a
         * promise makes the owner arm silently DENY (`Promise === string` is
         * false) and the grant arm silently ALLOW EVERYONE (a promise is
         * truthy). Two halves failing in opposite directions on an authorization
         * predicate. Keeping the decision synchronous makes that impossible.
         *
         * So this reads the facts for the entities one pass is about to decide
         * on, and hands back a plain synchronous view. It is called per command
         * and never cached across commands: a stale owner or a stale grant
         * PERMITS MORE — it would authorize a principal whose ownership moved or
         * whose grant was revoked — and that is the direction rule 49 forbids
         * failing in.
         *
         * ABSENCE IS DENIAL, deliberately. An entity that resolved no row is
         * `null` here, which is exactly what ADR 9 D4 already means by an
         * unowned row: nobody's, not everyone's, admin-only. So a miss, a
         * partial load, or an entity nobody remembered to name all land on the
         * closed side rather than the open one.
         */
        resolveOwnership: async (entities) => {
          const owners = new Map<string, string | null>()
          const grants = new Set<string>()
          const key = (entity: { kind: string; id: string }) => `${entity.kind}\u0000${entity.id}`
          for (const entity of entities) {
            const entityKey = key(entity)
            if (owners.has(entityKey)) continue
            owners.set(entityKey, await this.store.workflows.ownerOf(entity.kind, entity.id))
            for (const grant of await this.store.grants.loadForResource(entity.kind, entity.id)) {
              grants.add(`${grant.grantee}\u0000${entityKey}\u0000${grant.verb}`)
            }
          }
          return {
            ownerOf: (entity) => owners.get(key(entity)) ?? null,
            hasGrant: (user, entity, verb) =>
              grants.has(`${user}\u0000${key(entity)}\u0000${verb}`),
          }
        },
        machinesFor: async (workflowPrincipal) => {
          let principal: CommandPrincipal | undefined
          if (workflowPrincipal.onBehalfOf === null) {
            return {
              mayUse: () => false,
              isReachable: (machineId: MachineId) => machines.hasDaemon(machineId),
            }
          }
          if (workflowPrincipal.actor.startsWith('session:')) {
            const sessionId = asSessionId(workflowPrincipal.actor.slice('session:'.length))
            try {
              principal = await principalForCapability(
                await sessionsSvc.capabilityForSession(sessionId),
              )
            } catch {
              principal = undefined
            }
          } else {
            const userId = asUserId(workflowPrincipal.onBehalfOf)
            const role = await this.store.users.roleOf(userId)
            principal = role ? userCommandPrincipal(userId, role) : undefined
          }
          const ownership = await ownershipSnapshotFromMachines(machines)
          return {
            mayUse: (machineId: MachineId) =>
              principal !== undefined &&
              checkMachineUse(principal, machineId, ownership) === undefined,
            isReachable: (machineId: MachineId) => machines.hasDaemon(machineId),
          }
        },
        ledger: {
          recall: async (key) => await this.store.sync.getAppliedMutation(asMutationId(key)),
          record: async (key, result) =>
            await this.store.sync.recordAppliedMutation(
              asMutationId(key),
              'workflows',
              result,
              this.now(),
            ),
        },
      },
    )
    sessionInstructions.register({
      source: 'podium:issues',
      prepare: async () => ({ content: ISSUE_SYSTEM_POINTER }),
    })
    // The seat (POD-6108, D5): whether this session talks to the user or asks a
    // coordinator. Fixed at spawn like every source; `prime` carries the current
    // line when a coordinator appears later.
    sessionInstructions.register({
      source: 'podium:seat',
      prepare: async ({ sessionId, issueId }) =>
        issueId ? { content: seatText(await issues.reports.seatFor(sessionId, issueId)) } : null,
    })
    sessionInstructions.register({
      source: 'podium:workflow',
      prepare: async ({ sessionId, cwd, issueId, workflowRevisionId, existingOnly }) => {
        if (!featureEnabled('workflows')) return null
        const prepared = existingOnly
          ? await workflows.prepareExistingSession({
              sessionId,
              ...(issueId ? { issueId } : {}),
            })
          : await workflows.prepareStart({
              sessionId,
              cwd,
              ...(issueId ? { issueId } : {}),
              ...(workflowRevisionId ? { explicitRevisionId: workflowRevisionId } : {}),
            })
        if (!prepared) return null
        return {
          content: prepared.prompt,
          ...(!existingOnly
            ? {
                afterSpawn: async () => {
                  await workflows.startRun({
                    sessionId,
                    onBehalfOf: (await sessionsSvc.sessionOwner(sessionId))?.owner ?? null,
                    cwd,
                    ...(issueId ? { issueId } : {}),
                    revisionId: prepared.revision.id,
                  })
                },
              }
            : {}),
        }
      },
    })
    // A Concertmaster's rules (POD-7211), for a marked session that is started
    // again. A session is marked after it exists, so a first start has none; the
    // mark itself briefs the running agent, and `prime` carries the rules too.
    sessionInstructions.register({
      source: 'podium:concertmaster',
      prepare: async ({ sessionId }) =>
        (await concertmaster.isConcertmaster(sessionId)) ? { content: CONCERTMASTER_RULES } : null,
    })
    // LAST, so it layers after the issue rules and seat text (flight deck D4):
    // the registry keeps registration order.
    sessionInstructions.register({
      source: 'podium:profile',
      prepare: async ({ agentProfileId }) => {
        const content = await agentProfiles.instructionsFor(agentProfileId)
        return content ? { content } : null
      },
    })
    const workflowModules = new LifecyclePort<RegistryModules>('registry workflow entries')
    const messageGate = new MessageGate(
      {
        messages: messagesSvc,
        issues,
        sessionById: async (sessionId) => await sessionsSvc.sessionById(sessionId),
        machineOnline: (machineId) => machines.hasDaemon(machineId),
        // A session's mail is its own owner's (POD-6284): the row, not its task.
        sessionOwnerUserId: async (sessionId) =>
          (await this.store.sessions.getSession(sessionId))?.ownerUserId,
        messageRecords: async (userId, ids, transcriptSessionId) =>
          await readMessageRecords(
            { messages: this.store.messages, sessions: this.store.sessions },
            userId,
            ids,
            transcriptSessionId,
          ),
        mutations,
        // Cross-harness subagent spawn (#237): the
        // child is a FULL Podium session through the one spawn path; --new is the
        // deliberate issue-create path (never automatic).
        awaitMachineInventory: async (machineId) => await machines.waitForInventory(machineId),
        launchCredential: async (ref, owner) => await sessionsSvc.launchCredential(ref, owner),
        spawnSession: async (o) =>
          await sessionsSvc.createSession({
            requestTerminalDriver: true,
            ownerUserId: o.ownerUserId,
            cwd: o.cwd,
            agentKind: o.agentKind as AgentKind,
            ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
            ...(o.model !== undefined ? { model: o.model } : {}),
            ...(o.effort !== undefined ? { effort: o.effort } : {}),
            ...(o.issueId ? { issueId: o.issueId } : {}),
            ...(o.spawnedBy ? { spawnedBy: o.spawnedBy } : {}),
            ...(o.machineId ? { machineId: o.machineId } : {}),
            // Spawner-prescribed curated name.
            ...(o.name ? { name: o.name } : {}),
            ...(o.workflowRunId ? { workflowRunId: o.workflowRunId } : {}),
            ...(o.workflowStepId ? { workflowStepId: o.workflowStepId } : {}),
            ...(o.agentProfileId ? { agentProfileId: o.agentProfileId } : {}),
            ...(o.credentialId !== undefined ? { credentialId: o.credentialId } : {}),
          }),
        findAgentProfile: async (ref) => await agentProfiles.find(ref),
        resolveWorkflowStepLaunch: async ({ caller, cwd, ...step }) => {
          const pinned = await workflows.agentProfileForStep({
            ...step,
            ...(caller
              ? {
                  caller: await workflowCallerForCapability(
                    caller.capability,
                    caller.overrideScope,
                  ),
                }
              : {}),
          })
          if (!pinned) return null
          const launch = await agentProfiles.launch({
            profileId: pinned.id,
            pinned,
            fields: {},
            cwd,
          })
          return {
            profile: { id: pinned.id, name: pinned.name },
            agentKind: launch.agentKind,
            model: launch.model,
            effort: launch.effort,
            machineId: launch.machineId,
          }
        },
        // mail.spawnAgent --new: inside the mail command, with its writer.
        createIssue: async (writer, o) =>
          await issues.crud.create(writer, { ...o, startNow: false }),
        appendEvent: async (e) => {
          await this.store.events.appendEvent(e)
        },
        now: () => new Date(this.now()).toISOString(),
        // Bounded-wait seam, absent unless a fixture injected one (see
        // SessionRegistryOptions.mailAwait).
        ...(options.mailAwait?.pollMs !== undefined
          ? { awaitPollMs: options.mailAwait.pollMs }
          : {}),
        ...(options.mailAwait?.sleep ? { sleep: options.mailAwait.sleep } : {}),
        // Parent-await consume-on-ack (POD-917/POD-923): clear the session-parent
        // wake sticky when the parent observes the child settled, so a later
        // genuine re-completion can re-fire once. Matches NotificationArbiter.retire.
        retireNotificationFact: async (factKey, target) => {
          await this.store.notificationFacts.retire(
            factKey,
            target,
            new Date(this.now()).toISOString(),
          )
        },
        // The mail writes go through the sync write entry point (POD-6525);
        // read per call, because the entry point is composed after the gate.
        // Before the module set exists (boot), a write dispatches directly.
        syncWrite: () => workflowModules.read().syncWrite,
        // An agent's spawn is a `session.launch` record its write creates
        // (POD-6525); the adapter waits for it.
        spawnRecord: {
          refuseUnplaceable: async (principal, input) => {
            if (principal.kind === 'system') throw new Error('a system principal spawns no agent')
            await refuseUnplaceable(workflowModules.read(), principal, {
              cwd: input.cwd,
              ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
              ...(input.agentKind !== undefined ? { agentKind: input.agentKind as AgentKind } : {}),
            })
          },
          create: async (writer, principal, launch) =>
            await createSpawnLaunchInUnit(workflowModules.read(), writer, principal, launch),
          settled: async (effectId) => await settledSpawnLaunch(workflowModules.read(), effectId),
        },
      },
      mail.gateOptions,
    )
    const readToolkit = new SessionReadToolkit({
      // Select on facts, wire only the survivors [POD-3857]; every selection is
      // a narrow read of the sessions it can name (POD-6160).
      readSessionFactsByIds: async (ids) => await sessionsSvc.readSessionFactsByIds(ids),
      readSessionFactsByIdPrefix: async (prefix) =>
        await sessionsSvc.readSessionFactsByIdPrefix(prefix),
      readSessionFactsByBirthRef: async (ref) => await sessionsSvc.readSessionFactsByBirthRef(ref),
      readSessionFactsByIssue: async (worktreePath, issueId) =>
        await sessionsSvc.readSessionFactsByIssue(worktreePath, issueId),
      readSessionFactsSpawnedBy: async (parentIds) =>
        await sessionsSvc.readSessionFactsSpawnedBy(parentIds),
      sessionById: async (sessionId) => await sessionsSvc.sessionById(sessionId),
      sessionsById: async (sessionIds) => await sessionsSvc.sessionsById(sessionIds),
      issues,
      messages: messagesSvc,
      sessionRefs: async (sessions) => await readSessionRefs(this.store, sessions),
      machineName: async (machineId) => await machines.machineName(machineId),
      machineOnline: (machineId) => machines.hasDaemon(machineId),
      events: this.store.events,
      // Tier-3 recap watermarks persist per (reader, target).
      watermarks: this.store.readWatermarks,
      repoOp: async (op, cwd, machineId) => await rpc.repoOp(op, cwd, undefined, machineId),
      readTranscript: async (input) =>
        await rpc.readTranscript(input, {
          kind: 'system',
          id: 'session-read-toolkit',
        }),
      now: () => new Date(this.now()).toISOString(),
    })

    const issueAttach = new IssueAttachOrchestrator({
      transact: async (work) => await this.store.transact(work),
      attention: issues.attention,
    })

    // Scheduled automations (#470). The spawn goes straight to
    // SessionLifecycle.createSession with its own provenance tag (the tRPC
    // `sessions.create` proc stamps spawnedBy 'user'), and the prompt rides the
    // durable outbox — see AutomationsService.spawn for why not initialPrompt.
    // A session still occupying the machine (anything but exited/hibernated)
    // makes the next occurrence a skipped_overlap rather than a pile-up.
    const automationService = new AutomationsService({
      store: this.store.automations,
      machines,
      ledger: writes.system('automations.schedule'),
      createSession: async (o) =>
        await sessionsSvc.createSession({ ...o, requestTerminalDriver: true }),
      // A run's prompt is its owner's message (POD-4846): stored, typed without a
      // frame, attributed to the automation, followed by its delivery status.
      deliverPrompt: automationPromptSender({
        messages: messagesSvc,
        writer: writes.system('automations.schedule'),
        sessionById: async (sessionId) => await sessionsSvc.sessionById(sessionId),
      }),
      createIssue: async (o) => {
        const issue = await issues.crud.create(writes.system('automations.schedule'), {
          ...o,
          startNow: false,
          origin: 'agent',
          audience: 'human',
        })
        await issues.crud.update(writes.system('automations.schedule'), issue.id, {
          stage: 'in_progress',
        })
        return { id: issue.id }
      },
      liveSessionIds: async () =>
        new Set(sessionsSvc.runningSessionFacts().map((s) => s.sessionId)),
      principalForOwner: async (ownerUserId) => {
        const role = await this.store.users.roleOf(ownerUserId)
        return role ? userCommandPrincipal(ownerUserId, role) : undefined
      },
      mayUseDefaultMachine: async (principal) => {
        const ownership = await ownershipSnapshotFromMachines(machines)
        return checkMachineUse(principal, await machines.defaultMachine(), ownership) === undefined
      },
      // An automation runs only into its owner's own sessions (POD-6284).
      sessionOwnerUserId: async (sessionId) =>
        (await this.store.sessions.getSession(sessionId))?.ownerUserId,
      now: () => new Date(this.now()),
    })
    // Approval broker (#410): agent-requested management ops.
    // An approval is an effect record with a human gate (POD-6674): its executor
    // registers below with the other effect kinds.
    const approvals = new ApprovalService({
      effects: this.store.effects,
      writer: writes.system('approvals.results'),
      nowMs: this.now,
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      // The stall deadline runs only while a machine's daemon is actually attached:
      // `toMachine` queues for an absent one, so that frame is parked, not lost.
      hasDaemon: (machineId) => machines.hasDaemon(machineId),
      // An approval is its session owner's (POD-6284): only they decide it.
      sessionOwnerUserId: async (sessionId) =>
        (await this.store.sessions.getSession(sessionId))?.ownerUserId,
      personActive: async (userId) => {
        const user = await this.store.users.get(userId)
        return user !== undefined && user !== null && !user.disabledAt
      },
      // A decider must also hold the operation's own permission, read live
      // (POD-6674 review): `modules/approvals/op-permission.ts`.
      opPermission: {
        machineVerb: async (principal, machineId, verb) =>
          checkMachineVerb(
            principal,
            machineId,
            await ownershipSnapshotFromMachines(machines),
            verb,
          ) === undefined,
        workflowWrite: async (principal, revisionId) =>
          principal.kind !== 'system' &&
          (await workflows.targetRefusal(
            await workflowCallerForCapability(principal.capability),
            'publish',
            { revisionId },
          )) === undefined,
        sessionOwner: async (sessionId) =>
          (await this.store.sessions.getSession(sessionId))?.ownerUserId,
      },
      personPrincipal: async (userId) => {
        const user = await this.store.users.get(userId)
        if (!user || user.disabledAt) return undefined
        return userCommandPrincipal(asUserId(user.id), user.role)
      },
      activeAdmins: async () =>
        [...(await this.store.users.activeAdminIds())].map((id) =>
          userCommandPrincipal(asUserId(id), 'admin'),
        ),
      sessionIssueId: async (sessionId) => {
        const s = await sessionsSvc.sessionById(sessionId)
        return s ? (s.issueId ?? (await issues.reports.issueForCwd(s.cwd))) : null
      },
      issueInfo: async (issueId) => {
        const row = await issues.reports.getMeta(issueId)
        if (!row) return null
        const prefix = await this.store.repos.prefixForPath(row.repoPath)
        return {
          seq: row.seq,
          title: row.title,
          displayRef: prefix ? formatIssueRef(prefix, row.seq) : `#${row.seq}`,
        }
      },
      machineName: async (machineId) =>
        (await machines.listMachines()).find((m) => m.id === machineId)?.name,
      // RETURNED, not discarded [POD-3806]. `sendMail` opens its own store
      // transaction and `ApprovalService.notify` awaits this; the `void` here
      // dropped the promise, so under the async store executor the mail joined
      // whatever span the decision was running inside and died orphaned when the
      // span closed. Same shape as the lock bug (POD-3802).
      notifyIssue: async (issueId, body) => {
        await systemIssueNotice(
          messagesSvc,
          writes.system('messages.server'),
          'approval-broker',
        )(issueId, body)
      },
      executeServerOp: async (op, sessionId) => {
        const caller = await workflowCallerForCapability(
          await sessionsSvc.capabilityForSession(sessionId),
        )
        if (op.kind === 'workflow-publish') {
          // The approval broker's server-side ops enter by the SAME door every
          // transport uses (POD-732) — the deleted `publish`/`assign` shims were
          // its only other way in, and a server op that skipped the contract's
          // parse would be the one caller whose input nobody validated.
          const revision = await workflows.execute(
            caller,
            'publish',
            { revisionId: op.revisionId },
            // Its rows and their change entries commit on the approval's origin.
            { writer: writes.system('approvals.execute') },
          )
          return `published workflow revision ${revision.id}`
        }
        if (op.kind === 'workflow-set-default') {
          // The binding's generic edit runs the same assign (POD-6676); a server
          // op parses its input like every caller of it.
          const binding = await workflows.assign(
            caller,
            workflowAssignInput.parse({
              targetKind: op.targetKind,
              targetId: op.targetId,
              revisionId: op.revisionId,
            }),
            writes.system('approvals.execute'),
          )
          return `set ${binding.targetKind} workflow default to revision ${binding.revisionId}`
        }
        if (op.kind === 'automation-schedule') {
          const existingSessionId =
            op.target.kind === 'current'
              ? sessionId
              : op.target.kind === 'session'
                ? op.target.sessionId
                : null
          const existing =
            existingSessionId === null ? null : await sessionsSvc.sessionById(existingSessionId)
          if (existingSessionId !== null && !existing) {
            throw new Error(`unknown target session: ${existingSessionId}`)
          }
          const fresh = op.target.kind === 'fresh' ? op.target : null
          const principal = await resolvePrincipalAsync(
            await sessionsSvc.capabilityForSession(sessionId),
            {
              parentSessionOf: async (candidate) =>
                spawnedByParentSessionId(await sessionsSvc.sessionSpawnedBy(candidate)),
              onBehalfOfFor: async (candidate) =>
                (await sessionsSvc.sessionOwner(candidate))?.owner,
            },
          )
          // ONE ANSWER to "which agent, model and effort?" (POD-1107). This site
          // used to hardcode 'codex' and 'auto', so a one-off scheduled with no
          // explicit agent ignored the operator's configured default harness
          // while issue-create honoured it. Continuing an existing session still
          // wins outright — that session's harness is already running.
          // The defaults of the person the automation runs for (POD-6285).
          const settings = await this.store.settings.getSettingsFor(
            onBehalfOfUser(principal) ??
              (await soleMemberFor(this.store.users, 'a scheduled automation')),
          )
          const spawnDefaults = resolveSpawnDefaults(settings, {
            agentKind: existing?.agentKind ?? fresh?.agentKind,
          })
          const selection = resolveLaunchSelection({
            agentKind: spawnDefaults.agentKind,
            explicit: { model: fresh?.model ?? 'auto', effort: fresh?.effort ?? 'auto' },
            settings,
            // Scheduling snapshots defaults without probing; spawn vets the selected host's row.
            catalog: null,
          })
          // An approved server op, run by its approval record after the
          // decision committed: the server's own write on the requester's
          // behalf (ADR 12 D2), under its declared origin.
          const scheduled = await automationService.create(
            writes.system('approvals.execute'),
            {
              name: op.name,
              scheduleKind: 'once',
              cron: null,
              runAt: op.runAt,
              targetSessionId: existingSessionId,
              repoPath: existing?.cwd ?? fresh?.repoPath ?? null,
              agentKind: spawnDefaults.agentKind,
              model: fresh?.model === 'auto' ? 'auto' : selection.model,
              effort: fresh?.effort === 'auto' ? 'auto' : selection.effort,
              prompt: op.prompt,
              enabled: true,
              sessionMode: existingSessionId === null ? 'fresh' : 'resume',
            },
            principal,
          )
          return `scheduled one-off automation ${scheduled.id} for ${scheduled.runAt}`
        }

        return null
      },
      logEvent: async (kind, issueId, payload) => {
        try {
          await this.store.events.appendEvent({
            ts: new Date().toISOString(),
            kind,
            subject: issueId ?? 'approvals',
            payload,
          })
        } catch {}
      },
    })
    // Commands are assembled immediately before Shipping, but handlers run only
    // after construction. Bind the narrow service port through one initialized-
    // once cell instead of making either module construct the other. The cell
    // is a declaration like any other, so the audit still orders this edge —
    // a definite-assignment `!` would have hidden it (POD-1411).
    const shippingCell: { current?: ShippingService } = {}
    const shippingPort = (): ShippingService => {
      const service = shippingCell.current
      if (!service) throw new Error('shipping port used before the service was constructed')
      return service
    }
    const issueCommands = new IssueCommandDispatcher({
      // An effect record's run writes as the issue service's own work, after its
      // record committed (POD-6603); no served command runs without its own.
      effectRunWriter: writes.system('issues.server'),
      // Git actions as effect records (POD-6394), read per call: the modules
      // and the entry point are composed after this dispatcher.
      gitEffects: issueGitEffectPort({ modules: workflowModules.read }),
      // Relayed and MCP issue writes through the entry point (POD-6413).
      syncWrite: () => workflowModules.read().syncWrite,
      // Start, stop, sessions, cleanup, ship, assistant as effect records (POD-6414).
      workEffects: issueWorkEffectPort({ modules: workflowModules.read }),
      // Adding, publishing and removing artifacts as effect records (POD-6420).
      artifactEffects: issueArtifactEffectPort({
        modules: workflowModules.read,
        record: async (id) => await this.store.effects.get(id),
      }),
      arbitration: issueArbitration,
      attachSession: async (caller, input) => await issueAttach.execute(caller, input),
      issues,
      shipping: {
        enqueueCurrent: async (writer, input) => await shippingPort().enqueueCurrent(writer, input),
        resolveHold: async (writer, input) => await shippingPort().resolveHold(writer, input),
        cancel: async (writer, input) => await shippingPort().cancel(writer, input),
        deliveryReceipt: async (input) => await shippingPort().deliveryReceipt(input),
      },
      deleteIssue: async (writer, id, by) =>
        await issueSessionLifecycle.deleteIssue(writer, id, by),
      restoreIssue: async (writer, id) => await issueSessionLifecycle.restoreIssue(writer, id),
      mutations,
      // The by-id read [POD-1646]: one session, not the full pass.
      sessionById: async (sessionId) => await sessionsSvc.sessionById(sessionId),
      // The narrow issue read [POD-1639] — `issues.get` embeds its members, as
      // its reader may read them (POD-6285).
      listSessionsForIssue: async (worktreePath, issueId, forUser) =>
        await sessionsSvc.listSessionsForIssue(
          worktreePath,
          issueId,
          forUser ? await sessionsSvc.view.principalForTrustedUser(forUser) : undefined,
        ),
      // The execution-private task fields' facts (design §4.2, POD-6288).
      executionFacts: {
        rows: async (ids) => await readIssues(this.store.issues, ids),
        store: { grants: this.store.grants, sessions: this.store.sessions },
      },
      // A task mailbox read outside the caller's subtree shows only the mail
      // the caller may read (POD-6284, POD-6288).
      mailVisibleIds: async (capability, ids) => await messageGate.visibleMailIds(capability, ids),
      // Starting work in a task's worktree needs `use` there (POD-6296, Q4).
      machineStanding: async (principal, machineId) => {
        const ownership = await ownershipSnapshotFromMachines(machines)
        const row = ownership.rowFor(machineId)
        return {
          use: checkMachineUse(principal, machineId, ownership) === undefined,
          custodian: row ? machineCustodian(row.grants) : null,
          name: row?.name || machineId,
        }
      },
      repoPaths: async () => await this.store.repos.listRepoPaths(),
      inferRepoFromPath: async (path) =>
        inferRepoFromRoots(await this.store.repos.listRepoPaths(), path),
      // mailSend rides the unified substrate (#237).
      sendMessage: async (writer, from, input) => await messagesSvc.send(writer, from, input),
      // mailSend's old doors answer with the hand-on after its commit (POD-6525).
      mailHandOnOf: async (messageId) => await messagesSvc.handOnOf(messageId),
      // Tray answer delivery (issue #53): the shared answer_question matching
      // path, with text fallback — no live menu means the answer arrives as the
      // answerer's own message, which wakes a parked session (POD-4846).
      answerSessionQuestion: async (writer, sessionId, answer, caller) => {
        // Answering an agent's question is driving it (design §2.3, POD-6283):
        // only the session's own human may, even on someone else's task.
        if (!(await sessionsSvc.mayReachSession(caller.capability, sessionId))) {
          return {
            ok: false,
            message: 'only the person this agent works for can answer its question',
          }
        }
        const r = await deliverAnswerToSession(
          {
            getSession: async (id) => await sessionsSvc.sessionById(id),
            sessions: sessionsSvc,
            messages: messagesSvc,
            writer,
            rpc: {
              readTranscript: async (input) =>
                await rpc.readTranscript(input, {
                  kind: 'system',
                  id: 'issue-answer-delivery',
                }),
            },
          },
          {
            sessionId,
            answer,
            principal: await sessionsSvc.inboxPrincipalForCapability(caller.capability),
            textFallback: true,
          },
        )
        return r.ok ? { ok: true, via: r.via } : r
      },
      isConcertmaster: async (sessionId) => await concertmaster.isConcertmaster(sessionId),
      // issue stop: park every member session + free worktree.
      stopIssueSessions: async (input) => await issueSessionLifecycle.stopIssue(input),
    })
    this.issues = issues
    this.bus.on('machine.diagnostic', async (diagnostic) => {
      await routeMachineDiagnostic(diagnostic, {
        recipients: async (machineId) => {
          const owner = await machines.effectiveOwner(machineId)
          return [
            ...(owner ? [asUserId(owner)] : []),
            ...(await this.store.users.list())
              .filter((user) => user.role === 'admin')
              .map((user) => asUserId(user.id)),
          ]
        },
        repoPath: async (machineId) =>
          (await this.store.repos.listRepoPaths(machineId))[0] ??
          (await this.store.repos.listRepoPaths())[0],
        issueExists: async (id) => (await readIssue(this.store.issues, id)) !== null,
        createIssue: async (input) =>
          await issues.crud.create(writes.system('issues.server'), input),
        sendMail: async (issueId, body) =>
          await systemIssueNotice(
            messagesSvc,
            writes.system('messages.server'),
            'machine-diagnostic',
          )(issueId, body),
        notify: (ownerUserId, notice) => notify.notifyExternal(notice, ownerUserId),
        warn: (message) => log.warn(message),
      })
    })
    this.issueCommands = issueCommands
    const shippingWorkerIncarnation = randomUUID()
    const shippingLocks = new Map<string, Set<string>>()
    const shippingLockKey = (orderId: string, attemptId: string, generation: number) =>
      `${shippingWorkerIncarnation}:${orderId}:${attemptId}:${generation}`
    const shippingLockCaller = (
      orderId: string,
      attemptId: string,
      generation: number,
      issueId: IssueId,
    ) => ({
      sessionId: shippingResourceHolderId(
        shippingWorkerIncarnation,
        orderId,
        attemptId,
        generation,
      ),
      issueId,
      label: `Shipping ${orderId} attempt ${generation}`,
      workspace: null,
    })
    // Repo base branch → instance default → main, for the issue's repo [POD-2065].
    const shippingPolicy = new CompatibilityShippingPolicyResolver(async (issue) => {
      const instance = (await this.store.settings.getSettings()).gitWorkflow.defaultParentBranch
      const repo = issue.repoPath
        ? await this.store.repos.defaultParentBranchForIssueRepo(issue.repoPath, issue.machineId)
        : null
      return repo || instance.trim() || 'main'
    })
    const shippingEvidence = new ShippingEvidenceRegistry(this.store.shipping)
    const shipwright = new ShipwrightService({
      headless,
      settingsFor: async (userId) => await settings.getSettingsFor(userId),
      modelCatalog: async (machineId) => await settings.getModelCatalog(machineId),
      quota: async (machineId) => (await rpc.agentQuota(false, machineId)).agents,
      nativeAccountId: async (machineId, agent, requested) =>
        requested === `native:${agent}`
          ? await machines.harnessLoginAccountId(machineId, agent)
          : requested,
      validationProfile: async (issue) => (await shippingPolicy.resolve(issue)).validationProfile,
      evidence: {
        materialize: async (input) => {
          const materialized: import('@podium/model').ShipwrightEvidenceRef[] = []
          for (const ref of input.refs) {
            const existing = await shippingEvidence.resolve({
              sourceRef: ref,
              order: input.order,
              attempt: input.attempt,
              custody: input.custody,
              authority: input.authority,
            })
            if (existing) {
              materialized.push(existing)
              continue
            }
            const resolved = await rpc.shippingEvidence(
              input.authority,
              ref,
              256 * 1024,
              input.custody.machineId,
            )
            if (!resolved.ok || resolved.content === undefined) {
              throw new Error(resolved.error ?? 'shipping evidence was refused')
            }
            materialized.push(
              await shippingEvidence.materialize({
                sourceRef: ref,
                content: resolved.content,
                order: input.order,
                attempt: input.attempt,
                custody: input.custody,
                authority: input.authority,
              }),
            )
          }
          return materialized
        },
      },
      context: async (input, limits) => {
        const content: string[] = []
        let remaining = Math.min(limits.maxContextBytes, limits.maxFailureBytes)
        for (const ref of input.failure.artifactRefs) {
          if (remaining <= 0) break
          const resolved = await shippingEvidence.read(input, ref, remaining)
          content.push(resolved)
          remaining -= Buffer.byteLength(resolved)
        }
        return { output: content.join('\n'), relevantDiff: '' }
      },
      applyPatch: shipwrightApplyPatchThroughRelay(rpc),
    })
    /** SHIPPING'S LIFECYCLE CONTRACT (design §2.2, POD-6288): every member
     *  edits every task, but only its assignee or an admin ships it. */
    const mayShipTask = async (
      humanId: string,
      role: import('@podium/model').UserRole,
      issueId: string,
    ): Promise<boolean> =>
      role === 'admin' || (await readIssue(this.store.issues, issueId))?.ownerUserId === humanId
    const shipping = new ShippingService({
      workspaceId: this.store.workspaceId,
      repository: this.store.shipping,
      // The lease projection is process-owned memory installed behind a
      // `ledger.commit` that may be a savepoint inside a wider span, so it waits
      // for the OUTERMOST commit through the same port the ledger's commit
      // applications do [POD-3366, spec §3.3 mechanism 1].
      applyCommit: { spanOpen, onCommit: applyAfterCommit },
      issues: {
        get: async (id) => {
          const issue = await issues.reports.get(id)
          if (!issue) throw new Error(`unknown issue ${id}`)
          return issue
        },
        children: async (id, recursive) => await issues.reports.children(id, recursive),
        shippingCommit: async (writer, id, mutation, write) =>
          await issues.crud.shippingCommit(writer, id, mutation, write),
        shippingCommitMany: async (writer, entries, write) =>
          await issues.crud.shippingCommitMany(writer, entries, write),
        takeBranchCustody: async (issue) => {
          const stopped = await issueSessionLifecycle.stopIssue({
            issueId: issue.id,
            principal: systemPrincipal('shipping-custody'),
          })
          const live = await issues.reports.get(issue.id)
          const freed = live?.worktreePath == null
          return {
            ok: stopped.ok && freed,
            detail:
              stopped.reason ??
              (freed
                ? `Podium has custody of ${issue.branch ?? issue.displayRef ?? issue.id}`
                : 'write-capable sessions or a non-clean worktree still own the source branch'),
          }
        },
      },
      ledger: writes.system('shipping.lanes'),
      daemon: rpc,
      authorization: {
        attribution: (principal) => {
          if (principal.kind === 'user') {
            return {
              actor: actorUser(principal.user),
              onBehalfOf: principal.user,
            }
          }
          if (principal.kind === 'agent') {
            return {
              actor: actorAgent(asAgentIdentityId(principal.agentSessionId)),
              onBehalfOf: principal.onBehalfOf,
            }
          }
          return { actor: actorSystem(principal.job), onBehalfOf: null }
        },
        authorize: async ({ principal, action, issue, overrideScope }) => {
          // SHIPPING IS A LIFECYCLE COMMAND (design §2.2, POD-6288): editing a
          // task is every member's, shipping it is its assignee's or an
          // admin's. Receipt reads are reads of a shared task.
          const assertMayShip = async (
            humanId: string,
            role: import('@podium/model').UserRole,
          ): Promise<void> => {
            if (await mayShipTask(humanId, role, issue.id)) return
            throw new Error(`only the task's assignee or an admin may ${action} a shipping order`)
          }
          if (principal.kind === 'system') {
            throw new Error(`system job ${principal.job} cannot ${action} a shipping order`)
          }
          const humanId = onBehalfOfUser(principal)
          if (!humanId) throw new Error('shipping command has no human authorization owner')
          const liveRole = await this.store.users.roleOf(humanId)
          if (!liveRole) throw new Error(`shipping requester ${humanId} is no longer active`)
          // Shipping writes intersect an agent's live delegated subtree with
          // the human owner's current rights. Receipt reads are not scoped
          // writes: they use only the active human's current owner/grant read.
          if (action !== 'read-receipt') {
            await checkIssueAccess(
              { capability: principal.capability, overrideScope },
              issueAccess,
              `shipping.${action}`,
              'write',
              issue.id,
            )
          }
          // overrideScope can acknowledge a write outside the agent subtree; it
          // never widens the human owner's current account rights.
          await checkIssueAccess(
            { capability: userCommandPrincipal(humanId, liveRole).capability },
            issueAccess,
            `shipping.${action}.owner`,
            action === 'read-receipt' ? 'read' : 'write',
            issue.id,
          )
          if (action !== 'read-receipt') await assertMayShip(humanId, liveRole)
        },
        reauthorize: async ({ order, issue, machineId, effect }) => {
          const attribution = order.requestedBy
          const userId = attribution.onBehalfOf
          if (!userId) throw new Error('shipping order has no human authorization owner')
          const role = await this.store.users.roleOf(userId)
          if (!role) throw new Error(`shipping requester ${userId} is no longer active`)
          const humanPrincipal = userCommandPrincipal(userId, role)
          let principal: CommandPrincipal
          if (attribution.actor.kind === 'agent') {
            const sessionId = asSessionId(attribution.actor.id)
            principal = await principalForCapability(
              await sessionsSvc.capabilityForSession(sessionId),
            )
            if (principal.kind !== 'agent' || principal.onBehalfOf !== userId) {
              throw new Error('shipping requester delegation no longer matches its original actor')
            }
          } else if (attribution.actor.kind === 'user') {
            if (attribution.actor.id !== userId)
              throw new Error('shipping requester attribution no longer matches its user')
            principal = userCommandPrincipal(userId, role)
          } else {
            throw new Error(`shipping requester actor ${attribution.actor.kind} cannot own effects`)
          }
          await checkIssueAccess(
            { capability: principal.capability },
            issueAccess,
            `shipping.${effect}`,
            'write',
            issue.id,
          )
          if (principal.kind === 'agent') {
            await checkIssueAccess(
              { capability: humanPrincipal.capability },
              issueAccess,
              `shipping.${effect}.owner`,
              'write',
              issue.id,
            )
          }
          if (!(await mayShipTask(userId, role, issue.id))) {
            throw new Error(
              `shipping requester ${userId} is no longer the task's assignee or an admin`,
            )
          }
          const machineAccess = checkMachineUse(
            principal,
            machineId,
            await ownershipSnapshotFromMachines(machines),
          )
          if (machineAccess) {
            throw new Error(
              machineAccess === 'absent'
                ? `shipping machine ${machineId} is unavailable`
                : `shipping requester may no longer use machine ${machineId}`,
            )
          }
        },
      },
      evidence: {
        rootIntegrationReceipt: async (rootIssueId, approvedHeadSha) =>
          await this.store.shipping.rootIntegrationReceipt(rootIssueId, approvedHeadSha),
        // Slice 1 has no accepted-review repository yet. Compatibility policy
        // explicitly permits this typed boundary to return no accepted record.
        acceptedReviewEvidence: async () => null,
      },
      policy: shippingPolicy,
      repair: shipwright,
      background: false,
      resourceAdmission: {
        acquire: async ({ order, attempt, issue, names, ttlSeconds }) => {
          const key = shippingLockKey(order.id, attempt.id, attempt.leaseGeneration)
          const caller = shippingLockCaller(order.id, attempt.id, attempt.leaseGeneration, issue.id)
          const held = shippingLocks.get(key) ?? new Set<string>()
          shippingLocks.set(key, held)
          for (const name of [...new Set(names)].sort()) {
            const result = await locks.acquire(caller, {
              repoPath: issue.repoPath,
              name,
              ttlSeconds,
              note: `exact landing for ${order.id}`,
            })
            if (result.granted) {
              held.add(name)
              continue
            }
            // Preserve FIFO admission when the first resource is busy. If a
            // later resource blocks, cancel that waiter before releasing the
            // sorted prefix so a granted suffix can never deadlock the prefix.
            if (held.size > 0) {
              try {
                await locks.cancel(caller, {
                  repoPath: issue.repoPath,
                  name,
                })
              } catch {}
            }
            for (const acquired of [...held]) {
              try {
                await locks.release(caller, {
                  repoPath: issue.repoPath,
                  name: acquired,
                })
              } catch {}
              held.delete(acquired)
            }
            shippingLocks.delete(key)
            return false
          }
          return true
        },
        renew: async ({ order, attempt, issue, names, ttlSeconds }) => {
          const key = shippingLockKey(order.id, attempt.id, attempt.leaseGeneration)
          const caller = shippingLockCaller(order.id, attempt.id, attempt.leaseGeneration, issue.id)
          const held = shippingLocks.get(key)
          if (!held || names.some((name) => !held.has(name))) {
            shippingLocks.delete(key)
            return false
          }
          try {
            for (const name of [...new Set(names)].sort()) {
              await locks.renew(caller, {
                repoPath: issue.repoPath,
                name,
                ttlSeconds,
              })
            }
            return true
          } catch {
            shippingLocks.delete(key)
            return false
          }
        },
        release: async ({ order, attempt, issue, names }) => {
          const key = shippingLockKey(order.id, attempt.id, attempt.leaseGeneration)
          const caller = shippingLockCaller(order.id, attempt.id, attempt.leaseGeneration, issue.id)
          const held = shippingLocks.get(key)
          for (const name of [...new Set(names)].sort().reverse()) {
            if (!held?.has(name)) continue
            await locks.release(caller, {
              repoPath: issue.repoPath,
              name,
            })
            held.delete(name)
          }
          if (held?.size === 0) shippingLocks.delete(key)
        },
      },
      machineFor: async (issue) =>
        issue.machineId ?? (await machines.pickMachineForRepo(undefined, issue.repoPath)),
      machineCapabilities: async (machineId) =>
        (await machines.listMachines()).find((machine) => machine.id === machineId)?.deliveryCaps ??
        [],
      resolveBranchTip: async (issue) => {
        if (!issue.branch) throw new Error(`issue ${issue.id} has no branch`)
        const machineId =
          issue.machineId ?? (await machines.pickMachineForRepo(undefined, issue.repoPath))
        const result = await rpc.repoOp(
          'revParseVerify',
          issue.repoPath,
          { ref: `refs/heads/${issue.branch}` },
          machineId,
        )
        const tip = result.ok ? result.output.trim().split(/\s+/)[0] : undefined
        if (!tip) {
          throw new Error(
            `could not freeze ${issue.displayRef ?? issue.id} branch tip: ${result.output}`,
          )
        }
        return tip
      },
      resolveRefTip: async (issue, ref) => {
        const machineId =
          issue.machineId ?? (await machines.pickMachineForRepo(undefined, issue.repoPath))
        const result = await rpc.repoOp(
          'revParseVerify',
          issue.repoPath,
          { ref: `refs/heads/${ref}` },
          machineId,
        )
        const tip = result.ok ? result.output.trim().split(/\s+/)[0] : undefined
        if (!tip) {
          throw new Error(`could not freeze target ${ref}: ${result.output}`)
        }
        return tip
      },
      isAncestor: async (issue, ancestorSha, descendantSha) => {
        const machineId =
          issue.machineId ?? (await machines.pickMachineForRepo(undefined, issue.repoPath))
        const result = await rpc.repoOp(
          'isMergedInto',
          issue.repoPath,
          { branch: ancestorSha, parentBranch: descendantSha },
          machineId,
        )
        return result.ok
      },
      now: () => new Date(this.now()).toISOString(),
      audit: async (kind, issueId, payload) => {
        try {
          await this.store.events.appendEvent({
            ts: new Date(this.now()).toISOString(),
            kind,
            subject: issueId,
            repoPath: (await readIssue(this.store.issues, issueId))?.repoPath ?? null,
            payload,
          })
        } catch {}
      },
    })
    // Close the late-bound edge the command dispatcher above reaches through.
    shippingCell.current = shipping
    this.shipping = shipping
    this.bus.on('machine.connected', () => {
      void shipping
        .reconcile()
        .catch((error) => log.warn('shipping machine recovery deferred', { err: error }))
    })
    // Layout service is composed here (not reached from tRPC via sessionStore) so
    // the transport only names familyState(ctx).modules.layout — router-triple-access.
    const layout = new LayoutService({
      layout: this.store.layout,
    })
    // THE SYNC WRITE ENTRY POINT (ADR 12 D2, POD-6273), over the one dedup ledger,
    // the one write-seam Ledger and the store's unit of work. It starts with no
    // registrations: the outbox commands move onto it in POD-6350, the rest in
    // POD-6359, each family registering on `syncWrite.registry`.
    // ONE-SHOT EFFECTS AS DATA (ADR 12 D5 E2, POD-6357). Every write to the
    // effects table reaches the feed inside its own transaction; the runner is
    // the one after-commit trigger and the recovery sweep. Kinds register their
    // executors on `modules.effects.executors`.
    this.store.effects.setFeedCapture(makeEffectFeedCapture(writes.system('feed.effects')))
    this.effectsRunner = new EffectsRunner({
      repo: this.store.effects,
      writer: writes.system('effects.runner'),
      registry: effectExecutors,
      now: this.now,
    })
    /**
     * Write one effect record, in the caller's unit of work when one is open:
     * the kind's schema and deadline apply, and the trigger runs it after the
     * commit (never for a rollback). For the server's own records and for a sync
     * command whose handler asks for an effect as part of its write (a dock
     * shell's start, POD-6419), attributed to whoever the caller names. Written
     * through `writer` (ADR 12 D9): the command's own, or a declared origin's.
     */
    const createEffectInUnit = async (
      writer: Pick<LedgerWriter, 'commit'>,
      effect: {
        readonly id: string
        readonly kind: string
        readonly target: EffectTarget
        readonly input: unknown
        readonly createdBy: UserId | null
        readonly actor: string
      },
    ) => {
      const executor = effectExecutors.get(effect.kind)
      if (executor === undefined) throw new Error(`effects: no executor for ${effect.kind}`)
      const now = this.now()
      const insert = async (scope: WriteScope) =>
        await this.store.effects.insert(
          scope,
          {
            id: effect.id,
            kind: effect.kind,
            target: effect.target,
            input: executor.input.parse(effect.input),
            deadlineAt: now + executor.deadlineMs,
            createdBy: effect.createdBy,
            actor: effect.actor,
          },
          now,
        )
      return (await writer.commit({ write: insert })).result
    }
    const syncWrite = new SyncWriteEntry({
      registry: new SyncWriteRegistry(),
      mutations,
      legacyFallback: (id, human) =>
        legacyMutationFallback(id, human, {
          owner: boot.legacyReceiptOwner,
          before: boot.legacyReceiptCutoff,
        }),
      unitOfWork: async (fn) => await this.store.transact(fn),
      afterCommit: (step, label) => this.store.effect(step, label),
      spanOpen,
      writer: (mutationId) => writes.sync(mutationId),
      receipt: async () => await this.writeReceiptNow(),
    })
    // Same composition seam for the read-cursor family (POD-1380).
    const readPosition = new ReadPositionService({
      cursors: this.store.readPositions,
    })
    // Server-owned dock-shell mapping (POD-4436): per user, per worktree →
    // shell session, so the same dock shell opens on every device. Its write
    // runs on the sync write entry point (POD-6419): the shell's start is a
    // `session.launch` effect record created in that write, and the spawn runs
    // after the commit. A mapped shell whose start is still pending or running
    // is live: its row is born when the start succeeds.
    const dockShells = new DockShellService({
      dockShells: this.store.dockShells,
      sessions: {
        sessionById: async (sessionId) => {
          const view = await sessionsSvc.sessionById(sessionId)
          if (view !== undefined) return view
          const launch = await this.store.effects.newestOnTarget(
            SESSION_LAUNCH_KIND,
            { kind: 'session', id: sessionId },
            'active',
          )
          return launch === undefined
            ? undefined
            : { sessionId, agentKind: 'shell', archived: false, status: 'starting' }
        },
        createShell: async ({ writer, sessionId, cwd, ownerUserId, machineId, actor }) => {
          await createEffectInUnit(writer, {
            id: mintDeviceId('eff_'),
            kind: SESSION_LAUNCH_KIND,
            target: { kind: 'session', id: sessionId },
            input: { agentKind: 'shell', cwd, ...(machineId ? { machineId } : {}) },
            createdBy: ownerUserId,
            actor: actor ?? ownerUserId,
          })
          return { sessionId }
        },
        archiveSession: (writer, sessionId) =>
          sessionsSvc.state.setArchived(writer, sessionId, true),
      },
    })

    /**
     * DURABLE OPERATIONS, AND THE ONE KIND THIS BINARY KNOWS (POD-2097/POD-2098).
     *
     * The registry is named on the module seam precisely so this registration is
     * a line a reviewer can see rather than a reach-through from inside the
     * engine. Registering `update` here — next to the `UpdatesService` it drives
     * — is what turns "an update" from four independently polled facts into one
     * object with an id, a plan and an outcome (spec §3.0/§3.1).
     */
    // Declared before the engine it reads and after the service it drives, which
    // is the only order the cycle allows: the engine's `onChanged` has to be
    // able to reach the reconciler, and the reconciler has to be able to ask the
    // engine whether an operation is active. Both reads are lazy, so neither
    // half captures the other's construction moment.
    const updateReconciliation = new LifecyclePort<
      Pick<UpdateReconciler, 'onOperationStarted' | 'onOperationSettled'>
    >('update transition reconciliation')
    const operationsModule = createOperations({
      store: this.store.operations,
      startCleanupJanitor: !backgroundDisabled,
      onChanged: updateOperationObserver(updatesService, updateReconciliation.read),
    })
    operationsModule.kinds.register(updateOperationKind())
    operationsModule.kinds.register(serverMoveOperationKind(serverTransfer))
    operations = operationsModule
    /**
     * The wave's own events are the operation's heartbeat (§3.3). Wired to the
     * daemon frames and the connection edges rather than to a poll, so a step's
     * liveness is a fact about the fleet and not about who happens to be
     * watching the panel.
     */
    const updateFleetBridge = createUpdateFleetBridge({
      engine: operationsModule.engine,
      updates: updatesService,
    })
    // A PUBLISH, A RE-RESOLVE OR A WITHDRAWAL, all three (POD-3040). It does the
    // ordinary fleet pass and, before it, corrects any deferred promise the
    // moved target has just falsified — including one left by an update that
    // already finished, which is what an all-offline fleet always leaves.
    targetChanged = async () => {
      await updateFleetBridge.onTargetChanged()
    }
    /**
     * THE STANDING RECONCILIATION (§3.6, POD-2105). Offline machines are
     * `deferred` at plan time so an update can finish without them; this is what
     * converges them afterwards, on their own reconnect, with no operation and
     * no second click.
     */
    const updatesReconciler = new UpdateReconciler({
      updates: updatesService,
      operationActive: async () =>
        (await operationsModule.engine.active(LIFECYCLE_EXCLUSION_GROUP)) !== undefined,
    })
    updateReconciliation.install(updatesReconciler)
    const reconciler = updatesReconciler
    this.bus.on('machine.connected', ({ machineId }) => {
      // The daemon's hello — and therefore the version it just booted with — is
      // already recorded by the time this fires: `recordHelloBuild` precedes
      // `attachDaemon` in the handshake, and `attachDaemon` is what emits this.
      // Independent: the bridge projects the active operation; the reconciler
      // checks operationActive before granting and keeps its queue paused while
      // that operation owns the fleet. EventBus.emit observes this promise but
      // deliberately does not wait for either task (rule 51 case 3).
      return Promise.all([
        updateFleetBridge.onFleetChanged(),
        reconciler.onMachineConnected(machineId),
      ])
    })
    this.bus.on('machine.disconnected', () => updateFleetBridge.onFleetChanged())

    /**
     * THE PendingInteraction AGGREGATE (POD-2020, spec §4).
     *
     * Composed HERE, after `sessionsSvc` and `rpc`, because answering routes
     * through the existing delivery gate and synthesis reads the transcript
     * tail. Its two inputs are BUS SUBSCRIPTIONS, not calls from anywhere:
     * nothing in the existing state-change or session-exit paths knows this
     * module exists, which is what makes "the aggregate observes; existing UI
     * behavior is unchanged" structural rather than careful.
     */
    const interactionFeed = new InteractionFeedPublisher({
      ledger: writes.system('feed.interactions'),
    })
    this.store.interactions.setFeedCapture(interactionFeed.capture)
    const interactions = new InteractionService({
      store: this.store.interactions,
      // A sign-in ask on a session that runs on a credential names it (§7).
      loginProviderForSession: async (sessionId) => {
        const credentialId = (await sessionsSvc.sessionById(sessionId))?.credentialId
        if (!credentialId) return undefined
        const label = (await this.store.credentials.get(credentialId))?.label
        return label ? `The credential "${label}"` : undefined
      },
      now: () => new Date(this.now()).toISOString(),
      /**
       * THE FAMILY IS ALREADY A SESSION PROJECTION. It is resolved from the
       * harness manifest when the session metadata is built; handing that
       * declaration-backed fact to the interaction aggregate keeps the state
       * shadow from guessing based on a driver id.
       */
      driverFamilyForSession: async (sessionId) =>
        (await sessionsSvc.sessionById(sessionId))?.driverFamily,
      /**
       * PROVENANCE FOR THE FAILURE PATH (POD-2414 re-verdict P2/7, narrowed by
       * the third pass).
       *
       * Read from the store directly because the gate is private to the session
       * wiring. Ownership means the causal stream ALREADY REPORTED THE FAILURE
       * being shadowed, so the aggregate drops the compatibility `errored` copy
       * of it rather than racing it. Durable on purpose: an in-memory bit lost
       * this across a restart.
       *
       * IT IS NOT ENOUGH THAT A CHECKPOINT EXISTS, which is what this asked
       * before. Every accepted coarse event checkpoints, so a terminal
       * runtime-contract session emitting only `state`/`turn/completed` claimed
       * ownership of failures it never reported, and its `errored` recovery ask
       * was suppressed into silence. The checkpoint supplies the TURN; the
       * event log supplies the FAILURE.
       */
      causalFailuresOwned: async (sessionId) => {
        const checkpoint = await this.store.events.runtimeEventCheckpoint(sessionId)
        if (!checkpoint) return false
        return await this.store.events.hasCausalTurnFailure(sessionId, checkpoint.turnEpoch)
      },
      deliver: async (input) =>
        await deliverAnswerToSession(
          {
            getSession: async (id) => await sessionsSvc.sessionById(id),
            sessions: sessionsSvc,
            messages: messagesSvc,
            writer: writes.system('messages.server'),
            rpc: {
              readTranscript: async (readInput) =>
                await rpc.readTranscript(readInput, { kind: 'system', id: 'interaction-answer' }),
            },
          },
          input,
        ),
      readTranscript: async (input) =>
        await rpc.readTranscript(input, { kind: 'system', id: 'interaction-synthesis' }),
      policyPrincipal: () => SYSTEM_INBOX_PRINCIPAL,
      /**
       * THE SCREEN-READ MENU'S ANSWER ROUTE (POD-2414).
       *
       * Same keystroke path `deliver` ends in; what differs is where the
       * options come from. A dialog the CLI draws itself — Claude's onboarding
       * and trust prompts, which is the operator complaint this issue names —
       * has no AskUserQuestion in the transcript, so the transcript route can
       * neither read its options nor match an answer against them, and refused
       * every answer to a session it could see was blocked.
       */
      deliverNativeMenu: async (input) => {
        const state = (await sessionsSvc.sessionById(input.sessionId))?.agentState
        return deliverToNativeMenu(
          {
            getState: () => state,
            // An answer run after its record committed: the server's own.
            answer: (answerInput) =>
              sessionsSvc.answerAskUserQuestion({
                ...answerInput,
                writer: sessionsSvc.serverWriter,
              }),
          },
          input,
        )
      },
      /**
       * STRUCTURED DELIVERY (POD-2023) — the route W2 declared and W5 shipped.
       *
       * A `structured` ask came from a protocol driver, so answering it means
       * replying over that driver's own protocol rather than typing at a menu.
       * The runtime gateway already owns that round-trip (`runtimeAnswer` →
       * `runtimeAnswerRequest` → the session's driver), so this is the wiring
       * and nothing else — which is why the aggregate takes a port instead of
       * learning what a driver is.
       *
       * `answer as Record<string, unknown>` is the contract's own signature at
       * this seam: the frame carries an open record and the DRIVER narrows it
       * against the ask it holds, because only the driver knows which harness
       * request id this answers. Narrowing here would mean the server deciding
       * the shape of a reply it does not send.
       */
      /**
       * An ask owned by a runtime binding is answered by that binding; menu
       * identity stays with the driver that holds the ask.
       */
      contractRouted: async (sessionId) => {
        // THE INTERNAL LIVE SESSION, not `sessionById`. The public projection
        // deliberately omits `hasBoundDriver` (POD-3739), so the predicate read
        // through it would be permanently false and this port would never route
        // anything — a silent no-op the type checker caught and the focused
        // tests could not, because they stub this port.
        const session = sessionsSvc.sessions.get(sessionId)
        return session?.hasBoundDriver === true
      },
      deliverStructured: async (input) =>
        await sessionsSvc.inbox.deliverInteractionAnswer(
          { ...input, writer: sessionsSvc.serverWriter },
          () =>
            sessionsSvc.runtimeGateway.answer({
              sessionId: input.sessionId,
              interactionId: input.interactionId,
              principal: { kind: input.principal.kind, ref: input.principal.principalRef },
              answer: input.answer as unknown as Record<string, unknown>,
            }),
        ),
    })
    interactionsRef = interactions
    /**
     * THE PROTOCOL ASK INGRESS, BOUND (POD-2023).
     *
     * A server-family driver's asks arrive as `runtimeInteractionAsked` frames
     * and land in the aggregate with the DRIVER's own id, `source: 'protocol'`
     * and `answerable: 'structured'` — the fields the driver already set,
     * carried rather than re-derived. Nothing here synthesizes: a protocol ask
     * has a real request id, which is the identity `hasReliableIdentity`
     * branches on when it decides whether to dedupe by fingerprint.
     */
    sessionsSvc.interactionAnswer = (input) => interactions.answerChoices(input)
    sessionsSvc.pendingQuestion = async (sessionId) =>
      (await interactions.listOpen(sessionId)).find((row) => row.kind === 'question') ?? null
    sessionsSvc.interactionAsk = (msg) => {
      // LOGGED, NOT SWALLOWED (POD-2023 review, 7.2). This frame is classified
      // `control.entity` on the argument that "a dropped one would leave a
      // session blocked with nothing on any surface saying so" — so a write that
      // REJECTS is exactly the case the classification is about, and dropping it
      // into an unhandled rejection would make the aggregate's own failure the
      // one thing nobody is told about.
      void interactions
        .ask({ interaction: { ...msg.interaction, sessionId: msg.sessionId } })
        .catch((err: unknown) => {
          log.error('protocol interaction ask failed to reach the aggregate', {
            err,
            sessionId: msg.sessionId,
            kind: msg.interaction.kind,
          })
        })
    }
    /**
     * THE FAILURE SINK, BOUND (POD-2414).
     *
     * Every coarse turn boundary the runtime event gate commits reaches the
     * aggregate: a `needs-human` failure opens an ask, and a turn that starts or
     * completes closes the stale login/recovery row it left behind. AWAITED by
     * the gate's projector — its durable cursor does not advance until this
     * resolves — which is what makes a failure survive a crash between the
     * event's commit and its materialization.
     *
     * The provider hint is the session's own harness, so a `login` ask names the
     * credential a person actually has to refresh instead of echoing a failure
     * reason back at them.
     */
    sessionsSvc.interactionTurn = async (msg) => {
      const provider = (await sessionsSvc.sessionById(msg.sessionId))?.agentKind
      return await interactions.onTurnEvent({
        sessionId: msg.sessionId,
        ev: msg.ev,
        at: msg.at,
        ...(provider ? { provider } : {}),
      })
    }
    /**
     * THE RESOLUTION SINK, BOUND (POD-2414). A protocol ask answered inside the
     * harness's own UI retires here; without it the aggregate could only ever
     * open one of those rows.
     */
    sessionsSvc.interactionResolved = async (msg) => {
      await interactions.onInteractionResolved(msg)
    }
    // Retain the interaction reaction in the frame's operation, including its async reads and writes.
    this.bus.on('session.stateChanged', async (e) => {
      await interactions.onStateChanged({ sessionId: e.sessionId, prev: e.prev, next: e.next })
    })
    this.bus.on('session.exited', async (e) => await interactions.onSessionExited(e.sessionId))
    // CREDENTIAL HEALTH ON THE SESSION STREAM (§7, §8). An error that names the
    // credential (a rejection, a limit) is noted; a turn boundary runs a restart
    // or stop that was waiting for it.
    this.bus.on('session.stateChanged', ({ sessionId, prev, next, ownerUserId }) => {
      const boundary = CREDENTIAL_TURN_BOUNDARY.has(next.phase)
      const enteredError = next.phase === 'errored' && next.error && prev?.phase !== 'errored'
      if (!(boundary && !CREDENTIAL_TURN_BOUNDARY.has(prev?.phase ?? 'unknown')) && !enteredError) {
        return
      }
      void (async () => {
        const credentialId = (await sessionsSvc.sessionById(sessionId))?.credentialId ?? null
        if (enteredError && next.error && credentialId) {
          const failure = classifyCredentialFailure({ errorClass: next.error.class })
          if (failure !== 'other') {
            await credentialHealth.noteFailure({
              credentialId,
              failure,
              reason: formatAgentError(next.error),
              ...(ownerUserId ? { actorUserId: ownerUserId } : {}),
              sessionId,
            })
          }
        }
        if (boundary) await credentialHealth.onTurnBoundary(sessionId, credentialId)
      })().catch((err: unknown) => {
        log.warn('credential health on a session state change failed', { sessionId, err })
      })
    })
    this.modules = {
      superagentToolsWriter: this.writes.system('superagent.tools'),
      superagentTurnsWriter: this.writes.system('superagent.turns'),
      superagentBridgeWriter: this.writes.system('superagent.bridge'),
      effects: {
        executors: effectExecutors,
        runner: this.effectsRunner,
        get: async (id) => await this.store.effects.get(id),
        awaitSettled: async (id, timeoutMs) =>
          await awaitEffectSettled(this.store.effects, id, timeoutMs),
        newestOnTarget: async (kind, target, phase) =>
          await this.store.effects.newestOnTarget(kind, target, phase),
        createAsSystem: async (effect) =>
          await createEffectInUnit(writes.system('effects.system'), {
            ...effect,
            createdBy: null,
            actor: attributionOf(systemPrincipal(effect.job)).actor,
          }),
        createInUnit: async (writer, effect) => await createEffectInUnit(writer, effect),
      },
      bus: this.bus,
      funnel,
      sessions: sessionsSvc,
      machines,
      checkouts: this.checkouts,
      updates: updatesService,
      operations: operationsModule,
      updatesReconciler: reconciler,
      updateFleetBridge,
      rpc,
      costs: new CostService(this.store, rpc),
      credentialHealth,
      credentialSwitch,
      chatgptPlan,
      serverTransfer,
      loginPropagation,
      nativeLogin,
      homeSignIn,
      memory,
      hosts,
      settings,
      layout,
      syncWrite,
      dockShells,
      readPosition,
      headless,
      reactions,
      notify,
      notices,
      concertmaster,
      issues,
      agentProfiles,
      shipping,
      issueSessionLifecycle,
      sessionLifecycleController,
      issueCommands,
      approvals,
      interactions,
      workflows,
      locks,
      lockCommands,
      messages: messagesSvc,
      messageGate,
      readToolkit,
      issueArtifacts,
      pendingUploads,
      automations: automationService,
      perf,
      logs,
      clientLogLevels,
      fleetLogs,
      fleetLogLevels,
      mutations,
    }
    workflowModules.install(this.modules)
    // THE OUTBOX COMMANDS ON THE ENTRY POINT (ADR 12 D2, POD-6350): every command
    // the apps queue is registered on `syncWrite`, each family with its own
    // target resolver and handler. Registered once the modules exist, because the
    // session and issue handlers reach them per call.
    const syncFamilyDeps = {
      modules: () => this.modules,
      roleOf: async (user: UserId) => await this.store.users.roleOf(user),
    }
    registerOutboxCommands(syncWrite.registry, syncFamilyDeps)
    // The rest of the synced writes, family by family (POD-6359).
    const fleetRepos = new RepoRegistry(this, this.store)
    const processReadState: HostState = { hosts, rpc, issues, repos: fleetRepos }
    processTopic.installReaders({
      roots: (id) => memoryBreakdownRoots(processReadState, id),
      reclaim: (id) =>
        HOST_COMMANDS_TRPC.reclaimInventory.handler(processReadState, { machineId: id }),
      fallback: (id) =>
        HOST_COMMANDS_TRPC.memoryBreakdown.handler(processReadState, { machineId: id }),
    })
    registerFamilyCommands(syncWrite.registry, {
      ...syncFamilyDeps,
      fleet: {
        repos: () => fleetRepos,
        store: () => this.store,
        servesHub: () => options.servesHub !== false,
      },
    })
    // The generic create, edit and remove of every declared synced kind (ADR 12
    // D3, POD-6391), beside the queued commands they replace one by one.
    registerRecordCommands(syncWrite.registry, {
      modules: () => this.modules,
      store: () => this.store,
    })
    registerEffectCommands(syncWrite.registry, {
      repo: this.store.effects,
      executors: effectExecutors,
      now: this.now,
    })
    // The effect kinds (POD-6394..6396): each family registers its executors.
    registerIssueGitEffects({ modules: () => this.modules })
    // The issue commands that act on machines (POD-6414).
    registerIssueWorkEffects({ modules: () => this.modules, users: this.store.users })
    // Adding, publishing and removing an issue's artifacts (POD-6420).
    registerIssueArtifactEffects({ modules: () => this.modules, users: this.store.users })
    // Filing a task and starting its first agent at once (POD-6410).
    registerIssueStartEffect({ modules: () => this.modules, users: this.store.users })
    // Starting a session is an effect record too (POD-6398).
    this.modules.sessionLaunches = registerSessionLaunchEffect({
      modules: () => this.modules,
      users: this.store.users,
    })
    // Stop names the turn it is for and ends with it (POD-6397).
    this.modules.sessionInterrupts = registerSessionInterruptEffect({
      modules: () => this.modules,
      now: this.now,
    })
    // A running session's model or effort changes through its driver (POD-6416).
    registerSessionConfigureEffect({ modules: () => this.modules })
    // An agent's approval request is an effect record with a human gate (POD-6674).
    effectExecutors.register(approvals.executor())
    // Answering an agent's question, every way Podium answers (POD-6415).
    registerSessionAnswerEffect({
      modules: () => this.modules,
      users: this.store.users,
      superagentThread: async (id) => await this.store.superagent.getSuperagentThread(id),
      deliverMenuText: async ({ sessionId, answer, principal }) => {
        const r = await deliverAnswerToSession(
          {
            getSession: async (id) => await sessionsSvc.sessionById(id),
            sessions: sessionsSvc,
            messages: messagesSvc,
            writer: this.writes.system('messages.server'),
            rpc: {
              readTranscript: async (input) =>
                await rpc.readTranscript(input, { kind: 'system', id: 'superagent-answer' }),
            },
          },
          { sessionId, answer, principal },
        )
        if (!r.ok) return r
        if (r.via !== 'menu') return { ok: false, message: 'failed: unexpected delivery path' }
        return { ok: true, choices: r.choices, ...(r.note ? { note: r.note } : {}) }
      },
    })
    // Moving a session to another machine (POD-6422).
    registerSessionHandoffEffect({ modules: () => this.modules, users: this.store.users })
    // Software update and server move start from effect records; the
    // Operations engine is their executor (ADR 12 D5 E3, POD-6358).
    this.modules.updateEffects = registerUpdateEffect({
      executors: effectExecutors,
      runner: this.effectsRunner,
      engine: operationsModule.engine,
      hostMachine: this.store.hostMachine,
    })
    registerServerMoveEffect({
      executors: effectExecutors,
      engine: operationsModule.engine,
      modules: () => this.modules,
      roleOf: async (userId) => await this.store.users.roleOf(userId),
    })
    // Saving a file from the app (POD-6395).
    registerFileWriteEffect({
      modules: () => this.modules,
      repoPaths: async (machineId) => await this.store.repos.listRepoPaths(machineId),
      repoMachines: async (root) => await fleetRepos.machinesForRoot(root),
    })
    // Scans and clones on a machine (POD-6396).
    this.repoDiscovery = new MachineRepoDiscovery({
      listRepos: async () => await this.store.repos.listRepos(),
      // Through the registry's write funnel: a discovered or healed repo's
      // record commits with its row. Bare writes left it off the feed until
      // the next boot reconcile (POD-6769's finding).
      addRepo: async (path, machineId, originUrl) =>
        await this.commitServerRepoWrite(
          async () => await this.store.repos.addRepo(path, machineId, originUrl),
        ),
      removeRepo: async (path, machineId) =>
        await this.commitServerRepoWrite(
          async () => await this.store.repos.removeRepo(path, machineId),
        ),
      // Liveness probed on the MACHINE (POD-1498), never inferred from scan coverage:
      // browseDirs answers from that daemon's own filesystem, and a directory that is
      // gone comes back without a listing. Any failure to answer is treated as "cannot
      // tell" by the caller, which then declines to heal.
      pathExists: async (path, machineId) =>
        Boolean((await this.modules.rpc.browseDirs(path, {}, machineId)).listing),
      scanRepos: async (roots, opts, machineId) =>
        await this.modules.rpc.scanRepos(roots, opts, machineId),
      machineNames: async (ids) => await this.modules.machines.machineNames(ids),
      log: (message) => repoDiscoveryLog.info(message),
    })
    const cloneRegistry = new RepoRegistry(this, this.store)
    registerDiscoveryEffects({
      modules: () => this.modules,
      discovery: this.repoDiscovery,
      addKnownOrigin: async (path, machineId, originUrl) =>
        await cloneRegistry.addKnownOrigin(path, machineId, originUrl),
    })
    // The folder picker's writes and a machine's update (POD-6417).
    registerFolderEffects({
      modules: () => this.modules,
      register: async (path, machineId) =>
        await cloneRegistry.add(cloneRegistry.serverWriter, path, machineId),
      registeredPaths: async (machineId) => await cloneRegistry.list(machineId),
    })
    registerMachineUpdateEffect({
      modules: () => this.modules,
      roleOf: async (userId) => await this.store.users.roleOf(userId),
      servesHub: () => options.servesHub !== false,
    })
    // The machine menu's "Uninstall Podium" (managed installs §12 item 14).
    registerMachineUninstallEffect({
      modules: () => this.modules,
      roleOf: async (userId) => await this.store.users.roleOf(userId),
      servesHub: () => options.servesHub !== false,
      hostMachine: () => this.store.hostMachine,
    })
    const agentRelayGate = new AgentRelayGate({
      // issues/repos ops run through the registry dispatcher (guard + schema +
      // handler, router-equal); the sessions slice exposes ONLY real-turn
      // delivery (sendText/resumeAndSend/continue — never spawn/kill/archive or
      // raw PTY input), scope-gated
      // against the TARGET session's issue exactly like an issue write
      // (RELAY_ALLOWED lists the exposed procedures).
      dispatch: makeAgentRelayDispatch({
        approvals,
        featureStates: () => getFeatureStates(currentSettings),
        featureEnabled,
        issueCommands,
        issues,
        listRepos: async () => await this.store.repos.listRepos(),
        lockCommands,
        messageGate,
        // A getter, not `this.modules`: the field is filled just above and the
        // arm only runs per request, long after — but the arm is BUILT here, so
        // it must not capture the value.
        modules: () => this.modules,
        readToolkit,
        sessionsSvc,
        workflowCallerForCapability,
        workflows,
      }),
      capabilityForSession: (sessionId, machineId) =>
        sessionsSvc.capabilityForSession(sessionId, machineId),
      toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
      // Self-stop kill only after agentRelayResult is on the wire.
      // POD-3989: graceful lifecycle(stop) first, kill frame as escalation.
      afterSuccessfulReply: (msg, result) => {
        if (!result || typeof result !== 'object') return
        if ((result as { deferredKill?: boolean }).deferredKill !== true) return
        if (!(msg.router === 'sessions' || msg.router === 'issues') || msg.proc !== 'stop') return
        // `issues.stop` as an effect record (POD-6414) left the caller's own
        // session running: its `desired: stopped` now, as itself.
        const self = result as { selfStopPending?: boolean; force?: boolean }
        if (msg.router === 'issues' && self.selfStopPending === true) {
          void finishSelfStop(this.modules, msg.sessionId, self.force === true).catch(() => {})
          return
        }
        void sessionsSvc.finalizeDeferredStopKill(msg.sessionId).catch(() => {})
      },
    })
    // Shipping retries its durable work and recovers unfinished acknowledgements.
    // Its remaining history scans are tracked by POD-6797.
    if (!backgroundDisabled) {
      shipping.start()
    }
    // The durable queued-row pass runs in `hydrate`. Called here it
    // was never awaited, so it raced the rest of boot AND the catch below it was
    // dead -- an unawaited rejection cannot be caught by the try that started it.
    this.steward = new StewardService({
      writer: this.writes.system('steward'),
      principal: systemPrincipal('steward'),
      store: this.store.events,
      facts: this.store.notificationFacts,
      messages: this.store.messages,
      issues,
      // The cheap fleet read [POD-3857]: the steward nudges running sessions
      // from facts and looks parked ones up by id (POD-6160).
      runningSessionFacts: () => sessionsSvc.runningSessionFacts(),
      readSessionFactsByIds: async (sessionIds) =>
        await sessionsSvc.readSessionFactsByIds(sessionIds),
      // The by-id read [POD-1646]: one session, not the full pass.
      sessionById: async (sessionId) => await sessionsSvc.sessionById(sessionId),
      sessionOwner: async (sessionId) => (await sessionsSvc.sessionOwner(sessionId))?.owner,
      // The steward's notices are messages from `system:steward` (POD-4846):
      // stored under their derived id, enveloped, delivered and followed like
      // mail. Wake notices resurrect a parked session through the mail wake path.
      sendNotice: stewardNoticeSender(messagesSvc, this.writes.system('steward')),
      // The `notify` switch's external push (#470) — injected, not
      // imported, so the steward's unit tests never touch ntfy/Telegram.
      notify: (ownerUserId, notice) => notify.notifyExternal(notice, ownerUserId),
      getSettings: async () => await this.store.settings.getSettings(),
      // Deterministic ack fallback (#237): stitch issue
      // stage + last commit (best-effort daemon git) into the system notice.
      messaging: {
        ackFallback: (sessionId, outcome, notificationFact) =>
          void (async () => {
            if ((await messagesSvc.settleNotifiable(sessionId)).length === 0) return
            const meta = await sessionsSvc.sessionById(sessionId)
            const issueId = meta
              ? (meta.issueId ?? (await issues.reports.issueForCwd(meta.cwd)))
              : null
            const issue = issueId ? await issues.reports.getMeta(issueId) : null
            let lastCommit: string | undefined
            if (meta) {
              try {
                const r = await rpc.repoOp('log', meta.cwd, undefined, meta.machineId)
                if (r.ok) lastCommit = r.output.split('\n')[0]
              } catch {}
            }
            await messagesSvc.systemAckFallback(this.writes.system('steward'), sessionId, {
              outcome,
              notificationFact,
              ...(issue ? { issueSeq: issue.seq, issueStage: issue.stage } : {}),
              ...(lastCommit ? { lastCommit } : {}),
              // #285 pass-through: a worker that settles without reporting its
              // assigned workflow step gets that flagged in the settle notice.
              ...(meta?.workflowStepId ? { workflowStepId: meta.workflowStepId } : {}),
            })
          })().catch(() => {}),
      },
    })
    // Steward timer RETIRED [POD-925]: janitor owns steward-poll cadence.
    // this.steward.start()
    // A turn ending (phase → idle) clears the hop context for the finished
    // turn. It confirms and delivers nothing: only the daemon's settlement, a
    // receipt, the echo or a read say a message arrived [POD-4661, POD-4775].
    this.bus.on('session.stateChanged', ({ sessionId, prev, next }) => {
      if (next.phase !== 'idle' || prev?.phase === 'idle') return
      messagesSvc.onSessionIdle(sessionId)
    })
    // Transcript-echo confirmation (#834) [POD-834 §04d]: a message the substrate
    // typed into a PTY reappears as a user turn carrying its `[podium message
    // <id>]` frame — seeing that echo is what flips the ledger queued → delivered
    // (an honest "the agent has it", never the old enqueue-time lie).
    this.bus.on('transcript.delta', async ({ sessionId, items, reset }) => {
      // A reset can replay an old interrupt marker while a new prompt is queued.
      // Only a fresh tail event is evidence about the current delivery.
      if (reset !== true) await sessionsSvc.inbox.onTranscriptDelta(sessionId, items)
      await messagesSvc.onTranscriptDelta(sessionId, items)
    })
    this.messageSweep = setInterval(() => {
      if (!backgroundDisabled)
        void messagesSvc.sweep().catch((err: unknown) => {
          log.warn('message delivery sweep failed', { err })
        })
    }, DELIVERY_RETRY_BACKSTOP_MS)
    this.messageSweep.unref?.()
    // The credential expiry sweep (§7): a notice two weeks before, attention at expiry.
    const sweepCredentialExpiry = () => {
      if (!backgroundDisabled)
        this.startBackground('credential expiry sweep failed', () =>
          this.modules.credentialHealth.checkExpiry(),
        )
    }
    this.credentialExpirySweep = setInterval(sweepCredentialExpiry, CREDENTIAL_EXPIRY_SWEEP_MS)
    this.credentialExpirySweep.unref?.()
    // The PTY queue's backstop (POD-1703). Faster than the ledger sweep because
    // it is cheap — `drain` is single-flight and returns immediately on a
    // session with an empty queue or one already draining — and because what it
    // heals is a person waiting on a message that has already been accepted.
    this.queuedInputSweep = setInterval(() => {
      if (!backgroundDisabled)
        void sessionsSvc.inbox.sweepQueuedInputs().catch((err: unknown) => {
          log.warn('queued input sweep failed', { err })
        })
    }, QUEUED_INPUT_SWEEP_MS)
    this.queuedInputSweep.unref?.()
    // The workspace's file jobs (POD-6963 design 2.9). Hourly, and once at
    // boot: composer uploads nobody sent within a day (POD-2148) and CLI
    // transfers interrupted a day ago, each a query over its table plus
    // idempotent deletes; a server-transfer fence skips a pass rather than
    // failing it. Daily, starting an hour after boot: the orphan audit, which
    // deletes what no row references. All three run in this process until
    // POD-6962's lease-owned jobs exist; `fileJobs` is the seam it replaces.
    const fileJobs = fileStorageJobs()
    const orphanAudit = new OrphanAudit(workspaceFiles, this.store.workspaceId, {
      pendingUploads: this.store.pendingUploads,
      artifactUploads: this.store.artifactUploads,
      panelArtifacts: async (issueIds) =>
        (await this.store.issues.panel.forIssues(
          'issuePanelArtifact',
          issueIds,
        )) as IssuePanelArtifactWire[],
      // With the lake off nothing writes parts, and `transcripts/` is not audited.
      ...(options.transcriptLake ? { lake: this.store.conversations.mirror } : {}),
    })
    let nextOrphanAuditAt = Date.now() + PENDING_UPLOAD_SWEEP_MS / 2
    const runFileJob = (name: FileStorageJobName, job: () => Promise<unknown>) => {
      void fileJobs.run(name, job).catch((err: unknown) => {
        log.warn('file storage job failed', { job: name, err })
      })
    }
    const sweepFiles = () => {
      if (backgroundDisabled) return
      runFileJob('pending-upload-sweep', () => pendingUploads.sweep())
      runFileJob('artifact-upload-sweep', () => issueArtifacts.sweepUploads())
      if (Date.now() >= nextOrphanAuditAt) {
        nextOrphanAuditAt = Date.now() + ORPHAN_AUDIT_EVERY_MS
        runFileJob('orphan-audit', async () => {
          const report = await orphanAudit.run()
          log.info('file orphan audit', { roots: report.roots })
        })
      }
    }
    sweepFiles()
    this.pendingUploadSweep = setInterval(sweepFiles, PENDING_UPLOAD_SWEEP_MS)
    this.pendingUploadSweep.unref?.()
    // Event-log retention + issue auto-archive timers RETIRED [POD-925]: both
    // jobs now run on the fenced janitor surface (parity-proven in unit tests).
    // Classes remain for tests / manual pruneNow; start() is no longer called.
    this.eventRetention = new EventLogRetention(this.store.events, {
      onMetrics: (metrics) => {
        perf.record('phase', 'eventLogPrune.total', metrics.totalDurationMs, DEPLOYMENT)
        perf.record('phase', 'eventLogPrune.maxSlice', metrics.maxUninterruptedSliceMs, DEPLOYMENT)
      },
    })
    this.issueAutoArchive = new IssueAutoArchive(issues.attention)
    // STARTED, unlike the two retired timers around it: the watch refreshes only
    // the ephemeral in-memory git-state cache, so there is no durable write for
    // the janitor's fence to protect — see IssueGitWatch.
    this.issueGitWatch = new IssueGitWatch(issues.gitWorkflow)
    if (!backgroundDisabled) this.issueGitWatch.start()
    // Reads through the same fan-out `quota.summary` serves, so the sampler adds
    // no new path to the daemons — only a clock behind the one that exists.
    // A recorded window belongs to the reporting machine's custodian (POD-6300).
    const quotaOwnerOf = async (machineId: string) => await this.store.machines.custodian(machineId)
    this.quotaSampler = new QuotaSampler(
      this.store.quotaHistory,
      async () => await this.modules.rpc.agentQuotaAll(),
      { ownerOf: quotaOwnerOf },
    )
    if (!backgroundDisabled) this.quotaSampler.start()
    // `account.quota` and `account.usage` (ADR 7 Amendment 2 D26, POD-5798):
    // while anyone holds a key, a live pass every minute. Quota goes through
    // the SAME sampler; usage is each holder's own harvest, held only while a
    // usage reader is on screen. Holders are what start them, so they run even
    // when the background timers are off (a holder is a person looking).
    this.accountQuota = new AccountQuotaTopic({
      sample: async () => await this.quotaSampler.sampleNow(),
      custodian: async (machineId) => await this.store.machines.custodian(machineId),
      publish: (user, value) => topics.publish('account.quota', user, value),
    })
    this.accountUsage = new AccountUsageTopic({
      readUsage: async (user) => {
        const role = await this.store.users.roleOf(user)
        if (!role) return null
        try {
          return await readUsageSummary({
            rpc: this.modules.rpc,
            store: this.store,
            privateAccess: privateResourceAccess(
              {
                sessionOwnerUserId: async (sessionId) =>
                  (await this.store.sessions.getSession(sessionId))?.ownerUserId,
                machines: this.modules.machines,
              },
              userCommandPrincipal(user, role),
            ),
            userId: user,
          })
        } catch (err) {
          log.debug('account usage read failed', { err })
          return null
        }
      },
      publish: (user, value) => topics.publish('account.usage', user, value),
    })
    topicLate.quota = this.accountQuota
    topicLate.usage = this.accountUsage
    this.quotaBackfill = new QuotaBackfill(
      this.store.quotaHistory,
      async (sinceMs) => await this.modules.rpc.quotaHistoryAll(sinceMs),
      { ownerOf: quotaOwnerOf },
    )
    if (!backgroundDisabled) this.quotaBackfill.start()
    // Automations scheduler timer RETIRED [POD-925]: janitor owns automation-fire.
    this.automationScheduler = new AutomationScheduler(automationService)
    // this.automationScheduler.start()

    // THE GATEWAY (POD-317 / POD-389). The daemon socket mux is composed HERE,
    // over the feature ports, so no feature module owns another feature's
    // traffic. `agentRelay` is its own port and receives exactly the two relay
    // frames — the host-edge separation of ADR 7 D2 / ADR 5 D7 survives the fact
    // that both surfaces arrive on the same socket.
    // The CLIENT plane's mux. Every client frame is session-owned today except
    // `ping`, which the mux answers itself — see gateway/client-frame-routing.ts.
    const mobileVersions = new MobileClientVersions(join(stateDir(), 'mobile-client-versions.json'))
    this.mobileVersions = mobileVersions
    this.clientGateway = new ClientMux({
      mobileVersions,
      registry: clientRegistry,
      workspaceId: this.store.workspaceId,
      ports: { sessions: sessionsSvc },
      feed: feedServing,
      presence,
      topics,
      serverBuild: () => serverBuildVersion(),
      serverFeatures: () => serverFeatureFacts(),
      syncKindTokens: () => readKindTokens(this.store.sync, effectExecutors.kinds()),
      now: () => this.now(),
      // This task is independent of session replay and feed admission
      // (POD-3509). Approvals reach a client on the feed (POD-6674).
      bootstrap: async (client): Promise<void> => {
        hosts.snapshotFor(client.send)
      },
    })
    // ACCESS CHANGES TAKE EFFECT AT THEIR COMMIT (POD-6293). A disable, removal
    // or sign-out-everywhere closes the member's open connections; a role change
    // rescopes them and rewrites their machine access rows.
    const accessChangeSubscriptions = [
      this.store.users.onAccessChange((change) => {
        this.clientGateway.applyAccessChange(change)
      }),
    ]
    this.unsubscribeAccessChanges = () => {
      for (const unsubscribe of accessChangeSubscriptions) unsubscribe()
    }
    this.gateway = new DaemonMux({
      bus: this.bus,
      ports: {
        sessions: sessionsSvc,
        machines,
        hosts,
        conversations: memory,
        rpc,
        headless,
        approvals,
        agentRelay: {
          run: (machineId, msg) => void agentRelayGate.run(machineId, msg),
        },
        // FLEET DAEMON LOG CAPTURE (POD-3156). The machine comes from the mux's
        // authenticated principal, never from the frame — which carries no
        // machine field for it to disagree with.
        logs: {
          onDaemonLogBatch: (machineId, msg) => {
            fleetLogs.append(machineId, {
              records: msg.records,
              ...(msg.dropped !== undefined ? { dropped: msg.dropped } : {}),
              ...(msg.v !== undefined ? { v: msg.v } : {}),
            })
          },
        },
        updates: {
          onUpdateStatus: async (machineId, msg) => {
            await updatesService.onStatus(machineId, msg)
            // …and the same frame is the running operation's progress event.
            // The service still owns convergence; the operation only learns.
            updateFleetBridge.onFleetChanged()
          },
        },
        // TOPICS (ADR 7 Amendment 2 D21). A topics.v1 daemon publishes its host
        // sample on machine.metrics:<self>; on the server it means exactly what
        // the pre-topics hostMetrics frame means (pressure sweep, readiness), and
        // the hosts service hands it on to the topic.
        topics: createDaemonTopicIngress({
          producers: topicProducers,
          sinks: {
            'checkout.changed': (_machine, payload, id) =>
              topics.publish('checkout.changed', id, payload),
            'machine.processes': (_machine, payload, id) =>
              processTopic.receive(id, payload as HostMemoryBreakdown),
            'machine.metrics': (machineId, payload) => {
              const sample = payload as import('@podium/model').HostMetricsWire
              void Promise.resolve(hosts.onHostMetrics(machineId, sample)).catch((err: unknown) => {
                log.warn('host metrics sample failed', { machineId, err })
              })
              machines.recordDaemonReadiness(machineId, sample.daemonReadiness)
            },
          },
        }),
      },
    })
  }

  /** The backing store — shared with services that persist their own tables (superagent). */
  get sessionStore(): SessionStore {
    return this.store
  }

  /** Write-seam ledger — layout (and other non-session modules) capture entity rows here. */
  get changeLedger(): Ledger {
    return this.ledger
  }

  /**
   * THE RECEIPT, read now (ADR 12 D2 step 8, POD-6273): the persisted feed
   * identity and the change-log head. The entry point reads it after the call's
   * commit, so the head covers every row the call wrote, and a no-op that wrote
   * none (plan Decision 1).
   */
  async writeReceiptNow(): Promise<WriteReceipt> {
    const identity = await this.syncDelta.serving.identity()
    return { feedId: identity.feedId, epoch: identity.epoch, seq: await this.ledger.cursor() }
  }

  /** Register the daemon-local upload fence for the all-in-one process. */
  attachLocalDaemonPortableState(control: LocalPortableStateControl): void {
    this.localDaemonPortableState = control
  }

  /**
   * A repo registry write the server makes by itself (a scan's discovery, a
   * handoff's clone), in one commit with the logical repos' records (POD-6770).
   */
  private async commitServerRepoWrite<T>(write: () => Promise<T>): Promise<T> {
    return await asSystemWrite(
      async () =>
        await this.modules.issues.reports.store.commitRepoWrite(
          this.writes.system('repos.registry'),
          write,
        ),
    )
  }

  /**
   * ADOPT THE SUPERAGENT FOR SHUTDOWN (POD-2772).
   *
   * It cannot be a field: it is built from `this.modules`, so it exists only
   * after this registry does. Left unadopted it was disposed by NOBODY — its
   * turn reaper is a `setInterval` that outlived every close path and woke into
   * a closed database, and each e2e file ended with two or three
   * `RangeError: Cannot use a closed database` from `reapStaleTurns`. Vitest
   * counts those as unhandled errors and fails the FILE, so a lane whose every
   * assertion passed still reported red.
   *
   * Adoption rather than a `dispose()` call at each construction site, because
   * there are three of them — the shutdown persist list, the port-in-use
   * `failListen` path, and the oracle test harness — and all three already call
   * `dispose()` here. One of them getting a new line and the others not is
   * exactly the shape this bug already had.
   */
  adoptSuperagent(service: SuperagentService): void {
    this.adoptedSuperagent = service
  }

  async dispose(): Promise<void> {
    this.stopping = true
    clearInterval(this.credentialExpirySweep)
    await Promise.allSettled(this.backgroundTasks)
    this.unsubscribeAccessChanges?.()
    this.mobileVersions?.close()
    // FIRST, and before store.close() further down the shutdown's persist list:
    // the memory service owns paced loops (transcript mirror + FTS indexer) that
    // keep writing to the store on later turns. Left running they woke after the
    // handle closed and logged their own failure, so a clean stop was
    // indistinguishable from a broken one (POD-1390).
    this.modules.memory.dispose()
    // Same hazard, same window: the superagent's turn reaper is a periodic
    // write against the store this shutdown is about to close (POD-2772).
    await this.adoptedSuperagent?.dispose()
    // Effect runs write their outcome to the store this shutdown closes.
    await this.effectsRunner.stop()
    this.eventRetention.dispose()
    this.quotaSampler.dispose()
    this.accountQuota.dispose()
    this.accountUsage.dispose()
    this.quotaBackfill.dispose()
    this.concertmasterDelivered.dispose()
    clearInterval(this.messageSweep)
    clearInterval(this.credentialExpirySweep)
    clearInterval(this.queuedInputSweep)
    clearInterval(this.pendingUploadSweep)
    this.modules.messages.dispose()
    this.modules.machines.dispose()
    this.modules.issueSessionLifecycle.dispose()
    this.issueAutoArchive.dispose()
    this.issueGitWatch.dispose()
    this.automationScheduler.dispose()
    this.shipping.dispose()
    // Also drains any coalesced session broadcast + pending delta batch (the
    // durable change log is already complete — commits happen at persist time).
    this.steward.dispose()
    this.configChangedBridge()
    await this.modules.sessions.dispose()
  }

  /** Fenced janitor entry: one bounded steward poll with
   * deliveries-before-cursor-advance. First ownership seeds past the source
   * topology's intentionally dark history. */
  async runStewardTick(): Promise<void> {
    return await this.steward.tick({ owner: 'janitor', limit: JANITOR_STEWARD_EVENT_LIMIT })
  }
}
