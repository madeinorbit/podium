/**
 * THE DAEMON SOCKET MUX (POD-389, under POD-317's gateway).
 *
 * `attachDaemon`, `detachDaemon` and `onDaemonMessageFrom` used to be methods on
 * the SESSIONS SERVICE, which meant one feature owned the multiplexer for every
 * other feature's traffic: host metrics, repo scans, credential relays and RPC
 * replies all entered the system through a giant switch inside session code.
 * They live here now. The sessions service keeps lifecycle, inbox and presence
 * and has no socket.
 *
 * WHAT THIS MODULE OWNS: the connection lifecycle, the machine principal, and
 * the routing table. Nothing else. Every case body moved to the feature that
 * owns it; the gateway calls a port and stops.
 *
 * ---------------------------------------------------------------------------
 * THE PRINCIPAL, AND WHY IT IS AN OBJECT
 * ---------------------------------------------------------------------------
 * A daemon connection is a MACHINE PRINCIPAL (`docs/multi-user-readiness.md`
 * §3.1.4: machines are owned compute, with see / use / manage as separate verbs
 * and `use` a CODE-EXECUTION boundary). Every routed frame carries one, so a
 * feature port can enforce those verbs once ownership lands (POD-1079).
 *
 * The principal comes from the AUTHENTICATED TRANSPORT ONLY — ADR 3 D7, ADR 5
 * D5, resolved by the strategy modules POD-388 landed and handed to
 * {@link DaemonMux.attachDaemon} by `daemon-socket.ts`. It is NEVER read out of
 * a frame body. No `DaemonMessage` even has a machine field today, and
 * `daemon-mux.test.ts` pins that an injected one is inert.
 *
 * `DaemonPeer` also admits a bare machine id. That is the IN-PROCESS form used
 * by the all-in-one local daemon link and by the test harness, and it can only
 * ever become a MACHINE principal — there is deliberately no path here through
 * which a user or operator identity could reach the daemon path, which is the
 * multi-user hole this extraction had to avoid. The socket path cannot use it:
 * `daemon-socket.ts` holds a `MachinePrincipal` and passes that object through.
 *
 * ---------------------------------------------------------------------------
 * WRITER CLASS
 * ---------------------------------------------------------------------------
 * ADR 1's permitted-writers column has FOUR classes — operator, agent-session,
 * DAEMON and SYSTEM — and ADR 9 carries the same taxonomy. A daemon-observed
 * runtime field (status, exitCode, epoch, geometry, resumable/resume,
 * transcriptAvailable, busy, agentState, agentColor, clientCount, activity
 * timestamps) is a single-writer OBSERVATION stream whose source is the daemon.
 * So the mux attributes those writes to the machine principal it resolved: not
 * to a person, and not to the system class. Server-side automations that fold or
 * derive from them (boot reconcile, expiry, the steward) are the SYSTEM class of
 * §3.1.6 S5 and are not delegated — neither carries an on-behalf-of, and
 * `attributionOf(machinePrincipal).onBehalfOf` is `null` by construction.
 */

import type { DaemonMessage, MachinePrincipal } from '@podium/protocol'
import { asCapabilityRef, asDeviceId } from '@podium/protocol'
import { asMachineId } from '@podium/model'
import {
  type DaemonPortId,
  daemonPlaneClassFor,
  daemonPortsFor,
  type SessionsDaemonFrame,
} from './daemon-frame-routing'
import { LOCAL_MACHINE_ID } from '@podium/runtime/local-machine'
import type { ControlSend, DaemonFeaturePorts, DaemonFrame } from './daemon-ports'

/**
 * Either a resolved transport principal (the socket path) or a bare machine id
 * (the in-process link and the test harness). See the header: a string can only
 * become a machine principal.
 */
export type DaemonPeer = MachinePrincipal | string

/**
 * The in-process machine principal. `device` names the BINDING, not an identity
 * (ADR 3 Amendment 1 D14.1), and `in-process` is the honest name for a link with
 * no socket. Nothing here can produce a user, agent or system principal.
 */
export const inProcessMachinePrincipal = (machineId: string): MachinePrincipal => ({
  kind: 'machine',
  machine: asMachineId(machineId),
  device: asDeviceId(`in-process:${machineId}`),
  capability: asCapabilityRef(`cap:machine:${machineId}`),
})

const principalOf = (peer: DaemonPeer): MachinePrincipal =>
  typeof peer === 'string' ? inProcessMachinePrincipal(peer) : peer

