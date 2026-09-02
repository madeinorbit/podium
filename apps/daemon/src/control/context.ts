import type { agentLaunchCommand, HarnessLogin } from '@podium/harness'
import type { AgentKind, MachineId, SessionId, UsageBucketWire } from '@podium/model'
import type { ServerTransferServingProof } from '@podium/protocol'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import type { AgentSession } from '@podium/pty'
import type { ProvisionedAccountHome } from '../account-home'
import type { ConversationDeltaWire } from '../active-refresh'
import type { AgentRelayHub } from '../agent-relay'
import type { BindingStore } from '../binding-store'
import type { BrowserOpenManager } from '../browser-open'
import type { ComposerSyncEngine } from '../composer-sync'
import type { DaemonHarnessRuntime } from '../harness-runtime.js'
import type { HeadlessTurnHandle } from '../headless-drivers.js'
import type { OutputScheduler } from '../output-scheduler'
import type { PortableStateFence } from '../portable-state-fence'
import type { OpencodeClientTerminals } from '../runtime/opencode-attach'
import type { ScopeMonitor } from '../runtime/scope-monitor'
import type { DaemonMachineRuntime } from '../runtime/machine-runtime'
import type { ServerReapIo } from '../runtime/server-reap'
import type { SessionBinding } from '../session-binding'
import type { SessionObservers } from '../session-observers'
import type { ShippingExecutionPlane } from '../shipping/executor'
import type { DiscoveryWorkerClient } from '../worker-client'
import type { SessionCwdTracker } from '../worktree-resolve'

/** What holds the agent's PTY across daemon restarts. `none` = bare Bun.Terminal. */
export type DurableBackend = 'abduco' | 'tmux' | 'none'

/**
 * Everything a control-frame handler may touch, made explicit (#195). One
 * context object per daemon, built by startDaemon and handed to every handler —
 * replacing the former 2k-line closure where every handler reached into the
 * same lexical scope. Fields are grouped by which module owns the state.
 */
export interface DaemonContext {
  // -- wire ------------------------------------------------------------------
  /** Send a frame to the server. Ordinary frames drop while disconnected; queue
   *  abandonment is durably replayed until acknowledged. */
  send(msg: DaemonMessage): void
  /** Retire one durable queue-abandonment report after the server acknowledges
   *  that its terminal receipt correction committed. */
  acknowledgeQueueDrainReport(reportId: string): void
  /** Retire a retained coarse event after the server's durable commit. */
  acknowledgeRuntimeEvent(deliveryId: string): void

  // -- configuration ---------------------------------------------------------
  /** The machine identity this daemon registers as (inventory reports carry it). */
  machineId: MachineId
  /** Selected Podium instance that owns every runtime/session in this daemon. */
  instanceId: string
  /** Immutable UUID stamped into every process owned by this daemon. */
  instanceUuid: string
  durableLabels: Map<SessionId, string>
  durableLabelFor(sessionId: SessionId): string
  backend: DurableBackend
  /** Legacy pure argv builder retained as a test seam. Production launches through harnessRuntime. */
  launch: typeof agentLaunchCommand
  /** Generation-bound executable inventory and launch service. */
  harnessRuntime?: DaemonHarnessRuntime
  /** Where per-session hook settings files are written. */
  settingsDir: string
  /** Discovery homeDir override (tests / isolated HOME); undefined = real home. */
  homeDir: string | undefined
  /** Separately provisioned native-account HOME. Ambient/default HOME is never
   * sufficient for tool-less repair execution. */
  accountHome?: ProvisionedAccountHome
  /** The same per-harness login fact published in machine inventory. */
  harnessLoginState(agentKind: AgentKind): HarnessLogin['state'] | undefined

