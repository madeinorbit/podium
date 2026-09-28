/**
 * THE TERMINAL FAMILY'S HOST PORT (POD-4785).
 *
 * ONE interface naming every capability the terminal RuntimeDriver needs from
 * whoever owns processes, disks and screens. Each member is a capability, not
 * a daemon object: the daemon satisfies it structurally in
 * `apps/daemon/src/runtime/host.ts`, and nothing in this package imports
 * `apps/daemon`.
 *
 * WORKED EXAMPLES this mirrors: the Codex family's `CodexRuntimeHost`
 * (`families/codex/runtime.ts`) receiving its engine through `EngineProcessOwner`
 * plus `SessionDriverSlots`, and the session slots port itself
 * (`families/session-slots.ts`). POD-4780/4781 added `readHistory` to those
 * hosts the same way `readHistory` arrives here.
 *
 * THE TERMINAL IS HANDED, NOT LOOKED UP. The session entry holds one driver
 * handle and one Terminal by structure (POD-4610/4613), so the entry is the
 * handoff point: `register`/`recoverWithId` capture the Terminal the host
 * hands at bind, `setTerminal` refreshes it on reattach (and on steal/park),
 * and no per-write `bridge(sessionId)` lookup remains. The transport itself
 * is the narrow `TerminalTransport` below — base64 writes plus liveness —
 * never the daemon's Terminal class.
 *
 * PROCESS FACTS ARE KEYED BY SESSION (REVIEW-4438 A1/A6, POD-4414 review
 * 2026-09-28). The session owns the process by its durable label; the driver
 * never resolves labels, scope units or pids itself. It asks per session and
 * the daemon resolves: `processAlive(sessionId)`, `resources(sessionId)`,
 * `stopSession({sessionId})`. Answer ownership compares Terminal object
 * identity plus observer generation/bindingVersion — a replaced Terminal is a
 * new object, so no pid comparison is needed (the write paths that used pid
 * were answer ownership, binding pid and health resources pid; all three now
 * go through object identity or host-resolved ports).
 */

import type { AgentKind, ResumeRef, SessionId } from '@podium/model'
import type {
  ControlMessage,
  RuntimeHistoryPage,
  RuntimeHistoryRange,
} from '@podium/protocol/daemon'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { ScopeResources } from '../../capabilities.js'
import type {
  InstalledTerminalInstrumentation,
} from './instrumentation.js'
import type { AttachmentStager } from '../../turns.js'
import type {
  QueuedTurn,
  QueueDrainAbandonedReason,
  TimerHandle,
} from './injection.js'
import type { SessionSpec } from '../../session-spec.js'
import type { AgentRuntimeState } from '@podium/model'
import type { SessionBinding } from '../../binding.js'
import type { RuntimeEvent } from '../../events.js'

export type TerminalSpawnControl = Extract<ControlMessage, { type: 'spawn' }>
export type TerminalReattachControl = Extract<ControlMessage, { type: 'reattach' }>

/**
 * THE FRAMES THIS DRIVER MAY EMIT.
 *
 * Narrowed from the whole daemon wire (POD-4414 review 1): grepping
 * terminal-driver.ts shows `host.send` carries only `runtimeEvent`,
 * `runtimeFineEvent` (the outbound-frame tap), and `machineDiagnostic` (the
 * instrumentation-degradation report). Nothing else may go out through this
 * port — spawn results, credentials and transfer frames are not this
 * driver's to send.
 */
export type TerminalDriverReport = Extract<
  DaemonMessage,
  { type: 'runtimeEvent' | 'runtimeFineEvent' | 'machineDiagnostic' }
>

/**
 * THE LIVE TERMINAL, as the driver needs it.
 *
 * writeBase64 carries injection bytes and menu keystrokes; live reports
 * whether the surface is still attached (parked surfaces drop writes).
 * No pid: answer ownership uses Terminal object identity (a replaced surface
 * is a new object) plus the observer generation/bindingVersion fences, and
 * resource/binding identity is resolved by the host per session. The daemon
 * adapts its Terminal class to this shape at the boundary.
 */
export interface TerminalTransport {
  readonly live: boolean
  writeBase64(dataBase64: string): void
}

/** Out-of-band context the mail boundary reads, when one exists. */
export type TerminalMailBoundaryContext = (
  sessionId: SessionId,
  signal?: AbortSignal,
) => Promise<string | null>

/**
 * Everything the terminal driver needs from its host, named explicitly.
 *
 * DELIBERATELY NOT a context object. This names what the driver needs, and
 * the daemon satisfies it structurally — the same discipline the contract
 * applies one layer down.
 */
