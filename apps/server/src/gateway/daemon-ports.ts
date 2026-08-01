/**
 * THE FEATURE PORTS THE DAEMON MUX ROUTES TO (POD-389).
 *
 * Each interface is the narrow slice of ONE feature module the gateway is
 * allowed to reach. They are declared here — not imported from the services —
 * so the dependency points the right way: the gateway names what it needs, and
 * a feature satisfies it structurally. Nothing here interprets a frame; every
 * method body lives in the owning module.
 *
 * WHERE THE MACHINE PRINCIPAL APPEARS: on every method whose frame is
 * machine-adjacent under `docs/multi-user-readiness.md` §3.1.1, and on the
 * sessions port's whole surface (a daemon-observed session write is attributed
 * to the MACHINE, ADR 1's daemon writer class — never to a person). Ports whose
 * frames are request-correlated replies take the message alone; see
 * `MACHINE_SCOPE_CARRIER` for that audit and its recorded gap.
 */

import type { ConversationDiagnosticWire, ConversationSummaryWire } from '@podium/model'
import type { ControlMessage, DaemonMessage, MachinePrincipal } from '@podium/protocol'
import type { SessionsDaemonFrame } from './daemon-frame-routing'

/** A frame of a given type. */
export type DaemonFrame<T extends DaemonMessage['type']> = Extract<DaemonMessage, { type: T }>

/** Outbound control-message sink for one daemon socket (`Send<ControlMessage>`). */
export type ControlSend = (msg: ControlMessage) => void

/**
 * SESSIONS. Lifecycle, inbox and presence stay here; the socket does not. The
 * two lifecycle hooks are what `attachDaemon`/`detachDaemon` used to do inline,
 * minus the machine bookkeeping and the bus emits the gateway now orchestrates.
 */
export interface SessionsDaemonPort {
  /** This machine's daemon just became reachable: drain, park, re-probe, re-bind. */
  onMachineAttached(principal: MachinePrincipal): void
  /** Its daemon went away: this machine's live sessions drop to 'reconnecting'. */
  onMachineDetached(principal: MachinePrincipal): void
  /** One session-owned frame, attributed to the machine that sent it. */
  onSessionDaemonFrame(principal: MachinePrincipal, msg: SessionsDaemonFrame): void
}

/** MACHINES. Socket bookkeeping plus the machine's own reported inventory. */
export interface MachinesDaemonPort {
  attach(machineId: string, send: ControlSend): void
  detach(machineId: string, send?: ControlSend): boolean
  flushQueued(machineId: string): void
  adoptPlaceholderRows(machineId: string): void
  broadcastMachines(): void
  recordInventory(machineId: string, inventory: DaemonFrame<'inventoryReport'>['inventory']): void
}

/** HOSTS. Health samples are per-machine facts and are scoped by the principal. */
export interface HostsDaemonPort {
  onHostMetrics(machineId: string, sample: Omit<DaemonFrame<'hostMetrics'>, 'type'>): void
  onMemoryBreakdownResult(msg: DaemonFrame<'memoryBreakdownResult'>): void
}

/** CONVERSATIONS. Discovery is per-machine; the mirror read is request-correlated. */
export interface ConversationsDaemonPort {
  onDiscovery(
    machineId: string,
    conversations: ConversationSummaryWire[],
    diagnostics: ConversationDiagnosticWire[],
    removed?: string[],
  ): void
  onTranscriptMirrorResult(msg: DaemonFrame<'transcriptMirrorResult'>): void
  triggerLakeSweep(machineId: string): void
}

/**
 * RPC REPLIES. Correlated by `requestId` — POD-318 owns the generic correlator
 * that replaces this hand-paired surface, so the port is stated as it is today
 * and the mux does not re-create a correlator behind the gateway boundary.
 */
export interface RpcDaemonPort {
  onScanResult(msg: DaemonFrame<'scanResult'>): void
  onScanReposResult(msg: DaemonFrame<'scanReposResult'>): void
  onBrowseDirsResult(msg: DaemonFrame<'browseDirsResult'>): void
  onRepoOpResult(msg: DaemonFrame<'repoOpResult'>): void
  onHarnessExecResult(msg: DaemonFrame<'harnessExecResult'>): void
  onUsageResult(msg: DaemonFrame<'usageResult'>): void
  onAgentQuotaResult(msg: DaemonFrame<'agentQuotaResult'>): void
  onImageUploadResult(msg: DaemonFrame<'imageUploadResult'>): void
  onTranscriptReadResult(msg: DaemonFrame<'transcriptReadResult'>): void
  onFileReadResult(msg: DaemonFrame<'fileReadResult'>): void
  onFileWriteResult(msg: DaemonFrame<'fileWriteResult'>): void
  onFileAssetResult(msg: DaemonFrame<'fileAssetResult'>): void
  onDirListResult(msg: DaemonFrame<'dirListResult'>): void
  onHandoffExportResult(msg: DaemonFrame<'handoffExportResult'>): void
  onHandoffChunkReadResult(msg: DaemonFrame<'handoffChunkReadResult'>): void
  onHandoffImportChunkResult(msg: DaemonFrame<'handoffImportChunkResult'>): void
  onHandoffImportResult(msg: DaemonFrame<'handoffImportResult'>): void
  onHandoffBindingFinalizeResult(msg: DaemonFrame<'handoffBindingFinalizeResult'>): void
  onWorkspaceExportResult(msg: DaemonFrame<'workspaceExportResult'>): void
  onWorkspaceImportResult(msg: DaemonFrame<'workspaceImportResult'>): void
  onWorkspaceCleanResult(msg: DaemonFrame<'workspaceCleanResult'>): void
  onCredentialExportResult(msg: DaemonFrame<'credentialExportResult'>): void
  onCredentialInstallResult(msg: DaemonFrame<'credentialInstallResult'>): void
}

/** HEADLESS turns. */
export interface HeadlessDaemonPort {
  onTurnEvent(msg: DaemonFrame<'headlessTurnEvent'>): void
  onTurnResult(msg: DaemonFrame<'headlessTurnResult'>): void
  onBindResult(msg: DaemonFrame<'headlessBindResult'>): void
}

/** APPROVALS. */
export interface ApprovalsDaemonPort {
  onExecResult(msg: DaemonFrame<'approvalExecResult'>): void
}

/**
 * THE AGENT COMMAND RELAY — its OWN port, never merged with the host edge.
 *
 * ADR 7 D2 / ADR 5 D7, [spec:SP-b85a] restated by SP-fccf and SP-a43e: the relay
 * bakes session identity into its URL path, so a host callback routed through it
 * re-homes identity. The two surfaces arrive on the SAME SOCKET and this
 * extraction is exactly where they would be easiest to quietly merge — hence a
 * separate port with exactly one frame reaching it.
 */
export interface AgentRelayDaemonPort {
  run(machineId: string, msg: DaemonFrame<'agentRelayRequest'>): void
}

/** Everything the mux is given. */
export interface DaemonFeaturePorts {
  sessions: SessionsDaemonPort
  machines: MachinesDaemonPort
  hosts: HostsDaemonPort
  conversations: () => ConversationsDaemonPort
  rpc: RpcDaemonPort
  headless: HeadlessDaemonPort
  approvals: ApprovalsDaemonPort
  agentRelay: AgentRelayDaemonPort
}
