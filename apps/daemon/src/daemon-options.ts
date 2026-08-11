import type { agentLaunchCommand } from '@podium/harness'
import type { LocalDaemonLink, ServerTransferServingProof } from '@podium/protocol'
import type { DurableBackend } from './control/context'
import type { DiscoveryWorkerClient } from './worker-client'

export interface DaemonDiscoveryOptions {
  /** Disable unsolicited cached/background conversation pushes; scanRequest still works. */
  background?: boolean
  /** Defaults to the selected instance state root/discovery.db. */
  cachePath?: string
  /** Test hook / isolated HOME for discovery. */
  homeDir?: string
  /** Background quick-scan interval. Defaults to 15s. */
  scanIntervalMs?: number
}

export interface ReconnectTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface DaemonMetricsOptions {
  /** Disable the periodic hostMetrics push entirely. */
  background?: boolean
  /** Sample/push cadence. Defaults to 5s. */
  intervalMs?: number
}

export interface DaemonHooksOptions {
  /** Ingest port. Fixed by default; 0 = ephemeral (tests). */
  port?: number
  /** Per-session hook settings directory. */
  settingsDir?: string
  /** Stable Codex hook socket. Defaults in the instance runtime dir on POSIX. */
  socketPath?: string
  /** Legacy receipt-directory migration override. No new receipts are written here. */
  receiptDir?: string
}

export interface DaemonOptions {
  serverUrl: string
  installCodexHooks?: boolean
  installGrokHooks?: boolean
  /** Local machine secret (`daemonSecret` credential), never ambient trust. */
  bootstrapToken?: string
  /** In-process transport; it still performs the common machine handshake. */
  localLink?: LocalDaemonLink
  /** One-time `pairCode` credential for a new remote daemon. */
  pairCode?: string
  name?: string
  onBlocked?: (info: { type: string; reason: string }) => void
  identityDir?: string
  machineId?: string
  launch?: typeof agentLaunchCommand
  backend?: DurableBackend
  tmux?: boolean
  discovery?: DaemonDiscoveryOptions
  metrics?: DaemonMetricsOptions
  hooks?: DaemonHooksOptions
  agentRelay?: { port?: number }
  workerClient?: DiscoveryWorkerClient
  reconnectTimers?: ReconnectTimers
  /** Test/embedding seam; production derives its checkout from the loaded source module. */
  sourceRoot?: string
  /** Test/embedding seam; production exits so the process manager restarts the daemon. */
  restartAfterUpdate?: () => void
  /** Starts the promoted role and echoes the expected proof only after it is serving. */
  restartAfterTransfer?: (
    expected: ServerTransferServingProof,
  ) => Promise<ServerTransferServingProof> | ServerTransferServingProof
  /** Retires the retained daemon after a durable promoted-proof acknowledgement. */
  retireAfterTransfer?: () => void | Promise<void>
}
