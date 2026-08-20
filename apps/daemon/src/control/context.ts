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
import type { HeadlessTurnHandle } from '../headless-drivers.js'
import type { DaemonHarnessRuntime } from '../harness-runtime.js'
import type { OutputScheduler } from '../output-scheduler'
import type { PortableStateFence } from '../portable-state-fence'
import type { DaemonCodexRuntime } from '../runtime/codex-driver'
import type { DaemonGrokRuntime } from '../runtime/grok-driver'
import type { OpencodeClientTerminals } from '../runtime/opencode-attach'
import type { DaemonOpencodeRuntime } from '../runtime/opencode-driver'
import type { TerminalRuntime } from '../runtime/terminal-driver'
import type { SessionBinding } from '../session-binding'
import type { SessionObservers } from '../session-observers'
import type { ShippingExecutionPlane } from '../shipping/executor'
import type { DiscoveryWorkerClient } from '../worker-client'
import type { SessionCwdTracker } from '../worktree-resolve'

/** What holds the agent's PTY across daemon restarts. `none` = bare node-pty. */
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

  // -- configuration ---------------------------------------------------------
  /** The machine identity this daemon registers as (inventory reports carry it). */
  machineId: MachineId
  /** Selected Podium instance that owns every runtime/session in this daemon. */
  instanceId: string
  /** Exact labels retained for reattached legacy/adopted sessions. */
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
  /** Sessions whose currently visible browser surface is the native harness TUI. */
  nativeClientRequests?: Set<SessionId>
  /** Per-session serialization for attach/release transitions. */
  nativeClientTransitions?: Map<SessionId, Promise<void>>
  /** Agent-state trackers, transcript tails, per-harness observers. */
  observers: SessionObservers
  /**
   * The Agent Runtime contract's terminal driver (POD-1761 W3), when this daemon
   * was built with it.
   *
   * OPTIONAL, AND THAT IS THE FLAG'S SHAPE. A daemon with no registry drives
   * every session the legacy way and answers every `runtime*` frame with
   * `not_running` — which is true. The registry exists whenever the daemon can
   * run the contract at all; whether a given SESSION is behind it is the
   * registry's own per-session question, not this field's.
   */
  runtime?: TerminalRuntime
  /**
   * THE SERVER-FAMILY REGISTRY (POD-1761 W5).
   *
   * A SECOND FIELD, not a widened one, and the reason is that they are not
   * interchangeable: `runtime` is the terminal driver's registry and carries
   * terminal-only verbs (`observe`, `onHookPayload`, `register`) that the
   * daemon's frame tap and hook ingest call directly. What the two DO share is
   * `handleFor`, and every place that only needs that goes through
   * `runtime/handlers.ts`'s one lookup rather than asking both in its own order.
   */
  opencodeRuntime?: DaemonOpencodeRuntime
  /**
   * THE SECOND SERVER-FAMILY REGISTRY (POD-1761 W6).
   *
   * A THIRD FIELD rather than a widened second one, for the same reason W5 gave
   * for not widening the first: these registries are not interchangeable. Each
   * holds sessions for exactly one driver, a session appears in exactly one of
   * them by construction, and the shared question — "who owns this session" —
   * is answered in the one lookup in `runtime/handlers.ts` rather than at each
   * call site in its own order.
   */
  codexRuntime?: DaemonCodexRuntime
  /** Grok sessions driven over ACP stdio. */
  grokRuntime?: DaemonGrokRuntime
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
  /** Usage-scan memo (mutable box — handlers replace the value). */
  usageMemo: {
    value?: { atMs: number; sinceMs: number; buckets: UsageBucketWire[] }
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