  // -- per-session runtime state ---------------------------------------------
  /** Live PTY bridges by Podium session id. */
  bridges: Map<SessionId, AgentSession>
  /**
   * Geometry a client asked for while this session had no bridge to apply it to.
   * Spawn is async (fork+exec, abduco socket handshake) and the server publishes
   * the session row the moment it dispatches `spawn`, so a browser that fits its
   * pane in that window sends a resize the daemon cannot deliver yet. Held here
   * and applied by wireBridge instead of being dropped (POD-628).
   */
  pendingResizes: Map<SessionId, { cols: number; rows: number }>
  /** Draft Sync v2 (POD-859): read-only/inject composer engine for flagged sessions. */
  composerEngine: ComposerSyncEngine
  /** Coalesced, prioritized PTY frame relay. */
  outputScheduler: OutputScheduler
  /**
   * Client terminals for server-family sessions (POD-2059), when this daemon
   * hosts any.
   *
   * ON THE CONTEXT rather than reachable only through the opencode host, because
   * two control frames drive it and neither is about opencode: `sessionPriority`
   * is the viewer signal its idle clock runs on, and `reclaimAttachments` is the
   * server's pressure order. A handler that had to reach through a driver's
   * private deps to answer a machine-wide frame would be the wrong shape.
   */
  clientTerminals?: OpencodeClientTerminals
  /**
   * The machine's cgroup observer (POD-2413) — per-session memory, tasks and
   * the kernel's OOM-kill counter.
   *
   * ON THE CONTEXT for the same reason `clientTerminals` is: it is machine-wide
   * rather than any one driver's, and the terminal driver's host port reads it
   * through here exactly as the three server hosts read it directly.
   */
  scopeMonitor?: ScopeMonitor
  /** Sessions whose currently visible browser surface is the native harness TUI. */
  nativeClientRequests?: Set<SessionId>
  /** Per-session serialization for attach/release transitions. */
  nativeClientTransitions?: Map<SessionId, Promise<void>>
  /**
   * Native requests a transient attach refusal left owing, and how many attempts
   * each has spent (POD-2489). An entry means "the user still wants Native here
   * and the session said not right now" — the next attachable `agentState` frame
   * re-runs the reconcile. Absent for every session that attached, never asked,
   * or was refused for a standing reason.
   */
  nativeClientRetries?: Map<SessionId, number>
  /** Agent-state trackers, transcript tails, per-harness observers. */
  observers: SessionObservers
  /** The one per-machine runtime. Family registries are private mechanisms
   * behind this root; handlers never walk them independently. Optional only
   * during bootstrap while the driver host ports close their wiring cycle. */
  agentRuntime?: DaemonMachineRuntime
  /** The machine-wide `PODIUM_RUNTIME_CONTRACT` switch, read ONCE at bootstrap.
   *  OR-ed with each session's own `runtimeContract` field — see
   *  `runtime/flag.ts` for why both exist and why neither wins. */
  runtimeContractEnabled: boolean
  /** Resolves hook cwds to worktree roots; cleared on session exit. */
  sessionCwdTracker: SessionCwdTracker
  /** Re-arms prime injection when a session dies. */
  primeInjector: { reset(sessionId: SessionId): void }
  /** Bounds the reattach spawn fan-out (REATTACH_CONCURRENCY). */
  reattachGate<T>(fn: () => Promise<T>): Promise<T>
  /** Paces transcript reseeds independently of immediate bridge wiring. */
  tailSeedGate(fn: () => Promise<void>, priority?: number): Promise<void>
  /** One live headless turn per session. */
  runningHeadlessTurns: Map<string, HeadlessTurnHandle>

  // -- services --------------------------------------------------------------
  /** Stable instance-scoped Codex hook endpoint; absent on Windows. */
  hookSocketPath: string | undefined
  /** Durable per-machine SessionBinding and append-only alias history. */
  bindingStore: BindingStore
  /** Canonical lifecycle API; handlers never reconstruct binding mutations. */
  sessionBinding: SessionBinding
  /** Hook-ingest endpoint for a session (instrumentation URLs). */
  hookEndpointFor(sessionId: SessionId): string
  /** Agent-relay loopback endpoint for a session (agent env). */
  agentRelayEndpointFor(sessionId: SessionId): string
  agentRelayHub: AgentRelayHub
  /** Expiring, redirect-bound browser-open callback capabilities. */
  browserOpen: BrowserOpenManager
  /** Runs /proc walks + discovery scans off the interactive loop. */
  workerClient: DiscoveryWorkerClient
  /** Discovery scan + publish; `full` requests the entire conversation list. */
  refreshAndPublishConversations(full?: boolean): Promise<ConversationDeltaWire>
  /** Per-agent plan-quota reader (TTL-cached). */
  quotaFetcher: {
    getAgentQuota(refresh?: boolean): Promise<import('@podium/model').AgentQuotaWire[]>
  }
  /** Usage-scan memo (mutable box — handlers replace the value). `sources` is
   *  the per-file half of the same walk, which the server folds into per-task
   *  cost; `cache` is the incremental cursor set the next walk resumes from. */
  usageMemo: {
    value?: {
      atMs: number
      sinceMs: number
      buckets: UsageBucketWire[]
      sources: import('@podium/model').UsageSourceWire[]
    }
    cache?: import('../usage-scan').UsageScanCache
  }

  /** Process-wide admission/drain fence for daemon-owned portable-state mutations. */
  portableStateFence: PortableStateFence
  /** Restart-safe, purpose-built shipping jobs; never a generic process runner. */
  shipping: ShippingExecutionPlane

  /** Starts the promoted server and returns only after the expected state is serving. */
  restartAfterTransfer?: (
    expected: ServerTransferServingProof,
  ) => Promise<ServerTransferServingProof> | ServerTransferServingProof
  /** Retires the target daemon only after promoted proof is acknowledged. */
  retireAfterTransfer?: () => void | Promise<void>
  /** Test-only injected process-death boundary; production leaves this absent. */
  serverTransferCrashPoint?: (
    point: import('../server-transfer').ServerTransferCrashPoint,
  ) => void | Promise<void>
  /** Test-only injected server-child reaper I/O; production uses real process/scope probes. */
  serverReapIo?: ServerReapIo

  /**
   * FLEET DAEMON LOG CAPTURE (POD-3156) — the operator's knob, as this daemon
   * holds it. The `setDaemonLogLevel` handler is the only caller; everything
   * else about the raise (the TTL, the flight recorder, the bounded queue) is
   * the forwarding module's, so the context carries the handle and no policy.
   */
  logForwarding: import('@podium/runtime/log-forward').DaemonLogForwarding

  /** Server-granted convergence is wired by the production composition root. */
  applyUpdateGrant: (
    grant: Extract<ControlMessage, { type: 'updateGrant' }>,
  ) => void | Promise<void>
}

/** The frame-handler registry shape: one handler per control-frame type,
 *  exhaustiveness-checked over the ControlMessage union. */
export type ControlHandlers = {
  [K in ControlMessage['type']]: (
    ctx: DaemonContext,
    msg: Extract<ControlMessage, { type: K }>,
  ) => void
}
