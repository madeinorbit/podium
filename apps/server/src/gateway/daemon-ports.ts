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
 * to the MACHINE, ADR 1's daemon writer class — never to a person).
 *
 * IT APPEARS ON THE REQUEST-CORRELATED REPLIES TOO, since POD-318. Those methods
 * used to take the message alone, which is exactly why `MACHINE_SCOPE_CARRIER`
 * could only RECORD the request-correlated claim instead of enforcing it: the
 * settle path never learned who answered. Every reply port below now takes the
 * answering machine id as its first argument, and the correlator refuses a reply
 * from a machine other than the one the request was sent to (POD-1175).
 */

import type { ConversationDiagnosticWire, ConversationSummaryWire } from '@podium/model'
import type { ControlMessage, DaemonMessage, MachinePrincipal } from '@podium/protocol'
import type { RpcDaemonFrame, SessionsDaemonFrame } from './daemon-frame-routing'

/** A frame of a given type. */
export type DaemonFrame<T extends DaemonMessage['type']> = Extract<DaemonMessage, { type: T }>

/** Outbound control-message sink for one daemon socket (`Send<ControlMessage>`). */
export type ControlSend = (msg: ControlMessage) => void

/**
 * Outbound session-inbox leg of the daemon gateway.
 *
 * This is transport only: the caller has already authorized the command at the
 * command boundary, and a durable queued input is authorized again immediately
 * before this port is called. The port deliberately carries neither a
 * capability nor an authorization result, so it cannot cache either one (ADR 3
 * D8/D16; POD-394).
 */
export interface SessionInputGatewayPort {
  sendInput(machineId: string, message: Extract<ControlMessage, { type: 'input' }>): void
}

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

/** HOSTS. Health samples are per-machine facts and are scoped by the principal;
 *  so is the memory-breakdown reply, which the correlator checks the sender of. */
export interface HostsDaemonPort {
  onHostMetrics(machineId: string, sample: Omit<DaemonFrame<'hostMetrics'>, 'type'>): void
  onMemoryBreakdownResult(machineId: string, msg: DaemonFrame<'memoryBreakdownResult'>): void
}

/** CONVERSATIONS. Discovery is per-machine; the mirror read is request-correlated
 *  and settles through the same correlator, so it takes the answering machine. */
export interface ConversationsDaemonPort {
  onDiscovery(
    machineId: string,
    conversations: ConversationSummaryWire[],
    diagnostics: ConversationDiagnosticWire[],
    removed?: string[],
  ): void
  onTranscriptMirrorResult(machineId: string, msg: DaemonFrame<'transcriptMirrorResult'>): void
  triggerLakeSweep(machineId: string): void
}

/**
 * RPC REPLIES — ONE METHOD, because there is one correlator (POD-318).
 *
 * This used to be twenty-three hand-paired `on*Result` methods, each mirroring a
 * consumer-owned pending map. The maps are gone, so the pairing has nothing left
 * to mirror: a correlated reply is settled by `requestId`, and which frame
 * carried it is the OWNING MODULE's business, not the gateway's. The frame union
 * is derived from `DAEMON_FRAME_PORTS`, so a new reply frame routed to `rpc`
 * arrives here without touching this interface — and the module's own settle
 * table is a compile error until it handles it.
 *
 * `machineId` is the ANSWERING machine, from the authenticated transport. It is
 * the whole reason this port changed shape: without it the correlator cannot
 * tell a reply to your request from a reply to someone else's (POD-1175).
 */
export interface RpcDaemonPort {
  settleDaemonReply(machineId: string, msg: RpcDaemonFrame): void
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
  conversations: ConversationsDaemonPort
  rpc: RpcDaemonPort
  headless: HeadlessDaemonPort
  approvals: ApprovalsDaemonPort
  agentRelay: AgentRelayDaemonPort
}
