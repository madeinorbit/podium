import type { agentLaunchCommand } from '@podium/harness'
import type { SessionId, UsageBucketWire } from '@podium/model'
import type { ControlMessage, DaemonMessage, ServerTransferServingProof } from '@podium/protocol'
import type { AgentSession } from '@podium/pty'
import type { ConversationDeltaWire } from '../active-refresh'
import type { AgentRelayHub } from '../agent-relay'
import type { BindingStore } from '../binding-store'
import type { BrowserOpenManager } from '../browser-open'
import type { ComposerSyncEngine } from '../composer-sync'
import type { HeadlessTurnHandle } from '../headless-drivers.js'
import type { OutputScheduler } from '../output-scheduler'
import type { SessionBinding } from '../session-binding'
import type { SessionObservers } from '../session-observers'
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
  /** Send a frame to the server over the live socket (drops when disconnected). */
  send(msg: DaemonMessage): void

  // -- configuration ---------------------------------------------------------
  /** The machine identity this daemon registers as (inventory reports carry it). */
  machineId: string
  /** Selected Podium instance that owns every runtime/session in this daemon. */
  instanceId: string
  /** Exact labels retained for reattached legacy/adopted sessions. */
  durableLabels: Map<SessionId, string>
  durableLabelFor(sessionId: SessionId): string
  backend: DurableBackend
  /** Maps an agent kind to a spawn command (tests inject a fixture). */
  launch: typeof agentLaunchCommand
  /** Where per-session hook settings files are written. */
  settingsDir: string
  /** Discovery homeDir override (tests / isolated HOME); undefined = real home. */
  homeDir: string | undefined

  // -- per-session runtime state ---------------------------------------------
  /** Live PTY bridges by Podium session id. */
  bridges: Map<SessionId, AgentSession>
  /** Draft Sync v2 (POD-859): read-only/inject composer engine for flagged sessions. */
  composerEngine: ComposerSyncEngine
  /** Coalesced, prioritized PTY frame relay. */
  outputScheduler: OutputScheduler
  /** Agent-state trackers, transcript tails, per-harness observers. */
  observers: SessionObservers
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
  usageMemo: { value?: { atMs: number; sinceMs: number; buckets: UsageBucketWire[] } }

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