export interface TerminalHostPorts {
  boundaryContext?: TerminalMailBoundaryContext
  /** The driver's outbound reports: runtime events plus the instrumentation
   *  degradation diagnostic. Narrowed from the whole daemon wire — see
   *  `TerminalDriverReport` for the grep. */
  send(msg: TerminalDriverReport): void
  stageAttachment: AttachmentStager
  /** The observers' current folded state for a session. */
  trackedState(sessionId: SessionId): AgentRuntimeState | undefined
  /** Whether composer sync is running (Draft Sync v2) for this session. */
  draftSyncing(sessionId: SessionId): boolean
  setDraftTarget(sessionId: SessionId, text: string): boolean
  /** Does this session's durable process still live? The ONLY thing that makes
   *  an adopt exact rather than hopeful. Keyed by session: the daemon resolves
   *  the entry's durable label itself, so the driver never holds labels. */
  processAlive(sessionId: SessionId): Promise<boolean>
  /** Rebuild/reuse the exact process bridge, observer lease, screen and composer.
   * Call ready after composition, before publishing bind or replaying redraw.
   * The host hands the freshly wired Terminal to ready, so the driver's
   * refresh lands with the reattach rather than via a later lookup. */
  recover(
    msg: TerminalReattachControl,
    ready: (terminal: TerminalTransport | undefined) => void,
  ): Promise<void>
  /** The daemon half of the survival table — dispose the bridge, reap the host.
   * Keyed by session: the daemon resolves the entry's durable label itself. */
  stopSession(input: { sessionId: SessionId }): Promise<boolean>
  /** The existing spawn path. `create()`/`resume()` go through it rather than
   *  around it, which is what keeps a contract-driven session byte-identical to
   *  a server-spawned one.
   *
   *  KEPT AS A PORT (POD-4414 review 3): install needs daemon-only state —
   *  the settings/home directories the per-session hook files are written
   *  under, the harness version-probe report sink, and the registry's
   *  instrumentation sections. None of those lives in this package. */
  installInstrumentation(
    sessionId: SessionId,
    spec: SessionSpec,
  ): Promise<InstalledTerminalInstrumentation>
  launch(
    msg: TerminalSpawnControl,
    instrumentation?: InstalledTerminalInstrumentation,
  ): Promise<void>
  /** A cursor-anchored transcript slice in the slice shape ({items, head, tail,
   *  hasMore}) with direction — the Store read over the live source, and the
   *  only transcript capability the host offers (POD-4471: the items-only
   *  readTranscript is deleted, every reader goes through history). */
  readHistory(
    session: { sessionId: SessionId; agentKind: AgentKind; cwd: string; resume?: ResumeRef },
    range: Omit<RuntimeHistoryRange, 'direction'> & {
      direction?: RuntimeHistoryRange['direction']
    },
  ): Promise<RuntimeHistoryPage>
  /** Locate the harness-native transcript for an archive, or throw with the
   *  harness's own reason when it declares none. The driver passes its own
   *  agentKind/cwd/resume (the daemon entry does not store them, and the
   *  claude family reuses this locator with fact-only inputs — so sessionId
   *  keying is not implementable here; scoping lives in the locator itself). */
  archiveTranscript(input: {
    agentKind: AgentKind
    cwd: string
    resumeValue: string
  }): Promise<{ path: string; relativeDir?: string }>
  /** Read the handoff transcript bytes for export. Scoped by purpose: the ONLY
   *  read through this port is the export path just located above, confined
   *  the way control/transcripts.ts guards its reads. No unscoped path reads. */
  readArchiveBytes(path: string): Promise<Uint8Array>
  /** Resource truth for this session — memory, tasks and the kernel's own
   *  OOM-kill counter, from the daemon's one cgroup observer. Keyed by session:
   *  the daemon resolves label, scope unit and pid itself. Undefined where
   *  there is neither a cgroup nor a readable /proc — honest, not zero. */
  resources(sessionId: SessionId): ScopeResources | undefined
  now(): number
  setTimer(fn: () => void, delayMs: number): TimerHandle
  clearTimer(handle: TimerHandle): void
  /**
   * RE-AUTHORIZE a queued turn immediately before it is typed, if this composer
   * can. See `TerminalInjectionPorts.authorizeAtDrain`.
   *
   * ABSENT ON THE DAEMON TODAY, and honestly so: authorization is a server fact
   * (owner, delegation, revocation), the durable FIFO is the server's, and the
   * server re-authorizes at its own drain before anything reaches this machine.
   * The port exists because the driver-side queue now CARRIES the principal, so
   * whoever forwards a queue here later has a seam to decide at rather than a
   * mechanism to invent.
   */
  authorizeAtDrain?(input: {
    sessionId: SessionId
    turn: QueuedTurn
  }): { ok: true } | { ok: false; reason: string }
  onDrainRejected?(input: { sessionId: SessionId; turn: QueuedTurn; reason: string }): void
  /**
   * The driver sent this session its interrupt key. A harness can obey it and
   * report nothing — Claude fires no hook on a user interrupt, and a stop before
   * any output leaves no transcript record either — so whoever reads the screen
   * needs to know a Stop went out to read it as one (POD-4633). The fence itself
   * still arrives only as a provider-confirmed observation.
   */
  onInterruptRequested?(sessionId: SessionId): void
  /**
   * The drain reached its deadline or was torn down with queued turns, so the
   * turns below were never typed (POD-2107, POD-2202). See
   * `TerminalInjectionPorts.onDrainAbandoned` for why this cannot stay silent.
   *
   * OPTIONAL FOR THE SAME REASON `onDrainRejected` IS: the durable FIFO is the
   * server's and nothing forwards a queue here yet, so there is no receipt on
   * this machine to correct. The driver logs the abandonment unconditionally —
   * that part is not optional — and this port is where whoever forwards a queue
   * here later hangs the receipt correction, rather than inventing the
   * mechanism under pressure.
   */
  onDrainAbandoned?(input: {
    sessionId: SessionId
    turns: readonly QueuedTurn[]
    reason: QueueDrainAbandonedReason
  }): void
  /**
   * Trace one runtime event for lifecycle timing. The daemon wires
   * `driverTiming.runtimeEvent`; tests leave it absent. Optional so the family
   * never imports the daemon's timing module.
   */
  traceRuntimeEvent?(binding: SessionBinding, event: RuntimeEvent): void
}