/**
 * Per-frame dispatch, TOTAL over `DaemonMessage` by construction: the value is a
 * function per type, and `satisfies` makes a missing type a compile error. There
 * is no string-built method name and no `any` — a reviewer can read the owner of
 * every frame off one table.
 */
type Dispatcher = {
  [K in DaemonMessage['type']]: (
    ports: DaemonFeaturePorts,
    principal: MachinePrincipal,
    msg: DaemonFrame<K>,
  ) => void
}

const toSessions = (
  ports: DaemonFeaturePorts,
  principal: MachinePrincipal,
  msg: SessionsDaemonFrame,
): void => ports.sessions.onSessionDaemonFrame(principal, msg)

const DISPATCH: Dispatcher = {
  // ---- sessions ----
  bind: toSessions,
  agentFrame: toSessions,
  agentFrameBatch: toSessions,
  agentExit: toSessions,
  spawnError: toSessions,
  reattachFailed: toSessions,
  transcriptDelta: toSessions,
  title: toSessions,
  agentState: toSessions,
  agentColor: toSessions,
  agentModel: toSessions,
  agentObservation: toSessions,
  agentObservationRebind: toSessions,
  agentObserverLiveConfirmation: toSessions,
  nativeDraft: toSessions,
  sessionResumeRef: toSessions,
  sessionCwd: toSessions,
  sessionGitActivity: toSessions,
  sessionOpenUrl: toSessions,
  sessionOpenUrlResult: toSessions,

  // ---- machines: the machine's own reported inventory, scoped by principal ----
  inventoryReport: (ports, principal, msg) =>
    ports.machines.recordInventory(principal.machine, msg.inventory),

  // ---- hosts: a per-machine fact, so the machine rides the delivery path ----
  hostMetrics: (ports, principal, msg) => {
    const { type: _type, ...sample } = msg
    ports.hosts.onHostMetrics(principal.machine, sample)
  },
  memoryBreakdownResult: (ports, _principal, msg) => ports.hosts.onMemoryBreakdownResult(msg),

  // ---- conversations: discovery is per-machine ----
  conversationsChanged: (ports, principal, msg) =>
    ports.conversations().onDiscovery(principal.machine, msg.conversations, msg.diagnostics, msg.removed),
  transcriptMirrorResult: (ports, _principal, msg) =>
    ports.conversations().onTranscriptMirrorResult(msg),
  // Dual ownership, preserved from the pre-extraction switch: a scan is BOTH a
  // conversation discovery and the reply to an RPC. Order matters and is the
  // table's, not a send site's.
  scanResult: (ports, principal, msg) => {
    ports.conversations().onDiscovery(principal.machine, msg.conversations, msg.diagnostics, msg.removed)
    ports.rpc.onScanResult(msg)
  },

  // ---- RPC replies (requestId-correlated; POD-318 owns the correlator) ----
  scanReposResult: (ports, _p, msg) => ports.rpc.onScanReposResult(msg),
  browseDirsResult: (ports, _p, msg) => ports.rpc.onBrowseDirsResult(msg),
  repoOpResult: (ports, _p, msg) => ports.rpc.onRepoOpResult(msg),
  harnessExecResult: (ports, _p, msg) => ports.rpc.onHarnessExecResult(msg),
  usageResult: (ports, _p, msg) => ports.rpc.onUsageResult(msg),
  agentQuotaResult: (ports, _p, msg) => ports.rpc.onAgentQuotaResult(msg),
  imageUploadResult: (ports, _p, msg) => ports.rpc.onImageUploadResult(msg),
  transcriptReadResult: (ports, _p, msg) => ports.rpc.onTranscriptReadResult(msg),
  fileReadResult: (ports, _p, msg) => ports.rpc.onFileReadResult(msg),
  fileWriteResult: (ports, _p, msg) => ports.rpc.onFileWriteResult(msg),
  fileAssetResult: (ports, _p, msg) => ports.rpc.onFileAssetResult(msg),
  dirListResult: (ports, _p, msg) => ports.rpc.onDirListResult(msg),
  handoffExportResult: (ports, _p, msg) => ports.rpc.onHandoffExportResult(msg),
  handoffChunkReadResult: (ports, _p, msg) => ports.rpc.onHandoffChunkReadResult(msg),
  handoffImportChunkResult: (ports, _p, msg) => ports.rpc.onHandoffImportChunkResult(msg),
  handoffImportResult: (ports, _p, msg) => ports.rpc.onHandoffImportResult(msg),
  workspaceExportResult: (ports, _p, msg) => ports.rpc.onWorkspaceExportResult(msg),
  workspaceImportResult: (ports, _p, msg) => ports.rpc.onWorkspaceImportResult(msg),
  workspaceCleanResult: (ports, _p, msg) => ports.rpc.onWorkspaceCleanResult(msg),
  credentialExportResult: (ports, _p, msg) => ports.rpc.onCredentialExportResult(msg),
  credentialInstallResult: (ports, _p, msg) => ports.rpc.onCredentialInstallResult(msg),

  // ---- headless ----
  headlessTurnEvent: (ports, _p, msg) => ports.headless.onTurnEvent(msg),
  headlessTurnResult: (ports, _p, msg) => ports.headless.onTurnResult(msg),
  headlessBindResult: (ports, _p, msg) => ports.headless.onBindResult(msg),

  // ---- approvals ----
  approvalExecResult: (ports, _p, msg) => ports.approvals.onExecResult(msg),

  // ---- THE AGENT COMMAND RELAY. Its own port; nothing else reaches it. ----
  agentRelayRequest: (ports, principal, msg) => ports.agentRelay.run(principal.machine, msg),
}

