/**
 * THE DAEMON MUX'S ROUTING TABLE — which FEATURE PORT owns each inbound daemon
 * frame (POD-389, under POD-317's gateway).
 *
 * The gateway owns no feature logic. What it owns is this table: a total,
 * compile-checked map from `DaemonMessage['type']` to the feature port(s) that
 * handle it. Adding a daemon frame without naming its owner is a compile error
 * here, exactly as failing to classify it is a compile error in
 * `messages/message-class.ts`.
 *
 * THE PLANE IS NOT RE-DERIVED HERE. ADR 7's inventory (`DAEMON_PLANE_CLASS`) is
 * the single classification source; this module READS it and refuses anything it
 * cannot classify (`planeClassOf` returning null ⇒ the mux drops the frame).
 * POD-317's "no local reclassification" rule is why the plane never appears as a
 * literal in this file.
 */

import { DAEMON_PLANE_CLASS, type DaemonMessage, type PlaneClass } from '@podium/protocol'

/**
 * The feature ports the daemon edge routes to. Each is owned by a module; the
 * gateway holds only the reference and the table below.
 */
export const DAEMON_PORT_IDS = [
  'sessions',
  'machines',
  'hosts',
  'conversations',
  'rpc',
  'headless',
  'agentRelay',
  'approvals',
] as const
export type DaemonPortId = (typeof DAEMON_PORT_IDS)[number]

/**
 * Frame → owning port(s), TOTAL over `DaemonMessage`. A frame with two entries
 * is fanned out in array order (only `scanResult`, which is both a conversation
 * discovery and an RPC reply — that dual ownership predates this extraction and
 * is preserved deliberately rather than silently collapsed).
 */
export const DAEMON_FRAME_PORTS = {
  // ---- session-owned: session-keyed runtime, lifecycle and host callbacks ----
  bind: ['sessions'],
  agentFrame: ['sessions'],
  agentFrameBatch: ['sessions'],
  agentExit: ['sessions'],
  spawnError: ['sessions'],
  reattachFailed: ['sessions'],
  transcriptDelta: ['sessions'],
  title: ['sessions'],
  agentState: ['sessions'],
  agentColor: ['sessions'],
  agentModel: ['sessions'],
  agentObservation: ['sessions'],
  agentObservationRebind: ['sessions'],
  agentObserverLiveConfirmation: ['sessions'],
  nativeDraft: ['sessions'],
  sessionResumeRef: ['sessions'],
  sessionCwd: ['sessions'],
  sessionGitActivity: ['sessions'],
  sessionOpenUrl: ['sessions'],
  sessionOpenUrlResult: ['sessions'],

  // ---- machine-owned ----
  inventoryReport: ['machines'],
  machineDiagnostic: ['machines'],

  // ---- host-owned ----
  hostMetrics: ['hosts'],
  memoryBreakdownResult: ['hosts'],

  // ---- conversation-owned ----
  conversationsChanged: ['conversations'],
  transcriptMirrorResult: ['conversations'],
  scanResult: ['conversations', 'rpc'],

  // ---- RPC replies, settled by the generic correlator (POD-318) ----
  scanReposResult: ['rpc'],
  browseDirsResult: ['rpc'],
  repoOpResult: ['rpc'],
  harnessExecResult: ['rpc'],
  usageResult: ['rpc'],
  agentQuotaResult: ['rpc'],
  imageUploadResult: ['rpc'],
  transcriptReadResult: ['rpc'],
  fileReadResult: ['rpc'],
  fileWriteResult: ['rpc'],
  fileAssetResult: ['rpc'],
  dirListResult: ['rpc'],
  handoffExportResult: ['rpc'],
  handoffChunkReadResult: ['rpc'],
  handoffImportChunkResult: ['rpc'],
  handoffImportResult: ['rpc'],
  handoffBindingFinalizeResult: ['rpc'],
  workspaceExportResult: ['rpc'],
  workspaceImportResult: ['rpc'],
  workspaceCleanResult: ['rpc'],
  credentialExportResult: ['rpc'],
  credentialInstallResult: ['rpc'],

  // ---- headless-owned ----
  headlessTurnEvent: ['headless'],
  headlessTurnResult: ['headless'],
  headlessBindResult: ['headless'],

  // ---- approvals ----
  approvalExecResult: ['approvals'],

  // ---- THE AGENT COMMAND RELAY, and nothing else (ADR 7 D2 / ADR 5 D7) ----
  agentRelayRequest: ['agentRelay'],
} as const satisfies Record<DaemonMessage['type'], readonly [DaemonPortId, ...DaemonPortId[]]>

/** The session-owned subset, as a type — the sessions port's frame argument. */
export type SessionsDaemonFrameType = {
  [K in keyof typeof DAEMON_FRAME_PORTS]: (typeof DAEMON_FRAME_PORTS)[K] extends readonly [
    'sessions',
  ]
    ? K
    : never
}[keyof typeof DAEMON_FRAME_PORTS]

