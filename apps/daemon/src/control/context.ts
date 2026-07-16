import type { AgentSession, agentLaunchCommand } from '@podium/agent-bridge'
import type { ControlMessage, DaemonMessage, UsageBucketWire } from '@podium/protocol'
import type { ConversationDeltaWire } from '../active-refresh'
import type { AgentRelayHub } from '../agent-relay'
import type { CodexIdentityReceipts } from '../codex-identity-receipts'
import type { HeadlessTurnHandle } from '../headless-drivers.js'
import type { OutputScheduler } from '../output-scheduler'
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
  durableLabels: Map<string, string>
  durableLabelFor(sessionId: string): string
  backend: DurableBackend
  /** Maps an agent kind to a spawn command (tests inject a fixture). */
  launch: typeof agentLaunchCommand
  /** Where per-session hook settings files are written. */
  settingsDir: string
  /** Discovery homeDir override (tests / isolated HOME); undefined = real home. */
  homeDir: string | undefined

  // -- per-session runtime state ---------------------------------------------
  /** Live PTY bridges by Podium session id. */
  bridges: Map<string, AgentSession>
  /** Coalesced, prioritized PTY frame relay. */
  outputScheduler: OutputScheduler
  /** Agent-state trackers, transcript tails, per-harness observers. */
  observers: SessionObservers
  /** Resolves hook cwds to worktree roots; cleared on session exit. */
  sessionCwdTracker: SessionCwdTracker
  /** Re-arms prime injection when a session dies. */
  primeInjector: { reset(sessionId: string): void }
  /** Bounds the reattach spawn fan-out (REATTACH_CONCURRENCY). */
  reattachGate<T>(fn: () => Promise<T>): Promise<T>
  /** One live headless turn per session. */
  runningHeadlessTurns: Map<string, HeadlessTurnHandle>

  // -- services --------------------------------------------------------------
  /** Stable instance-scoped Codex hook endpoint; absent on Windows. */
  hookSocketPath: string | undefined
  /** Owner-only directory inherited by Codex hook subprocesses. */
  codexReceiptDir: string
  /** Pending exact Podium ID -> native Codex ID bindings. */
  codexIdentityReceipts: CodexIdentityReceipts
  /** Hook-ingest endpoint for a session (instrumentation URLs). */
  hookEndpointFor(sessionId: string): string
  /** Agent-relay loopback endpoint for a session (agent env). */
  agentRelayEndpointFor(sessionId: string): string
  agentRelayHub: AgentRelayHub
  /** Runs /proc walks + discovery scans off the interactive loop. */
  workerClient: DiscoveryWorkerClient
  /** Discovery scan + publish; `full` requests the entire conversation list. */
  refreshAndPublishConversations(full?: boolean): Promise<ConversationDeltaWire>
  /** Per-agent plan-quota reader (TTL-cached). */
  quotaFetcher: {
    getAgentQuota(refresh?: boolean): Promise<import('@podium/protocol').AgentQuotaWire[]>
  }
  /** Usage-scan memo (mutable box — handlers replace the value). */
  usageMemo: { value?: { atMs: number; sinceMs: number; buckets: UsageBucketWire[] } }
}

/** The frame-handler registry shape: one handler per control-frame type,
 *  exhaustiveness-checked over the ControlMessage union. */
export type ControlHandlers = {
  [K in ControlMessage['type']]: (
    ctx: DaemonContext,
    msg: Extract<ControlMessage, { type: K }>,
  ) => void
}