/** Bus emits the mux owns (machine reachability is a gateway fact, not a session one). */
export interface DaemonMuxBus {
  emit(event: 'machine.connected', payload: { machineId: string }): void
  emit(event: 'machine.disconnected', payload: { machineId: string }): void
}

export interface DaemonMuxDeps {
  readonly ports: DaemonFeaturePorts
  readonly bus: DaemonMuxBus
}

export class DaemonMux {
  constructor(private readonly deps: DaemonMuxDeps) {}

  /**
   * A daemon proved its identity and is now reachable.
   *
   * The ORDER below is load-bearing and is the pre-extraction order exactly:
   * socket registration, then placeholder adoption, then the queued flush, then
   * the sessions port's own attach work (drain / lake sweep / priorities / park
   * / reattach probes / headless binds), then the machine broadcast, then the
   * bus. `attachDaemon` synchronously flushes buffered control frames, so the
   * caller must already have sent its handshake reply — see `daemon-socket.ts`.
   */
  attachDaemon(peer: DaemonPeer, send: ControlSend): void {
    const principal = principalOf(peer)
    const machineId = principal.machine
    const { machines, sessions } = this.deps.ports
    machines.attach(machineId, send)
    // The local machine adopts every lingering `'__local__'` placeholder row as
    // it attaches: a session created between `ensureLocalMachine` and the daemon
    // connecting is still attributed to the placeholder. Idempotent.
    if (machineId === LOCAL_MACHINE_ID) machines.adoptPlaceholderRows(machineId)
    machines.flushQueued(machineId)
    sessions.onMachineAttached(principal)
    machines.broadcastMachines()
    this.deps.bus.emit('machine.connected', { machineId })
  }

  /**
   * That daemon's socket closed. `send` identifies WHICH socket: a superseded
   * socket's late close must not evict the live registration, nor knock this
   * machine's sessions back to 'reconnecting' behind the daemon's back.
   *
   * `machine.disconnected` is emitted BEFORE the session sweep, preserving the
   * pre-module ordering (the hosts module drops this machine's health sample and
   * rebroadcasts where the inline delete used to sit).
   */
  detachDaemon(peer: DaemonPeer, send?: ControlSend): void {
    const principal = principalOf(peer)
    const machineId = principal.machine
    const { machines, sessions } = this.deps.ports
    if (!machines.detach(machineId, send)) return
    this.deps.bus.emit('machine.disconnected', { machineId })
    sessions.onMachineDetached(principal)
    machines.broadcastMachines()
  }

  /**
   * Route ONE inbound daemon frame to the feature port that owns it.
   *
   * An unknown type is DROPPED, never guessed at: a gateway that cannot classify
   * a frame must refuse it (POD-317's no-local-reclassification rule). Both
   * lookups have to answer — the ADR 7 plane inventory AND the owner table — so
   * a frame classified in one and forgotten in the other cannot slip through as
   * a default.
   */
  routeDaemonFrame(peer: DaemonPeer, msg: DaemonMessage): void {
    const principal = principalOf(peer)
    if (daemonPlaneClassFor(msg.type) === null || daemonPortsFor(msg.type) === null) {
      console.warn(`[podium] refused unclassified daemon frame '${msg.type}'`)
      return
    }
    const dispatch = DISPATCH[msg.type] as (
      ports: DaemonFeaturePorts,
      principal: MachinePrincipal,
      msg: DaemonMessage,
    ) => void
    dispatch(this.deps.ports, principal, msg)
  }

  /** Which port(s) own a frame type — exposed for the routing audit. */
  static portsFor(type: string): readonly DaemonPortId[] | null {
    return daemonPortsFor(type)
  }
}