export type SessionsDaemonFrame = Extract<DaemonMessage, { type: SessionsDaemonFrameType }>

/**
 * The RPC-owned subset, as a type — DERIVED from the table above rather than
 * restated, so the correlator's fan-in stays total over exactly the frames the
 * gateway routes to it. This is MEMBERSHIP, not sole ownership: `scanResult` is
 * both a conversation discovery and an RPC reply, and belongs in both.
 */
export type RpcDaemonFrameType = {
  [K in keyof typeof DAEMON_FRAME_PORTS]: 'rpc' extends (typeof DAEMON_FRAME_PORTS)[K][number]
    ? K
    : never
}[keyof typeof DAEMON_FRAME_PORTS]

export type RpcDaemonFrame = Extract<DaemonMessage, { type: RpcDaemonFrameType }>

/**
 * HOW A MACHINE-ADJACENT FRAME CARRIES ITS MACHINE SCOPE.
 *
 * `docs/multi-user-readiness.md` §3.1.1: every per-machine fact — repos and
 * prefixes, worktrees, harness and model inventory, host metrics — inherits that
 * machine's scoping and carries no visibility of its own. The mux is where those
 * facts enter the system, so a frame routed without its machine identity becomes
 * an unscopable projection downstream.
 *
 * This is an AUDIT, not an assumption: every machine-adjacent frame is listed
 * with the mechanism that carries its scope, and `daemon-mux.test.ts` fails if a
 * frame here is routed to a port method that receives neither.
 *
 * - `principal` — the port method takes the resolved machine principal (or its
 *   machine id) as an argument. Scope is carried on the delivery path.
 * - `request-correlated` — the frame is a reply the server itself asked a NAMED
 *   machine for; the scope was fixed when the request was sent, and the ANSWERER
 *   is checked against it before the request settles.
 *
 * THE GAP THIS USED TO RECORD IS CLOSED (POD-1175, by POD-318). The
 * `request-correlated` rows settled in pending maps keyed by `requestId` ALONE,
 * so the claim above was an assertion nothing enforced: machine B's reply could
 * settle a request sent to machine A. The maps are gone; every correlated reply
 * now settles through `modules/daemon-request.ts`, which is handed
 * `principal.machine` on the delivery path and REFUSES an answer from any
 * machine other than the one the request was sent to (the request is left to
 * time out). The gateway still re-creates no correlator of its own — it only
 * carries the principal to the one that exists.
 */
export const MACHINE_SCOPE_CARRIER = {
  inventoryReport: 'principal',
  machineDiagnostic: 'principal',
  hostMetrics: 'principal',
  memoryBreakdownResult: 'request-correlated',
  scanResult: 'principal',
  conversationsChanged: 'principal',
  scanReposResult: 'request-correlated',
  browseDirsResult: 'request-correlated',
  repoOpResult: 'request-correlated',
  transcriptMirrorResult: 'request-correlated',
} as const satisfies Partial<Record<DaemonMessage['type'], 'principal' | 'request-correlated'>>

export type MachineAdjacentFrameType = keyof typeof MACHINE_SCOPE_CARRIER

/** Machine-adjacent frames whose scope rides the DELIVERY path, not a request. */
export const PRINCIPAL_SCOPED_FRAMES = Object.entries(MACHINE_SCOPE_CARRIER)
  .filter(([, carrier]) => carrier === 'principal')
  .map(([type]) => type) as MachineAdjacentFrameType[]

/**
 * Machine-adjacent frames that are REPLIES to a request the server sent.
 *
 * These also have to reach their port with the answering machine, or the
 * correlator has nothing to compare the target against and the
 * `request-correlated` claim goes back to being unenforceable. `daemon-mux.test.ts`
 * audits every row here, so dropping the principal from one of these dispatch
 * lines — the exact shape the code had before POD-318 — fails the mux's suite.
 */
export const REQUEST_CORRELATED_FRAMES = Object.entries(MACHINE_SCOPE_CARRIER)
  .filter(([, carrier]) => carrier === 'request-correlated')
  .map(([type]) => type) as MachineAdjacentFrameType[]

/**
 * Which port(s) own a frame, or `null` when the type is unknown. A null answer
 * means REFUSE — the gateway never guesses an owner, exactly as it never guesses
 * a plane.
 */
export const daemonPortsFor = (type: string): readonly DaemonPortId[] | null => {
  const table: Record<string, readonly DaemonPortId[]> = DAEMON_FRAME_PORTS
  return table[type] ?? null
}

/** The frame's ADR 7 plane·class, read from the inventory. Never re-derived. */
export const daemonPlaneClassFor = (type: string): PlaneClass | null => {
  const table: Record<string, PlaneClass> = DAEMON_PLANE_CLASS
  return table[type] ?? null
}
