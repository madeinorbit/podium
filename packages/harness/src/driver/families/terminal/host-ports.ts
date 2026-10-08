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
  TerminalWriteRole,
  TimerHandle,
} from './injection.js'
import type { SessionSpec } from '../../session-spec.js'
import type { AgentRuntimeState } from '@podium/model'
import type { SessionBinding } from '../../binding.js'
import type { RuntimeEvent } from '../../events.js'

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
  /** `role` says whose write it is (POD-4888): `message` for a turn's own
   *  typing, which the host's foreign-write counter lets through; anything
   *  else, including no role, is counted as a foreign write. */
  writeBase64(dataBase64: string, role?: TerminalWriteRole): void
}

/**
 * THE SESSION'S FOREIGN-WRITE COUNTER, as the driver uses it (POD-4888,
 * receipt-proof spec §5.3). The host owns one per session entry and bumps it
 * from its terminal write call; the driver only marks where a turn's typing
 * starts, keyed by session like every other process fact here.
 */
export interface TerminalForeignWrites {
  /** Every foreign write and exclusivity loss so far, this host life. */
  count(sessionId: SessionId): number
  /** Whether an unchanged count can be believed: true only while the session's
   *  terminal holds the host's writer lease (never on an adopted abduco session). */
  orderTrustworthy(sessionId: SessionId): boolean
  /** Remember the session's current count as `turnId`'s typing start. */
  markTyping(sessionId: SessionId, turnId: string): void
  /** The count when `turnId`'s typing started, if it is still remembered. */
  typingMark(sessionId: SessionId, turnId: string): number | undefined
}

/** Out-of-band context the mail boundary reads, when one exists. */
export type TerminalMailBoundaryContext = (
  sessionId: SessionId,
  signal?: AbortSignal,
) => Promise<string | null>

/** What the terminal host launches one session from. */
export interface TerminalLaunch {
  sessionId: SessionId
  spec: SessionSpec
  instrumentation: InstalledTerminalInstrumentation
  /** The conversation to continue; absent = a new one. */
  resume?: ResumeRef
}

/** What the host hands back once the session's process is up. */
export interface TerminalLaunched {
  /** The live surface the driver writes through. */
  terminal?: TerminalTransport
  /** The observation lease the server issued with the spawn, which every
   *  event this driver emits must carry. Absent = the driver's own first. */
  observerGeneration?: number
  bindingVersion?: number
  /** Announce the session live (the bind). Called once, after the driver has
   *  registered the handle the bind names. */
  announce(): void
}

/**
 * Everything the terminal driver needs from its host, named explicitly.
 *
 * DELIBERATELY NOT a context object. This names what the driver needs, and
 * the daemon satisfies it structurally — the same discipline the contract
 * applies one layer down.
 */
export interface TerminalHostPorts {
  boundaryContext?: TerminalMailBoundaryContext
  /** Per-writer bookkeeping and diagnostics; never a receipt veto. */
  foreignWrites?: TerminalForeignWrites
  /** Pending typed sends in the existing daemon binding record. The floor is
   * time, never a transcript byte position. Save before the first byte. */
  proofWatches?: {
    load(sessionId: SessionId): Promise<readonly TerminalProofWatch[]>
    save(sessionId: SessionId, watch: TerminalProofWatch): Promise<void>
    remove(sessionId: SessionId, turnId: string): Promise<void>
  }
  /** The driver's outbound reports: runtime events plus the instrumentation
   *  degradation diagnostic. Narrowed from the whole daemon wire — see
   *  `TerminalDriverReport` for the grep. */
  send(msg: TerminalDriverReport): void
  stageAttachment: AttachmentStager
  /** The observers' current folded state for a session. */
  trackedState(sessionId: SessionId): AgentRuntimeState | undefined
  /** Flush and read the current harness input box, without changing tracked state. */
  readInput?(sessionId: SessionId): Promise<string | undefined>
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
  /** Write this session's per-session hook wiring before its harness starts.
   *
   *  KEPT AS A PORT (POD-4414 review 3): install needs daemon-only state —
   *  the settings/home directories the per-session hook files are written
   *  under, the harness version-probe report sink, and the registry's
   *  instrumentation sections. None of those lives in this package. */
  installInstrumentation(
    sessionId: SessionId,
    spec: SessionSpec,
  ): Promise<InstalledTerminalInstrumentation>
  /**
   * Start this session's harness in a durable PTY, FROM THE CONTRACT'S OWN SPEC
   * (POD-5814): the host composes the argv through the harness adapter (the
   * spec's instructions, model, first prompt; the resume ref), binds the
   * session's process env, and wires the bridge, observers and screen.
   *
   * The host owns what is not the driver's: the PTY's size, the durable label,
   * and the observation lease the server issued with the spawn. It hands back
   * the lease the driver envelopes its events with, the live terminal, and the
   * announcement — the bind — which the driver makes once it holds its handle.
   * Nothing is announced before that.
   */
  launch(input: TerminalLaunch): Promise<TerminalLaunched>
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
  /** Read the handoff transcript bytes for export. CONFINED FOR REAL: the host
   *  resolves the path with resolveWithinRoots against discoveryRoots(homeDir)
   *  — the same guard control/transcripts.ts uses — and refuses anything
   *  outside with a typed error. No unscoped path reads. */
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

export interface TerminalProofWatch {
  turnId: string
  text: string
  typingStartedAt: string
}
